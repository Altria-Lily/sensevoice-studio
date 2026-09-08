import io
import time
import wave

import pytest
from fastapi.testclient import TestClient

import app.main as web_app
from app.domain import Transcript, TranscriptSegment


def _silent_wav() -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16_000)
        audio.writeframes(b"\x00\x00" * 16_000)
    return buffer.getvalue()


@pytest.mark.parametrize("streaming", [False, True])
def test_full_api_job_flow_without_loading_models(monkeypatch, api_environment, streaming) -> None:
    def fake_transcribe(
        audio_path, *, language, identify_speakers, use_itn, speaker_count,
        batch_size_s, progress, details,
    ):
        assert audio_path.exists()
        assert identify_speakers is True
        assert use_itn is False
        assert speaker_count == 2
        assert batch_size_s == 15
        progress(35, "测试识别")
        progress(90, "测试整理")
        return Transcript(
            text="你好，欢迎使用。",
            duration_ms=1_000,
            language=language,
            segments=[
                TranscriptSegment(
                    id=0,
                    start_ms=0,
                    end_ms=1_000,
                    text="你好，欢迎使用。",
                    speaker="SPK0" if identify_speakers else "SPK0",
                )
            ],
        )

    monkeypatch.setattr(web_app.transcriber, "transcribe", fake_transcribe)

    with TestClient(web_app.app) as client:
        assert client.get("/").status_code == 200
        health = client.get("/api/health")
        assert health.status_code == 200
        assert health.json()["ffmpeg"]["ready"] is True
        assert health.json()["funasr"]["ready"] is True

        options = {
            "language": "zh", "identify_speakers": "true", "use_itn": "false",
            "speaker_count": 2, "batch_size_s": 15,
        }
        if streaming:
            created = client.post(
                "/api/jobs/upload", params={"filename": "api-test.wav", **options},
                content=_silent_wav(), headers={"Content-Type": "application/octet-stream"},
            )
        else:
            created = client.post(
                "/api/jobs", files={"file": ("api-test.wav", _silent_wav(), "audio/wav")},
                data=options,
            )
        assert created.status_code == 202
        job_id = created.json()["id"]

        deadline = time.monotonic() + 15
        result = None
        while time.monotonic() < deadline:
            response = client.get(f"/api/jobs/{job_id}")
            assert response.status_code == 200
            result = response.json()
            if result["state"] in {"completed", "failed"}:
                break
            time.sleep(0.05)

        assert result is not None
        assert result["state"] == "completed", result.get("error")
        assert result["transcript"]["segments"][0]["start_ms"] == 0
        assert result["speaker_count"] == 2
        assert result["use_itn"] is False
        assert result["batch_size_s"] == 15
        assert result["result_files"]["txt"].endswith("result.txt")
        result_dir = api_environment.settings.jobs_dir / job_id
        assert "你好，欢迎使用。" in (result_dir / "result.txt").read_text(encoding="utf-8-sig")

        patched = client.patch(
            f"/api/jobs/{job_id}/result",
            json={
                "speaker_names": {"SPK0": "主持人"},
                "segments": [{"id": 0, "text": "校对后的文字。", "speaker": "SPK0"}],
            },
        )
        assert patched.status_code == 200
        assert patched.json()["segments"][0]["speaker_name"] == "主持人"
        assert patched.json()["segments"][0]["text"] == "校对后的文字。"
        assert "主持人：校对后的文字。" in (result_dir / "result.txt").read_text(encoding="utf-8-sig")

        subtitle = client.get(f"/api/jobs/{job_id}/export/srt")
        assert subtitle.status_code == 200
        assert "[主持人] 校对后的文字。" in subtitle.text
        assert client.get(f"/api/jobs/{job_id}/media").status_code == 200
        assert client.get(f"/api/jobs/{job_id}/audio").status_code == 200

        assert client.delete(f"/api/jobs/{job_id}").status_code == 204
