"""Where large, regenerable files go: build output, package checkouts, downloaded tools.

If a cache folder is configured, they go there and the project's .build/ (and Tuist/.build/) become links into it.
Configure it with $BSTACK_CACHE_DIR, or `cache_dir = "/path"` in ~/.config/b-stack/config.toml.
With nothing configured, everything stays inside the project (the default for a fresh clone).
The same file holds per-machine settings, read by machine_setting(): `rule_jobs` and `verify_workers` (see
scripts/test_rules.py and scripts/verify.py). They describe the machine, so set them by hand after measuring there.
A configured folder that doesn't exist (e.g. an unmounted drive) is an error: never fall back to the internal drive.
"""
from pathlib import Path
import hashlib
import os
import shutil
import sys
import tomllib

CONFIG = Path.home() / '.config/b-stack/config.toml'


def cache_root() -> Path | None:
    configured = os.environ.get('BSTACK_CACHE_DIR')
    source = '$BSTACK_CACHE_DIR'
    if not configured and CONFIG.is_file():
        configured = tomllib.loads(CONFIG.read_text()).get('cache_dir')
        source = str(CONFIG)
    if not configured:
        return None
    root = Path(configured).expanduser()
    if not root.is_dir():
        sys.exit(f'Cache folder {root} (from {source}) is not available. Is its drive mounted? '
                 'Refusing to put build output anywhere else.')
    return root


def machine_setting(name: str, default: int) -> int:
    """An integer setting for this machine from ~/.config/b-stack/config.toml, else `default`."""
    value = tomllib.loads(CONFIG.read_text()).get(name, default) if CONFIG.is_file() else default
    if not isinstance(value, int) or value < 1:
        sys.exit(f'{name} in {CONFIG} must be a whole number of at least 1, not {value!r}.')
    return value


def project_cache(project: Path) -> Path | None:
    root = cache_root()
    if root is None:
        return None
    project = project.resolve()
    key = f'{project.name}-{hashlib.sha256(str(project).encode()).hexdigest()[:8]}'
    return root / 'projects' / key


def link_build_dirs(project: Path) -> None:
    """Point the project's build folders into the cache folder, if one is configured."""
    cache = project_cache(project)
    if cache is None:
        return
    links = {'.build': 'build'}
    if (project / 'Tuist/Package.swift').is_file():
        links['Tuist/.build'] = 'tuist-build'
    for link, target in links.items():
        path, destination = project / link, cache / target
        destination.mkdir(parents=True, exist_ok=True)
        if path.is_symlink():
            if path.resolve() == destination.resolve():
                continue
            path.unlink()
        elif path.exists():
            shutil.rmtree(path)  # regenerable build output; the cache folder replaces it
        path.symlink_to(destination, target_is_directory=True)
