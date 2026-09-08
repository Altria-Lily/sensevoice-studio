from __future__ import annotations

import re
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from app.config import Settings
from app.domain import Transcript, TranscriptSegment
from app.services.media import wav_duration_ms
from app.services.progress import (
    DetailsCallback,
    ModelLoadProgress,
    RecognitionProgress,
    observed_model_class,
)

ProgressCallback = Callable[[int, str], None]
TAG_PATTERN = re.compile(r"<\|([^|>]+)\|>")
KNOWN_LANGUAGES = {"zh", "yue", "en", "ja", "ko", "auto"}
KNOWN_EMOTIONS = {
    "HAPPY", "SAD", "ANGRY", "NEUTRAL", "FEARFUL", "DISGUSTED", "SURPRISED",
}
KNOWN_EVENTS = {
    "Speech", "BGM", "Applause", "Laughter", "Cry", "Cough", "Sneeze", "Breath",
}
DUPLICATE_PUNCTUATION = re.compile(r"([。！？!?，,；;：:])\1+")


class TranscriptionError(RuntimeError):
    pass


def _clean_rich_text(value: str) -> str:
    try:
        from funasr.utils.postprocess_utils import rich_transcription_postprocess

        cleaned = rich_transcription_postprocess(value).strip()
    except (ImportError, AttributeError, TypeError):
        cleaned = TAG_PATTERN.sub("", value or "").strip()
    return DUPLICATE_PUNCTUATION.sub(r"\1", cleaned)


def _rich_metadata(value: str) -> tuple[str | None, str | None, str | None]:
    tags = TAG_PATTERN.findall(value or "")
    language = next((tag for tag in tags if tag.lower() in KNOWN_LANGUAGES), None)
    emotion = next((tag for tag in tags if tag.upper() in KNOWN_EMOTIONS), None)
    event = next((tag for tag in tags if tag in KNOWN_EVENTS), None)
    return language, emotion, event


def _number(value: Any, default: int = 0) -> int:
    try:
        return max(0, round(float(value)))
    except (TypeError, ValueError):
        return default


def _speaker_label(value: Any) -> str:
    if value is None or value == "":
        return "SPK0"
    text = str(value).strip()
    upper = text.upper()
    if upper.startswith("SPEAKER"):
        return "SPK" + upper[len("SPEAKER"):].lstrip(" _-")
    if upper.startswith("SPK"):
        return "SPK" + upper[3:].lstrip(" _-")
    return f"SPK{text}"


def _join_text(segments: list[TranscriptSegment], fallback: str) -> str:
    cleaned_fallback = _clean_rich_text(fallback)
    if cleaned_fallback:
        return cleaned_fallback
    pieces: list[str] = []
    for segment in segments:
        if pieces and pieces[-1] and segment.text:
            previous = pieces[-1][-1]
            current = segment.text[0]
            if previous.isascii() and previous.isalnum() and current.isascii() and current.isalnum():
                pieces.append(" ")
        pieces.append(segment.text)
    return "".join(pieces)


def normalize_result(
    raw: Any,
    *,
    duration_ms: int,
    language: str,
    model_name: str,
    identify_speakers: bool,
) -> Transcript:
    """Normalize the slightly different result shapes emitted by FunASR releases."""
    if isinstance(raw, list):
        item = raw[0] if raw else {}
    elif isinstance(raw, dict):
        item = raw
    else:
        item = {}

    raw_full_text = str(item.get("text", "") or "")
    sentence_info = item.get("sentence_info") or item.get("sentences") or []
    segments: list[TranscriptSegment] = []

    for sentence in sentence_info:
        if not isinstance(sentence, dict):
            continue
        raw_text = str(sentence.get("text", sentence.get("sentence", "")) or "")
        text = _clean_rich_text(raw_text)
        if not text:
            continue
        start_ms = _number(sentence.get("start", sentence.get("start_ms", 0)))
        end_ms = _number(sentence.get("end", sentence.get("end_ms", start_ms)), start_ms)
        if end_ms < start_ms:
            end_ms = start_ms
        lang, emotion, event = _rich_metadata(raw_text)
        speaker = _speaker_label(sentence.get("spk", sentence.get("speaker")))
        if not identify_speakers:
            speaker = "SPK0"
        segments.append(
            TranscriptSegment(
                id=len(segments),
                start_ms=start_ms,
                end_ms=end_ms,
                text=text,
                speaker=speaker,
                language=lang,
                emotion=emotion,
                event=event,
                raw_text=raw_text if raw_text != text else None,
            )
        )

    # A short clip or an older FunASR release can return only a flat transcript.
    if not segments:
        text = _clean_rich_text(raw_full_text)
        if text:
            lang, emotion, event = _rich_metadata(raw_full_text)
            segments.append(
                TranscriptSegment(
                    id=0,
                    start_ms=0,
                    end_ms=duration_ms,
                    text=text,
                    speaker="SPK0",
                    language=lang,
                    emotion=emotion,
                    event=event,
                    raw_text=raw_full_text if raw_full_text != text else None,
                )
            )

    full_text = _join_text(segments, raw_full_text)
    outer_language, _, _ = _rich_metadata(raw_full_text)
    detected_language = (
        next((s.language for s in segments if s.language), None)
        or outer_language
        or language
    )
    if detected_language != "auto":
        for segment in segments:
            segment.language = segment.language or detected_language
    return Transcript(
        text=full_text,
        duration_ms=duration_ms,
        segments=segments,
        language=detected_language,
        model=model_name,
    )


class SenseVoiceTranscriber:
    """Thread-safe, lazily loaded SenseVoice + VAD + punctuation + CAM++ pipeline."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._model: Any = None
        self._device: str | None = None
        self._load_lock = threading.Lock()
        self._inference_lock = threading.Lock()

    @property
    def loaded(self) -> bool:
        return self._model is not None

    @property
    def device(self) -> str:
        return self._device or self._select_device()

    def _select_device(self) -> str:
        configured = self.settings.device.lower()
        if configured != "auto":
            return self.settings.device
        try:
            import torch

            return "cuda:0" if torch.cuda.is_available() else "cpu"
        except ImportError:
            return "cpu"

    def _load(self, progress: ProgressCallback, details: DetailsCallback | None = None) -> Any:
        model_progress = ModelLoadProgress(details)
        if self._model is not None:
            model_progress.ready(cached=True)
            return self._model
        with self._load_lock:
            if self._model is not None:
                model_progress.ready(cached=True)
                return self._model
            progress(18, "首次运行：正在下载并加载语音模型")
            model_progress.emit("正在初始化模型运行环境")
            try:
                from funasr import AutoModel
            except ImportError as exc:
                raise TranscriptionError(
                    "未安装 FunASR。请先运行 install.ps1，或执行 pip install -r requirements.txt。"
                ) from exc

            self._device = self._select_device()
            try:
                self._model = observed_model_class(AutoModel)(
                    load_progress=model_progress,
                    model=self.settings.model,
                    vad_model=self.settings.vad_model,
                    vad_kwargs={"max_single_segment_time": self.settings.max_segment_ms},
                    punc_model=self.settings.punc_model,
                    spk_model=self.settings.spk_model,
                    device=self._device,
                    trust_remote_code=True,
                    disable_update=True,
                )
            except Exception as exc:  # third-party model loaders expose many exception types
                raise TranscriptionError(f"模型加载失败：{exc}") from exc
            model_progress.ready()
            return self._model

    def transcribe(
        self,
        audio_path: Path,
        *,
        language: str = "auto",
        identify_speakers: bool = True,
        use_itn: bool = True,
        speaker_count: int | None = None,
        batch_size_s: int | None = None,
        progress: ProgressCallback | None = None,
        details: DetailsCallback | None = None,
    ) -> Transcript:
        callback = progress or (lambda _percent, _stage: None)
        duration_ms = wav_duration_ms(audio_path)
        model = self._load(callback, details)
        callback(35, f"正在等待识别器（{self.device}）")
        try:
            with self._inference_lock:
                tracker = RecognitionProgress(duration_ms, details)
                model._studio_progress = tracker
                tracker.emit("正在检测语音区间", substage="vad")
                try:
                    raw = model.generate(
                        input=str(audio_path), cache={}, language=language, use_itn=use_itn,
                        batch_size_s=batch_size_s or self.settings.batch_size_s,
                        preset_spk_num=speaker_count if identify_speakers else None,
                        return_spk_res=identify_speakers, merge_vad=True,
                        merge_length_s=self.settings.merge_length_s, sentence_timestamp=True,
                    )
                finally:
                    model._studio_progress = None
        except Exception as exc:
            message = str(exc)
            if "out of memory" in message.lower():
                message += "。GPU 显存不足，请在更多设置中选择较小的识别批次，或在 .env 中设置 FUNASR_DEVICE=cpu 后重试。"
            raise TranscriptionError(f"语音识别失败：{message}") from exc

        callback(90, "正在整理时间轴与说话人")
        transcript = normalize_result(
            raw,
            duration_ms=duration_ms,
            language=language,
            model_name=self.settings.model,
            identify_speakers=identify_speakers,
        )
        if not transcript.segments:
            raise TranscriptionError("没有检测到可识别的语音。请确认视频包含清晰音轨。")
        tracker.emit("语音、时间轴与说话人处理完成", substage="done", state="completed")
        return transcript
