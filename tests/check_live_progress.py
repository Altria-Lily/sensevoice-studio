"""Opt-in real video -> text integration check using the public cached sample.

Run: .venv/Scripts/python.exe tests/check_live_progress.py http://127.0.0.1:8001
Creates one clearly named example job. Does not read or edit user media/text.
"""
import json
import subprocess
import sys
import time
from pathlib import Path

import httpx
import imageio_ffmpeg


def main():
    root = Path(__file__).resolve().parents[1]
    temporary = root / ".tmp" / "progress-v3-check"
    temporary.mkdir(parents=True, exist_ok=True)
    sample = root / "data/models/modelscope/models/iic--SenseVoiceSmall/snapshots/master/example/zh.mp3"
    unit = temporary / "public-sample-with-pause.wav"
    video = temporary / "progress-example.mp4"
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    commands = [
        [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(sample),
         "-af", "apad=pad_dur=1", "-ac", "1", "-ar", "16000", str(unit)],
        [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
         "-stream_loop", "19", "-i", str(unit), "-f", "lavfi", "-i", "color=c=black:s=320x180:r=5",
         "-t", "96", "-map", "1:v:0", "-map", "0:a:0", "-c:v", "libx264",
         "-preset", "ultrafast", "-c:a", "aac", "-movflags", "+faststart", str(video)],
    ]
    for command in commands:
        subprocess.run(command, check=True, capture_output=True, timeout=60)
    print("Created 96-second public-sample video", flush=True)
    base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8001"
    with httpx.Client(base_url=base, timeout=20, trust_env=False) as client:
        assert client.get("/api/settings").json()["features"]["detailed_progress"] is True
        with video.open("rb") as stream:
            response = client.post(
                "/api/jobs/upload",
                params={"filename": "详细进度验收示例.mp4", "language": "zh", "batch_size_s": 15},
                headers={"Content-Type": "application/octet-stream", "Content-Length": str(video.stat().st_size)},
                content=stream,
            )
        assert response.status_code == 202, response.text
        job_id = response.json()["id"]
        print("JOB_ID=" + job_id, flush=True)
        deadline = time.monotonic() + 300
        signature = None
        intermediate = set()
        model_counts = set()
        while time.monotonic() < deadline:
            status = client.get(f"/api/jobs/{job_id}?include_transcript=false")
            status.raise_for_status()
            job = status.json()
            assert "transcript" not in job
            details = job.get("progress_details", {})
            models = details.get("models", {})
            recognition = details.get("recognize", {})
            current = recognition.get("current", 0)
            total = recognition.get("total")
            if total and 0 < current < total:
                intermediate.add(current)
            if models:
                model_counts.add(models.get("current", 0))
            new_signature = (job["state"], models.get("current"), current, total, recognition.get("substage"))
            if new_signature != signature:
                print(json.dumps({
                    "state": job["state"], "models_ready": models.get("current"),
                    "segments_done": current, "segments_total": total,
                    "substage": recognition.get("substage"),
                }), flush=True)
                signature = new_signature
            if job["state"] in {"completed", "failed"}:
                break
            time.sleep(0.08)
        assert job["state"] == "completed", job.get("error") or job["state"]
        details = job["progress_details"]
        assert all(details[phase]["state"] == "completed" for phase in ("extract", "models", "recognize"))
        assert abs(details["extract"]["current"] - 96000) < 1500
        assert details["models"]["current"] == details["models"]["total"] == 4
        recognition = details["recognize"]
        assert recognition["current"] == recognition["total"] > 1
        assert recognition["processed_ms"] == recognition["total_ms"]
        assert intermediate, "must observe real progress before all ASR segments finish"
        result = client.get(f"/api/jobs/{job_id}").json()
        assert result["transcript"]["segments"]
        print(json.dumps({
            "result": "PASS", "job_id": job_id, "asr_segments": recognition["total"],
            "observed_intermediate_counts": sorted(intermediate),
            "observed_model_counts": sorted(model_counts),
            "extraction_ms": details["extract"]["current"],
            "result_segments": len(result["transcript"]["segments"]),
        }), flush=True)


if __name__ == "__main__":
    main()
