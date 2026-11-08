import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from plugin.plugins.video_reader import model_analysis as analysis


def model():
    create = AsyncMock(return_value=SimpleNamespace(choices=[SimpleNamespace(
        message=SimpleNamespace(content="观察记录：1 秒时出现测试画面。"))]))
    return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))), create


@pytest.mark.asyncio
async def test_large_realistic_payload_is_split_and_all_sheets_are_analyzed():
    client, create = model()
    sheets = ["data:image/png;base64," + chr(65 + i) * 3_000_000 for i in range(8)]
    manifests = [{"frames": [{"t": i, "via": "cut"}]} for i in range(8)]
    feedback, batches = await analysis.analyze_sheets(client, "总结视频", sheets, manifests)
    assert feedback and batches > 1
    assert create.await_count == batches + 1
    received = []
    for call in create.call_args_list:
        payload = call.kwargs
        assert len(json.dumps(payload).encode()) <= analysis.REQUEST_BUDGET_BYTES < 16 * 1024 * 1024
        received.extend(part["image_url"]["url"] for part in payload["messages"][1]["content"]
                        if part["type"] == "image_url")
    assert received == sheets
    assert all(p["type"] == "text" for p in create.call_args.kwargs["messages"][1]["content"])


@pytest.mark.asyncio
async def test_single_sheet_too_large_fails_before_model_call(monkeypatch):
    monkeypatch.setattr(analysis, "REQUEST_BUDGET_BYTES", 2048)
    client, create = model()
    with pytest.raises(analysis.AnalysisError, match="video.quality"):
        await analysis.analyze_sheets(client, "总结", ["data:image/png;base64," + "A" * 3000], [])
    create.assert_not_called()


@pytest.mark.asyncio
async def test_batch_failure_never_returns_a_full_video_conclusion(monkeypatch):
    monkeypatch.setattr(analysis, "REQUEST_BUDGET_BYTES", 4096)
    client, create = model()
    create.side_effect = [SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="第一批"))]),
                          RuntimeError("second batch failed")]
    with pytest.raises(RuntimeError, match="second batch"):
        await analysis.analyze_sheets(client, "总结", ["A" * 2000, "B" * 2000], [])
    assert create.await_count == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(("code", "expected"), [
    ("model_usage_not_bound", "尚未绑定"),
    ("model_usage_not_declared", "未识别"),
    ("model_capability_mismatch", "不支持图片"),
])
async def test_gateway_configuration_errors_are_actionable_and_redacted(code, expected):
    client, create = model()
    error = RuntimeError("provider payload containing secret-key-must-not-leak")
    error.code = code
    create.side_effect = error
    with pytest.raises(analysis.AnalysisError, match=expected) as caught:
        await analysis.analyze_sheets(client, "总结", ["data:image/png;base64,test"], [])
    assert "secret-key" not in str(caught.value)
