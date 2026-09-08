from __future__ import annotations

import html
import json
from collections.abc import Callable

from app.domain import Transcript, TranscriptSegment


def format_timestamp(milliseconds: int, *, separator: str = ",", always_hours: bool = True) -> str:
    milliseconds = max(0, int(milliseconds))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, millis = divmod(remainder, 1_000)
    if always_hours:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}{separator}{millis:03d}"
    total_minutes = hours * 60 + minutes
    return f"{total_minutes:02d}:{seconds:02d}{separator}{millis:03d}"


def _display_speaker(transcript: Transcript, segment: TranscriptSegment) -> str:
    return transcript.speaker_names.get(segment.speaker, segment.speaker)


def to_srt(transcript: Transcript) -> str:
    blocks = []
    for index, segment in enumerate(transcript.segments, 1):
        start = format_timestamp(segment.start_ms)
        end = format_timestamp(max(segment.end_ms, segment.start_ms + 1))
        speaker = _display_speaker(transcript, segment)
        blocks.append(f"{index}\n{start} --> {end}\n[{speaker}] {segment.text}")
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def to_vtt(transcript: Transcript) -> str:
    blocks = ["WEBVTT"]
    for segment in transcript.segments:
        start = format_timestamp(segment.start_ms, separator=".")
        end = format_timestamp(max(segment.end_ms, segment.start_ms + 1), separator=".")
        speaker = html.escape(_display_speaker(transcript, segment), quote=True)
        text = html.escape(segment.text, quote=False)
        blocks.append(f"{start} --> {end}\n<v {speaker}>{text}</v>")
    return "\n\n".join(blocks) + "\n"


def to_txt(transcript: Transcript) -> str:
    lines = []
    for segment in transcript.segments:
        stamp = format_timestamp(segment.start_ms, separator=".")[:-4]
        speaker = _display_speaker(transcript, segment)
        lines.append(f"[{stamp}] {speaker}：{segment.text}")
    return "\n".join(lines) + ("\n" if lines else "")


def to_json(transcript: Transcript) -> str:
    return json.dumps(transcript.to_dict(), ensure_ascii=False, indent=2) + "\n"


EXPORTERS: dict[str, tuple[str, str, Callable[[Transcript], str]]] = {
    "txt": ("text/plain; charset=utf-8", ".txt", to_txt),
    "srt": ("application/x-subrip; charset=utf-8", ".srt", to_srt),
    "vtt": ("text/vtt; charset=utf-8", ".vtt", to_vtt),
    "json": ("application/json; charset=utf-8", ".json", to_json),
}
