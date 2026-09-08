from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class TranscriptSegment:
    id: int
    start_ms: int
    end_ms: int
    text: str
    speaker: str = "SPK0"
    language: str | None = None
    emotion: str | None = None
    event: str | None = None
    raw_text: str | None = None

    def to_dict(self, speaker_names: dict[str, str] | None = None) -> dict[str, Any]:
        result = {
            "id": self.id, "start_ms": self.start_ms, "end_ms": self.end_ms,
            "text": self.text, "speaker": self.speaker, "language": self.language,
            "emotion": self.emotion, "event": self.event, "raw_text": self.raw_text,
        }
        result["start"] = round(self.start_ms / 1000, 3)
        result["end"] = round(self.end_ms / 1000, 3)
        result["speaker_name"] = (speaker_names or {}).get(self.speaker, self.speaker)
        return result


@dataclass
class Transcript:
    text: str
    duration_ms: int
    segments: list[TranscriptSegment]
    language: str = "auto"
    speaker_names: dict[str, str] = field(default_factory=dict)
    model: str = "iic/SenseVoiceSmall"
    created_at: str = field(default_factory=utc_now_iso)

    def __post_init__(self) -> None:
        for speaker in sorted({segment.speaker for segment in self.segments}):
            self.speaker_names.setdefault(speaker, speaker)

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "duration_ms": self.duration_ms,
            "duration": round(self.duration_ms / 1000, 3),
            "language": self.language,
            "speaker_names": self.speaker_names,
            "model": self.model,
            "created_at": self.created_at,
            "segments": [segment.to_dict(self.speaker_names) for segment in self.segments],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Transcript:
        segments = []
        for item in data.get("segments", []):
            values = dict(item)
            values.pop("start", None)
            values.pop("end", None)
            values.pop("speaker_name", None)
            segments.append(TranscriptSegment(**values))
        return cls(
            text=data.get("text", ""),
            duration_ms=int(data.get("duration_ms", 0)),
            segments=segments,
            language=data.get("language", "auto"),
            speaker_names=dict(data.get("speaker_names", {})),
            model=data.get("model", "iic/SenseVoiceSmall"),
            created_at=data.get("created_at", utc_now_iso()),
        )


@dataclass
class Job:
    id: str
    filename: str
    source_path: Path
    audio_path: Path
    language: str = "auto"
    identify_speakers: bool = True
    use_itn: bool = True
    speaker_count: int | None = None
    batch_size_s: int | None = None
    state: str = "queued"
    progress: int = 0
    stage: str = "等待处理"
    error: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    progress_details: dict[str, dict[str, Any]] = field(default_factory=dict)
    created_at: str = field(default_factory=utc_now_iso)
    updated_at: str = field(default_factory=utc_now_iso)
    transcript: Transcript | None = None

    def to_dict(self, include_transcript: bool = False) -> dict[str, Any]:
        result = {
            "id": self.id,
            "filename": self.filename,
            "language": self.language,
            "identify_speakers": self.identify_speakers,
            "use_itn": self.use_itn,
            "speaker_count": self.speaker_count,
            "batch_size_s": self.batch_size_s,
            "state": self.state,
            "progress": self.progress,
            "stage": self.stage,
            "error": self.error,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "progress_details": self.progress_details,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "has_result": self.transcript is not None,
        }
        if include_transcript and self.transcript:
            result["transcript"] = self.transcript.to_dict()
            result["result_files"] = {
                suffix: str(self.source_path.parent / f"result.{suffix}")
                for suffix in ("json", "txt")
                if (self.source_path.parent / f"result.{suffix}").exists()
            }
        return result
