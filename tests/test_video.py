import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from plugin.plugins.video_reader import VideoReaderPlugin
from plugin.plugins.video_reader.media import VideoError, extract, ffmpeg_binary, local_source, run, validate_url


def test_vendored_source_is_byte_identical_to_pinned_revision():
    root = Path(__file__).resolve().parents[1] / "third_party" / "dsh-see-now"
    lock = json.loads((root / "UPSTREAM.json").read_text(encoding="utf-8"))
    assert lock["revision"] == "8a5490885d23feec8aff6b035af95465d172c1f2"
    assert "src/pipeline.js" in lock["files"] and "src/cuts.js" in lock["files"]
    # LOCAL-PATCHES.json 登记本地对上游的全部改动；本地文件套回 upstream 文本后必须
    # 与 UPSTREAM.json 里那份上游哈希逐字节相符，因此补丁之外的任何改动都会失败。
    patches = json.loads((root / "LOCAL-PATCHES.json").read_text(encoding="utf-8"))["patches"]
    assert set(patches) <= set(lock["files"])
    for filename, expected in lock["files"].items():
        content = (root / filename).read_bytes()
        patch = patches.get(filename)
        if patch:
            text = content.decode("utf-8")
            assert text.count(patch["local"]) == 1, filename
            content = text.replace(patch["local"], patch["upstream"]).encode("utf-8")
        assert hashlib.sha256(content).hexdigest() == expected, filename


@pytest.mark.asyncio
async def test_local_and_private_sources_rejected(tmp_path):
    with pytest.raises(VideoError):
        local_source("neko-video:../../secret.mp4")
    with pytest.raises(VideoError):
        local_source(str(tmp_path / "missing.mp4"))
    with pytest.raises(VideoError):
        await validate_url("http://127.0.0.1/video.mp4")
    with pytest.raises(VideoError):
        await validate_url("file:///secret.mp4")


@pytest.mark.asyncio
async def test_actual_ffmpeg_decode(tmp_path):
    binary = ffmpeg_binary({})
    path = tmp_path / "scene.mp4"
    code, _, stderr = await run(binary, "-y", "-v", "error", "-f", "lavfi", "-i",
                                "testsrc2=size=320x180:rate=6:duration=4", "-c:v", "libx264", str(path))
    assert code == 0, stderr
    result = await extract(path, start=1, seconds=2, config={"fps": 3})
    assert result["frames_scanned"] == 6
    assert result["start_seconds"] == 1
    assert result["end_seconds"] == 3
    assert result["partial"] and not result["audio_analyzed"]
    assert result["sheets"][0].startswith("data:image/png;base64,")
    assert result["pipeline_options"]["queueDepth"] == 0
    assert result["pipeline_options"]["scoreNormalize"] is True
    assert result["pipeline_options"]["cutFutureDelay"] > 0
    assert result["pipeline_options"]["cutMcRadius"] > 0
    assert result["frames_selected"] == sum(len(s["frames"]) for s in result["sheet_manifest"])
    assert all(t >= 1 for t in result["timestamps"])
    with pytest.raises(VideoError):
        await extract(path, start=20, seconds=2, config={})


@pytest.mark.asyncio
async def test_sheet_budget_stops_video_without_dropping_generated_sheets(tmp_path):
    binary = ffmpeg_binary({})
    path = tmp_path / "long.mp4"
    code, _, _ = await run(binary, "-y", "-v", "error", "-f", "lavfi", "-i",
                           "testsrc2=size=160x90:rate=12:duration=45", "-c:v", "libx264", str(path))
    assert code == 0
    result = await extract(path, start=0, seconds=45, config={"max_sheets": 1})
    assert result["sheet_limit_reached"]
    assert result["partial"] and result["end_seconds"] < 45
    assert len(result["sheets"]) == result["upstream_stats"]["sheets"]
    assert result["frames_scanned"] == result["upstream_stats"]["frames"]


@pytest.mark.asyncio
async def test_missing_node_has_actionable_error(monkeypatch, tmp_path):
    import plugin.plugins.video_reader.media as media
    monkeypatch.setattr(media, "ffmpeg_binary", lambda config: "ffmpeg")
    monkeypatch.setattr(media.shutil, "which", lambda name: None)
    with pytest.raises(VideoError, match="Node.js"):
        await extract(tmp_path / "demo.mp4", start=0, seconds=2, config={})


@pytest.mark.asyncio
async def test_proxy_fake_dns_is_rejected_without_a_verifiable_public_destination(monkeypatch):
    import socket
    for name in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **kw: [(2, 1, 6, "", ("198.18.0.1", 443))])
    with pytest.raises(VideoError):
        await validate_url("https://example.com/video.mp4")
    with pytest.raises(VideoError):
        await validate_url("https://198.18.0.1/video.mp4")
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **kw: [(2, 1, 6, "", ("192.168.1.1", 443))])
    with pytest.raises(VideoError):
        await validate_url("https://example.com/video.mp4")


@pytest.mark.asyncio
async def test_model_receives_images_and_feedback_returns(monkeypatch, tmp_path):
    import plugin.plugins.video_reader.media as media

    monkeypatch.setattr(media, "retrieve", AsyncMock(return_value=(tmp_path / "demo.mp4", "demo")))
    monkeypatch.setattr(media, "extract", AsyncMock(return_value={
        "sheets": ["data:image/jpeg;base64,abc"], "start_seconds": 0, "end_seconds": 5,
        "duration_seconds": 5, "frames_selected": 2, "partial": False, "audio_analyzed": False,
        "sheet_manifest": [{"frames": [{"t": 1.25, "via": "cut"}, {"t": 3.5, "via": "mark"}]}],
    }))
    create = AsyncMock(return_value=SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="观察到红色画面"))]))
    fake = SimpleNamespace(
        config=SimpleNamespace(dump=AsyncMock(return_value={})),
        ctx=SimpleNamespace(models=SimpleNamespace(get_client=AsyncMock(return_value=SimpleNamespace(
            chat=SimpleNamespace(completions=SimpleNamespace(create=create)))))))
    result = await VideoReaderPlugin._watch(fake, "https://example.com/video.mp4", "发生了什么", 0, 5)
    assert result["feedback"] == "观察到红色画面"
    assert result["next_start_seconds"] is None
    assert create.call_args.kwargs["model"] == "vision"
    content = create.call_args.kwargs["messages"][1]["content"]
    assert "格1=1.25秒" in content[1]["text"]
    assert "格2=3.5秒" in content[1]["text"]
    assert content[2]["type"] == "image_url"
    assert not fake._watching


@pytest.mark.asyncio
async def test_subprocess_timeout_reaps_child():
    import sys
    with pytest.raises(TimeoutError):
        await run(sys.executable, "-c", "import time; time.sleep(10)", timeout=0.1)
