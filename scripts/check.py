"""Run every enforcement gate. Exit non-zero if any gate fails. CI runs this; agents run it before handing back.

Gates:
  compiler  TypeScript 7 with the Effect language service (effect-tsgo), each package against its role's settings
            in arch/tsconfig/: no DOM or Node.js in logic, strict, every Effect diagnostic in tsconfig.effect.json
  lint      oxlint, type-aware (vite.config.ts and arch/lint): no any, `as` or `!`, exhaustive switches, awaited
            promises, imports inside the module shape, no ambient declarations or module state, no skipped tests
  deps      every installed package from the npm registry, with an allowed license (scripts/deps.py)
  arch      the package graph against the module shape (arch/shape.json), config files, suppression comments
  settings  the enforcement settings in effect (compiler, Effect diagnostics, lint, tests, workspace, CODEOWNERS)
            match arch/settings.json (scripts/settings.py)
  tests     every unit and property test (vp test, the `unit` project); a skipped or todo test fails; and the
            scripts' own tests (scripts/test_*.py, unittest)
  verify    the feature map is complete, and every journey passes against the built app (scripts/verify.py)

Before the gates, the locked packages are installed (pnpm install --frozen-lockfile) if anything changed. Each gate's
output is printed when it fails, followed by its result and time; a summary in gate order comes last.

Every run is recorded against the git tree of the files it saw (scripts/handback.py, observe mode: it never blocks).

Usage: python3 scripts/check.py [--only GATE ...]
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import argparse
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from arch import findings as arch_findings  # noqa: E402
from handback import record_check, snapshot  # noqa: E402
from settings import findings as settings_findings  # noqa: E402
from tools import abort_active, defer_signals, handle_termination, install, node_env, reset_abort, run_group  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
GATES = ['compiler', 'lint', 'deps', 'arch', 'settings', 'tests', 'verify']


def run(cmd: list[str], env: dict) -> tuple[bool, str]:
    proc = run_group(cmd, ROOT, env)
    return proc.returncode == 0, (proc.stdout + proc.stderr).strip()


def has_code(package: Path) -> bool:
    """Whether the package has a TypeScript file where its role's tsconfig looks (src/ and tests/)."""
    return any(p.suffix in ('.ts', '.tsx') for folder in ('src', 'tests') for p in (package / folder).rglob('*'))


def tsconfigs() -> list[Path]:
    """Every package's tsconfig.json, plus the journeys'. A package with no code yet (an app's fixtures before its
    first fixture) has nothing to compile, and the compiler fails on a project with no inputs, so it's left out."""
    shape = json.loads((ROOT / 'arch/shape.json').read_text())
    found = [p for role in shape['roles'].values() for folder in role['folders'] for p in ROOT.glob(f'{folder}/tsconfig.json')
             if has_code(p.parent)]
    return sorted(found + [p for p in [ROOT / 'apps/desktop/journeys/tsconfig.json'] if p.is_file()])


def compiler(env: dict) -> tuple[bool, str]:
    def one(config: Path) -> tuple[bool, str]:
        ok, output = run(['effect-tsgo', 'tsc', '-p', str(config.relative_to(ROOT))], env)
        # Effect's suggestions are advice, not failures (the exit code says which).
        return ok, '\n'.join(l for l in output.splitlines() if ': suggestion TS' not in l)
    configs = tsconfigs()
    reset_abort()
    pool = ThreadPoolExecutor(max_workers=min(2, max(1, len(configs))))
    futures = []
    try:
        for config in configs:
            futures.append(pool.submit(one, config))
        results = [future.result() for future in futures]
    except BaseException:
        with defer_signals(reraise=False, clear_pending=True):
            abort_active()
            for future in futures:
                future.cancel()
            pool.shutdown(wait=True, cancel_futures=True)
        raise
    else:
        pool.shutdown(wait=True)
    return all(ok for ok, _ in results), '\n'.join(output for _, output in results if output)


def tests(env: dict) -> tuple[bool, str]:
    """Every unit test runs and passes: a test Vitest skipped or left as todo fails the gate, however it was marked
    (lint catches `.skip`; this catches options like `{ skip: true }` too)."""
    # A report of its own: another check.py in this checkout must not overwrite it.
    (ROOT / '.build').mkdir(exist_ok=True)
    handle, name = tempfile.mkstemp(prefix='unit-results-', suffix='.json', dir=ROOT / '.build')
    os.close(handle)
    report = Path(name)
    report.unlink()
    ok, output = run(['vp', 'test', 'run', '--project', 'unit', '--reporter=default', '--reporter=json',
                      f'--outputFile.json={report}'], env)
    if not report.is_file():
        return False, output
    results = json.loads(report.read_text())
    report.unlink()
    skipped = [f'{suite["name"]}: {test["fullName"]} ({test["status"]})'
               for suite in results.get('testResults', [])
               for test in suite.get('assertionResults', []) if test.get('status') not in ('passed', 'failed')]
    if skipped:
        return False, '\n'.join([output, '[tests-always-run] every test runs; these didn\'t:', *skipped,
                                 'If a test can\'t pass, fix the code or the test, or stop and report.'])
    scripts_ok, scripts_output = run([sys.executable, '-m', 'unittest', 'discover', '-s', 'scripts', '-p', 'test_*.py'], env)
    return ok and scripts_ok, '\n'.join([output, scripts_output])


def gate(name: str, env: dict) -> tuple[bool, str]:
    if name == 'compiler':
        return compiler(env)
    if name == 'lint':
        # One output format everywhere: oxlint otherwise picks one from the environment (agent, GitHub, terminal).
        return run(['vp', 'lint', '--deny-warnings', '--format', 'agent'], env)
    if name == 'deps':
        return run([sys.executable, str(ROOT / 'scripts/deps.py')], env)
    if name == 'arch':
        found = arch_findings()
        return not found, '\n'.join(found)
    if name == 'settings':
        found = settings_findings(env)
        return not found, '\n'.join(found)
    if name == 'tests':
        return tests(env)
    return run([sys.executable, str(ROOT / 'scripts/verify.py'), 'run'], env)


def check(selected: list[str]) -> list[str]:
    env = node_env()
    install(env)  # may update pnpm-lock.yaml, so it runs before the record's snapshot
    before = snapshot(ROOT)  # observe mode: a run counts only for files that didn't change while it ran
    results: dict[str, bool] = {}
    for name in selected:
        started = time.monotonic()
        ok, output = gate(name, env)
        results[name] = ok
        if not ok and output:
            print(output)
        print(f'{"PASS" if ok else "FAIL"} {name}  ({time.monotonic() - started:.0f}s)', flush=True)
    if len(selected) > 1:
        print('Summary: ' + ', '.join(f'{n} {"PASS" if results[n] else "FAIL"}' for n in selected), flush=True)
    failed = [n for n in selected if not results[n]]
    record_check(ROOT, selected, failed, before)  # observe mode: lets scripts/handback.py tell whether hand-backs were checked
    return failed


if __name__ == '__main__':
    handle_termination()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--only', action='append', choices=GATES)
    chosen = parser.parse_args().only or GATES
    try:
        failed = check([g for g in GATES if g in chosen])
    except KeyboardInterrupt:
        sys.exit('\nStopped.')  # an interrupted run isn't a check, so it isn't recorded
    sys.exit(1 if failed else 0)
