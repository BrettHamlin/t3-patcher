"""Build the desktop app's installers with electron-builder for each platform, then prove each one runs.

  1. build the app (scripts/build.py) and stage it alone: its bundled code and a package.json, no node_modules
  2. electron-builder for each target, from the locked Electron (another platform's binary is downloaded and checked
     against the locked package's checksums.json, scripts/tools.py): a .dmg and a .zip for macOS (the zip is what
     auto-update downloads), an NSIS installer for Windows, an AppImage for Linux, each with the unpacked app beside it
  3. on this Mac, the verify gate's journeys and checks against the Apple silicon app ($BSTACK_PACKAGED_APP), then
     scripts/smoke.mjs against the app inside the .dmg; the Intel macOS app gets scripts/smoke.mjs under Rosetta (whose
     first launch translates Electron and is too slow for a journey's time limit). Windows and Linux installers are
     proved on those systems (scripts/install_and_smoke.py; CI runs it).

Targets: mac-arm64 (default), mac-x64, win-x64, win-arm64, linux-x64, linux-arm64; --all for every one.
Version: the root package.json's `version`, or --version X.Y.Z.

Updates: with $BSTACK_UPDATE_URL set (a folder served over HTTPS, or http://127.0.0.1 for a test), the app checks it
at <url>/<target>/ at start, downloads a newer version and installs it on quit (electron-updater). Each target's update
files (its latest*.yml, installer and blockmap) are in .build/package/out/update/<target>/: publish a version by
uploading .build/package/out/update/ as is, so each target's files land in <url>/<target>/.

Signing: macOS with $CSC_LINK (a .p12 Developer ID Application certificate, or its base64) and $CSC_KEY_PASSWORD,
with the hardened runtime, and notarized when $APPLE_ID, $APPLE_APP_SPECIFIC_PASSWORD and $APPLE_TEAM_ID are set too.
Windows with $WIN_CSC_LINK (a .pfx code-signing certificate) and $WIN_CSC_KEY_PASSWORD: the app and its installer.
A signed build that comes out unsigned fails. Linux packages aren't signed.

Output: .build/package/out/: the installers, each unpacked app, and update/<target>/ (see Updates).

Usage: python3 scripts/package.py [--all | TARGET ...] [--version X.Y.Z] [--no-journeys]
"""
from pathlib import Path
import json
import shutil
import struct
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build import DIST, build  # noqa: E402
from tools import electron_dist, install, node_env  # noqa: E402
import verify  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.build/package'
# The app's icon. Built on a Mac, a Windows uninstaller only passes NSIS's integrity check when it has the installer's
# icon: electron-builder writes it without running Windows, and doesn't swap the icon in. With this icon both use one
# file; without it NSIS's two default icons differ, and every update and reinstall stops on "Failed to uninstall".
ICON = ROOT / 'apps/desktop/resources/icon.png'
# target: (electron-builder platform flag, arch flag, Electron release name, unpacked folder, executable in it)
TARGETS = {
    'mac-arm64': ('--mac', '--arm64', None, 'mac-arm64', '{name}.app/Contents/MacOS/{name}'),
    'mac-x64': ('--mac', '--x64', 'darwin-x64', 'mac', '{name}.app/Contents/MacOS/{name}'),
    'win-x64': ('--win', '--x64', 'win32-x64', 'win-unpacked', '{name}.exe'),
    'win-arm64': ('--win', '--arm64', 'win32-arm64', 'win-arm64-unpacked', '{name}.exe'),
    'linux-x64': ('--linux', '--x64', 'linux-x64', 'linux-unpacked', '{name}'),
    'linux-arm64': ('--linux', '--arm64', 'linux-arm64', 'linux-arm64-unpacked', '{name}'),
}
MAC_SIGNING = ('CSC_LINK', 'CSC_KEY_PASSWORD')
WIN_SIGNING = ('WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD')
NOTARIZING = ('APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID')
SKIPPED = ('skipped macOS application code signing', 'code signing will be skipped', 'signing is skipped')


def run(cmd: list[str], env: dict, cwd: Path = ROOT) -> str:
    proc = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit(f'`{" ".join(cmd[:3])} ...` failed:\n{(proc.stdout + proc.stderr).strip()[-4000:]}')
    return proc.stdout + proc.stderr


def has(env: dict, keys: tuple[str, ...]) -> bool:
    return all(env.get(key) for key in keys)


def stage(name: str, version: str) -> Path:
    shutil.rmtree(OUT, ignore_errors=True)
    folder = OUT / 'stage'
    shutil.copytree(DIST, folder / 'dist')
    (folder / 'package.json').write_text(json.dumps({'name': name, 'productName': name, 'version': version,
                                                     'main': 'dist/main.cjs', 'private': True}, indent=2))
    return folder


def config(name: str, target: str, env: dict) -> dict:
    electron = ROOT / 'apps/desktop/node_modules/electron'
    release = TARGETS[target][2]
    mac: dict = {'target': ['dmg', 'zip']}
    if has(env, MAC_SIGNING):
        mac |= {'hardenedRuntime': True, 'notarize': has(env, NOTARIZING)}
    else:
        mac['identity'] = None
    settings = {
        'appId': f'dev.bstack.{name}', 'productName': name, 'executableName': name,
        'artifactName': '${productName}-${version}-' + target + '.${ext}',
        'electronVersion': json.loads((electron / 'package.json').read_text())['version'],
        'electronDist': str(electron_dist(release) if release else electron / 'dist'),
        'npmRebuild': False, 'files': ['dist/**/*', 'package.json'],
        'directories': {'output': str(OUT / 'out'), 'buildResources': str(ICON.parent)},
        'mac': mac,
        'win': {'target': ['nsis'], 'signAndEditExecutable': has(env, WIN_SIGNING)},
        'nsis': {'oneClick': True, 'perMachine': False},
        'linux': {'target': ['AppImage'], 'category': 'Utility'},
    }
    if env.get('BSTACK_UPDATE_URL'):
        # One feed per target: Windows x64 and arm64 both name theirs latest.yml.
        settings['publish'] = [{'provider': 'generic', 'url': f'{env["BSTACK_UPDATE_URL"].rstrip("/")}/{target}/'}]
    return settings


def authenticode_size(path: Path) -> int:
    """The size of a Windows executable's certificate table: 0 when it isn't signed."""
    head = path.read_bytes()[:4096]
    pe = struct.unpack_from('<I', head, 0x3c)[0]
    optional = pe + 24
    directories = optional + (112 if struct.unpack_from('<H', head, optional)[0] == 0x20b else 96)
    return struct.unpack_from('<II', head, directories + 4 * 8)[1]


def check_signed(target: str, output: str, unpacked: Path, installers: list[Path], env: dict) -> None:
    if target.startswith('mac') and has(env, MAC_SIGNING):
        if any(skip in output for skip in SKIPPED):
            # electron-builder skips an identity macOS doesn't trust, and pull-request builds, and still succeeds.
            reason = next(line.strip() for line in output.splitlines() if any(skip in line for skip in SKIPPED))
            sys.exit(f'{target}: $CSC_LINK is set but the app wasn\'t signed:\n{reason}')
        app = next(unpacked.glob('*.app'))
        proc = subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], capture_output=True, text=True)
        if proc.returncode != 0:
            said = [line.strip() for line in output.splitlines() if any(w in line.lower() for w in ('sign', 'identity', 'keychain'))]
            sys.exit(f'{target}: the app isn\'t validly signed: {proc.stderr.strip()}\nelectron-builder said:\n' + '\n'.join(said))
    if target.startswith('win') and has(env, WIN_SIGNING):
        # Whether a signature is valid is checked on Windows (CI); here, that there is one on each executable.
        unsigned = [p for p in [*unpacked.glob('*.exe'), *installers] if p.suffix == '.exe' and not authenticode_size(p)]
        if unsigned:
            sys.exit(f'{target}: $WIN_CSC_LINK is set but these aren\'t signed: {", ".join(p.name for p in unsigned)}')


def package(env: dict, targets: list[str], version: str) -> dict[str, Path]:
    if not ICON.is_file():
        sys.exit(f'{ICON.relative_to(ROOT)} is missing. The app needs an icon (512x512 PNG): without one, the Windows '
                 f'uninstaller fails its integrity check and every update stops on "Failed to uninstall".')
    failed = build(env)
    if failed:
        sys.exit(failed)
    name = json.loads((ROOT / 'package.json').read_text())['name']
    folder = stage(name, version)
    builder = ROOT / 'apps/desktop/node_modules/.bin/electron-builder'
    executables = {}
    for target in targets:
        platform, arch, _, unpacked, executable = TARGETS[target]
        settings = OUT / f'electron-builder-{target}.json'
        settings.write_text(json.dumps(config(name, target, env), indent=2))
        builder_env = {**env, 'CSC_IDENTITY_AUTO_DISCOVERY': 'true' if has(env, MAC_SIGNING) and target.startswith('mac') else 'false'}
        if not target.startswith('mac'):
            # electron-builder signs Windows with CSC_LINK when WIN_CSC_LINK is unset: never with the Apple certificate.
            for key in MAC_SIGNING:
                builder_env.pop(key, None)
        output = run([str(builder), platform, arch, '--projectDir', str(folder), '--config', str(settings),
                      '--publish', 'never'], builder_env)
        path = OUT / 'out' / unpacked / executable.format(name=name)
        installers = [p for p in sorted((OUT / 'out').glob(f'{name}-{version}-{target}.*'))
                      if p.suffix in ('.dmg', '.zip', '.exe', '.AppImage')]
        if not path.is_file() or not installers:
            sys.exit(f'electron-builder left no {path} or installer for {target}')
        check_signed(target, output, OUT / 'out' / unpacked, installers, env)
        # Each target's update feed on its own: Windows x64 and arm64 builds both write latest.yml.
        feed = OUT / 'out/update' / target
        feed.mkdir(parents=True, exist_ok=True)
        for yml in (OUT / 'out').glob('latest*.yml'):
            yml.rename(feed / yml.name)
        for file in installers + [p.with_name(p.name + '.blockmap') for p in installers]:
            if file.is_file():
                shutil.copy2(file, feed / file.name)
        print(f'packaged {target}: {", ".join(p.name for p in installers)}', flush=True)
        executables[target] = path
    return executables


def journeys(env: dict, target: str, executable: Path) -> list[str]:
    """The verify gate's checks (map, every mapped journey ran once and passed, screenshots) on a packaged app."""
    verify.EVIDENCE = ROOT / '.build/evidence' / target
    shutil.rmtree(verify.EVIDENCE, ignore_errors=True)
    features, errors = verify.verified_map()
    if errors:
        return errors
    verify.EVIDENCE.mkdir(parents=True)
    return verify.run({**env, 'BSTACK_PACKAGED_APP': str(executable), 'BSTACK_EVIDENCE': str(verify.EVIDENCE)},
                      features, build_first=False)


def smoke(env: dict, executable: Path, evidence: str) -> str:
    folder = ROOT / '.build/evidence' / evidence
    shutil.rmtree(folder, ignore_errors=True)  # only this run's screenshots
    proc = subprocess.run(['node', 'scripts/smoke.mjs', str(executable), str(ROOT / 'apps/desktop'), str(folder)],
                          cwd=ROOT, env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit(f'{evidence}: the smoke test failed:\n{(proc.stdout + proc.stderr).strip()[-3000:]}')
    return proc.stdout.strip()


def smoke_dmg(env: dict, name: str, version: str) -> str:
    """The app as a user gets it: mounted from the .dmg, read-only."""
    image = OUT / 'out' / f'{name}-{version}-mac-arm64.dmg'
    mount = Path(tempfile.mkdtemp(prefix='dmg-'))
    run(['hdiutil', 'attach', '-nobrowse', '-readonly', '-mountpoint', str(mount), str(image)], env)
    try:
        return smoke(env, mount / f'{name}.app/Contents/MacOS/{name}', 'mac-arm64-dmg')
    finally:
        subprocess.run(['hdiutil', 'detach', str(mount)], capture_output=True)


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if a != '--no-journeys']
    version = json.loads((ROOT / 'package.json').read_text())['version']
    if '--version' in args:
        at = args.index('--version')
        version, args = args[at + 1], args[:at] + args[at + 2:]
    chosen = list(TARGETS) if '--all' in args else [a for a in args if a != '--all'] or ['mac-arm64']
    unknown = [t for t in chosen if t not in TARGETS]
    if unknown:
        sys.exit(f'unknown target {", ".join(unknown)}; targets: {", ".join(TARGETS)}\n\n{__doc__}')
    env = node_env()
    install(env)
    executables = package(env, chosen, version)
    if '--no-journeys' not in sys.argv[1:]:
        name = json.loads((ROOT / 'package.json').read_text())['name']
        for target, executable in executables.items():
            if target == 'mac-arm64':
                errors = journeys(env, target, executable)
                if errors:
                    sys.exit('\n'.join(errors + [f'The {target} app failed its journeys.']))
                print(f'{target}: every journey passed against the app. Evidence: {verify.EVIDENCE / "evidence.md"}')
                print(f'{target} .dmg: {smoke_dmg(env, name, version)}')
            elif target == 'mac-x64':
                print(f'mac-x64 (Rosetta): {smoke(env, executable, "mac-x64")}')
            else:
                print(f'{target}: prove it on that system with scripts/install_and_smoke.py (CI does)')
