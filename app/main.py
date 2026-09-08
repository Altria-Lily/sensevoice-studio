from __future__ import annotations

import errno
import importlib.metadata
import mimetypes
import re
import shutil
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated
from urllib.parse import quote

import anyio
from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.requests import ClientDisconnect

from app import __version__
from app.config import settings
from app.services.exporters import EXPORTERS
from app.services.jobs import InvalidJobState, JobManager, JobNotFound
from app.services.media import MediaError, is_supported, is_video, resolve_ffmpeg
from app.services.transcriber import SenseVoiceTranscriber

settings.prepare()
transcriber = SenseVoiceTranscriber(settings)
jobs = JobManager(settings, transcriber)
STATIC_DIR = settings.project_root / "app" / "static"
SAFE_FILENAME = re.compile(r"[^\w\-. ()\[\]\u4e00-\u9fff]+", re.UNICODE)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    jobs.shutdown()


app = FastAPI(
    title="SenseVoice Studio",
    description="Local video transcription with timestamps and speaker diarization.",
    version=__version__,
    lifespan=lifespan,
)


class SegmentPatch(BaseModel):
    id: int
    text: str | None = Field(default=None, max_length=20_000)
    speaker: str | None = Field(default=None, max_length=80)


class TranscriptPatch(BaseModel):
    speaker_names: dict[str, str] | None = None
    segments: list[SegmentPatch] | None = None


def _get_job(job_id: str):
    try:
        return jobs.get(job_id)
    except JobNotFound as exc:
        raise HTTPException(status_code=404, detail="任务不存在") from exc


def _clean_filename(filename: str | None) -> str:
    name = Path(filename or "media").name
    cleaned = SAFE_FILENAME.sub("_", name).strip(" ._")
    return cleaned[:180] or "media"


def _download_headers(filename: str) -> dict[str, str]:
    ascii_name = filename.encode("ascii", "ignore").decode() or "transcript"
    return {
        "Content-Disposition": (
            f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(filename)}'
        )
    }


@app.get("/api/health")
def health() -> dict:
    ffmpeg_ready = True
    ffmpeg_error = None
    try:
        ffmpeg_path = resolve_ffmpeg()
    except MediaError as exc:
        ffmpeg_ready = False
        ffmpeg_path = None
        ffmpeg_error = str(exc)
    try:
        funasr_version = importlib.metadata.version("funasr")
    except importlib.metadata.PackageNotFoundError:
        funasr_version = None
    return {
        "status": "ok" if ffmpeg_ready and funasr_version else "setup_required",
        "version": __version__,
        "ffmpeg": {"ready": ffmpeg_ready, "path": ffmpeg_path, "error": ffmpeg_error},
        "funasr": {"ready": funasr_version is not None, "version": funasr_version},
        "model": {
            "loaded": transcriber.loaded,
            "name": settings.model,
            "device": transcriber.device,
        },
    }


@app.get("/api/jobs")
def list_jobs(limit: int = 20) -> dict:
    limit = max(1, min(limit, 100))
    return {"jobs": [job.to_dict() for job in jobs.list(limit)]}


@app.get("/api/settings")
def get_settings() -> dict:
    return {
        "max_upload_bytes": settings.max_upload_bytes,
        "features": {"detailed_progress": True, "paged_reader": True},
        "storage_dir": str(settings.jobs_dir),
        "free_disk_bytes": shutil.disk_usage(settings.jobs_dir).free,
        "defaults": {
            "language": "auto", "identify_speakers": True, "use_itn": True,
            "speaker_count": None, "batch_size_s": settings.batch_size_s,
        },
    }


def _check_upload(filename: str, language: str, size: int | None) -> None:
    if not is_supported(filename):
        raise HTTPException(status_code=415, detail="不支持此媒体格式，请选择视频或音频文件")
    if language not in {"auto", "zh", "yue", "en", "ja", "ko"}:
        raise HTTPException(status_code=422, detail="不支持的语言选项")
    if size is not None:
        if size < 0:
            raise HTTPException(status_code=400, detail="文件大小无效")
        if size > settings.max_upload_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"文件超过 {settings.max_upload_bytes / 1024**3:g} GB 限制",
            )
        if size + 256 * 1024**2 > shutil.disk_usage(settings.jobs_dir).free:
            raise HTTPException(status_code=507, detail="项目磁盘剩余空间不足，请清理空间后重试")


async def _receive_upload(
    chunks: AsyncIterator[bytes], *, filename: str, language: str,
    identify_speakers: bool, use_itn: bool, speaker_count: int | None,
    batch_size_s: int | None, declared_size: int | None,
) -> dict:
    _check_upload(filename, language, declared_size)
    job = jobs.create(
        filename, language, identify_speakers, use_itn=use_itn,
        speaker_count=speaker_count, batch_size_s=batch_size_s,
    )
    received = 0
    submitted = False
    try:
        # Stream directly to the project drive, without a second multipart spool
        # or loading a multi-gigabyte file into memory. File I/O uses a worker thread.
        async with await anyio.open_file(job.source_path, "wb") as target:
            async for chunk in chunks:
                received += len(chunk)
                if received > settings.max_upload_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"文件超过 {settings.max_upload_bytes / 1024**3:g} GB 限制",
                    )
                await target.write(chunk)
        if received == 0:
            raise HTTPException(status_code=400, detail="上传文件为空")
        if declared_size is not None and received != declared_size:
            raise HTTPException(status_code=400, detail="文件未传输完整，请重新上传")
        jobs.submit(job.id)
        submitted = True
        return job.to_dict()
    except ClientDisconnect as exc:
        raise HTTPException(status_code=400, detail="上传已中断") from exc
    except OSError as exc:
        status = 507 if exc.errno == errno.ENOSPC else 500
        raise HTTPException(status_code=status, detail=f"保存上传文件失败：{exc}") from exc
    finally:
        if not submitted:
            jobs.discard_unsubmitted(job.id)


@app.post("/api/jobs/upload", status_code=202)
async def upload_job(
    request: Request,
    filename: Annotated[str, Query(min_length=1, max_length=512)],
    language: str = "auto",
    identify_speakers: bool = True,
    use_itn: bool = True,
    speaker_count: Annotated[int | None, Query(ge=1, le=20)] = None,
    batch_size_s: Annotated[int | None, Query(ge=5, le=120)] = None,
) -> dict:
    """Raw file body upload, used by the browser for large files and byte progress."""
    length = request.headers.get("content-length")
    try:
        size = int(length) if length is not None else None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="文件大小无效") from exc
    return await _receive_upload(
        request.stream(), filename=_clean_filename(filename), language=language,
        identify_speakers=identify_speakers, use_itn=use_itn,
        speaker_count=speaker_count, batch_size_s=batch_size_s, declared_size=size,
    )


@app.post("/api/jobs", status_code=202)
async def create_job(
    file: Annotated[UploadFile, File()],
    language: Annotated[str, Form()] = "auto",
    identify_speakers: Annotated[bool, Form()] = True,
    use_itn: Annotated[bool, Form()] = True,
    speaker_count: Annotated[int | None, Form(ge=1, le=20)] = None,
    batch_size_s: Annotated[int | None, Form(ge=5, le=120)] = None,
) -> dict:
    async def chunks() -> AsyncIterator[bytes]:
        while chunk := await file.read(1024 * 1024):
            yield chunk

    try:
        return await _receive_upload(
            chunks(), filename=_clean_filename(file.filename), language=language,
            identify_speakers=identify_speakers, use_itn=use_itn,
            speaker_count=speaker_count, batch_size_s=batch_size_s,
            declared_size=file.size,
        )
    finally:
        await file.close()


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str, include_transcript: bool = True) -> dict:
    return _get_job(job_id).to_dict(include_transcript=include_transcript)


@app.patch("/api/jobs/{job_id}/result")
def patch_result(job_id: str, patch: TranscriptPatch) -> dict:
    try:
        transcript = jobs.patch_transcript(
            job_id,
            speaker_names=patch.speaker_names,
            segments=[item.model_dump(exclude_none=True) for item in patch.segments]
            if patch.segments is not None
            else None,
        )
    except JobNotFound as exc:
        raise HTTPException(status_code=404, detail="任务不存在") from exc
    except InvalidJobState as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return transcript.to_dict()


@app.get("/api/jobs/{job_id}/export/{format_name}")
def export_result(job_id: str, format_name: str) -> Response:
    job = _get_job(job_id)
    if not job.transcript:
        raise HTTPException(status_code=409, detail="任务尚未生成转写结果")
    if format_name not in EXPORTERS:
        raise HTTPException(status_code=404, detail="不支持的导出格式")
    media_type, suffix, exporter = EXPORTERS[format_name]
    stem = Path(job.filename).stem[:100] or "transcript"
    content = exporter(job.transcript)
    return Response(
        content=content.encode("utf-8-sig") if format_name == "txt" else content.encode("utf-8"),
        media_type=media_type,
        headers=_download_headers(f"{stem}{suffix}"),
    )


@app.get("/api/jobs/{job_id}/media")
def get_media(job_id: str) -> FileResponse:
    job = _get_job(job_id)
    if not job.source_path.exists():
        raise HTTPException(status_code=404, detail="原始媒体文件不存在")
    media_type = mimetypes.guess_type(job.filename)[0] or "application/octet-stream"
    return FileResponse(job.source_path, media_type=media_type)


@app.get("/api/jobs/{job_id}/audio")
def get_audio(job_id: str) -> FileResponse:
    job = _get_job(job_id)
    if not job.audio_path.exists():
        raise HTTPException(status_code=409, detail="音频尚未准备完成")
    return FileResponse(job.audio_path, media_type="audio/wav")


@app.delete("/api/jobs/{job_id}", status_code=204)
def delete_job(job_id: str) -> Response:
    try:
        jobs.delete(job_id)
    except JobNotFound as exc:
        raise HTTPException(status_code=404, detail="任务不存在") from exc
    except InvalidJobState as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return Response(status_code=204)


@app.get("/api/jobs/{job_id}/media-kind")
def media_kind(job_id: str) -> JSONResponse:
    job = _get_job(job_id)
    return JSONResponse({"kind": "video" if is_video(job.filename) else "audio"})


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
