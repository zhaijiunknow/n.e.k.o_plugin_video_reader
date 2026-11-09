"""Bound Agent-supplied time ranges without logging arbitrary request text."""
from __future__ import annotations

import math

from .media import VideoError

DEFAULT_SECONDS = 300
MAX_SECONDS = 600


def _number(value, name, default):
    if value is None or (isinstance(value, str) and not value.strip()):
        return float(default)
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise VideoError(f"{name} 必须是有限数字，不能是布尔值或其他类型。")
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        raise VideoError(f"{name} 必须是有限数字（单位：秒）。") from None
    if not math.isfinite(number):
        raise VideoError(f"{name} 必须是有限数字，不能是 NaN 或 Infinity。")
    return number


def safe_time_value(value):
    """Log numeric values, but never arbitrary strings, containers or secrets."""
    if value is None:
        return "unset"
    if isinstance(value, bool):
        return "invalid:bool"
    if isinstance(value, str) and not value.strip():
        return "empty"
    try:
        return str(_number(value, "time", 0))
    except VideoError:
        return f"invalid:{type(value).__name__}"


def normalize_time_range(start_seconds, seconds, max_seconds=DEFAULT_SECONDS):
    start = _number(start_seconds, "start_seconds（起始时间）", 0)
    length = _number(seconds, "seconds（观看时长）", DEFAULT_SECONDS)
    limit = _number(max_seconds, "video.max_seconds（配置上限）", DEFAULT_SECONDS)
    if start < 0:
        raise VideoError("start_seconds（起始时间）不能为负数；从头观看请省略或填 0。")
    if length < 0:
        raise VideoError("seconds（观看时长）不能为负数；默认观看请省略或填 300。")
    if limit <= 0:
        raise VideoError("video.max_seconds（配置上限）必须大于 0，建议设置为 300。")
    # Agents sometimes use zero as an unspecified duration; never treat it as unlimited.
    if length == 0:
        length = DEFAULT_SECONDS
    elif length < 1:
        raise VideoError("seconds（观看时长）须至少为 1 秒；默认观看请省略或填 300。")
    return start, min(length, max(1, min(MAX_SECONDS, limit)))
