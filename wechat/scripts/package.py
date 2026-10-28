"""Create a standalone source archive without local settings or user data."""
from pathlib import Path
import hashlib
import json
import os
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = ["AGENTS.md", "README.md", ".gitignore", "package.json", "package-lock.json", "project.config.json"]
SOURCE_DIRS = ["cloudfunctions", "docs", "miniprogram", "scripts", "shared", "tests"]
EXCLUDED_DIRS = {"node_modules", "artifacts", "__pycache__", ".git", ".venv"}
EXCLUDED_NAMES = {"config.local.js", "project.private.config.json", ".DS_Store"}
EXCLUDED_SUFFIXES = {".pyc", ".key", ".pem", ".p12", ".pfx", ".db", ".sqlite", ".sqlite3"}


def source_files():
    for name in ROOT_FILES:
        yield ROOT / name
    for name in SOURCE_DIRS:
        for directory, names, files in os.walk(ROOT / name, followlinks=False):
            directory = Path(directory)
            for child in list(names):
                if (directory / child).is_symlink():
                    raise ValueError("Source symlinks are not packaged")
            names[:] = sorted(child for child in names if child not in EXCLUDED_DIRS and not child.startswith("."))
            for child in sorted(files):
                file = directory / child
                if child in EXCLUDED_NAMES or child.startswith(".env") or file.suffix.lower() in EXCLUDED_SUFFIXES:
                    continue
                if child.startswith(".") and child != ".dockerignore":
                    continue
                if file.is_symlink():
                    raise ValueError("Source symlinks are not packaged")
                yield file


def package():
    version = json.loads((ROOT / "package.json").read_text())["version"]
    if not isinstance(version, str) or not version or any(char not in "0123456789.-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" for char in version):
        raise ValueError("Invalid engineering version")
    destination = ROOT / "artifacts"
    destination.mkdir(exist_ok=True)
    archive = destination / ("family-glucose-wechat-engineering-" + version + ".zip")
    files = {str(file.relative_to(ROOT).as_posix()): file.read_bytes() for file in source_files()}
    # Each recipient configures their own environment. Never copy local overrides.
    files["miniprogram/config.local.js"] = b"module.exports = {};\n"
    files = dict(sorted(files.items()))
    temporary = archive.with_suffix(".zip.tmp")
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
            for relative, content in files.items():
                output.writestr("wechat/" + relative, content)
        with zipfile.ZipFile(temporary) as output:
            if output.testzip() is not None:
                raise ValueError("Archive CRC check failed")
            for relative, content in files.items():
                if output.read("wechat/" + relative) != content:
                    raise ValueError("Archive content check failed")
        temporary.replace(archive)
    finally:
        if temporary.exists(): temporary.unlink()
    manifest = {
        "archive": archive.name, "files": len(files),
        "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "sources": {relative: hashlib.sha256(content).hexdigest() for relative, content in files.items()},
    }
    (destination / "source-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"archive": str(archive), "files": len(files), "bytes": archive.stat().st_size, "integrity": "CRC and source byte checks passed"}, ensure_ascii=False))


if __name__ == "__main__":
    package()
