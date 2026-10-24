from __future__ import annotations


def safe_vad_segments(
    segments: list[list[int]], *, max_segment_ms: int, merge_length_ms: int,
) -> list[list[int]]:
    """Preserve VAD speech regions and bound every ASR input in milliseconds.

    Only bridge pauses of at most 200 ms when the combined utterance fits the
    merge target. Longer non-speech gaps must never become ASR inputs. Split
    oversized regions evenly so a one-frame overrun cannot create a tiny tail.
    """
    if max_segment_ms <= 0 or merge_length_ms <= 0:
        raise ValueError("语音片段长度限制必须大于零")
    regions: list[list[int]] = []
    for start, end in sorted((max(0, int(a)), int(b)) for a, b in segments):
        if end <= start:
            continue
        if regions and start < regions[-1][1]:
            regions[-1][1] = max(regions[-1][1], end)
        else:
            regions.append([start, end])

    target = min(max_segment_ms, merge_length_ms)
    bounded: list[list[int]] = []
    for start, end in regions:
        duration = end - start
        count = (duration + max_segment_ms - 1) // max_segment_ms
        for index in range(count):
            left = start + duration * index // count
            right = start + duration * (index + 1) // count
            if (
                bounded and 0 <= left - bounded[-1][1] <= 200
                and right - bounded[-1][0] <= target
            ):
                bounded[-1][1] = right
            else:
                bounded.append([left, right])
    return bounded
