"""Install an installer the way a user would, then prove the installed app runs (scripts/smoke.mjs). Needs only
Python, Node.js and the pinned playwright-core (installed into the tools folder given): CI runs it on Windows and Linux
runners, and on macOS for the update check.

  Windows  the NSIS installer, silently (/S), into the user's programs folder; with --signed, Windows must also
           report a valid Authenticode signature on the installer and on the installed app (Get-AuthenticodeSignature)
  Linux    the AppImage, run in place (extracted on each run, so no FUSE is needed)
  macOS    the .dmg, mounted, its app copied out to a writable folder (an update replaces it), then detached
  --update <folder> <version> <port>: serve <folder> (a newer build's .build/package/out/update/) at the update URL the
           app was built with ($BSTACK_UPDATE_URL, http://127.0.0.1:<port>/), check the app downloads <version>, and
           that, reopened, it runs <version>

Usage: python3 scripts/install_and_smoke.py <installer> <tools folder> <evidence folder> [--signed]
                                            [--update <folder> <version> <port>]
"""
from pathlib import Path
import functools
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]


NAME = json.loads((ROOT / 'package.json').read_text())['name']  # what package.py names the app


def windows_install(installer: Path) -> Path:
    subprocess.run([str(installer), '/S'], check=True)  # waits: NSIS's silent install runs in the foreground
    return Path(os.environ['LOCALAPPDATA']) / 'Programs' / NAME / f'{NAME}.exe'


def mac_install(image: Path) -> Path:
    mount = Path(tempfile.mkdtemp(prefix='dmg-'))
    subprocess.run(['hdiutil', 'attach', '-nobrowse', '-readonly', '-mountpoint', str(mount), str(image)], check=True,
                   capture_output=True)
    try:
        bundle = next(mount.glob('*.app'))
        target = Path(tempfile.mkdtemp(prefix='Applications-')) / bundle.name
        subprocess.run(['ditto', str(bundle), str(target)], check=True)
    finally:
        subprocess.run(['hdiutil', 'detach', str(mount)], capture_output=True)
    return target / 'Contents/MacOS' / bundle.stem


def authenticode(path: Path) -> str:
    proc = subprocess.run(['powershell', '-NoProfile', '-Command',
                           f'$s = Get-AuthenticodeSignature -LiteralPath "{path}"; "$($s.Status): $($s.StatusMessage)"'],
                          capture_output=True, text=True)
    return proc.stdout.strip()


def serve(folder: Path, port: int) -> http.server.ThreadingHTTPServer:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(folder))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main(args: list[str]) -> int:
    if len(args) < 3:
        print(__doc__)
        return 2
    installer, tools, evidence = Path(args[0]).resolve(), args[1], args[2]
    signed = '--signed' in args
    update = args[args.index('--update') + 1:args.index('--update') + 4] if '--update' in args else []
    env = dict(os.environ)
    if installer.suffix == '.exe':
        app = windows_install(installer)
        if signed:
            for path in (installer, app):
                status = authenticode(path)
                print(f'Authenticode {path.name}: {status}')
                if not status.startswith('Valid:'):
                    return 1
    elif installer.suffix == '.dmg':
        app = mac_install(installer)
    elif installer.suffix == '.AppImage':
        # Installed under a name without its version, as a user keeps it: an update replaces that file in place.
        app = Path(tempfile.mkdtemp(prefix='Applications-')) / f'{NAME}.AppImage'
        shutil.copy2(installer, app)
        app.chmod(0o755)
        env['APPIMAGE_EXTRACT_AND_RUN'] = '1'
    else:
        print(f'not an installer this knows: {installer}')
        return 2
    if not app.is_file():
        print(f'the installer left no {app}')
        return 1
    server = serve(Path(update[0]).resolve(), int(update[2])) if update else None
    try:
        proc = subprocess.run(['node', str(ROOT / 'scripts/smoke.mjs'), str(app), tools, evidence, *update[1:2]], env=env)
    finally:
        if server:
            server.shutdown()
    return proc.returncode


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
