#!/usr/bin/env python3
"""Pin tools/mlx-requirements.in for pip --require-hashes (tools/mlx-host.sh).

    python3 tools/mlx-lock.py > tools/mlx-requirements.txt

Runs on any machine: pip resolves and downloads the wheels a Mac with Apple
silicon would get (macOS 14, 15 and 26 tags, CPython 3.12 and 3.13) into a
temporary directory, and every package gets one line with the sha256 of each
of its wheels. A package whose version differs between the Python versions
gets a line per version with a python_version marker.

pip download --platform evaluates dependency markers for the machine it runs
on, not for the Mac: mlx's `mlx-metal; platform_system == "Darwin"` was left
out on Linux, and pip on the Mac then refused the lock (no hash for
mlx-metal). So the wheels' own Requires-Dist are evaluated here for macOS on
arm64, and whatever a Mac would need but pip skipped is downloaded too, until
nothing is missing.
"""

import hashlib
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from collections import defaultdict

try:
    from packaging.requirements import Requirement
except ImportError:  # pip carries its own copy
    from pip._vendor.packaging.requirements import Requirement

HERE = os.path.dirname(os.path.abspath(__file__))
PLATFORMS = ["macosx_14_0_arm64", "macosx_15_0_arm64", "macosx_26_0_arm64"]
PYTHONS = ["3.12", "3.13"]


def norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def mac_env(py: str) -> dict:
    """The marker environment of a Mac with Apple silicon running CPython `py`."""
    return {"python_version": py, "python_full_version": py + ".0", "sys_platform": "darwin",
            "platform_system": "Darwin", "platform_machine": "arm64", "os_name": "posix",
            "implementation_name": "cpython", "platform_python_implementation": "CPython",
            "extra": ""}


def requires(wheel: str):
    """The Requires-Dist lines of a wheel's METADATA."""
    with zipfile.ZipFile(wheel) as z:
        meta = next(n for n in z.namelist() if n.endswith(".dist-info/METADATA"))
        for line in z.read(meta).decode("utf-8", "replace").splitlines():
            if line.startswith("Requires-Dist:"):
                yield line.split(":", 1)[1].strip()


def download(plat: str, py: str, src: str, cdir: str) -> None:
    """Download what a Mac with `plat` and CPython `py` installs, markers judged for the Mac."""
    extra = {}
    while True:
        cmd = [sys.executable, "-m", "pip", "download", "--quiet", "--disable-pip-version-check",
               "--only-binary=:all:", "--platform", plat, "--python-version", py,
               "--implementation", "cp", "-d", cdir, "-r", src]
        subprocess.run(cmd + sorted(extra.values()), check=True, stdout=sys.stderr)
        have = {norm(f.split("-")[0]) for f in os.listdir(cdir) if f.endswith(".whl")}
        missing = {}
        for f in os.listdir(cdir):
            if not f.endswith(".whl"):
                continue
            for line in requires(os.path.join(cdir, f)):
                r = Requirement(line)
                if r.marker is not None and not r.marker.evaluate(mac_env(py)):
                    continue
                if norm(r.name) not in have and norm(r.name) not in extra:
                    missing[norm(r.name)] = r.name + str(r.specifier)
        if not missing:
            return
        print("for %s, CPython %s, pip skipped (a marker judged on this machine): %s"
              % (plat, py, ", ".join(sorted(missing.values()))), file=sys.stderr)
        extra.update(missing)


def main() -> int:
    src = os.path.join(HERE, "mlx-requirements.in")
    with tempfile.TemporaryDirectory() as tmp:
        wdir = os.path.join(tmp, "all")
        os.mkdir(wdir)
        for plat in PLATFORMS:
            for py in PYTHONS:
                cdir = os.path.join(tmp, plat + "-" + py)
                os.mkdir(cdir)
                download(plat, py, src, cdir)
                for f in os.listdir(cdir):
                    os.replace(os.path.join(cdir, f), os.path.join(wdir, f))
        cp = {"cp" + p.replace(".", ""): p for p in PYTHONS}
        by = defaultdict(lambda: {"hashes": set(), "pys": set()})
        for f in sorted(os.listdir(wdir)):
            if not f.endswith(".whl"):
                sys.exit("not a wheel (an sdist would need building on the Mac): " + f)
            parts = f[:-4].split("-")
            name, version, pytag = parts[0], parts[1], parts[-3]
            if pytag.startswith("cp3") and pytag not in cp and "abi3" not in f:
                continue
            used = set(PYTHONS) if not pytag.startswith("cp3") or "abi3" in f else {cp[pytag]}
            with open(os.path.join(wdir, f), "rb") as fh:
                h = hashlib.sha256(fh.read()).hexdigest()
            by[(norm(name), version)]["hashes"].add(h)
            by[(norm(name), version)]["pys"] |= used
    versions = defaultdict(list)
    for (name, version), v in by.items():
        versions[name].append((version, v))
    print("# Generated by tools/mlx-lock.py from tools/mlx-requirements.in: the wheels pip")
    print("# picks for macOS arm64 (" + ", ".join(PLATFORMS) + "), CPython " + ", ".join(PYTHONS) + ".")
    print("# tools/mlx-host.sh installs it with --require-hashes. Do not edit by hand.")
    for name in sorted(versions):
        for version, v in sorted(versions[name]):
            marker = ""
            if len(versions[name]) > 1:
                marker = " ; " + " or ".join('python_version == "%s"' % p for p in sorted(v["pys"]))
            lines = ["--hash=sha256:" + h for h in sorted(v["hashes"])]
            print("%s==%s%s \\\n    %s" % (name, version, marker, " \\\n    ".join(lines)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
