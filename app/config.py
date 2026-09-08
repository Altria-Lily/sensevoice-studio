from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

try:
    from dotenv import load_dotenv

    load_dotenv(PROJECT_ROOT / ".env")
except ImportError:
    # Lightweight tests can import configuration before optional dependencies exist.
    pass


def _resolve_path(value: str, default: str) -> Path:
    path = Path(value or default).expanduser()
    return path if path.is_absolute() else PROJECT_ROOT / path


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    project_root: Path
    data_dir: Path
    jobs_dir: Path
    model_dir: Path
    device: str
    model: str
    vad_model: str
    punc_model: str
    spk_model: str
    max_segment_ms: int
    batch_size_s: int
    merge_length_s: int
    max_upload_bytes: int
    job_workers: int

    @classmethod
    def from_env(cls) -> Settings:
        data_dir = _resolve_path(os.getenv("FUNASR_DATA_DIR", ""), "data")
        return cls(
            project_root=PROJECT_ROOT,
            data_dir=data_dir,
            jobs_dir=data_dir / "jobs",
            model_dir=_resolve_path(os.getenv("FUNASR_MODEL_DIR", ""), "data/models"),
            device=os.getenv("FUNASR_DEVICE", "auto").strip() or "auto",
            model=os.getenv("FUNASR_MODEL", "iic/SenseVoiceSmall").strip(),
            vad_model=os.getenv("FUNASR_VAD_MODEL", "fsmn-vad").strip(),
            punc_model=os.getenv("FUNASR_PUNC_MODEL", "ct-punc").strip(),
            spk_model=os.getenv("FUNASR_SPK_MODEL", "cam++").strip(),
            max_segment_ms=max(1_000, _int_env("FUNASR_MAX_SEGMENT_MS", 30_000)),
            batch_size_s=max(1, _int_env("FUNASR_BATCH_SIZE_S", 60)),
            merge_length_s=max(1, _int_env("FUNASR_MERGE_LENGTH_S", 15)),
            max_upload_bytes=max(1, _int_env("FUNASR_MAX_UPLOAD_MB", 10240)) * 1024 * 1024,
            job_workers=max(1, _int_env("FUNASR_JOB_WORKERS", 1)),
        )

    def prepare(self) -> None:
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self.model_dir.mkdir(parents=True, exist_ok=True)
        (self.project_root / ".tmp").mkdir(parents=True, exist_ok=True)
        (self.project_root / ".cache").mkdir(parents=True, exist_ok=True)

        # Keep multi-gigabyte model caches in the project drive. setdefault lets
        # advanced users override any value before starting the process.
        os.environ.setdefault("MODELSCOPE_CACHE", str(self.model_dir / "modelscope"))
        os.environ.setdefault("HF_HOME", str(self.model_dir / "huggingface"))
        os.environ.setdefault("TORCH_HOME", str(self.model_dir / "torch"))
        os.environ.setdefault("XDG_CACHE_HOME", str(self.project_root / ".cache"))
        os.environ.setdefault("TMP", str(self.project_root / ".tmp"))
        os.environ.setdefault("TEMP", str(self.project_root / ".tmp"))


settings = Settings.from_env()
