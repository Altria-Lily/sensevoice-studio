import json
import wave
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

import app.main as web_app
import app.services.transcriber as transcription
from app.services.media import MediaError, extract_audio, parse_media_time
from app.services.progress import ModelLoadProgress, RecognitionProgress, StageReporter, observed_model_class


@pytest.mark.parametrize("value,expected", [
    ("00:00:01.500000", 1500), ("12:03:04.56", 43_384_560),
    ("00:00:00.000", 0), ("N/A", None), ("invalid", None),
])
def test_media_time(value, expected):
    assert parse_media_time(value) == expected


def test_ffmpeg_reports_real_audio_time(tmp_path):
    source = tmp_path / "source.wav"
    target = tmp_path / "audio.wav"
    with wave.open(str(source), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\0\0" * 32000)
    updates = []
    extract_audio(source, target, progress=lambda current, total, done: updates.append((current, total, done)))
    assert updates[0] == (0, None, False)
    assert updates[-1][2] is True
    assert 1950 <= updates[-1][0] <= 2050
    assert updates[-1][1] == 2000
    assert all(a[0] <= b[0] for a, b in zip(updates, updates[1:], strict=False))
    with pytest.raises(MediaError):
        extract_audio(tmp_path / "missing.mp4", tmp_path / "missing.wav")


class FakeAutoModel:
    @staticmethod
    def build_model(**kwargs):
        return object(), kwargs

    def __init__(self, **kwargs):
        for name in ("model", "vad_model", "punc_model", "spk_model"):
            model, _ = self.build_model(model=name)
            setattr(self, name, model)
        self.vad_result = [{"value": [[0, 500], [500, 1000], [1000, 3000], [3000, 5000]]}]

    def inference(self, input, input_len=None, model=None, kwargs=None, key=None, progress_callback=None, **cfg):
        size = len(input) if isinstance(input, list) else 1
        for index in range(1, size + 1):
            if progress_callback:
                progress_callback(index, size)
        return self.vad_result if model is self.vad_model else [{"text": "test"}] * size


def test_model_loading_is_per_component():
    updates = []
    loading = ModelLoadProgress(updates.append)
    model = observed_model_class(FakeAutoModel)(load_progress=loading)
    loading.ready()
    assert model._studio_load_progress is None
    assert [event["current"] for event in updates if event["label"].endswith("已就绪")] == [1, 2, 3, 4, 4]
    assert updates[-1]["state"] == "completed"
    assert all(item["state"] == "completed" for item in updates[-1]["models"])
    # Previously returned snapshots must not mutate as later models finish.
    assert updates[0]["models"][0]["state"] == "running"
    assert updates[0]["models"][1]["state"] == "waiting"


def test_model_failure_is_not_marked_ready():
    updates = []
    loading = ModelLoadProgress(updates.append)
    with pytest.raises(RuntimeError):
        loading.build(Mock(side_effect=RuntimeError("test load failure")), model="test")
    assert updates[-1]["state"] == "failed"
    assert updates[-1]["current"] == 0
    assert updates[-1]["models"][0]["state"] == "failed"


def test_counts_merged_asr_segments_only_and_ignores_speaker_callbacks():
    model = observed_model_class(FakeAutoModel)(load_progress=ModelLoadProgress(None))
    updates = []
    tracker = RecognitionProgress(5000, updates.append)
    model._studio_progress = tracker
    vad = model.inference("sample.wav", model=model.vad_model)
    # Match FunASR: merging replaces the VAD result's values before the ASR call.
    vad[0]["value"] = [[0, 1000], [1000, 3000], [3000, 5000]]
    model.inference([b"\0" * 16000, b"\0" * 32000], model=model.model)
    assert tracker.total == 3
    assert tracker.total_ms == 5000
    assert tracker.current == 2
    assert tracker.processed_ms == 3000
    model.inference([b"\0"] * 25, model=model.spk_model)
    assert tracker.current == 2
    assert tracker.processed_ms == 3000
    model.inference([b"\0" * 32000], model=model.model)
    assert tracker.current == 3
    assert tracker.processed_ms == 5000
    model.inference("text", model=model.punc_model)
    assert updates[-1]["substage"] == "finalizing"
    assert updates[-1]["state"] == "running"  # clustering is not completed yet
    tracker.emit("done", state="completed", substage="done")
    counts = [event["current"] for event in updates]
    assert counts == sorted(counts)
    assert updates[-1]["total"] == 3
    assert updates[-1]["state"] == "completed"


def test_missing_totals_are_indeterminate():
    updates = []
    tracker = RecognitionProgress(1000, updates.append)
    tracker.emit("Detecting speech", substage="vad")
    assert updates[-1]["total"] is None
    assert updates[-1]["eta_s"] is None


def test_tracker_is_detached_if_inference_fails(api_environment, monkeypatch):
    worker = api_environment.transcriber
    fake = Mock()
    fake.generate.side_effect = RuntimeError("inference error")
    worker._model = fake
    worker._device = "cpu"
    monkeypatch.setattr(transcription, "wav_duration_ms", lambda _: 5000)
    with pytest.raises(transcription.TranscriptionError):
        worker.transcribe(api_environment.settings.jobs_dir / "file.wav", details=lambda _: None)
    assert fake._studio_progress is None


def test_progress_snapshots_are_persisted_and_summary_does_not_include_text(api_environment):
    manager = api_environment.jobs
    job = manager.create("test.wav", "zh", True)
    report = StageReporter("extract", lambda event: manager._detail(job, event))
    report.emit("extracting", current=4000, total=10000, unit="ms")
    manager._detail(job, {
        "phase": "recognize", "state": "completed", "label": "done",
        "current": 10, "total": 10, "processed_ms": 10000, "total_ms": 10000,
    })
    saved = json.loads((job.source_path.parent / "job.json").read_text(encoding="utf-8"))
    assert saved["progress_details"]["recognize"]["current"] == 10
    with TestClient(web_app.app) as client:
        result = client.get(f"/api/jobs/{job.id}?include_transcript=false").json()
        assert "transcript" not in result
        assert result["progress_details"]["extract"]["current"] == 4000
