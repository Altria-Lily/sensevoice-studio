from app.domain import Transcript, TranscriptSegment
from app.services.exporters import format_timestamp, to_json, to_srt, to_txt, to_vtt


def sample_transcript() -> Transcript:
    return Transcript(
        text="大家好Hello there",
        duration_ms=65_250,
        segments=[
            TranscriptSegment(id=0, start_ms=610, end_ms=3_250, text="大家好", speaker="SPK0"),
            TranscriptSegment(id=1, start_ms=61_005, end_ms=65_250, text="Hello there", speaker="SPK1"),
        ],
        speaker_names={"SPK0": "主持人", "SPK1": "Guest"},
    )


def test_timestamp_formats_milliseconds_and_hours() -> None:
    assert format_timestamp(3_723_045) == "01:02:03,045"
    assert format_timestamp(-1) == "00:00:00,000"


def test_srt_has_timeline_and_display_speaker() -> None:
    output = to_srt(sample_transcript())
    assert "00:00:00,610 --> 00:00:03,250" in output
    assert "[主持人] 大家好" in output
    assert "[Guest] Hello there" in output


def test_vtt_has_voice_cues() -> None:
    output = to_vtt(sample_transcript())
    assert output.startswith("WEBVTT\n")
    assert "<v Guest>Hello there</v>" in output


def test_txt_and_json_are_unicode() -> None:
    transcript = sample_transcript()
    assert "主持人：大家好" in to_txt(transcript)
    assert '"speaker_name": "主持人"' in to_json(transcript)

