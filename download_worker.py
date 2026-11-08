"""Private subprocess entry for yt-dlp; never accepts command text."""
from __future__ import annotations

import json
import sys
from pathlib import Path

vendor = Path(__file__).resolve().parent / "vendor"
if vendor.is_dir():
    sys.path.insert(0, str(vendor))


def main() -> int:
    job = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    directory = Path(job["directory"])
    result = {}
    try:
        from network_security import secure_downloader

        def limit(progress):
            if progress.get("downloaded_bytes", 0) > job["max_bytes"]:
                raise ValueError("download exceeds size limit")

        options = {
            "quiet": True, "no_warnings": True, "noplaylist": True, "playlist_items": "1",
            "format": "bestvideo[height<=?720][protocol=https]/best[height<=?720][protocol=https]/bestvideo[height<=?720][protocol=http]/best[height<=?720][protocol=http]",
            "outtmpl": str(directory / "video.%(ext)s"), "max_filesize": job["max_bytes"],
            "socket_timeout": 20, "retries": 1, "fragment_retries": 1,
            "progress_hooks": [limit], "cachedir": False,
            "match_filter": lambda info, *, incomplete=False: "Live streams are unsupported" if info.get("is_live") else None,
        }
        if job.get("cookies_file"):
            options["cookiefile"] = job["cookies_file"]
        with secure_downloader(options) as downloader:
            info = downloader.extract_info(job["url"], download=True)
            if info and info.get("entries"):
                info = next((entry for entry in info["entries"] if entry), None)
            if not info:
                raise ValueError("no video")
            path = Path(downloader.prepare_filename(info))
            if not path.is_file() or path.stat().st_size > job["max_bytes"]:
                raise ValueError("missing or oversized file")
            result = {"path": str(path), "title": info.get("title", "网络视频")}
    except Exception:
        result = {"error": "无法下载该视频：可能目标不是可验证的公网地址（含代理/TUN DNS）、需要登录、超过大小限制、仅提供直播/HLS，或平台限制访问。可改发本地视频，或在插件设置配置 cookies_file。"}
    (directory / "result.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    return 0 if result.get("path") else 1


if __name__ == "__main__":
    raise SystemExit(main())
