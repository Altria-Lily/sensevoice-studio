from unittest.mock import Mock

import app.services.transcriber as transcription
from app.services.transcriber import normalize_result


def test_normalizes_sensevoice_sentence_shape() -> None:
    raw = [{
        "text": "<|zh|><|NEUTRAL|><|Speech|><|withitn|>大家好",
        "sentence_info": [
            {
                "start": 610,
                "end": 3250,
                "sentence": "<|zh|><|HAPPY|><|Speech|><|withitn|>大家好",
                "spk": 2,
            }
        ],
    }]
    transcript = normalize_result(
        raw,
        duration_ms=4_000,
        language="auto",
        model_name="iic/SenseVoiceSmall",
        identify_speakers=True,
    )
    assert transcript.text == "大家好"
    assert transcript.language == "zh"
    assert len(transcript.segments) == 1
    assert transcript.segments[0].speaker == "SPK2"
    assert transcript.segments[0].emotion == "HAPPY"
    assert transcript.segments[0].event == "Speech"
    assert transcript.segments[0].start_ms == 610


def test_normalizes_speaker_prefixes() -> None:
    raw = {"sentence_info": [
        {"start": 0, "end": 1000, "text": "one", "speaker": "SPEAKER_00"},
        {"start": 1000, "end": 2000, "text": "two", "speaker": "spk-1"},
    ]}
    transcript = normalize_result(
        raw,
        duration_ms=2_000,
        language="en",
        model_name="model",
        identify_speakers=True,
    )
    assert [segment.speaker for segment in transcript.segments] == ["SPK00", "SPK1"]
    assert transcript.text == "one two"


def test_can_collapse_speakers_and_fallback_to_flat_text() -> None:
    transcript = normalize_result(
        {"text": "<|en|><|NEUTRAL|><|Speech|><|withitn|>Hello world"},
        duration_ms=1_500,
        language="auto",
        model_name="model",
        identify_speakers=False,
    )
    assert transcript.text == "Hello world"
    assert transcript.segments[0].speaker == "SPK0"
    assert transcript.segments[0].end_ms == 1_500


def test_removes_duplicate_pipeline_punctuation_and_fills_language() -> None:
    transcript = normalize_result(
        {"text": "测试完成。。", "sentence_info": [
            {"start": 100, "end": 900, "text": "测试完成。。", "spk": 0}
        ]},
        duration_ms=1_000,
        language="zh",
        model_name="model",
        identify_speakers=True,
    )
    assert transcript.text == "测试完成。"
    assert transcript.segments[0].text == "测试完成。"
    assert transcript.segments[0].language == "zh"


def test_options_reach_model_and_reset_between_jobs(api_environment, monkeypatch):
    worker = api_environment.transcriber
    fake_model = Mock()
    fake_model.generate.return_value = [{
        "sentence_info": [{"start": 0, "end": 1000, "text": "你好", "spk": 0}],
    }]
    worker._model = fake_model
    worker._device = "cpu"
    monkeypatch.setattr(transcription, "wav_duration_ms", lambda _: 1000)
    worker.transcribe(
        api_environment.settings.jobs_dir / "sample.wav",
        language="zh", identify_speakers=True, use_itn=False,
        speaker_count=2, batch_size_s=15,
    )
    options = fake_model.generate.call_args.kwargs
    assert options["use_itn"] is False
    assert options["preset_spk_num"] == 2
    assert options["return_spk_res"] is True
    assert options["batch_size_s"] == 15
    worker.transcribe(api_environment.settings.jobs_dir / "sample.wav", identify_speakers=False)
    options = fake_model.generate.call_args.kwargs
    assert options["use_itn"] is True
    assert options["preset_spk_num"] is None
    assert options["return_spk_res"] is False
    assert options["batch_size_s"] == api_environment.settings.batch_size_s
