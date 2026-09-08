from app.services.media import is_supported, is_video


def test_supported_media_extensions_are_case_insensitive() -> None:
    assert is_supported("Meeting.MP4")
    assert is_supported("voice.FLAC")
    assert not is_supported("notes.pdf")


def test_video_detection() -> None:
    assert is_video("clip.mkv")
    assert not is_video("clip.wav")

