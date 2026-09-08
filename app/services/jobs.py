from __future__ import annotations

import json
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from app.config import Settings
from app.domain import Job, Transcript, utc_now_iso
from app.services.exporters import to_txt
from app.services.media import extract_audio
from app.services.progress import StageReporter
from app.services.transcriber import SenseVoiceTranscriber


class JobNotFound(KeyError):
    pass


class InvalidJobState(RuntimeError):
    pass


class JobManager:
    def __init__(self, settings: Settings, transcriber: SenseVoiceTranscriber):
        self.settings = settings
        self.transcriber = transcriber
        self._jobs: dict[str, Job] = {}
        self._lock = threading.RLock()
        self._progress_write_at: dict[str, float] = {}
        self._executor = ThreadPoolExecutor(
            max_workers=settings.job_workers,
            thread_name_prefix="funasr-job",
        )
        self._load_persisted_jobs()

    def create(
        self, filename: str, language: str, identify_speakers: bool, *,
        use_itn: bool = True, speaker_count: int | None = None,
        batch_size_s: int | None = None,
    ) -> Job:
        job_id = uuid.uuid4().hex
        job_dir = self.settings.jobs_dir / job_id
        job_dir.mkdir(parents=True, exist_ok=False)
        suffix = Path(filename).suffix.lower()
        job = Job(
            id=job_id,
            filename=filename,
            source_path=job_dir / f"source{suffix}",
            audio_path=job_dir / "audio.wav",
            language=language,
            identify_speakers=identify_speakers,
            use_itn=use_itn,
            speaker_count=speaker_count if identify_speakers else None,
            batch_size_s=batch_size_s,
            state="uploading",
            stage="正在接收文件",
        )
        with self._lock:
            self._jobs[job_id] = job
            self._persist_manifest(job)
        return job

    def discard_unsubmitted(self, job_id: str) -> None:
        with self._lock:
            existing = self._jobs.get(job_id)
            if existing and existing.state != "uploading":
                raise InvalidJobState("不能丢弃已提交的任务")
            job = self._jobs.pop(job_id, None)
        if job:
            shutil.rmtree(job.source_path.parent, ignore_errors=True)

    def submit(self, job_id: str) -> None:
        with self._lock:
            job = self.get(job_id)
            if job.state != "uploading":
                raise InvalidJobState(f"任务当前状态为 {job.state}，无法再次提交")
            self._update(job, 0, "等待处理", "queued")
            try:
                self._executor.submit(self._run, job_id)
            except RuntimeError:
                self._update(job, 0, "正在接收文件", "uploading")
                raise

    def get(self, job_id: str) -> Job:
        with self._lock:
            try:
                return self._jobs[job_id]
            except KeyError as exc:
                raise JobNotFound(job_id) from exc

    def list(self, limit: int = 20) -> list[Job]:
        with self._lock:
            jobs = sorted(self._jobs.values(), key=lambda item: item.created_at, reverse=True)
            return jobs[:limit]

    def delete(self, job_id: str) -> None:
        with self._lock:
            job = self.get(job_id)
            if job.state in {"uploading", "queued", "preparing", "loading", "transcribing", "finalizing"}:
                raise InvalidJobState("正在运行的任务不能删除")
            self._jobs.pop(job_id, None)
        shutil.rmtree(job.source_path.parent, ignore_errors=False)

    def patch_transcript(
        self,
        job_id: str,
        *,
        speaker_names: dict[str, str] | None,
        segments: list[dict[str, Any]] | None,
    ) -> Transcript:
        with self._lock:
            job = self.get(job_id)
            if not job.transcript:
                raise InvalidJobState("任务尚未生成转写结果")
            transcript = job.transcript
            valid_speakers = set(transcript.speaker_names)
            if speaker_names is not None:
                for speaker, name in speaker_names.items():
                    if speaker in valid_speakers:
                        cleaned = name.strip()[:80]
                        transcript.speaker_names[speaker] = cleaned or speaker
            if segments is not None:
                by_id = {segment.id: segment for segment in transcript.segments}
                for change in segments:
                    segment = by_id.get(int(change.get("id", -1)))
                    if segment is None:
                        continue
                    if "text" in change:
                        segment.text = str(change["text"]).strip()[:20_000]
                    if "speaker" in change and change["speaker"] in valid_speakers:
                        segment.speaker = change["speaker"]
                transcript.text = "".join(segment.text for segment in transcript.segments)
            job.updated_at = utc_now_iso()
            self._persist_result(job)
            self._persist_manifest(job)
            return transcript

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=False)

    def _update(
        self, job: Job, progress: int, stage: str, state: str | None = None, *,
        throttled: bool = False,
    ) -> None:
        with self._lock:
            job.progress = max(job.progress, min(100, progress))
            job.stage = stage
            job.updated_at = utc_now_iso()
            if state:
                job.state = state
            now = time.monotonic()
            if not throttled or now - self._progress_write_at.get(job.id, 0) >= 1:
                self._persist_manifest(job)
                self._progress_write_at[job.id] = now

    def _detail(self, job: Job, event: dict[str, Any]) -> None:
        phase = event["phase"]
        with self._lock:
            # Replace snapshots rather than mutating ones an API response may read.
            job.progress_details = {**job.progress_details, phase: dict(event)}
            complete = event.get("state") == "completed"
            total = event.get("total_ms") or event.get("total")
            current = event.get("processed_ms") if event.get("total_ms") else event.get("current", 0)
            ratio = min(1, max(0, current / total)) if total else 0
            start, width, state = {
                "extract": (3, 9, "preparing"), "models": (12, 22, "loading"),
                "recognize": (35, 55, "transcribing"),
            }[phase]
            progress = start + int(width * (1 if complete else ratio))
            self._update(job, progress, event["label"], state, throttled=not complete)

    def _run(self, job_id: str) -> None:
        job = self.get(job_id)
        try:
            job.started_at = utc_now_iso()
            self._update(job, 3, "正在从媒体文件提取音频", "preparing")
            extraction = StageReporter("extract", lambda event: self._detail(job, event))

            def extracted(current: int, total: int | None, done: bool) -> None:
                eta = None
                if current > 0 and total and not done:
                    eta = round((time.monotonic() - extraction.started) * max(0, total - current) / current, 1)
                extraction.emit(
                    "音频提取完成" if done else "正在从视频或音频文件提取音轨",
                    state="completed" if done else "running",
                    current=current, total=total, unit="ms", eta_s=eta,
                )

            extract_audio(job.source_path, job.audio_path, progress=extracted)
            self._update(job, 12, "音频准备完成，正在初始化识别器", "loading")

            def report(progress: int, stage: str) -> None:
                state = "loading" if progress < 35 else "transcribing"
                self._update(job, progress, stage, state, throttled=True)

            transcript = self.transcriber.transcribe(
                job.audio_path,
                language=job.language,
                identify_speakers=job.identify_speakers,
                use_itn=job.use_itn,
                speaker_count=job.speaker_count,
                batch_size_s=job.batch_size_s,
                progress=report,
                details=lambda event: self._detail(job, event),
            )
            self._update(job, 94, "正在生成字幕与结构化结果", "finalizing")
            with self._lock:
                job.transcript = transcript
                self._persist_result(job)
            job.finished_at = utc_now_iso()
            self._update(job, 100, "转写完成", "completed")
        except Exception as exc:
            with self._lock:
                job.state = "failed"
                job.error = str(exc)
                job.stage = "处理失败"
                job.updated_at = utc_now_iso()
                job.finished_at = job.updated_at
                job.progress_details = {
                    phase: {**item, "state": "failed"} if item.get("state") == "running" else item
                    for phase, item in job.progress_details.items()
                }
                self._persist_manifest(job)

    def _manifest_path(self, job: Job) -> Path:
        return job.source_path.parent / "job.json"

    def _result_path(self, job: Job) -> Path:
        return job.source_path.parent / "result.json"

    def _persist_manifest(self, job: Job) -> None:
        data = job.to_dict(include_transcript=False)
        data["source_name"] = job.source_path.name
        data["audio_name"] = job.audio_path.name
        target = self._manifest_path(job)
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(target)

    def _persist_result(self, job: Job) -> None:
        if not job.transcript:
            return
        target = self._result_path(job)
        temporary = target.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(job.transcript.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temporary.replace(target)
        text_target = target.with_suffix(".txt")
        text_temporary = text_target.with_suffix(".txt.tmp")
        text_temporary.write_text(to_txt(job.transcript), encoding="utf-8-sig")
        text_temporary.replace(text_target)

    def _load_persisted_jobs(self) -> None:
        if not self.settings.jobs_dir.exists():
            return
        for manifest_path in self.settings.jobs_dir.glob("*/job.json"):
            try:
                data = json.loads(manifest_path.read_text(encoding="utf-8"))
                job_dir = manifest_path.parent
                state = data.get("state", "failed")
                if state not in {"completed", "failed"}:
                    state = "failed"
                    data["error"] = "应用重启时此任务尚未完成，请重新上传。"
                job = Job(
                    id=data["id"],
                    filename=data.get("filename", "media"),
                    source_path=job_dir / data.get("source_name", "source"),
                    audio_path=job_dir / data.get("audio_name", "audio.wav"),
                    language=data.get("language", "auto"),
                    identify_speakers=bool(data.get("identify_speakers", True)),
                    use_itn=bool(data.get("use_itn", True)),
                    speaker_count=data.get("speaker_count"),
                    batch_size_s=data.get("batch_size_s"),
                    state=state,
                    progress=100 if state == "completed" else int(data.get("progress", 0)),
                    stage="转写完成" if state == "completed" else data.get("stage", "处理失败"),
                    error=data.get("error"),
                    started_at=data.get("started_at"),
                    finished_at=data.get("finished_at"),
                    progress_details=data.get("progress_details", {}),
                    created_at=data.get("created_at", utc_now_iso()),
                    updated_at=data.get("updated_at", utc_now_iso()),
                )
                result_path = job_dir / "result.json"
                if result_path.exists():
                    job.transcript = Transcript.from_dict(
                        json.loads(result_path.read_text(encoding="utf-8"))
                    )
                self._jobs[job.id] = job
            except (OSError, ValueError, TypeError, KeyError):
                continue
