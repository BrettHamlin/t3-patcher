"""The deps gate: every installed package comes from the npm registry and has an allowed license. Which third-party
packages each role may use is the arch gate's job (arch/shape.json).

Both checks read what pnpm itself reports it installed (`pnpm list --long`), so they see pnpm-lock.yaml exactly as
pnpm reads it, whatever its text looks like.
  sources    every package was resolved from https://registry.npmjs.org/: no git, URL or folder dependencies
             (workspace packages are linked, not resolved). pnpm checks each download against the lockfile's hash.
  licenses   each installed copy's own license: shipped dependencies (each package's `dependencies`, all the way
             down) are permissive; build and test tools (devDependencies) may also be MPL-2.0 or WTFPL, which never
             ship. An SPDX `OR` needs one allowed choice; `AND` needs all.

Usage: python3 scripts/deps.py
"""
from pathlib import Path
import json
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tools import install, node_env  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = 'https://registry.npmjs.org/'
PERMISSIVE = {'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0',
              'Unlicense', 'Zlib', 'Python-2.0'}
TOOLS_ALSO = {'MPL-2.0', 'WTFPL'}


def installed(env: dict, prod: bool) -> list[dict]:
    """Every installed copy of a third-party package (name, version, path, resolved, license), from `pnpm list`.
    Workspace packages are the app's own and are left out; optional packages for other platforms aren't installed."""
    proc = subprocess.run(['pnpm', 'list', '--recursive', '--json', '--long', '--depth', 'Infinity',
                           *(['--prod'] if prod else [])], cwd=ROOT, env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit(f'pnpm list failed:\n{(proc.stdout + proc.stderr).strip()[-2000:]}')
    found: dict[str, dict] = {}
    sections = ('dependencies', 'optionalDependencies') + (() if prod else ('devDependencies',))

    def walk(node: dict) -> None:
        for name, dependency in [item for section in sections for item in (node.get(section) or {}).items()]:
            path, version = dependency.get('path', ''), str(dependency.get('version', ''))
            if path in found or version.startswith('link:') or not (Path(path) / 'package.json').is_file():
                continue
            manifest = json.loads((Path(path) / 'package.json').read_text())
            license = manifest.get('license')
            if not isinstance(license, str):
                legacy = manifest.get('licenses')
                license = ' OR '.join(l.get('type', '?') for l in legacy) if isinstance(legacy, list) else 'none'
            found[path] = {'name': name, 'version': version, 'path': path, 'license': license,
                           'resolved': str(dependency.get('resolved', ''))}
            walk(dependency)

    for importer in json.loads(proc.stdout or '[]'):
        walk(importer)
    return list(found.values())


def allowed(license: str, accepted: set[str]) -> bool:
    """Whether an SPDX expression can be met with accepted licenses: OR needs one side, AND both, AND binds tighter,
    parentheses group. `WITH <exception>` keeps the license it modifies."""
    tokens = license.replace('(', ' ( ').replace(')', ' ) ').split()
    position = 0

    def take() -> str:
        nonlocal position
        position += 1
        return tokens[position - 1] if position <= len(tokens) else ''

    def peek() -> str:
        return tokens[position] if position < len(tokens) else ''

    def name(token: str) -> str:
        if not token or token in ('(', ')', 'AND', 'OR', 'WITH'):
            raise ValueError(f'malformed license expression: {license!r}')
        return token

    def term() -> bool:
        token = take()
        if token == '(':
            ok = any_of()
            if take() != ')':
                raise ValueError(f'malformed license expression: {license!r}')
            return ok
        if peek() == 'WITH':
            take()
            name(take())
        return name(token) in accepted

    def all_of() -> bool:
        ok = term()
        while peek() == 'AND':
            take()
            ok = term() and ok
        return ok

    def any_of() -> bool:
        ok = all_of()
        while peek() == 'OR':
            take()
            ok = all_of() or ok
        return ok

    try:
        result = any_of()
    except ValueError:
        return False  # a syntax error makes the whole expression unknown
    return result and position == len(tokens)


def findings(env: dict) -> list[str]:
    out = []
    every, shipped = installed(env, prod=False), installed(env, prod=True)
    for package in sorted(every, key=lambda p: (p['name'], p['version'])):
        if not package['resolved'].startswith(REGISTRY):
            source = package['resolved'] or package['version']
            out.append(f'[allowed-dependencies] {package["name"]}@{package["version"]} comes from {source}. Packages '
                       'come only from the npm registry: no git, URL or folder dependencies.')
    for license in sorted(l for l in {p['license'] for p in shipped} if not allowed(l, PERMISSIVE)):
        names = sorted({p['name'] for p in shipped if p['license'] == license})
        out.append(f'[allowed-dependencies] {", ".join(names)}: license {license} isn\'t allowed in shipped '
                   f'dependencies (allowed: {", ".join(sorted(PERMISSIVE))}). Stop and report: the owner decides.')
    # Each installed copy by itself: a tool's version of a package isn't covered by a shipped version's license.
    shipped_paths = {p['path'] for p in shipped}
    tools = [p for p in every if p['path'] not in shipped_paths]
    for license in sorted(l for l in {p['license'] for p in tools} if not allowed(l, PERMISSIVE | TOOLS_ALSO)):
        names = sorted({p['name'] for p in tools if p['license'] == license})
        out.append(f'[allowed-dependencies] {", ".join(names)}: license {license} isn\'t allowed, even for build and '
                   f'test tools (allowed: {", ".join(sorted(PERMISSIVE | TOOLS_ALSO))}). Stop and report.')
    return out


if __name__ == '__main__':
    env = node_env()
    install(env)
    found = findings(env)
    print('\n'.join(found) if found else 'deps: every package is from the registry with an allowed license')
    sys.exit(1 if found else 0)
