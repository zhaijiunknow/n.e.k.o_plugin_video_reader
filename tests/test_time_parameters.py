import pytest
from plugin.plugins.video_reader import SCHEMA, VideoReaderPlugin
from plugin.plugins.video_reader.media import VideoError
from plugin.plugins.video_reader.time_parameters import normalize_time_range, safe_time_value
from plugin.sdk.shared.core.base import EVENT_META_ATTR


@pytest.mark.parametrize("start,length,limit,expected", [
    (0, 300, 300, (0, 300)), (None, None, 300, (0, 300)),
    ("", "  ", 300, (0, 300)), (0, 0, 300, (0, 300)),
    ("0", "0", 120, (0, 120)), (12.5, "45.5", 300, (12.5, 45.5)),
    (0, 3600, 300, (0, 300)), (0, 3600, 900, (0, 600)),
    (600, 600, 90, (600, 90)), (0, 300, None, (0, 300)),
])
def test_normalized_time_budget(start, length, limit, expected):
    assert normalize_time_range(start, length, limit) == expected


@pytest.mark.parametrize("start,length,limit,field", [
    (-1, 300, 300, "start_seconds"), (0, -1, 300, "seconds"),
    (True, 300, 300, "start_seconds"), (0, False, 300, "seconds"),
    (0, .5, 300, "seconds"), ("private credential", 300, 300, "start_seconds"),
    (0, [], 300, "seconds"), (0, {}, 300, "seconds"),
    (float("nan"), 300, 300, "start_seconds"), (0, "inf", 300, "seconds"),
    (0, 300, "nan", "video.max_seconds"), (0, 300, 0, "video.max_seconds"),
    (0, 300, -10, "video.max_seconds"), (0, 300, True, "video.max_seconds"),
    (0, 10**1000, 300, "seconds"),
])
def test_invalid_time_is_actionable_and_sanitized(start, length, limit, field):
    with pytest.raises(VideoError) as exc:
        normalize_time_range(start, length, limit)
    assert field in str(exc.value)
    assert "private credential" not in str(exc.value)


def test_safe_time_log_does_not_echo_text():
    assert safe_time_value("private credential") == "invalid:str"
    assert safe_time_value({"token": "private"}) == "invalid:dict"
    assert safe_time_value("601") == "601.0"
    assert safe_time_value(None) == "unset"


def test_agent_schema_defaults_and_error_result_contract():
    assert SCHEMA["properties"]["start_seconds"]["default"] == 0
    assert SCHEMA["properties"]["seconds"]["default"] == 300
    meta = getattr(VideoReaderPlugin.analyze, EVENT_META_ATTR)
    assert meta.llm_result_fields == ["message", "feedback"]
    # Exercise the host parser that previously returned the transport message "done".
    from utils.result_parser import parse_plugin_result
    message = "seconds（观看时长）不能为负数。"
    assert parse_plugin_result({"status": "error", "message": message},
                               llm_result_fields=meta.llm_result_fields,
                               plugin_message="done", lang="zh") == message
