"""A patch's version goes up whenever its published content changes. Compares the patches folder at HEAD with a base
ref: each patch whose changes.patch, or patch.json other than `version`, differs from the base's must have a greater
version at HEAD. A new patch is fine at any version from 1; a deleted one is fine. A patch.json without `version` is
version 1. Prints one line per patch that breaks this and exits 1.

Usage: python3 scripts/check_patch_versions.py <base ref> [--repo <folder>]    (CI: origin/<base branch>)
"""
from pathlib import Path
import argparse
import json
import subprocess
import sys

FOLDER = 'patches'


def git(repo: Path, *args: str) -> str:
    return subprocess.run(['git', *args], cwd=repo, capture_output=True, text=True, check=True).stdout


def patch_ids(repo: Path, ref: str) -> set[str]:
    """The patch folders under patches/ at `ref`."""
    listed = git(repo, 'ls-tree', '-d', '--name-only', f'{ref}:{FOLDER}') if has(repo, ref, FOLDER) else ''
    return {name for name in listed.splitlines() if name}


def has(repo: Path, ref: str, path: str) -> bool:
    return subprocess.run(['git', 'cat-file', '-e', f'{ref}:{path}'], cwd=repo, capture_output=True).returncode == 0


def read(repo: Path, ref: str, path: str) -> str | None:
    return git(repo, 'show', f'{ref}:{path}') if has(repo, ref, path) else None


def manifest(repo: Path, ref: str, patch: str) -> dict:
    text = read(repo, ref, f'{FOLDER}/{patch}/patch.json')
    return json.loads(text) if text is not None else {}


def version(found: dict) -> object:
    return found.get('version', 1)


def content(found: dict) -> dict:
    """patch.json without `version`: what the version describes."""
    return {key: value for key, value in found.items() if key != 'version'}


def is_version(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 1


def problems(repo: Path, base: str) -> list[str]:
    """One line per patch at HEAD whose version doesn't follow its changes since `base`."""
    base_name = base.removeprefix('origin/')
    before = patch_ids(repo, base)
    found = []
    for patch in sorted(patch_ids(repo, 'HEAD')):
        now = manifest(repo, 'HEAD', patch)
        if not is_version(version(now)):
            found.append(f'{patch}: version must be a whole number from 1, not {json.dumps(version(now))}')
            continue
        if patch not in before:
            continue
        then = manifest(repo, base, patch)
        diff = f'{FOLDER}/{patch}/changes.patch'
        changed = read(repo, 'HEAD', diff) != read(repo, base, diff) or content(now) != content(then)
        previous = version(then)
        if changed and is_version(previous) and version(now) <= previous:
            found.append(f'{patch}: changed but version is still {version(now)} ({base_name} has {previous})')
    return found


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('base')
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1])
    options = parser.parse_args()
    lines = problems(options.repo, options.base)
    print('\n'.join(lines) if lines else f'patch versions: every changed patch is newer than in {options.base}')
    sys.exit(1 if lines else 0)
