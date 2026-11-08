"""Packaged-host download startup and user share-message regressions."""
import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from plugin.plugins.video_reader import media

BILI = "https://www.bilibili.com/video/BV18W4b6eE8Q/"
SHORT = "https://b23.tv/zTVdFY6"


@pytest.mark.parametrize(("source", "expected"), [
    (SHORT, SHORT),
    (f" {SHORT}", SHORT),
    (f'" {SHORT}"', SHORT),
    (f"【和嘿嘿嘿嘿-哔哩哔哩】 {SHORT}", SHORT),
    (f"【和嘿嘿嘿嘿-哔哩哔哩】\n{SHORT}", SHORT),
    (f"[和嘿嘿嘿嘿-哔哩哔哩]({SHORT})", SHORT),
    (f'如果链接是" {SHORT}"这样的呢，【和嘿嘿嘿嘿-哔哩哔哩】 {SHORT}', SHORT),
    (BILI + "?trackid=tracking&spm_id_from=x&vd_source=y", BILI),
    (f"[{BILI}?vd_source=a]({BILI}?trackid=x\\&vd_source=a)", BILI),
    (f"【大家对于魂大人的评价belike：】 {BILI}?share_source=copy_web", BILI),
    (f"[视频]({BILI}?p=2&vd_source=x&t=30)", BILI + "?p=2&t=30"),
    ("https://example.com/a?signature=a%2Fb&x=(z)", "https://example.com/a?signature=a%2Fb&x=(z)"),
    (r"C:\My Videos\clip.mp4", r"C:\My Videos\clip.mp4"),
    ("neko-video:" + "a" * 32 + ".mp4", "neko-video:" + "a" * 32 + ".mp4"),
    ("[label](http://127.0.0.1/a.mp4)", "http://127.0.0.1/a.mp4"),
    ("https://user:pass@www.bilibili.com/video/BV1/?vd_source=x",
     "https://user:pass@www.bilibili.com/video/BV1/?vd_source=x"),
    ("https://www.bilibili.com.evil.test/a?vd_source=x", "https://www.bilibili.com.evil.test/a?vd_source=x"),
])
def test_share_normalization(source, expected):
    assert media.normalize_source(source) == expected


def test_multiple_targets_are_not_silently_selected():
    with pytest.raises(media.VideoError, match="多个"):
        media.normalize_source("[a](https://a.test/a) [b](https://b.test/b)")


@pytest.fixture
def frozen_host(monkeypatch, tmp_path):
    host = tmp_path / "projectneko_server.exe"
    host.touch()
    monkeypatch.setattr(media.sys, "executable", str(host))
    monkeypatch.setattr(media.sys, "frozen", True, raising=False)
    monkeypatch.setattr(media, "registered_pythons", lambda: [])
    return host


@pytest.mark.asyncio
async def test_frozen_host_uses_verified_python_not_app(frozen_host, monkeypatch):
    monkeypatch.setattr(media.shutil, "which", lambda name: "C:/Python311/python.exe" if name == "python" else None)
    runner = AsyncMock(return_value=(0, b"neko-video-python-ok\r\n", b""))
    monkeypatch.setattr(media, "run", runner)
    assert await media.download_python({}) == ("C:/Python311/python.exe",)
    assert runner.call_args.args[0] != str(frozen_host)
    assert runner.call_args.args[1:3] == ("-I", "-c")


@pytest.mark.asyncio
async def test_frozen_host_on_path_is_never_probed(frozen_host, monkeypatch):
    monkeypatch.setattr(media.shutil, "which", lambda name: str(frozen_host))
    runner = AsyncMock()
    monkeypatch.setattr(media, "run", runner)
    with pytest.raises(media.VideoError, match="Python 3.11"):
        await media.download_python({})
    runner.assert_not_called()


@pytest.mark.asyncio
async def test_configured_host_rejected(frozen_host, monkeypatch):
    runner = AsyncMock()
    monkeypatch.setattr(media, "run", runner)
    with pytest.raises(media.VideoError, match="不能指向"):
        await media.download_python({"python_path": str(frozen_host)})
    runner.assert_not_called()


@pytest.mark.asyncio
async def test_bad_explicit_config_does_not_fall_back(monkeypatch, tmp_path):
    with pytest.raises(media.VideoError, match="python_path"):
        await media.download_python({"python_path": str(tmp_path / "missing.exe")})


@pytest.mark.asyncio
async def test_registry_fallback_when_steam_path_is_stale(frozen_host, monkeypatch):
    monkeypatch.setattr(media.shutil, "which", lambda name: None)
    monkeypatch.setattr(media, "registered_pythons", lambda: ["C:/Python311/python.exe"])
    monkeypatch.setattr(media, "run", AsyncMock(return_value=(0, b"neko-video-python-ok", b"")))
    assert await media.download_python({}) == ("C:/Python311/python.exe",)


@pytest.mark.asyncio
@pytest.mark.parametrize("result", [(0, b"too-old", b""), (1, b"", b"failure"), (0, b"", b"")])
async def test_invalid_interpreter_probes_rejected(frozen_host, monkeypatch, result):
    monkeypatch.setattr(media.shutil, "which", lambda name: "C:/Python/python.exe" if name == "python" else None)
    monkeypatch.setattr(media, "run", AsyncMock(return_value=result))
    with pytest.raises(media.VideoError, match="Python 3.11"):
        await media.download_python({})


@pytest.mark.asyncio
async def test_probe_timeout_tries_next_candidate(frozen_host, monkeypatch):
    monkeypatch.setattr(media.shutil, "which", lambda name: None)
    monkeypatch.setattr(media, "registered_pythons", lambda: ["C:/Old/python.exe", "C:/New/python.exe"])
    monkeypatch.setattr(media, "run", AsyncMock(side_effect=[TimeoutError(), (0, b"neko-video-python-ok", b"")]))
    assert await media.download_python({}) == ("C:/New/python.exe",)


@pytest.mark.asyncio
async def test_isolated_worker_bootstraps_without_host_sdk(tmp_path):
    # Invalid URL fails before networking but still imports the real vendored downloader.
    job = tmp_path / "download.json"
    job.write_text(json.dumps({"directory": str(tmp_path), "url": "file:///not-allowed.mp4",
                               "max_bytes": 1024}), encoding="utf-8")
    worker = Path(media.__file__).with_name("download_worker.py")
    code, _, stderr = await media.run(sys.executable, "-I", str(worker), str(job))
    result = json.loads((tmp_path / "result.json").read_text(encoding="utf-8"))
    assert code == 1, stderr
    assert "无法下载" in result["error"]
    assert "依赖不完整" not in result["error"]


@pytest.mark.asyncio
@pytest.mark.parametrize(("source", "expected"), [
    (f"[video]({BILI}?vd_source=test)", BILI),
    (f'" {SHORT}"', SHORT),
    (f"【和嘿嘿嘿嘿-哔哩哔哩】 {SHORT}", SHORT),
])
async def test_retrieve_uses_isolated_worker_and_normalized_url(tmp_path, monkeypatch, source, expected):
    monkeypatch.setattr(media, "validate_url", AsyncMock())
    monkeypatch.setattr(media, "download_python", AsyncMock(return_value=("python.exe",)))
    async def fake_run(*args):
        assert args[0:2] == ("python.exe", "-I")
        job = json.loads(Path(args[-1]).read_text(encoding="utf-8"))
        assert job["url"] == expected
        video = tmp_path / "video.mp4"
        video.write_bytes(b"fake")
        (tmp_path / "result.json").write_text(json.dumps({"path": str(video), "title": "demo"}), encoding="utf-8")
        return 0, b"", b""
    monkeypatch.setattr(media, "run", fake_run)
    path, title = await media.retrieve(source, tmp_path, {})
    assert path == tmp_path / "video.mp4"
    assert title == "demo"


@pytest.mark.asyncio
@pytest.mark.parametrize("result", [None, "invalid json", "[]"])
async def test_worker_missing_or_invalid_result_is_actionable(tmp_path, monkeypatch, result):
    monkeypatch.setattr(media, "validate_url", AsyncMock())
    monkeypatch.setattr(media, "download_python", AsyncMock(return_value=("python.exe",)))
    monkeypatch.setattr(media, "run", AsyncMock(return_value=(0, b"", b"")))
    if result is not None:
        (tmp_path / "result.json").write_text(result, encoding="utf-8")
    with pytest.raises(media.VideoError, match="下载器未返回有效结果"):
        await media.retrieve(BILI, tmp_path, {})


@pytest.mark.asyncio
async def test_local_video_needs_no_python(tmp_path, monkeypatch):
    video = tmp_path / "a.mp4"
    video.write_bytes(b"fake")
    interpreter = AsyncMock()
    monkeypatch.setattr(media, "download_python", interpreter)
    assert (await media.retrieve(str(video), tmp_path, {}))[0] == video.resolve()
    interpreter.assert_not_called()
