"""Vendor an immutable upstream revision without rewriting its source files."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

PATCHES = "LOCAL-PATCHES.json"


def apply_local_patches(root: Path) -> int:
    """Re-apply the recorded local edits on top of freshly written upstream files.

    UPSTREAM.json keeps the pristine hash of every fetched file, so the edits live
    in their own list and are replayed here after each fetch. A patch that no longer
    matches upstream stops the update instead of producing a file whose hash silently
    disagrees with the recorded revision.
    """
    path = root / PATCHES
    if not path.exists():
        return 0
    patches = json.loads(path.read_text(encoding="utf-8"))["patches"]
    for name, patch in patches.items():
        target = root / name
        text = target.read_bytes().decode("utf-8")
        if text.count(patch["upstream"]) != 1:
            raise ValueError(f"{name}: the recorded patch in {PATCHES} no longer applies to this revision; "
                             "re-read the fetched file, update its upstream/local text, then rerun")
        target.write_bytes(text.replace(patch["upstream"], patch["local"]).encode("utf-8"))
    return len(patches)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("revision", help="Full 40-character dsh-see-now commit SHA")
    revision = parser.parse_args().revision
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        parser.error("an immutable full commit SHA is required")
    root = Path(__file__).resolve().parents[1] / "third_party" / "dsh-see-now"
    url = f"https://codeload.github.com/SAOS-3624/dsh-see-now/zip/{revision}"
    with urllib.request.urlopen(url, timeout=60) as response:
        archive = response.read(64 * 1024 * 1024 + 1)
    if len(archive) > 64 * 1024 * 1024:
        raise ValueError("upstream archive exceeded size limit")
    files = {}
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        for entry in bundle.infolist():
            parts = PurePosixPath(entry.filename).parts[1:]
            if not parts or entry.is_dir() or ".." in parts:
                continue
            if parts[0] not in {"src", "test", "package.json", "LICENSE", "NOTICE", "README.md"}:
                continue
            relative = PurePosixPath(*parts).as_posix()
            content = bundle.read(entry)
            target = root.joinpath(*parts)
            if not target.resolve().is_relative_to(root.resolve()):
                raise ValueError("invalid archive path")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            files[relative] = hashlib.sha256(content).hexdigest()
    patched = apply_local_patches(root)
    # Updates may remove files; only remove previously recorded vendor files.
    lock = root / "UPSTREAM.json"
    if lock.exists():
        previous = json.loads(lock.read_text(encoding="utf-8"))
        for name in previous.get("files", {}):
            path = root / name
            if name not in files and path.resolve().is_relative_to(root.resolve()):
                path.unlink(missing_ok=True)
    lock.write_text(json.dumps({"repository": "https://github.com/SAOS-3624/dsh-see-now",
                               "revision": revision, "files": files}, indent=2) + "\n", encoding="utf-8")
    print(f"Vendored {len(files)} files at {revision} with {patched} recorded local patch(es)")


if __name__ == "__main__":
    main()
