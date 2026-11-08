import asyncio
import base64
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from PIL import Image
from plugin.plugins.video_reader import VideoReaderPlugin
from plugin.plugins.video_reader.host_delivery import MAX_IMAGE_BYTES, deliver_to_host, prepare_images
from plugin.plugins.video_reader.model_analysis import AnalysisError


def sample_sheets(count):
    sheets, manifests = [], []
    for n in range(count):
        out = BytesIO()
        with Image.new("RGB", (120, 70), (n * 7 % 256, 80, 130)) as image:
            image.save(out, format="PNG")
        sheets.append("data:image/png;base64," + base64.b64encode(out.getvalue()).decode())
        manifests.append({"frames": [{"t": n + .25, "via": "mark"}]})
    return sheets, manifests


@pytest.mark.parametrize("count,limit", [(1, 8), (25, 8), (65, 8), (25, 2)])
def test_all_sheets_preserved_with_bounded_images(count, limit):
    payloads, mappings = prepare_images(*sample_sheets(count), max_images=limit)
    assert 1 <= len(payloads) <= limit
    text = "\n".join(mappings)
    for n in range(count):
        assert text.count(f"S{n + 1}: 格1={n + .25}秒") == 1
    for data in payloads:
        assert len(data) <= MAX_IMAGE_BYTES
        with Image.open(BytesIO(data)) as image:
            assert max(image.size) <= 2048
            assert image.format == "JPEG"


@pytest.mark.parametrize("sheets,manifests", [([], []), (["bad"], [{"frames": []}]),
    (["data:image/png;base64,%%%"], [{"frames": []}]), (*sample_sheets(1)[:1], [])])
def test_bad_images_fail(sheets, manifests):
    with pytest.raises(AnalysisError):
        prepare_images(sheets, manifests)


def host_context():
    return SimpleNamespace(
        images=SimpleNamespace(upload=AsyncMock(return_value={"type": "image", "url": "http://host/image"})),
        push_message=Mock(return_value={"submitted": True}),
        models=SimpleNamespace(get_client=AsyncMock(side_effect=AssertionError("must not access model gateway"))),
        finish=AsyncMock(return_value={"meta": {"agent": {"delivery": "silent"}}}),
    )


@pytest.mark.asyncio
async def test_upload_all_then_push_once():
    ctx = host_context()
    def push(**kwargs):
        assert ctx.images.upload.await_count == 7
        assert len(kwargs["parts"]) == 8
        assert kwargs["ai_behavior"] == "respond"
        assert kwargs["visibility"] == []
        assert kwargs["target_lanlan"] == "test-character"
        return {"submitted": True}
    ctx.push_message.side_effect = push
    result = await deliver_to_host(ctx, "question", *sample_sheets(25), target="test-character")
    assert result == {"host_images": 7, "submitted": True}
    ctx.push_message.assert_called_once()


@pytest.mark.asyncio
async def test_partial_upload_failure_never_pushes():
    ctx = host_context()
    ctx.images.upload.side_effect = [{"type": "image", "url": "http://host/image"}, RuntimeError("private")]
    with pytest.raises(RuntimeError):
        await deliver_to_host(ctx, "question", *sample_sheets(3))
    ctx.push_message.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("receipt", [{"submitted": False}, {"ok": True}, None])
async def test_failed_submit_is_not_success(receipt):
    ctx = host_context()
    ctx.push_message.return_value = receipt
    with pytest.raises(AnalysisError, match="未接受"):
        await deliver_to_host(ctx, "question", *sample_sheets(1))
    ctx.push_message.assert_called_once()


@pytest.mark.asyncio
async def test_tool_returns_images_instead_of_second_proactive_turn():
    ctx = host_context()
    result = await deliver_to_host(ctx, "question", *sample_sheets(25), tool_call=True)
    assert len(result["images"]) == 2
    assert "S25:" in result["prompt"]
    ctx.images.upload.assert_not_called()
    ctx.push_message.assert_not_called()


def fake_plugin(monkeypatch, tmp_path):
    import plugin.plugins.video_reader.media as media
    sheets, manifests = sample_sheets(1)
    monkeypatch.setattr(media, "retrieve", AsyncMock(return_value=(tmp_path / "demo.mp4", "demo")))
    monkeypatch.setattr(media, "extract", AsyncMock(return_value={
        "sheets": sheets, "sheet_manifest": manifests, "start_seconds": 0, "end_seconds": 5,
        "duration_seconds": 5, "frames_selected": 1, "partial": False, "audio_analyzed": False,
    }))
    fake = SimpleNamespace(config=SimpleNamespace(dump=AsyncMock(return_value={})), ctx=host_context())
    fake._watch = VideoReaderPlugin._watch.__get__(fake)
    return fake


@pytest.mark.asyncio
async def test_default_backend_and_silent_agent_finish(monkeypatch, tmp_path):
    fake = fake_plugin(monkeypatch, tmp_path)
    await VideoReaderPlugin.analyze(fake, "source", seconds=5, _ctx={"lanlan_name": "test"})
    fake.ctx.models.get_client.assert_not_called()
    fake.ctx.finish.assert_awaited_once()
    finish = fake.ctx.finish.call_args.kwargs
    assert finish["delivery"] == "silent"
    assert finish["data"]["status"] == "submitted"
    assert finish["data"]["next_start_seconds"] is None
    assert fake.ctx.push_message.call_args.kwargs["target_lanlan"] == "test"
    assert not fake._watching


@pytest.mark.asyncio
async def test_agent_failure_is_not_silent(monkeypatch, tmp_path):
    fake = fake_plugin(monkeypatch, tmp_path)
    fake.ctx.push_message.return_value = {"submitted": False}
    await VideoReaderPlugin.analyze(fake, "source", seconds=5)
    fake.ctx.finish.assert_not_called()
    assert not fake._watching


@pytest.mark.asyncio
async def test_tool_entry_no_push(monkeypatch, tmp_path):
    fake = fake_plugin(monkeypatch, tmp_path)
    result = await VideoReaderPlugin.watch_video(fake, "source", seconds=5)
    assert result["output"]["status"] == "images_ready"
    assert result["images"]
    fake.ctx.push_message.assert_not_called()
    fake.ctx.finish.assert_not_called()


@pytest.mark.asyncio
async def test_cancellation_resets_busy_without_reply(monkeypatch, tmp_path):
    fake = fake_plugin(monkeypatch, tmp_path)
    fake.ctx.images.upload.side_effect = asyncio.CancelledError
    with pytest.raises(asyncio.CancelledError):
        await fake._watch("source", "question", 0, 5)
    assert not fake._watching
    fake.ctx.push_message.assert_not_called()


@pytest.mark.asyncio
async def test_upload_failure_is_sanitized(monkeypatch, tmp_path):
    fake = fake_plugin(monkeypatch, tmp_path)
    fake.ctx.images.upload.side_effect = RuntimeError("private credentials")
    result = await fake._watch("source", "question", 0, 5)
    assert result["status"] == "error"
    assert "private" not in result["message"]
    fake.ctx.push_message.assert_not_called()

@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["C:/private/video.mp4", "neko-video:secret", "file:///C:/private.mp4", "ftp://example.com/v.mp4", None])
async def test_qq_entry_refuses_non_http_sources(monkeypatch, tmp_path, source):
    fake = fake_plugin(monkeypatch, tmp_path)
    fake._watch = AsyncMock()
    result = await VideoReaderPlugin.prepare_for_qq(fake, source)
    assert result.value["status"] == "error"
    fake._watch.assert_not_called()
    fake.ctx.push_message.assert_not_called()


@pytest.mark.asyncio
async def test_qq_entry_forces_image_envelope_and_never_pushes(monkeypatch, tmp_path):
    fake = fake_plugin(monkeypatch, tmp_path)
    fake.config.dump.return_value = {"video": {"analysis_backend": "plugin_model"}}
    result = await VideoReaderPlugin.prepare_for_qq(fake, "【视频】 https://www.bilibili.com/video/BV18W4b6eE8Q/?a=1", seconds=5)
    assert result.value["output"]["status"] == "images_ready"
    assert result.value["images"]
    assert "sheet_manifest" not in result.value["output"]
    fake.ctx.models.get_client.assert_not_called()
    fake.ctx.images.upload.assert_not_called()
    fake.ctx.push_message.assert_not_called()
    fake.ctx.finish.assert_not_called()
