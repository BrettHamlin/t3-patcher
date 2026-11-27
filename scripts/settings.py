"""The settings gate: the enforcement settings in effect are the ones in arch/settings.json, so weakening a check fails
here as well as in code-owner review. It reads what the tools would use, not the files' text:

  compiler    each package's options as the compiler resolves them (effect-tsgo tsc --showConfig), exactly as
              recorded for its role, and no config in its extends chain that replaces the Effect language service's
              plugin list, except the journeys' role config (plugins: [])
  effect      the Effect language service in tsconfig.effect.json: every diagnostic, override and option as recorded
  lint        vite.config.ts's lint settings as Node imports them: plugins, categories, options, ignorePatterns and
              every recorded rule unchanged; added rules may only be errors; no overrides
  test        vite.config.ts's test settings as Node imports them, unchanged
  workspace   pnpm-workspace.yaml: only the recorded keys, no hoisting, only the recorded install scripts (all off)
              and overrides; no .npmrc or pnpmfile
  codeowners  /CODEOWNERS is the only one, every rule names an owner, and it lists every enforcement path

Changing one of these on purpose means changing arch/settings.json in the same change (both are code-owned).

Usage: python3 scripts/settings.py
"""
from pathlib import Path
import json
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tools import handle_termination, install, node_env, run_group  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
FIX = ('Restore it. If the change is meant, it needs the owner: they change the setting and arch/settings.json together. '
       'Never weaken a check to make code pass; fix the code, or stop and report.')


def jsonc(path: Path) -> dict:
    return json.loads(re.sub(r'^\s*//.*$', '', path.read_text(), flags=re.M))


def extends_chain(config: Path) -> list[Path] | str:
    """A tsconfig and every config it extends, nearest first; or why it can't be followed."""
    chain: list[Path] = []
    while config not in chain:
        if not config.is_file():
            return f'extends {config.relative_to(ROOT) if config.is_relative_to(ROOT) else config}, which doesn\'t exist'
        chain.append(config)
        parent = jsonc(config).get('extends')
        if parent is None:
            return chain
        if not isinstance(parent, str):
            return f'{config.relative_to(ROOT)} extends a list of configs; extend one, so the chain can be checked'
        config = (config.parent / parent).resolve()
    return chain


def compiler_findings(env: dict, expected: dict) -> list[str]:
    out = []
    shape = json.loads((ROOT / 'arch/shape.json').read_text())
    configs = [(role, p) for role, spec in shape['roles'].items() for folder in spec['folders']
               for p in sorted(ROOT.glob(f'{folder}/tsconfig.json'))]
    configs.append(('journeys', ROOT / 'apps/desktop/journeys/tsconfig.json'))
    for role, config in configs:
        where = config.relative_to(ROOT)
        proc = run_group(['effect-tsgo', 'tsc', '--showConfig', '-p', str(where)], ROOT, env)
        if proc.returncode != 0:
            out.append(f'[protected-enforcement] {where}: the compiler couldn\'t read it: {proc.stdout + proc.stderr}')
            continue
        # Every option the compiler ends up with, exactly: an added one (noCheck, strictNullChecks: false) counts too.
        options = json.loads(proc.stdout)['compilerOptions']
        wanted = expected['roles'].get(role, {})
        for key in sorted(set(options) | set(wanted)):
            if options.get(key) != wanted.get(key):
                out.append(f'[protected-enforcement] {where}: compiler option {key} is {options.get(key)!r}, '
                           f'not {wanted.get(key)!r}. {FIX}')
        # The Effect language service comes only from tsconfig.effect.json; a `plugins` anywhere else in the chain
        # replaces it (only the journeys' role config may, with none).
        chain = extends_chain(config)
        if isinstance(chain, str):
            out.append(f'[protected-enforcement] {where}: {chain}. {FIX}')
            continue
        if ROOT / 'tsconfig.effect.json' not in chain:
            out.append(f'[protected-enforcement] {where}: doesn\'t extend tsconfig.effect.json, so the Effect language '
                       f'service doesn\'t check it. {FIX}')
        for link in chain:
            plugins = jsonc(link).get('compilerOptions', {}).get('plugins')
            allowed = link.parent == ROOT / 'arch/tsconfig' and plugins == expected['plugins'].get(link.stem)
            if plugins is not None and link != ROOT / 'tsconfig.effect.json' and not allowed:
                out.append(f'[protected-enforcement] {link.relative_to(ROOT)}: `plugins` replaces the Effect language '
                           f'service for {where}. {FIX}')
    return out


def effect_findings(expected: dict) -> list[str]:
    plugins = jsonc(ROOT / 'tsconfig.effect.json').get('compilerOptions', {}).get('plugins', [])
    actual = plugins[0] if plugins else {}
    if actual == expected:
        return []
    severity = actual.get('diagnosticSeverity', {})
    changed = sorted(k for k, v in expected.get('diagnosticSeverity', {}).items() if severity.get(k) != v)
    other = sorted(k for k in set(expected) | set(actual) if k != 'diagnosticSeverity' and expected.get(k) != actual.get(k))
    what = ', '.join([f'diagnostic {k}' for k in changed] + [f'`{k}`' for k in other]) or 'its settings'
    return [f'[protected-enforcement] tsconfig.effect.json: the Effect language service changed ({what}). {FIX}']


def vite_config(env: dict) -> tuple[dict | None, str]:
    proc = run_group(['node', '--input-type=module', '-e',
                      'process.stdout.write(JSON.stringify((await import("./vite.config.ts")).default))'],
                     ROOT, env)
    if proc.returncode != 0:
        return None, (proc.stdout + proc.stderr).strip()[-2000:]
    return json.loads(proc.stdout), ''


def severity(value: object) -> object:
    return value[0] if isinstance(value, list) and value else value


def lint_findings(actual: dict, expected: dict) -> list[str]:
    out = []
    for key in sorted(set(expected) | set(actual)):
        if key == 'rules':
            continue
        if actual.get(key) != expected.get(key):
            out.append(f'[protected-enforcement] vite.config.ts: lint `{key}` changed. {FIX}')
    rules = actual.get('rules', {})
    for rule, value in expected.get('rules', {}).items():
        if rules.get(rule) != value:
            out.append(f'[protected-enforcement] vite.config.ts: lint rule {rule} is {rules.get(rule)!r}, '
                       f'not {value!r}. {FIX}')
    for rule, value in rules.items():
        if rule not in expected.get('rules', {}) and severity(value) != 'error':
            out.append(f'[protected-enforcement] vite.config.ts: added lint rule {rule} must be an error, not '
                       f'{severity(value)!r}. {FIX}')
    return out


WORKSPACE_KEYS = {'packages', 'hoist', 'publicHoistPattern', 'allowBuilds', 'overrides'}


def workspace_findings(expected: dict) -> list[str]:
    text = (ROOT / 'pnpm-workspace.yaml').read_text()
    out = []
    # Only the recorded settings: another key (nodeLinker, shamefullyHoist, hoistPattern...) could undo them.
    # Fails closed: every top-level line is one of these keys, written plainly, or it's a finding (a quoted key, a flow
    # mapping, an anchor...).
    for line in text.splitlines():
        if line and not line[0].isspace() and not line.startswith('#'):
            key = re.match(r'([A-Za-z]+):(\s|$)', line)
            if not key or key.group(1) not in WORKSPACE_KEYS:
                out.append(f'[protected-enforcement] pnpm-workspace.yaml: `{line.strip()}` isn\'t allowed (only '
                           f'{", ".join(sorted(WORKSPACE_KEYS))}, written plainly). {FIX}')
    checks = {
        'hoist': re.search(r'^hoist:\s*false\s*$', text, re.M),
        'publicHoistPattern': re.search(r'^publicHoistPattern:\s*\[\]\s*$', text, re.M),
    }
    out += [f'[protected-enforcement] pnpm-workspace.yaml: `{key}` must be {json.dumps(expected[key])}. {FIX}'
            for key, found in checks.items() if not found]
    for section in ('allowBuilds', 'overrides'):
        block = re.search(rf'^{section}:\n((?:[ \t]+.*\n?|\s*#.*\n?)*)', text, re.M)
        entries = dict(re.findall(r'^[ \t]+["\']?([^"\'#:\s][^:#]*?)["\']?:\s*(\S.*?)\s*$', block.group(1), re.M)) if block else {}
        wanted = {k: json.dumps(v) if isinstance(v, bool) else v for k, v in expected[section].items()}
        if entries != wanted:
            out.append(f'[protected-enforcement] pnpm-workspace.yaml: `{section}` must be exactly {expected[section]}. {FIX}')
    for name in ('.npmrc', '.pnpmfile.cjs', '.pnpmfile.mjs'):
        if (ROOT / name).exists():
            out.append(f'[protected-enforcement] {name}: package-manager settings live only in pnpm-workspace.yaml. {FIX}')
    return out


def codeowners_findings(expected: list[str]) -> list[str]:
    out = [f'[protected-enforcement] {other}: GitHub reads this CODEOWNERS before the root one. Keep code owners only in '
           f'/CODEOWNERS. {FIX}' for other in ('.github/CODEOWNERS', 'docs/CODEOWNERS') if (ROOT / other).exists()]
    path = ROOT / 'CODEOWNERS'
    # An inline `#` starts a comment, which isn't an owner.
    lines = [re.sub(r'(^|\s)#.*$', '', line).strip() for line in path.read_text().splitlines()] if path.is_file() else []
    rules = [line.split() for line in lines if line]
    # A pattern with no owner removes ownership from what it matches, so every rule must name one.
    out += [f'[protected-enforcement] CODEOWNERS: `{rule[0]}` has no owner, which removes code-owner review from what '
            f'it matches. {FIX}' for rule in rules if len(rule) < 2]
    owned = {rule[0] for rule in rules if len(rule) > 1}
    missing = [p for p in expected if p not in owned]
    if missing:
        out.append(f'[protected-enforcement] CODEOWNERS: no code owner for {", ".join(missing)}. Every enforcement '
                   f'path needs one. {FIX}')
    return out


def findings(env: dict) -> list[str]:
    expected = json.loads((ROOT / 'arch/settings.json').read_text())
    config, vite_error = vite_config(env)
    out = compiler_findings(env, expected['compiler'])
    out += effect_findings(expected['effect'])
    if config is None:
        out.append(vite_error if '[no-concurrency-escapes]' in vite_error
                   else f'[protected-enforcement] vite.config.ts couldn\'t be loaded:\n{vite_error}')
    else:
        out += lint_findings(config.get('lint', {}), expected['lint'])
        if config.get('test') != expected['test']:
            out.append(f'[protected-enforcement] vite.config.ts: the test settings changed (retries, `.only`, which files '
                       f'run, fake timers). {FIX}')
    out += workspace_findings(expected['workspace'])
    out += codeowners_findings(expected['codeowners'])
    return out


if __name__ == '__main__':
    handle_termination()
    try:
        env = node_env()
        install(env)
        found = findings(env)
    except KeyboardInterrupt:
        sys.exit('\nStopped.')
    print('\n'.join(found) if found else 'settings: every enforcement setting is as recorded')
    sys.exit(1 if found else 0)
