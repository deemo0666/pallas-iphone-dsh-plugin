"""Collect license texts for every Go module linked into pallas-mesh-node."""
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent
env = {**os.environ, "GOOS": "darwin", "GOFLAGS": "-mod=readonly"}
listing = subprocess.check_output(
    ["go", "list", "-deps", "-f", "{{with .Module}}{{.Path}}\t{{.Version}}\t{{.Dir}}{{end}}", "./node"],
    cwd=root, env=env, text=True)
modules = sorted({tuple(line.split("\t")) for line in listing.splitlines() if line.strip()})
goroot = Path(subprocess.check_output(["go", "env", "GOROOT"], env=env, text=True).strip())
go_version = subprocess.check_output(["go", "env", "GOVERSION"], env=env, text=True).strip()

parts = ["pallas-mesh-node — third-party notices\n\n"
         "pallas-mesh-node is built from Tools/PallasMesh and statically links the Go modules below.\n"
         "Neither this program nor its branding is affiliated with Tailscale Inc.\n"]

def section(title, directory):
    files = sorted(p for pattern in ("LICENSE*", "LICENCE*", "COPYING*", "NOTICE*", "PATENTS*")
                   for p in directory.glob(pattern) if p.is_file())
    if not files:
        raise SystemExit(f"Missing license text: {title}")
    parts.append(f"\n{'=' * 72}\n{title}\n")
    for path in files:
        parts.append(f"\n{path.name}\n{path.read_text(errors='replace')}\n")

section(f"Go standard library {go_version}", goroot)
for path, version, directory in modules:
    if path == "pallas/mesh":
        continue
    section(f"{path} {version}", Path(directory))
Path(sys.argv[1]).write_text("".join(parts))
