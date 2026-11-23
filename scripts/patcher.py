"""Run T3 Patcher's command line (apps/desktop/src/cli.ts) with the pinned Node.js, building it first if the sources
changed since the last build. Arguments go through unchanged.

Usage: python3 scripts/patcher.py <command> [--userdata <folder>] ...    (python3 scripts/patcher.py help lists them)
"""
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build import build  # noqa: E402
from tools import install, node_env  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'apps/desktop/dist/cli.cjs'
SOURCES = ['apps/desktop/src', 'apps/web/src', 'packages', 'pnpm-lock.yaml']


def stale() -> bool:
    """Whether the built CLI is missing or older than any source it's built from."""
    if not CLI.is_file():
        return True
    built = CLI.stat().st_mtime
    for name in SOURCES:
        source = ROOT / name
        files = [source] if source.is_file() else (p for p in source.rglob('*') if p.is_file() and 'node_modules' not in p.parts)
        if any(p.stat().st_mtime > built for p in files):
            return True
    return False


if __name__ == '__main__':
    env = node_env()
    if stale():
        install(env)
        failed = build(env)
        if failed:
            sys.exit(failed)
    sys.exit(subprocess.run(['node', str(CLI), *sys.argv[1:]], env=env).returncode)
