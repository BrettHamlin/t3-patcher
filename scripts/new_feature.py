"""Create a feature the way the module shape expects: its package, its feature-map entry and a journey to write.

  packages/features/<name>/   package.json, tsconfig.json (the feature role's), src/index.ts, tests/<name>.test.ts
  feature-map/<name>.toml     the feature and its first journey, <name>_works (snake case)
  apps/desktop/journeys/<name>.journey.ts   that journey

The package compiles and lints as created. Its test and its journey fail until you write them, with a message saying
so: a feature isn't done until both prove it works. Then run python3 scripts/check.py.

Usage: python3 scripts/new_feature.py <name>      (lowercase letters, digits and '-', starting with a letter)
"""
from pathlib import Path
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
NAME = re.compile(r'^[a-z][a-z0-9-]{0,39}$')


def files(name: str) -> dict[Path, str]:
    journey = f'{name.replace("-", "_")}_works'
    scope = json.loads((ROOT / 'arch/shape.json').read_text())['scope']
    package = {
        'name': f'{scope}/{name}', 'private': True, 'type': 'module', 'exports': {'.': './src/index.ts'},
        'dependencies': {f'{scope}/contracts': 'workspace:*', 'effect': '4.1.5'},
        'devDependencies': {'@effect/vitest': '4.1.5', 'vite-plus': '1.4.0'},
    }
    folder = Path('packages/features') / name
    return {
        folder / 'package.json': json.dumps(package, indent=2) + '\n',
        folder / 'tsconfig.json': '{ "extends": "../../../arch/tsconfig/feature.json" }\n',
        folder / 'src/index.ts': f'''// The {name} feature's logic: no I/O. Declare an Effect service (Context.Service) for what it needs from outside,
// implement it in a packages/platform/ package, and provide it in the composition roots.
export const feature = "{name}";
''',
        folder / f'tests/{name}.test.ts': f'''import {{ expect, it }} from "@effect/vitest";

it("{name} works", () => {{
  expect.unreachable("Write this test: the {name} feature's behaviour, asserting whole values.");
}});
''',
        Path(f'feature-map/{name}.toml'): f'''id = "{name}"
summary = "Write what the {name} feature does for the user."
modules = ["{name}"]

[[journeys]]
name = "{journey}"
proves = "Write what this journey shows working in the app."
''',
        Path(f'apps/desktop/journeys/{name}.journey.ts'): f'''import {{ expect, test }} from "vite-plus/test";

import {{ dataFolder, launch }} from "./support/app.ts";

test("{journey}", async () => {{
  const app = await launch("{journey}", await dataFolder("{journey}"));
  await app.checkpoint("opened");
  await app.close();
  expect.unreachable("Write this journey: use the feature through the Screen, as a user would, and check what they'd see.");
}});
''',
    }


def main(argv: list[str]) -> int:
    if len(argv) != 1 or not NAME.match(argv[0]):
        print(__doc__, file=sys.stderr)
        return 2
    name = argv[0]
    planned = files(name)
    taken = [str(path) for path in planned if (ROOT / path).exists()]
    if (ROOT / 'packages/features' / name).exists():
        taken.insert(0, f'packages/features/{name}')
    if taken:
        print(f'Not created: {", ".join(taken)} already exist.', file=sys.stderr)
        return 1
    for path, text in planned.items():
        (ROOT / path).parent.mkdir(parents=True, exist_ok=True)
        (ROOT / path).write_text(text)
    print('\n'.join(f'created {path}' for path in planned))
    print('Next: write the logic, the test and the journey, then run python3 scripts/check.py.')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
