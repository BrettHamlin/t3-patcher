"""The verify gate: every feature is in the feature map, and every journey it names passes against the built app.

Map check (feature-map/*.toml):
  - every package in packages/features/ is in exactly one feature's `modules`, and every module named is such a package
  - each journey has a `name` and a `proves`, and no journey is named twice (in one feature or across features)
Run: the renderer and the desktop app are built (vp build, vp pack), then the journeys run: the top-level tests in
apps/desktop/journeys/*.journey.ts, each launching the built Electron app through Playwright.
  - every journey there is in the map, and every journey in the map is there (one that never runs fails)
  - a journey fails if it doesn't pass or saves no screenshot (journeys/support/app.ts `checkpoint`)
Evidence (screenshots per journey, and evidence.md listing them) goes to .build/evidence/latest/.

Explore (not proof): `look` builds the app, opens it on a data folder (kept in .build/look/data between looks; --data
names another; --fresh starts a new, empty one), runs the steps given, and saves a screenshot and every element's test
id and text to .build/look/.

Usage: python3 scripts/verify.py [map|run]     (default: run, which does the map check first)
       python3 scripts/verify.py look [--data FOLDER | --fresh] [fill <test id> <text> | click <test id>]...
"""
from pathlib import Path
import json
import shutil
import sys
import tempfile
import tomllib

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build import build  # noqa: E402
from paths import machine_setting  # noqa: E402
from tools import handle_termination, install, node_env, run_group  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / '.build/evidence/latest'
JOURNEYS = 'apps/desktop/journeys'


def load_map() -> tuple[list[dict], list[str]]:
    features, errors = [], []
    for path in sorted((ROOT / 'feature-map').glob('*.toml')):
        try:
            entry = tomllib.loads(path.read_text())
        except tomllib.TOMLDecodeError as error:
            errors.append(f'[verified-features] feature-map/{path.name}: invalid TOML: {error}')
            continue
        entry['file'] = f'feature-map/{path.name}'
        features.append(entry)
    return features, errors


def verified_map() -> tuple[list[dict], list[str]]:
    features, errors = load_map()
    return features, errors + map_errors(features)


def map_errors(features: list[dict]) -> list[str]:
    errors = []
    packages = sorted(p.parent.name for p in (ROOT / 'packages/features').glob('*/package.json'))
    claimed: dict[str, str] = {}
    for feature in features:
        where = feature['file']
        for key in ('id', 'summary', 'modules', 'journeys'):
            if key not in feature:
                errors.append(f'[verified-features] {where}: missing `{key}`')
        for module in feature.get('modules', []):
            if module not in packages:
                errors.append(f'[verified-features] {where}: module `{module}` isn\'t a feature package '
                              f'(packages/features/{module}). Name the feature packages this feature is made of.')
            elif module in claimed:
                errors.append(f'[verified-features] {where}: module `{module}` is already in {claimed[module]}')
            else:
                claimed[module] = where
        if not feature.get('journeys'):
            errors.append(f'[verified-features] {where}: no journeys. Each feature needs at least one journey that '
                          'runs the app and shows the feature working.')
        for journey in feature.get('journeys', []):
            if not journey.get('name') or not journey.get('proves'):
                errors.append(f'[verified-features] {where}: each journey needs a `name` and what it `proves`')
    for package in packages:
        if package not in claimed:
            errors.append(f'[verified-features] packages/features/{package} isn\'t in the feature map. Add '
                          f'feature-map/<id>.toml naming it in `modules`, with journeys in {JOURNEYS}/ that prove it '
                          'works in the app.')
    seen: dict[str, str] = {}
    for feature in features:
        for journey in feature.get('journeys', []):
            name = journey.get('name')
            if name in seen:
                errors.append(f'[verified-features] {feature["file"]}: journey `{name}` is already named in {seen[name]}')
            elif name:
                seen[name] = feature['file']
    return errors


def verify_workers(env: dict) -> int:
    raw = env.get('BSTACK_VERIFY_WORKERS')
    if raw is not None and raw != '':
        if not raw.isdigit() or int(raw) < 1:
            sys.exit(f'$BSTACK_VERIFY_WORKERS must be a whole number of at least 1, not {raw!r}.')
        return int(raw)
    return machine_setting('verify_workers', 1)


def run(env: dict, features: list[dict], build_first: bool = True) -> list[str]:
    """Run the journeys and check them against the map. With $BSTACK_PACKAGED_APP in `env`, they launch that app
    (package.py) instead of the built one, and nothing is built here."""
    failed = build(env) if build_first else None
    if failed:
        return [f'[verified-features] the app didn\'t build, so it can\'t run: {failed}']
    errors: list[str] = []
    results = EVIDENCE / 'results.json'
    workers = verify_workers(env)
    worker_flags = ['--fileParallelism', f'--maxWorkers={workers}'] if workers > 1 else ['--no-file-parallelism', '--maxWorkers=1']
    proc = run_group(['vp', 'test', 'run', '--project', 'journeys', *worker_flags, '--reporter=json', f'--outputFile={results}'],
                     ROOT, {**env, 'BSTACK_VERIFY_WORKERS': str(workers), 'VITEST_MAX_WORKERS': str(workers)})
    if not results.is_file():
        return [f'[verified-features] the journeys didn\'t run:\n{(proc.stdout + proc.stderr).strip()[-4000:]}']
    report = json.loads(results.read_text())
    ran: dict[str, dict] = {}
    titles = [test['title'] for suite in report.get('testResults', []) for test in suite.get('assertionResults', [])]
    for suite in report.get('testResults', []):
        if suite.get('status') == 'failed' and not suite.get('assertionResults'):
            errors.append(f'[verified-features] {suite.get("name")} didn\'t load:\n{suite.get("message", "")[-3000:]}')
        for test in suite.get('assertionResults', []):
            if test.get('ancestorTitles'):
                errors.append(f'[verified-features] journey `{test.get("fullName")}`: journeys are top-level tests, '
                              'named as in the feature map (no describe blocks).')
            ran[test['title']] = test
    errors += [f'[verified-features] journey `{name}` is defined {titles.count(name)} times in {JOURNEYS}/. Each journey '
               'has one name, as in the feature map.' for name in sorted(set(titles)) if titles.count(name) > 1]
    mapped = {j['name']: f['file'] for f in features for j in f.get('journeys', []) if j.get('name')}
    errors += [f'[verified-features] journey `{name}` in {JOURNEYS}/ isn\'t in the feature map. Add it to the feature '
               'it proves.' for name in ran if name not in mapped]
    errors += [f'[verified-features] {mapped[name]}: journey `{name}` isn\'t in {JOURNEYS}/, so it never runs.'
               for name in mapped if name not in ran]
    lines = ['# Verify evidence', '']
    for feature in features:
        lines += [f'## {feature.get("id")}: {feature.get("summary", "")}', '']
        for journey in feature.get('journeys', []):
            name = journey.get('name')
            test = ran.get(name)
            if test is None:
                continue
            shots = sorted((EVIDENCE / name).glob('*.png')) if (EVIDENCE / name).is_dir() else []
            passed = test.get('status') == 'passed' and titles.count(name) == 1
            if titles.count(name) > 1:
                pass  # reported above
            elif not passed:
                message = '\n'.join(test.get('failureMessages', []))[-3000:]
                errors.append(f'[verified-features] journey `{name}` failed ({feature["file"]}). Fix the app, or if the '
                              f'journey is wrong, say why; never weaken it.\n{message}')
            elif not shots:
                errors.append(f'[verified-features] journey `{name}` saved no screenshot. Call checkpoint() where it '
                              'shows the feature working: screenshots are the evidence.')
            lines += [f'### {name}: {"PASS" if passed and shots else "FAIL"}', '', journey.get('proves', ''), '']
            lines += [f'- ![{shot.stem}]({name}/{shot.name})' for shot in shots] + ['']
    if '[no-concurrency-escapes]' in proc.stderr:
        leak = proc.stderr.strip()[-3000:]
        errors.append(leak)
        lines += ['## Process leak', '', leak, '']
    elif proc.returncode != 0 and not errors:
        errors.append(f'[verified-features] the journeys failed:\n{(proc.stdout + proc.stderr).strip()[-3000:]}')
    (EVIDENCE / 'evidence.md').write_text('\n'.join(lines))
    return errors


def look(args: list[str]) -> int:
    """Options come before the first step; anything after is a step, so a test id or text can't be read as one."""
    data: Path | None = ROOT / '.build/look/data'
    while args and args[0].startswith('--'):
        option, args = args[0], args[1:]
        if option == '--data' and args:
            data, args = Path(args[0]).resolve(), args[1:]
        elif option == '--fresh':
            data = None  # made below, once .build is linked into the cache folder
        else:
            print(__doc__)
            return 2
    env = node_env()  # links .build into the cache folder
    if data is None:
        (ROOT / '.build/look').mkdir(parents=True, exist_ok=True)
        data = Path(tempfile.mkdtemp(dir=ROOT / '.build/look', prefix='data-'))  # new and empty; nothing is deleted
    install(env)
    failed = build(env)
    if failed:
        print(failed)
        return 1
    out = ROOT / '.build/look'
    proc = run_group(['node', 'journeys/support/look.ts', str(data), str(out), *args], ROOT / 'apps/desktop', env)
    print((proc.stdout + proc.stderr).strip() + f'\ndata folder: {data}')
    return proc.returncode


if __name__ == '__main__':
    handle_termination()
    try:
        if sys.argv[1:2] == ['look']:
            sys.exit(look(sys.argv[2:]))
        mode = sys.argv[1] if len(sys.argv) > 1 else 'run'
        if mode not in ('map', 'run'):
            sys.exit(__doc__)
        if mode == 'run':
            shutil.rmtree(EVIDENCE, ignore_errors=True)  # never leave an earlier run's evidence as the latest
        features, errors = verified_map()
        if mode == 'run' and not errors:
            EVIDENCE.mkdir(parents=True)
            env = node_env()
            install(env)
            errors += run(env, features)
    except KeyboardInterrupt:
        sys.exit('\nStopped.')
    done = (f'verify: every feature mapped; every journey passed. Evidence: {EVIDENCE / "evidence.md"}' if mode == 'run'
            else 'verify map: every feature mapped (journeys not run)')
    print('\n'.join(errors) if errors else done)
    sys.exit(1 if errors else 0)
