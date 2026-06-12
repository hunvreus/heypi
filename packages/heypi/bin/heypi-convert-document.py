"""Convert one local document to Markdown using Microsoft MarkItDown.

Input: exactly one local file path.
Output: Markdown on stdout.
Failures: diagnostics on stderr and a non-zero exit code.
Side effects: imports MarkItDown after reducing the inherited environment.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

MARKITDOWN_PACKAGE = "markitdown[pdf,docx,pptx,xlsx]==0.1.6"
DEFAULT_EXTENSIONS = {
    ".doc",
    ".docx",
    ".epub",
    ".pdf",
    ".ppt",
    ".pptx",
    ".xls",
    ".xlsx",
}
DEFAULT_MAX_BYTES = 10_000_000
DEFAULT_MAX_OUTPUT_BYTES = 1_000_000


def fail(message: str, code: int = 1) -> None:
    print(f"heypi-convert-document: {message}", file=sys.stderr)
    raise SystemExit(code)


def parse_int_env(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    try:
        parsed = int(value)
    except ValueError:
        fail(f"{name} must be an integer")
    if parsed <= 0:
        fail(f"{name} must be greater than zero")
    return parsed


def parse_extensions() -> set[str]:
    value = os.environ.get("HEYPI_CONVERT_EXTENSIONS")
    if not value:
        return DEFAULT_EXTENSIONS
    extensions = set()
    for item in value.split(","):
        ext = item.strip().lower()
        if not ext:
            continue
        extensions.add(ext if ext.startswith(".") else f".{ext}")
    return extensions or DEFAULT_EXTENSIONS


def scrub_environment() -> None:
    keep = {
        "HOME",
        "PATH",
        "TMPDIR",
        "TEMP",
        "TMP",
        "SYSTEMROOT",
        "UV_CACHE_DIR",
        "WINDIR",
        "XDG_CACHE_HOME",
    }
    clean = {key: value for key, value in os.environ.items() if key in keep}
    os.environ.clear()
    os.environ.update(clean)


def run_with_uv(path: Path) -> None:
    uv = os.environ.get("HEYPI_CONVERT_UV", "uv")
    script = Path(__file__).resolve()
    command = [
        uv,
        "run",
        "--with",
        os.environ.get("HEYPI_CONVERT_MARKITDOWN_PACKAGE", MARKITDOWN_PACKAGE),
        "python",
        str(script),
        str(path),
    ]
    env = {**os.environ, "HEYPI_CONVERT_NO_UV": "1"}
    try:
        completed = subprocess.run(command, check=False, env=env)
    except FileNotFoundError:
        fail("MarkItDown is not available and uv was not found")
    raise SystemExit(completed.returncode)


def setup() -> None:
    uv = os.environ.get("HEYPI_CONVERT_UV", "uv")
    package = os.environ.get("HEYPI_CONVERT_MARKITDOWN_PACKAGE", MARKITDOWN_PACKAGE)
    command = [
        uv,
        "run",
        "--with",
        package,
        "python",
        "-c",
        "from markitdown import MarkItDown; MarkItDown(enable_plugins=False)",
    ]
    try:
        completed = subprocess.run(command, check=False)
    except FileNotFoundError:
        try:
            from markitdown import MarkItDown
        except Exception as error:
            fail(f"uv was not found and MarkItDown is not available: {error}")
        MarkItDown(enable_plugins=False)
        print("ok: MarkItDown ready from the current Python environment")
        return
    if completed.returncode != 0:
        fail("failed to set up MarkItDown")
    print(f"ok: MarkItDown ready via {uv} ({package})")


def convert(path: Path) -> None:
    extensions = parse_extensions()
    max_bytes = parse_int_env("HEYPI_CONVERT_MAX_BYTES", DEFAULT_MAX_BYTES)
    max_output_bytes = parse_int_env("HEYPI_CONVERT_MAX_OUTPUT_BYTES", DEFAULT_MAX_OUTPUT_BYTES)

    if path.is_symlink():
        fail("refusing to convert a symlink")
    if not path.is_file():
        fail("input is not a regular file")
    if path.suffix.lower() not in extensions:
        fail(f"unsupported extension: {path.suffix or '<none>'}")
    size = path.stat().st_size
    if size > max_bytes:
        fail(f"input is too large: {size} bytes > {max_bytes} bytes")

    scrub_environment()

    try:
        from markitdown import MarkItDown
    except Exception as error:
        if os.environ.get("HEYPI_CONVERT_NO_UV") == "1":
            fail(f"MarkItDown is not available: {error}")
        run_with_uv(path)

    try:
        md = MarkItDown(enable_plugins=False)
        result = md.convert_local(str(path))
        markdown = result.text_content
    except Exception as error:
        fail(f"conversion failed: {error}")

    encoded = markdown.encode("utf-8")
    if len(encoded) > max_output_bytes:
        fail(f"output is too large: {len(encoded)} bytes > {max_output_bytes} bytes")
    sys.stdout.write(markdown)


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "--setup":
        setup()
        return
    if len(sys.argv) != 2:
        fail("expected exactly one local file path")
    convert(Path(sys.argv[1]))


if __name__ == "__main__":
    main()
