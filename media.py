"""Bounded retrieval and cancellable FFmpeg decoding."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from .network_security import check_url, public_addresses

VIDEO_SUFFIXES = {".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".flv", ".mpeg", ".mpg"}


class VideoError(ValueError):
    pass


def ffmpeg_binary(config: dict) -> str:
    configured = str(config.get("ffmpeg_path") or "")
    if configured:
        if not Path(configured).is_file():
            raise VideoError("配置的 ffmpeg_path 不存在。")
        return configured
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError) as exc:
        raise VideoError("缺少 FFmpeg，请同步插件依赖或配置 video.ffmpeg_path。") from exc


async def stop_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    if os.name == "nt":
        killer = await asyncio.create_subprocess_exec(
            "taskkill", "/PID", str(process.pid), "/T", "/F",
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        await killer.wait()
    else:
        import signal
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
    with contextlib.suppress(ProcessLookupError):
        process.kill()
    await process.wait()


async def spawn(*args: str, **kwargs) -> asyncio.subprocess.Process:
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {"start_new_session": True}
    return await asyncio.create_subprocess_exec(*args, **options, **kwargs)


async def run(*args: str, timeout: float = 120) -> tuple[int, bytes, bytes]:
    process = await spawn(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        async with asyncio.timeout(timeout):
            stdout, stderr = await process.communicate()
        return process.returncode, stdout, stderr
    finally:
        await stop_process(process)


async def validate_url(url: str) -> None:
    try:
        check_url(url)
        parts = urlsplit(url)
        await asyncio.to_thread(public_addresses, parts.hostname, parts.port or (443 if parts.scheme == "https" else 80))
    except (OSError, ValueError) as exc:
        raise VideoError("视频链接必须指向可验证的公网 HTTP(S) 地址；不支持内网、代理或 TUN 虚拟 DNS，请改用直连网络或上传文件。") from exc


def local_source(source: str) -> Path:
    if source.startswith("neko-video:"):
        name = source.removeprefix("neko-video:")
        if not re.fullmatch(r"[0-9a-f]{32}\.(mp4|mkv|webm|mov|avi|m4v|flv|mpeg|mpg)", name):
            raise VideoError("视频附件标识无效，请重新上传。")
        path = Path(tempfile.gettempdir()) / "neko-video-uploads" / name
    else:
        path = Path(source).expanduser()
    if not path.is_file() or path.suffix.lower() not in VIDEO_SUFFIXES:
        raise VideoError("找不到视频文件或格式不支持；附件可能已过期，请重新发送。")
    return path.resolve()


async def retrieve(source: str, directory: Path, config: dict) -> tuple[Path, str]:
    if not source.lower().startswith(("http:", "https:")):
        return local_source(source), "本地视频"
    await validate_url(source)
    job = directory / "download.json"
    job.write_text(json.dumps({"url": source, "directory": str(directory),
                              "max_bytes": max(1, min(1024, int(config.get("max_download_mb", 256)))) * 1024 * 1024,
                              "cookies_file": str(config.get("cookies_file") or "")}), encoding="utf-8")
    code, _, _ = await run(sys.executable, str(Path(__file__).with_name("download_worker.py")), str(job))
    result_file = directory / "result.json"
    result = json.loads(result_file.read_text(encoding="utf-8")) if result_file.exists() else {}
    if code or not result.get("path"):
        raise VideoError(result.get("error") or "视频下载失败，请检查链接、访问权限或插件 yt-dlp 依赖。")
    path = Path(result["path"]).resolve()
    if not path.is_relative_to(directory.resolve()) or not path.is_file():
        raise VideoError("下载器没有生成可用视频。")
    return path, str(result.get("title") or "网络视频")[:200]


async def extract(path: Path, *, start: float, seconds: float, config: dict) -> dict:
    if not math.isfinite(start) or not math.isfinite(seconds) or start < 0 or not 0 < seconds <= 600:
        raise VideoError("视频起止时间无效。")
    binary = ffmpeg_binary(config)
    node = str(config.get("node_path") or shutil.which("node") or "")
    if not node:
        raise VideoError("完整版处理核心需要 Node.js 20 或以上，请安装 Node.js 或配置 video.node_path。")
    try:
        code, version, _ = await run(node, "--version", timeout=10)
    except OSError as exc:
        raise VideoError("无法启动 Node.js，请检查 video.node_path。") from exc
    if code or not re.match(rb"v(?:2[0-9]|[3-9][0-9])\.", version.strip()):
        raise VideoError("完整版处理核心需要 Node.js 20 或以上。")
    protocol = ["-protocol_whitelist", "file,pipe"]
    _, _, probe = await run(binary, "-hide_banner", *protocol, "-i", str(path), timeout=15)
    info = probe.decode("utf-8", errors="replace")
    match = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", info)
    duration = sum(float(value) * factor for value, factor in zip(match.groups(), (3600, 60, 1))) if match else None
    if "Video:" not in info:
        raise VideoError("文件中没有可解码的视频画面。")
    if duration is not None and start >= duration:
        raise VideoError("起始时间超过视频长度。")
    seconds = min(seconds, duration - start) if duration is not None else seconds
    fps = max(1, min(30, float(config.get("fps", 12))))
    quality = config.get("quality", "low")
    if quality not in {"low", "standard", "high", "ultra"}:
        raise VideoError("video.quality 必须为 low、standard、high 或 ultra。")
    max_sheets = max(1, min(64, int(config.get("max_sheets", 24))))
    with tempfile.TemporaryDirectory(prefix="neko-upstream-video-") as folder:
        directory = Path(folder)
        job = directory / "job.json"
        job.write_text(json.dumps({"path": str(path.resolve()), "ffmpeg": binary, "output": folder,
                                   "start": start, "seconds": seconds, "fps": fps,
                                   "quality": quality, "max_sheets": max_sheets}), encoding="utf-8")
        code, _, _ = await run(node, str(Path(__file__).with_name("upstream_bridge.mjs")), str(job), timeout=140)
        if code or not (directory / "result.json").is_file():
            raise VideoError("上游视频处理核心运行失败，请检查视频文件、Node.js 和 FFmpeg。")
        result = json.loads((directory / "result.json").read_text(encoding="utf-8"))
        sheets = []
        manifests = result["sheets"]
        for sheet in manifests:
            filename = sheet.pop("filename")
            if not re.fullmatch(r"sheet-\d{4}\.png", filename):
                raise VideoError("上游处理核心返回了无效的图片路径。")
            sheets.append("data:image/png;base64," + base64.b64encode((directory / filename).read_bytes()).decode("ascii"))
    timestamps = [frame["t"] for sheet in manifests for frame in sheet["frames"]]
    end = result["end_seconds"]
    return {"sheets": sheets, "sheet_manifest": manifests, "timestamps": timestamps,
            "frames_scanned": result["frames_scanned"], "frames_selected": len(timestamps),
            "duration_seconds": duration, "start_seconds": start, "end_seconds": round(end, 2),
            "partial": start > 0 or duration is None or end < duration - 0.5,
            "sampling": "dsh-see-now original createPipeline (offline, queueDepth=0)",
            "upstream_revision": result["upstream_revision"], "upstream_stats": result["stats"],
            "pipeline_options": result["pipeline_options"], "sheet_limit_reached": result["sheet_limit_reached"],
            "audio_analyzed": False}
