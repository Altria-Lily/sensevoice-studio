from __future__ import annotations

import argparse
from pathlib import Path

from app.config import settings
from app.services.exporters import EXPORTERS
from app.services.media import extract_audio, is_supported
from app.services.transcriber import SenseVoiceTranscriber


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="使用 FunASR + SenseVoice 将视频/音频转为带时间轴和说话人的字幕。"
    )
    parser.add_argument("input", type=Path, help="视频或音频文件")
    parser.add_argument("-o", "--output-dir", type=Path, default=Path("output"))
    parser.add_argument("--language", choices=["auto", "zh", "yue", "en", "ja", "ko"], default="auto")
    parser.add_argument("--no-speakers", action="store_true", help="不在结果中区分说话人")
    parser.add_argument(
        "--formats",
        nargs="+",
        choices=sorted(EXPORTERS),
        default=["txt", "srt", "vtt", "json"],
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    source = args.input.resolve()
    if not source.is_file():
        raise SystemExit(f"输入文件不存在：{source}")
    if not is_supported(source.name):
        raise SystemExit(f"不支持的媒体格式：{source.suffix}")

    settings.prepare()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    audio_path = output_dir / f".{source.stem}.16k.wav"
    print("[1/3] 提取 16 kHz 单声道音频…")
    extract_audio(source, audio_path)

    transcriber = SenseVoiceTranscriber(settings)

    def progress(percent: int, stage: str) -> None:
        print(f"[{percent:>3}%] {stage}")

    transcript = transcriber.transcribe(
        audio_path,
        language=args.language,
        identify_speakers=not args.no_speakers,
        progress=progress,
    )
    print("[3/3] 写入结果…")
    for format_name in args.formats:
        _, suffix, exporter = EXPORTERS[format_name]
        destination = output_dir / f"{source.stem}{suffix}"
        destination.write_text(exporter(transcript), encoding="utf-8-sig" if format_name == "txt" else "utf-8")
        print(f"  {destination}")
    audio_path.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

