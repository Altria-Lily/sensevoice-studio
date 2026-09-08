from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import wave
from collections import deque
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path

SUPPORTED_EXTENSIONS = {
    ".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v", ".mpeg", ".mpg",
    ".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wma",
}
VIDEO_EXTENSIONS = {".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v", ".mpeg", ".mpg"}


class MediaError(RuntimeError):
    pass


def is_supported(filename: str) -> bool:
    return Path(filename).suffix.lower() in SUPPORTED_EXTENSIONS


def is_video(filename: str) -> bool:
    return Path(filename).suffix.lower() in VIDEO_EXTENSIONS


def resolve_ffmpeg() -> str:
    configured = os.getenv("FFMPEG_BINARY", "").strip()
    if configured:
        path = Path(configured).expanduser()
        if path.is_file():
            return str(path)
        raise MediaError(f"FFMPEG_BINARY 指向的文件不存在：{path}")

    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg:
        return system_ffmpeg

    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError) as exc:
        raise MediaError(
            "未找到 FFmpeg。请安装 imageio-ffmpeg，或通过 FFMPEG_BINARY 指定 ffmpeg.exe。"
        ) from exc


def parse_media_time(value: str) -> int | None:
    match = re.fullmatch(r"(\d+):(\d{2}):(\d{2}(?:\.\d+)?)", value.strip())
    if not match:
        return None
    hours, minutes, seconds = match.groups()
    return round((int(hours) * 3600 + int(minutes) * 60 + float(seconds)) * 1000)


def extract_audio(
    source: Path, destination: Path, *,
    progress: Callable[[int, int | None, bool], None] | None = None,
) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    command = [
        resolve_ffmpeg(),
        "-hide_banner",
        "-loglevel", "info",
        "-nostdin",
        "-nostats",
        "-stats_period", "0.5",
        "-progress", "pipe:1",
        "-y",
        "-i", str(source),
        "-map", "0:a:0",
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-c:a", "pcm_s16le",
        str(destination),
    ]
    duration_ms: int | None = None
    processed_ms = 0
    errors: deque[str] = deque(maxlen=100)
    if progress:
        progress(0, None, False)
    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except OSError as exc:
        raise MediaError(f"无法启动 FFmpeg：{exc}") from exc

    def read_errors() -> None:
        nonlocal duration_ms
        for line in process.stderr:
            errors.append(line)
            match = re.search(r"Duration:\s*(\d+:\d{2}:\d{2}(?:\.\d+)?)", line)
            if match:
                duration_ms = parse_media_time(match.group(1))

    reader = threading.Thread(target=read_errors, name="ffmpeg-stderr", daemon=True)
    reader.start()
    try:
        for line in process.stdout:
            key, _, value = line.strip().partition("=")
            if key == "out_time_us":
                with suppress(ValueError):
                    processed_ms = max(processed_ms, int(value) // 1000)
            elif key == "out_time":
                processed_ms = max(processed_ms, parse_media_time(value) or 0)
            elif key == "progress" and progress:
                progress(processed_ms, duration_ms, False)
        returncode = process.wait()
        reader.join()
    except BaseException:
        process.kill()
        process.wait()
        reader.join(timeout=5)
        raise
    finally:
        process.stdout.close()
        process.stderr.close()

    if returncode != 0 or not destination.exists():
        detail = "".join(errors).strip()[-1200:] or "未知 FFmpeg 错误"
        raise MediaError(f"音频提取失败：{detail}")
    if progress:
        progress(processed_ms, duration_ms, True)


def wav_duration_ms(path: Path) -> int:
    try:
        with wave.open(str(path), "rb") as audio:
            frames = audio.getnframes()
            rate = audio.getframerate()
            return round(frames / rate * 1000) if rate else 0
    except (wave.Error, OSError) as exc:
        raise MediaError(f"无法读取转换后的 WAV：{exc}") from exc
