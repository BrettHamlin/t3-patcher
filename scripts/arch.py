"""The arch gate: the package graph and manifests against the module shape (arch/shape.json), then checks over every
source file that lint can't be trusted with. Prints `[rule-id] where: message` per finding; exits 1 if there are any.

Packages and manifests:
  module-boundaries      every package is in a role's folder; pnpm-workspace.yaml lists exactly the shape's folders;
                         each dependency on another package is one its role may use; no `imports` or export outside src/
  allowed-dependencies   a third-party package is on the role's `external` list (`dev_external` for devDependencies),
                         pinned to an exact version
  no-suppressions        each package's tsconfig.json only extends its role's config in arch/tsconfig/; no other
                         lint, test or TypeScript config files; no .npmrc or pnpmfile
  no-fixtures-in-release a test-setup role (dev_only) is only a devDependency of the roles that may use it
  tests-always-run       no package.json scripts; every file in tests/ is a *.test.ts(x) or under tests/support/
  no-io-in-logic         no JavaScript or .d.ts files: everything is TypeScript the compiler checks against its role
Source: suppression comments (eslint-/oxlint-disable, @ts-ignore/-expect-error/-nocheck, @effect-diagnostics), which
oxlint can't be trusted to report: a disable-all comment switches off a rule that bans it.

Usage: python3 scripts/arch.py
"""
from fnmatch import fnmatch
from pathlib import Path
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
SKIP = {'node_modules', 'dist', '.build', '.tools', '.git'}
EXACT = re.compile(r'^\d+\.\d+\.\d+$')
PACKAGE_KEYS = {'name', 'private', 'type', 'exports', 'main', 'dependencies', 'devDependencies'}
SUPPRESSION = re.compile(r'(?:eslint|oxlint)-(?:disable|enable)|@ts-(?:ignore|expect-error|nocheck)|@effect-diagnostics'
                         r'|/\*\s*(?:eslint|global|globals|exported)\s')
CONFIG = re.compile(r'^(?:tsconfig.*\.json|\.?oxlintrc.*|oxlint\.config\..*|\.eslintrc.*|eslint\.config\..*'
                    r'|vitest\.config\..*|vite\.config\..*|vitest\.workspace\..*|\.npmrc|\.pnpmfile\.c?js|pnpmfile\..*)$')
# Config files the owner placed (code-owned): the apps' build configs and the journeys' TypeScript config.
ALLOWED_CONFIG = {'apps/desktop/vite.config.ts', 'apps/web/vite.config.ts', 'apps/desktop/journeys/tsconfig.json',
                  # The root's own: the settings gate checks what they say.
                  'vite.config.ts', 'tsconfig.base.json', 'tsconfig.effect.json'}
SOURCE_SUFFIXES = ('.ts', '.tsx', '.mts', '.cts')


def files(folder: Path):
    # Build output and tools only where they really are: node_modules anywhere, the rest at the root or as an app's
    # own build (apps/<app>/dist). A folder with one of those names deeper in a package is checked like any other.
    for path in sorted(folder.rglob('*')):
        rel = path.relative_to(ROOT)
        skipped = 'node_modules' in rel.parts or rel.parts[0] in SKIP or (
            len(rel.parts) > 2 and rel.parts[0] == 'apps' and rel.parts[2] == 'dist')
        if path.is_file() and not skipped:
            yield path, rel


def in_folder(rel: Path, pattern: str) -> bool:
    parts = pattern.split('/')
    return len(rel.parts) == len(parts) and all(fnmatch(p, q) for p, q in zip(rel.parts, parts))


def workspace_globs() -> list[str]:
    text = (ROOT / 'pnpm-workspace.yaml').read_text()
    block = re.search(r'^packages:\n((?:[ \t]+-.*\n?)+)', text, re.M)
    return [re.sub(r'^[\s-]+', '', l).strip().strip('"\'') for l in block.group(1).splitlines()] if block else []


def findings() -> list[str]:
    out: list[str] = []
    shape = json.loads((ROOT / 'arch/shape.json').read_text())
    roles: dict = shape['roles']
    folders = [f for role in roles.values() for f in role['folders']]
    if sorted(workspace_globs()) != sorted(folders):
        out.append(f'[module-boundaries] pnpm-workspace.yaml: `packages` must be exactly the shape\'s folders '
                   f'({", ".join(folders)}). Never edit it; put packages in those folders.')

    # Every package.json outside the root is a package, and must be in a role's folder.
    packages: dict[Path, tuple[str, dict]] = {}
    names: dict[str, Path] = {}
    for path, rel in files(ROOT):
        if path.name != 'package.json' or rel == Path('package.json'):
            continue
        folder = rel.parent
        role = next((name for name, r in roles.items() if any(in_folder(folder, f) for f in r['folders'])), None)
        if role is None:
            out.append(f'[module-boundaries] {folder}: not in any role\'s folder in arch/shape.json '
                       f'({", ".join(folders)}). Move the package into one; if none fits, stop and report.')
            continue
        try:
            manifest = json.loads(path.read_text())
        except json.JSONDecodeError as error:
            out.append(f'[module-boundaries] {rel}: invalid JSON: {error}')
            continue
        packages[folder] = (role, manifest)
        names[manifest.get('name', '')] = folder

    for folder, (role, manifest) in sorted(packages.items()):
        spec = roles[role]
        where = f'{folder}/package.json'
        expected_name = f'{shape["scope"]}/{folder.name}'
        if manifest.get('name') != expected_name:
            out.append(f'[module-boundaries] {where}: name must be "{expected_name}" (the scope and the folder\'s name).')
        if 'scripts' in manifest:
            out.append(f'[tests-always-run] {where}: no `scripts`. The gates (scripts/check.py) build, test and verify '
                       'every package; install scripts would run code at install time.')
        for key in sorted(set(manifest) - PACKAGE_KEYS - {'scripts'}):
            out.append(f'[module-boundaries] {where}: `{key}` isn\'t allowed (only {", ".join(sorted(PACKAGE_KEYS))}).')
        exports = manifest.get('exports', {})
        targets = exports.values() if isinstance(exports, dict) else [exports]
        for target in targets:
            if not (isinstance(target, str) and target.startswith('./src/') and '..' not in target):
                out.append(f'[module-boundaries] {where}: every export must be a file in ./src/, not {target!r}.')
        for section in ('dependencies', 'devDependencies'):
            allowed = set(spec['external']) | (set(spec['dev_external']) if section == 'devDependencies' else set())
            for name, version in sorted(manifest.get(section, {}).items()):
                if name.startswith(f'{shape["scope"]}/'):
                    target = names.get(name)
                    target_role = packages[target][0] if target in packages else None
                    dev_only = target_role is not None and roles[target_role].get('dev_only', False)
                    if target_role is None:
                        out.append(f'[module-boundaries] {where}: {name} isn\'t a package in this workspace.')
                    elif dev_only and (section == 'dependencies' or target_role not in spec.get('dev_may_use', [])):
                        users = ', '.join(r for r, s in roles.items() if target_role in s.get('dev_may_use', [])) or 'none'
                        out.append(f'[no-fixtures-in-release] {where}: {name} ({target_role}) is test setup: only '
                                   f'devDependencies of {users} packages, for their journeys and tests, never code the app '
                                   'ships. Compose real services in the app; if a fixture seems needed there, stop and report.')
                    elif version != 'workspace:*' or (section == 'devDependencies' and not dev_only):
                        out.append(f'[module-boundaries] {where}: {name} goes in dependencies as "workspace:*".')
                    elif dev_only:
                        pass
                    elif target_role not in spec['may_use']:
                        may = ', '.join(spec['may_use']) or 'no other package'
                        out.append(f'[module-boundaries] {where}: a {role} package can\'t depend on {name} ({target_role}). '
                                   f'A {role} package may use: {may} (arch/shape.json). Move the code to a package that '
                                   'may use it, or pass what you need in through contracts; if the link seems necessary, '
                                   'stop and report.')
                elif name not in allowed:
                    out.append(f'[allowed-dependencies] {where}: "{name}" isn\'t allowed in a {role} package\'s '
                               f'{section}. Write the code without it, or stop and report which package you need and why: '
                               f'adding one needs the owner (arch/shape.json lists what each role may use).')
                elif not EXACT.match(version):
                    out.append(f'[allowed-dependencies] {where}: "{name}" must be pinned to an exact version, not '
                               f'"{version}".')
        expected = f'{"../" * len(folder.parts)}arch/tsconfig/{role}.json'
        tsconfig = ROOT / folder / 'tsconfig.json'
        try:
            found = json.loads(tsconfig.read_text()) if tsconfig.is_file() else None
        except json.JSONDecodeError:
            found = 'invalid'
        if found != {'extends': expected}:
            out.append(f'[no-suppressions] {folder}/tsconfig.json: must be exactly {{ "extends": "{expected}" }}, so the '
                       f'package gets its role\'s compiler settings. Fix the code the compiler objects to; never change '
                       'its settings.')

    for path, rel in files(ROOT):
        # Any other one, at the root too: a vitest.config.ts or .oxlintrc.json there would be read instead of, or as
        # well as, vite.config.ts.
        if CONFIG.match(path.name) and str(rel) not in ALLOWED_CONFIG \
                and not (path.name == 'tsconfig.json' and rel.parent in packages) and rel.parts[0] != 'arch':
            out.append(f'[no-suppressions] {rel}: lint, test, compiler and package-manager settings live only in the '
                       'protected root files and arch/. Remove this file.')
        package = next((f for f in packages if rel.is_relative_to(f)), None)
        if package is not None:
            inner = rel.relative_to(package)
            if path.suffix in ('.js', '.mjs', '.cjs', '.jsx', '.mts', '.cts') or path.name.endswith(('.d.ts', '.d.tsx')):
                out.append(f'[no-io-in-logic] {rel}: only TypeScript (.ts, .tsx), so the compiler and lint check every file '
                           'against its role. Write it as TypeScript; never declare types for code that isn\'t there.')
            if inner.parts[0] == 'tests' and path.suffix in SOURCE_SUFFIXES and inner.parts[1:2] != ('support',) \
                    and not re.search(r'\.test\.tsx?$', path.name):
                out.append(f'[tests-always-run] {rel}: files in tests/ are *.test.ts(x), which the tests gate runs, or '
                           'helpers in tests/support/.')
        if path.suffix in SOURCE_SUFFIXES and rel.parts[0] != 'arch':
            for number, line in enumerate(path.read_text().splitlines(), 1):
                if SUPPRESSION.search(line):
                    out.append(f'[no-suppressions] {rel}:{number}: suppression comments aren\'t allowed. Fix the '
                               'underlying issue. If the rule is wrong here, stop and report; a human changes the '
                               'protected settings.')
    return out


if __name__ == '__main__':
    found = findings()
    print('\n'.join(found) if found else 'arch: every package is inside the module shape')
    sys.exit(1 if found else 0)
