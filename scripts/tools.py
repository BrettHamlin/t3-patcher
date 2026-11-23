"""Pinned tools: Node.js and pnpm from tools.toml (downloaded, SHA-256-verified), and the packages in pnpm-lock.yaml.

Everything goes to $BSTACK_TOOLS_DIR if set, else <cache folder>/tools if one is configured (see paths.py), else
.tools/. That includes pnpm's package store. Installed packages (node_modules/.pnpm, Electron's binary) live in .build/,
a link into the cache folder, so nothing large lands in the project. Nothing is installed globally.

Usage: python3 scripts/tools.py <tool-name>     print the tool's path, downloading it first if needed
       python3 scripts/tools.py install         install the packages in pnpm-lock.yaml, and Electron's binary
"""
from pathlib import Path
import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import cache_root, link_build_dirs, project_cache  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


def tools_dir() -> Path:
    if os.environ.get('BSTACK_TOOLS_DIR'):
        return Path(os.environ['BSTACK_TOOLS_DIR'])
    cache = cache_root()
    return cache / 'tools' if cache else ROOT / '.tools'


def tool_path(name: str) -> Path:
    spec = tomllib.loads((ROOT / 'tools.toml').read_text())[name]
    home = tools_dir() / f'{name}-{spec["version"]}'
    binary = home / spec['binary']
    if binary.is_file():
        return binary
    # Several runs (other checkouts too) share this folder: one downloads at a time, into a staging folder that is
    # renamed into place only once verified and unpacked, so no one sees a half-written tool.
    home.parent.mkdir(parents=True, exist_ok=True)
    with (home.parent / f'{name}.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if binary.is_file():
            return binary
        staging = Path(tempfile.mkdtemp(dir=home.parent, prefix=f'.{name}-'))
        try:
            archive = staging / spec['url'].rsplit('/', 1)[-1]
            with urllib.request.urlopen(spec['url']) as response, archive.open('wb') as out:
                shutil.copyfileobj(response, out)
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            if digest != spec['sha256']:
                sys.exit(f'{name}: checksum mismatch (expected {spec["sha256"]}, got {digest}). Refusing to use it.')
            unpacked = staging / 'tool'
            with tarfile.open(archive) as tar:
                tar.extractall(unpacked, filter='data')
            (unpacked / spec['binary']).chmod(0o755)
            if home.exists():
                shutil.rmtree(home)  # a partial folder from a run that crashed before this lock existed
            unpacked.rename(home)
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    return binary


def node_env() -> dict:
    """The environment for every Node and pnpm command: the pinned node and pnpm first on PATH, pnpm's store in the
    tools folder, installed packages in .build/ (linked into the cache folder), and no telemetry or global config."""
    link_build_dirs(ROOT)
    node, pnpm = tool_path('node'), tool_path('pnpm')
    env = {k: v for k, v in os.environ.items() if not k.lower().startswith(('npm_config_', 'pnpm_config_'))}
    env.update({
        'PATH': os.pathsep.join([str(ROOT / 'node_modules/.bin'), str(node.parent), str(pnpm.parent), env.get('PATH', '')]),
        'COREPACK_ENABLE_STRICT': '0',
        'pnpm_config_store_dir': str(tools_dir() / 'pnpm-store'),
        # The real path: pnpm refuses a virtual store reached through the .build link.
        'pnpm_config_virtual_store_dir': str((project_cache(ROOT) or ROOT / '.build') / 'pnpm'),
        'pnpm_config_update_notifier': 'false',
        # Electron's install.js downloads its binary here and checks it against the package's checksums.json.
        'electron_config_cache': str(tools_dir() / 'electron-cache'),
        # electron-builder's own downloads (installer tools such as NSIS and appimagetool, each pinned by its version
        # with a checksum) go to the tools folder too.
        'ELECTRON_BUILDER_CACHE': str(tools_dir() / 'electron-builder-cache'),
        'NO_UPDATE_NOTIFIER': '1',
        'DO_NOT_TRACK': '1',
    })
    return env


def electron_dist(target: str) -> Path:
    """Electron's unpacked binary for another platform ('darwin-x64', 'win32-x64', 'linux-x64'), at the version the
    lockfile installed: downloaded from Electron's releases into the tools folder and checked against the SHA-256 in
    the locked package's checksums.json. For packaging only."""
    package = ROOT / 'apps/desktop/node_modules/electron'
    version = json.loads((package / 'package.json').read_text())['version']
    archive = f'electron-v{version}-{target}.zip'
    expected = json.loads((package / 'checksums.json').read_text()).get(archive)
    if expected is None:
        sys.exit(f'Electron {version} has no {archive} in its checksums.json.')
    home = tools_dir() / 'electron-dist' / archive.removesuffix('.zip')
    if (home / '.complete').is_file():
        return home
    home.parent.mkdir(parents=True, exist_ok=True)
    with (home.parent / f'{target}.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if (home / '.complete').is_file():
            return home
        staging = Path(tempfile.mkdtemp(dir=home.parent, prefix=f'.{target}-'))
        try:
            zipped = staging / archive
            url = f'https://github.com/electron/electron/releases/download/v{version}/{archive}'
            with urllib.request.urlopen(url) as response, zipped.open('wb') as out:
                shutil.copyfileobj(response, out)
            digest = hashlib.sha256(zipped.read_bytes()).hexdigest()
            if digest != expected:
                sys.exit(f'{archive}: checksum mismatch (expected {expected}, got {digest}). Refusing to use it.')
            unpacked = staging / 'dist'
            # ditto keeps the symlinks and permissions inside the archive; zipfile does not.
            subprocess.run(['ditto', '-x', '-k', str(zipped), str(unpacked)], check=True)
            (unpacked / '.complete').write_text(digest)
            if home.exists():
                shutil.rmtree(home)
            unpacked.rename(home)
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    return home


def install(env: dict) -> None:
    """Install the packages in pnpm-lock.yaml, updating it if a package.json changed (with $CI set, refusing to change
    it instead), then Electron's binary if it's missing."""
    # In CI the lockfile must already match every package.json: pnpm doesn't freeze it by itself with these flags.
    frozen = ['--frozen-lockfile'] if os.environ.get('CI', '').lower() not in ('', '0', 'false') else []
    proc = subprocess.run(['pnpm', 'install', '--prefer-offline', '--reporter=append-only', *frozen], cwd=ROOT,
                          env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit(f'pnpm install failed:\n{(proc.stdout + proc.stderr).strip()[-3000:]}')
    # Electron's install.js downloads the binary into the tools folder and checks it against the checksums.json in the
    # locked package.
    for package in sorted(ROOT.glob('apps/*/node_modules/electron')):
        if (package / 'path.txt').is_file() and (package / 'dist').is_dir():
            continue
        proc = subprocess.run(['node', 'install.js'], cwd=package, env=env, capture_output=True, text=True)
        if proc.returncode != 0:
            sys.exit(f'Electron install failed:\n{(proc.stdout + proc.stderr).strip()[-3000:]}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    if sys.argv[1] == 'install':
        install(node_env())
    else:
        print(tool_path(sys.argv[1]))
