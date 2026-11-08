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
from urllib.parse import unquote_plus, urlsplit, urlunsplit

from .network_security import check_url, public_addresses

VIDEO_SUFFIXES = {".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".flv", ".mpeg", ".mpg"}


class VideoError(ValueError):
    pass


def normalize_source(source: str) -> str:
    """Accept share text and Markdown without rewriting arbitrary signed URLs."""
    source = source.strip()
    if source.startswith("neko-video:") or Path(source).is_absolute():
        return source
    # Prefer the target, not the display label (which may itself be a URL).
    markdown = re.findall(r"\[[^\]\r\n]*\]\(<?(https?://[^\s<>]+?)>?\)", source, re.I)
    if markdown:
        urls = markdown
    elif source.lower().startswith(("https://", "http://")) and not re.search(r"\s", source):
        urls = [source]
    else:
        urls = re.findall(r"https?://[^\s<>\"\[\]【】]+", source, re.I)
        urls = [url.rstrip("，。；！）") for url in urls]
    if not urls:
        return source
    normalized = []
    for url in urls:
        url = url.replace(r"\&", "&")
        parts = urlsplit(url)
        # Do not discard credentials/ports or transform a lookalike host.
        if parts.netloc.lower() in {"www.bilibili.com", "bilibili.com", "m.bilibili.com"}:
            tracking = {"trackid", "spm_id_from", "vd_source", "share_source", "share_medium",
                        "share_plat", "share_session_id", "share_tag", "timestamp"}
            query = "&".join(item for item in parts.query.split("&")
                             if unquote_plus(item.split("=", 1)[0]) not in tracking)
            url = urlunsplit(parts._replace(query=query))
        if url not in normalized:
            normalized.append(url)
    if len(normalized) != 1:
        raise VideoError("消息中有多个不同的视频链接，请一次只发送一个视频。")
    return normalized[0]


def registered_pythons() -> list[str]:
    """Steam may retain an old PATH; also check standard Windows Python installs."""
    if os.name != "nt":
        return []
    import winreg
    paths = []
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
            try:
                with winreg.OpenKey(hive, r"SOFTWARE\Python\PythonCore", 0, winreg.KEY_READ | view) as root:
                    for index in range(winreg.QueryInfoKey(root)[0]):
                        version = winreg.EnumKey(root, index)
                        try:
                            with winreg.OpenKey(root, version + r"\InstallPath") as key:
                                try:
                                    path = winreg.QueryValueEx(key, "ExecutablePath")[0]
                                except OSError:
                                    path = str(Path(winreg.QueryValue(key, None)) / "python.exe")
                                paths.append(path)
                        except OSError:
                            continue
            except OSError:
                continue
    return paths


async def download_python(config: dict) -> tuple[str, ...]:
    """Never execute the frozen host as a Python script interpreter."""
    configured = str(config.get("python_path") or "").strip()
    candidates = []
    host = Path(sys.executable).resolve()
    host_is_python = not getattr(sys, "frozen", False) and bool(
        re.fullmatch(r"python(?:[0-9]+(?:\.[0-9]+)*)?(?:\.exe)?", host.name, re.I))
    if configured:
        path = Path(configured)
        if not path.is_absolute() or not path.is_file() or (path.resolve() == host and not host_is_python):
            raise VideoError("video.python_path 必须指向真实 Python 3.11+ 解释器的绝对路径，不能指向 N.E.K.O 主程序。")
        candidates.append((str(path),))
    else:
        if host_is_python:
            candidates.append((str(host),))
        for name in ("python", "python3"):
            if found := shutil.which(name):
                candidates.append((found,))
        if os.name == "nt" and (launcher := shutil.which("py")):
            candidates.append((launcher, "-3"))
        candidates.extend((path,) for path in registered_pythons())
    seen = set()
    probe = "import sys; print('neko-video-python-ok' if sys.version_info >= (3, 11) else 'too-old')"
    for command in candidates:
        executable = Path(command[0]).resolve()
        if command in seen or (executable == host and not host_is_python):
            continue
        seen.add(command)
        try:
            code, output, _ = await run(*command, "-I", "-c", probe, timeout=5)
        except (OSError, TimeoutError):
            continue
        if code == 0 and output.strip() == b"neko-video-python-ok":
            return command
    raise VideoError("无法启动下载器所需的 Python 3.11+。Steam 打包版的主程序不是 Python 解释器；"
                     "请安装 Python 3.11 或以上，或将 video.python_path 配置为真实 python.exe 的绝对路径。"
                     "无需安装 N.E.K.O 源码或开发环境。")


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
        # Developer convenience only. FFmpeg must never become a declared runtime
        # dependency: `sync` would copy its executable into vendor/, and the Market
        # rejects plugin packages that contain binaries.
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError):
        raise VideoError("找不到 FFmpeg：请把 ffmpeg 安装到 PATH，或把 video.ffmpeg_path 指向可执行文件。"
                         "插件包按市场规则不捆绑 FFmpeg 二进制。") from None


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
    source = normalize_source(source)
    if not source.lower().startswith(("http:", "https:")):
        return local_source(source), "本地视频"
    await validate_url(source)
    job = directory / "download.json"
    job.write_text(json.dumps({"url": source, "directory": str(directory),
                              "max_bytes": max(1, min(1024, int(config.get("max_download_mb", 256)))) * 1024 * 1024,
                              "cookies_file": str(config.get("cookies_file") or "")}), encoding="utf-8")
    interpreter = await download_python(config)
    try:
        code, _, _ = await run(*interpreter, "-I", str(Path(__file__).with_name("download_worker.py")), str(job))
    except TimeoutError as exc:
        raise VideoError("视频下载超时，请稍后重试或发送本地视频。") from exc
    except OSError as exc:
        raise VideoError("下载器进程启动失败，请检查 video.python_path 和 Python 安装。") from exc
    result_file = directory / "result.json"
    try:
        result = json.loads(result_file.read_text(encoding="utf-8"))
        if not isinstance(result, dict):
            raise ValueError("invalid result")
    except (OSError, ValueError) as exc:
        raise VideoError("下载器未返回有效结果，请检查 Python 安装和插件依赖（vendor/yt_dlp），"
                         "而不是反复修改视频链接。") from exc
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
