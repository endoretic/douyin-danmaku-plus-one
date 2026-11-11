"""Build the unpacked-extension ZIP using Python's standard library."""
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent.parent
version = json.loads((root / "extension" / "manifest.json").read_text(encoding="utf-8"))["version"]
destination = root / "dist" / f"douyin-danmaku-plus-one-v{version}.zip"
destination.parent.mkdir(exist_ok=True)
with ZipFile(destination, "w", ZIP_DEFLATED) as archive:
    for source in sorted((root / "extension").iterdir()):
        if source.is_file():
            archive.write(source, source.relative_to(root).as_posix())
    for name in ("README.md", "LICENSE"):
        archive.write(root / name, name)
with ZipFile(destination) as archive:
    assert archive.testzip() is None
    assert json.loads(archive.read("extension/manifest.json"))["version"] == version
    for name in archive.namelist():
        assert archive.read(name) == (root / name).read_bytes(), name
print(destination)
