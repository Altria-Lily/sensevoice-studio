from copy import deepcopy

import pytest

from app.services.progress import ModelLoadProgress, RecognitionProgress, observed_model_class


class RawVadModel:
    """Replace the neural models only; exercise the real application adapter."""

    def __init__(self, **kwargs):
        self.model = object()
        self.vad_model = object()
        self.spk_model = object()
        self.raw_segments = []
        self.asr_calls = 0

    def inference(self, input, *, model=None, **kwargs):
        if model is self.vad_model:
            return [{"key": "audio", "value": deepcopy(self.raw_segments)}]
        self.asr_calls += 1
        return [{"text": "recognized"}]


def adapter():
    return observed_model_class(RawVadModel)(
        load_progress=ModelLoadProgress(None),
        studio_max_segment_ms=30000, studio_merge_length_ms=15000,
    )


@pytest.mark.parametrize("raw,expected", [
    # Actual boundaries around the 27-minute non-speech interval in the failed job.
    ([[5188980, 5190020], [6823990, 6827090]],
     [[5188980, 5190020], [6823990, 6827090]]),
    # The 15-second merge target must never concatenate distant short utterances.
    ([[0, 1000], [10000, 11000]], [[0, 1000], [10000, 11000]]),
    ([[0, 1000], [1100, 2000]], [[0, 2000]]),
    ([[0, 10000], [10000, 20000]], [[0, 10000], [10000, 20000]]),
    # Hard splitting also applies when VAD returns only one segment.
    ([[1000, 92000]], [[1000, 23750], [23750, 46500], [46500, 69250], [69250, 92000]]),
    ([[0, 30010]], [[0, 15005], [15005, 30010]]),
    ([[1000, 3000], [0, 2000], [5000, 5000]], [[0, 3000]]),
    ([], []),
])
def test_vad_output_preserves_gaps_and_bounds_asr_segments(raw, expected):
    model = adapter()
    model.raw_segments = raw
    result = model.inference("audio.wav", model=model.vad_model)
    assert result == [{"key": "audio", "value": expected}]
    assert model.raw_segments == raw


def test_progress_counts_the_safe_segments_seen_by_asr():
    model = adapter()
    model.raw_segments = [[0, 61000]]
    model._studio_progress = RecognitionProgress(61000, None)
    result = model.inference("audio.wav", model=model.vad_model)
    model._studio_progress.prepare_totals()
    assert result[0]["value"] == [[0, 20333], [20333, 40666], [40666, 61000]]
    assert model._studio_progress.total == 3
    assert model._studio_progress.total_ms == 61000


def test_oversized_asr_input_is_rejected_before_neural_inference():
    model = adapter()
    with pytest.raises(ValueError, match="片段"):
        model.inference([range(30000 * 16 + 1)], model=model.model)
    assert model.asr_calls == 0


def test_exact_limit_can_be_recognized():
    model = adapter()
    assert model.inference([range(30000 * 16)], model=model.model) == [{"text": "recognized"}]
