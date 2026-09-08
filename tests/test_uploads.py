import asyncio
import json
from dataclasses import replace
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.requests import ClientDisconnect

import app.main as web_app
from app.config import Settings
from app.services.jobs import InvalidJobState, JobManager


@pytest.fixture
def pending_api(api_environment, monkeypatch):
    # Keep real queue/state/persistence behavior, but do not run speech models.
    monkeypatch.setattr(api_environment.jobs._executor, "submit", lambda *args: None)
    with TestClient(web_app.app) as client:
        yield client


def test_default_limit_is_ten_gib(monkeypatch, api_environment, pending_api):
    monkeypatch.delenv("FUNASR_MAX_UPLOAD_MB", raising=False)
    assert Settings.from_env().max_upload_bytes == 10_737_418_240
    settings = pending_api.get("/api/settings").json()
    assert settings["max_upload_bytes"] == 10_737_418_240
    assert settings["storage_dir"] == str(api_environment.settings.jobs_dir)
    assert settings["free_disk_bytes"] > 0


def test_declared_over_ten_gib_rejected_before_creating_job(pending_api, api_environment):
    response = pending_api.post(
        "/api/jobs/upload?filename=big.mp4",
        headers={"Content-Length": str(10 * 1024**3 + 1)}, content=b"x",
    )
    assert response.status_code == 413
    assert "10 GB" in response.json()["detail"]
    assert api_environment.jobs.list() == []
    assert list(api_environment.settings.jobs_dir.iterdir()) == []


@pytest.mark.parametrize("size,status", [(0, 400), (127, 202), (128, 202), (129, 413)])
@pytest.mark.parametrize("streaming", [False, True])
def test_actual_size_boundaries(size, status, streaming, monkeypatch, pending_api, api_environment):
    # Exercise exactly the same byte limit without allocating a 10 GB test file.
    monkeypatch.setattr(web_app, "settings", replace(api_environment.settings, max_upload_bytes=128))
    data = b"x" * size
    if streaming:
        # Generator => chunked body, no Content-Length. The running byte counter
        # must enforce the limit even when headers don't declare the size.
        response = pending_api.post(
            "/api/jobs/upload?filename=clip.mp4", content=iter([data[:64], data[64:]]),
        )
    else:
        response = pending_api.post("/api/jobs", files={"file": ("clip.mp4", data, "video/mp4")})
    assert response.status_code == status
    if status != 202:
        assert api_environment.jobs.list() == []
        assert list(api_environment.settings.jobs_dir.iterdir()) == []
    else:
        job = api_environment.jobs.get(response.json()["id"])
        assert job.state == "queued"
        assert job.source_path.read_bytes() == data


@pytest.mark.parametrize("query", [
    "language=invalid", "speaker_count=0", "speaker_count=21",
    "speaker_count=1.5", "batch_size_s=4", "batch_size_s=121",
    "identify_speakers=invalid", "use_itn=invalid",
])
def test_invalid_settings_never_enqueue(query, pending_api, api_environment):
    response = pending_api.post("/api/jobs/upload?filename=clip.mp4&" + query, content=b"test")
    assert response.status_code == 422
    assert api_environment.jobs.list() == []


def test_unsupported_file(pending_api, api_environment):
    assert pending_api.post("/api/jobs/upload?filename=test.exe", content=b"test").status_code == 415
    assert api_environment.jobs.list() == []


def test_truncated_request_and_invalid_length(pending_api, api_environment):
    for length in ("6", "-1", "invalid"):
        response = pending_api.post(
            "/api/jobs/upload?filename=clip.mp4", content=b"test",
            headers={"Content-Length": length},
        )
        assert response.status_code == 400
        assert api_environment.jobs.list() == []
        assert list(api_environment.settings.jobs_dir.iterdir()) == []


def test_low_disk_rejected_before_upload(monkeypatch, pending_api, api_environment):
    monkeypatch.setattr(web_app.shutil, "disk_usage", lambda _: SimpleNamespace(free=100))
    response = pending_api.post("/api/jobs/upload?filename=clip.mp4", content=b"test")
    assert response.status_code == 507
    assert api_environment.jobs.list() == []


@pytest.mark.parametrize("exception", [ClientDisconnect, asyncio.CancelledError])
def test_interrupted_stream_cleans_partial_file(exception, api_environment):
    async def chunks():
        yield b"partial file"
        raise exception()

    async def upload():
        return await web_app._receive_upload(
            chunks(), filename="interrupted.mp4", language="auto",
            identify_speakers=True, use_itn=True, speaker_count=None,
            batch_size_s=None, declared_size=None,
        )

    expected = HTTPException if exception is ClientDisconnect else asyncio.CancelledError
    with pytest.raises(expected):
        asyncio.run(upload())
    assert api_environment.jobs.list() == []
    assert list(api_environment.settings.jobs_dir.iterdir()) == []


def test_settings_persist_and_speakers_off_clears_count(pending_api, api_environment):
    created = pending_api.post(
        "/api/jobs/upload?filename=clip.mp4&language=zh&identify_speakers=false"
        "&speaker_count=3&use_itn=false&batch_size_s=15", content=b"test",
    )
    assert created.status_code == 202
    job = api_environment.jobs.get(created.json()["id"])
    assert job.identify_speakers is False
    assert job.speaker_count is None
    assert job.use_itn is False
    with pytest.raises(InvalidJobState):
        api_environment.jobs.submit(job.id)
    with pytest.raises(InvalidJobState):
        api_environment.jobs.discard_unsubmitted(job.id)
    assert job.source_path.exists()
    stored = json.loads((job.source_path.parent / "job.json").read_text(encoding="utf-8"))
    assert stored["batch_size_s"] == 15
    restored = JobManager(api_environment.settings, api_environment.transcriber)
    try:
        recovered = restored.get(job.id)
        assert recovered.language == "zh"
        assert recovered.batch_size_s == 15
        assert recovered.use_itn is False
        assert recovered.speaker_count is None
    finally:
        restored.shutdown()
