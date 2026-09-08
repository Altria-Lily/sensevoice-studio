from dataclasses import replace
from types import SimpleNamespace

import pytest

import app.main as web_app
from app.services.jobs import JobManager
from app.services.transcriber import SenseVoiceTranscriber


@pytest.fixture
def api_environment(tmp_path, monkeypatch):
    """Never read, modify, or delete real user jobs during API tests."""
    config = replace(
        web_app.settings, data_dir=tmp_path, jobs_dir=tmp_path / "jobs",
        device="cpu", max_upload_bytes=10 * 1024**3,
    )
    config.jobs_dir.mkdir()
    worker = SenseVoiceTranscriber(config)
    manager = JobManager(config, worker)
    monkeypatch.setattr(web_app, "settings", config)
    monkeypatch.setattr(web_app, "jobs", manager)
    monkeypatch.setattr(web_app, "transcriber", worker)
    yield SimpleNamespace(settings=config, jobs=manager, transcriber=worker)
    manager.shutdown()
