from __future__ import annotations

import time
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

DetailsCallback = Callable[[dict[str, Any]], None]


class StageReporter:
    """Structured snapshots. Time may advance; completion only advances on real work."""

    def __init__(self, phase: str, callback: DetailsCallback | None):
        self.phase = phase
        self.callback = callback
        self.started = time.monotonic()
        self.started_at = datetime.now(timezone.utc).isoformat()

    def emit(self, label: str, *, state: str = "running", **values: Any) -> None:
        if self.callback:
            self.callback({
                "phase": self.phase, "state": state, "label": label,
                "started_at": self.started_at,
                "elapsed_s": round(time.monotonic() - self.started, 2),
                **values,
            })


class ModelLoadProgress:
    def __init__(self, callback: DetailsCallback | None):
        self.reporter = StageReporter("models", callback)
        self.models = [
            {"name": name, "state": "waiting", "elapsed_s": 0}
            for name in ("SenseVoice · 语音识别", "FSMN-VAD · 语音分段", "标点模型", "CAM++ · 说话人")
        ]
        self.index = 0

    def emit(self, label: str, state: str = "running") -> None:
        self.reporter.emit(
            label, state=state, current=sum(item["state"] == "completed" for item in self.models),
            total=len(self.models), unit="models", models=[dict(item) for item in self.models],
        )

    def build(self, builder: Callable, **kwargs):
        index = self.index
        self.index += 1
        if index >= len(self.models):
            return builder(**kwargs)
        item = self.models[index]
        item["state"] = "running"
        item["started_at"] = datetime.now(timezone.utc).isoformat()
        started = time.monotonic()
        self.emit("正在加载 " + item["name"] + "（缺少缓存时会先下载）")
        try:
            result = builder(**kwargs)
        except BaseException:
            item["state"] = "failed"
            item["elapsed_s"] = round(time.monotonic() - started, 2)
            self.emit(item["name"] + " 加载失败", "failed")
            raise
        item["state"] = "completed"
        item["elapsed_s"] = round(time.monotonic() - started, 2)
        self.emit(item["name"] + " 已就绪")
        return result

    def ready(self, cached: bool = False) -> None:
        for item in self.models:
            item["state"] = "completed"
        self.emit("复用已加载的模型，无需重复加载" if cached else "全部模型已就绪", "completed")


class RecognitionProgress:
    """Observe the pinned FunASR VAD/batch pipeline without changing its results.

    VAD's returned list is deliberately retained by reference: FunASR replaces its
    segment lists when merge_vad runs. The first ASR batch sees those final lists.
    Batches are sorted by length, so processed_ms is cumulative work, NOT a cursor
    claiming that the video's first N minutes have all been transcribed.
    """

    def __init__(self, duration_ms: int, callback: DetailsCallback | None):
        self.reporter = StageReporter("recognize", callback)
        self.duration_ms = duration_ms
        self.vad_result: list[dict] | None = None
        self.total: int | None = None
        self.total_ms: int | None = None
        self.current = 0
        self.processed_ms = 0
        self.asr_started: float | None = None

    def emit(self, label: str, *, substage: str, state: str = "running") -> None:
        eta = None
        if (
            substage == "asr" and self.asr_started is not None and self.processed_ms > 0
            and self.total_ms and self.processed_ms < self.total_ms
        ):
            elapsed = time.monotonic() - self.asr_started
            eta = round(elapsed * (self.total_ms - self.processed_ms) / self.processed_ms, 1)
        self.reporter.emit(
            label, state=state, substage=substage, current=self.current, total=self.total,
            unit="segments", processed_ms=self.processed_ms, total_ms=self.total_ms,
            media_duration_ms=self.duration_ms, eta_s=eta,
        )

    def prepare_totals(self) -> None:
        if self.total is not None:
            return
        segments = [segment for result in self.vad_result or [] for segment in result.get("value", [])]
        if segments:
            self.total = len(segments)
            self.total_ms = sum(
                max(0, min(self.duration_ms, round(end)) - max(0, round(start)))
                for start, end in segments
            )
        self.asr_started = time.monotonic()

    def observe(self, owner, invoke: Callable, input, *, model=None, kwargs=None,
                input_len=None, key=None, progress_callback=None, **cfg):
        selected = owner.model if model is None else model
        kind = (
            "vad" if selected is owner.vad_model else
            "asr" if selected is owner.model else
            "speaker" if selected is owner.spk_model else "punctuation"
        )
        previous = self.current
        previous_ms = self.processed_ms
        lengths: list[int] = []
        if kind == "asr":
            self.prepare_totals()
            if isinstance(input, (list, tuple)):
                lengths = [round(len(part) / 16) for part in input]
            else:
                lengths = [self.duration_ms]
            self.emit("正在识别语音片段", substage="asr")
        else:
            self.emit({
                "vad": "正在检测语音区间，完成后可确定片段总数",
                "speaker": "正在提取当前批次的说话人特征",
                "punctuation": "正在恢复标点并整理说话人",
            }[kind], substage=kind)

        # Native callbacks are local to each inference call, not global progress.
        # Count ASR batches only: VAD / CAM++ callbacks cannot inflate the total.
        def advance(current, total):
            if kind == "asr":
                completed = max(0, min(int(current), len(lengths)))
                self.current = max(self.current, previous + completed)
                self.processed_ms = max(self.processed_ms, previous_ms + sum(lengths[:completed]))
                if self.total is not None:
                    self.current = min(self.current, self.total)
                if self.total_ms is not None:
                    self.processed_ms = min(self.processed_ms, self.total_ms)
                self.emit("语音片段识别中", substage="asr")
            if progress_callback is not None:
                progress_callback(current, total)

        result = invoke(
            input, input_len=input_len, model=model, kwargs=kwargs, key=key,
            progress_callback=advance, **cfg,
        )
        if kind == "vad":
            self.vad_result = result
        elif kind == "asr":
            advance(len(lengths), len(lengths))
        elif kind == "punctuation":
            self.emit("正在完成时间轴与全局说话人聚类", substage="finalizing")
        return result


def observed_model_class(base):
    """Local adapter for funasr==1.4.14; no vendor files or global monkeypatches."""
    class ObservedAutoModel(base):
        def __init__(self, *, load_progress: ModelLoadProgress, **kwargs):
            self._studio_load_progress = load_progress
            self._studio_progress = None
            try:
                super().__init__(**kwargs)
            finally:
                self._studio_load_progress = None

        def build_model(self, **kwargs):
            if self._studio_load_progress is None:
                return super().build_model(**kwargs)
            return self._studio_load_progress.build(super().build_model, **kwargs)

        def inference(self, input, input_len=None, model=None, kwargs=None, key=None,
                      progress_callback=None, **cfg):
            invoke = super().inference
            if self._studio_progress is None:
                return invoke(input, input_len=input_len, model=model, kwargs=kwargs,
                              key=key, progress_callback=progress_callback, **cfg)
            return self._studio_progress.observe(
                self, invoke, input, input_len=input_len, model=model, kwargs=kwargs,
                key=key, progress_callback=progress_callback, **cfg,
            )

    return ObservedAutoModel
