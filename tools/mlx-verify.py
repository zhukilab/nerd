"""Check an MLX model directory against its files.json (tools/mlx-host.sh).

    python3 tools/mlx-verify.py <model-dir>

files.json, as the Bonsai packs ship it: {"<path>": {"sha256": ..., "size": ...}}.
Every file it lists must be there with that size and sha256; prints one line
per file checked and exits 1 on the first that is not. Without a files.json
it says so and exits 2 (nothing to check against).
"""

import hashlib
import json
import os
import sys


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 24), b""):
            h.update(block)
    return h.hexdigest()


def main() -> int:
    root = sys.argv[1]
    listing = os.path.join(root, "files.json")
    if not os.path.isfile(listing):
        print(f"no files.json in {root}: its files cannot be checked")
        return 2
    with open(listing, encoding="utf-8") as f:
        files = json.load(f)
    for rel, want in sorted(files.items()):
        path = os.path.join(root, rel)
        if not os.path.isfile(path):
            print(f"MISSING {rel}")
            return 1
        size = os.path.getsize(path)
        if size != want["size"]:
            print(f"SIZE    {rel}: {size}, want {want['size']}")
            return 1
        got = sha256(path)
        if got != want["sha256"]:
            print(f"SHA256  {rel}: {got}, want {want['sha256']}")
            return 1
        print(f"ok      {rel}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
