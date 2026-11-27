"""Build the desktop app: the renderer (vp build), then the main process and preload (vp pack), with the renderer copied
into apps/desktop/dist/renderer/ so the app is one folder. verify.py runs journeys against it; package.py packages it.

Usage: python3 scripts/build.py
"""
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tools import handle_termination, install, node_env, run_group  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / 'apps/desktop/dist'


def build(env: dict) -> str | None:
    """Build the app; returns what failed, or None."""
    for cmd in (['vp', '-C', 'apps/web', 'build'], ['vp', '-C', 'apps/desktop', 'pack']):
        proc = run_group(cmd, ROOT, env)
        if proc.returncode != 0:
            return f'`{" ".join(cmd)}` failed:\n{(proc.stdout + proc.stderr).strip()[-3000:]}'
    shutil.rmtree(DIST / 'renderer', ignore_errors=True)
    shutil.copytree(ROOT / 'apps/web/dist', DIST / 'renderer')
    return None


if __name__ == '__main__':
    handle_termination()
    try:
        env = node_env()
        install(env)
        failed = build(env)
    except KeyboardInterrupt:
        sys.exit('\nStopped.')
    print(failed or f'built {DIST}')
    sys.exit(1 if failed else 0)
