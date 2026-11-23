# T3 Patcher: agent instructions

## Before you change code

- Packages and their dependencies come from the module shape (`arch/shape.json`, the owner's). A package's role is its folder: `packages/contracts` (types and schemas shared across processes), `packages/features/<name>` (logic), `packages/platform/<name>` (real I/O), `apps/desktop` (Electron's main process and preload), `apps/web` (the renderer), `packages/fixtures` (test setup for journeys). To add a feature, run `python3 scripts/new_feature.py <name>`: it creates the package with a test, its feature-map entry and a journey; the test and the journey fail until you write them. `python3 scripts/check.py` installs what a package declares. Don't edit the root `package.json`, `pnpm-workspace.yaml`, `vite.config.ts`, `tsconfig.*.json` or `arch/`: the gates fail if a package is outside the shape. A link the shape doesn't allow is outside it: stop and report.
- Use the existing approved APIs: persistence through `@app/files`; git, processes and the installed app through `@app/system`; time and background work through Effect. Don't introduce a second way to do the same thing.
- Dependencies are Effect services: a feature declares what it needs (`Context.Service`), a platform package implements it (a `Layer`), and the composition roots (`apps/desktop/src/main.ts`, `apps/web/src/main.tsx`) provide the real ones. The renderer reaches the main process only through the preload's bridge, typed in `packages/contracts/src/ipc.ts`.
- Features are shaped like `packages/features/tally`: logic with no I/O (the compiler has no Node.js or DOM there), a service for each thing it needs from outside, example tests and a property test (random sequences checked against a model of the spec, like `tests/property.test.ts`) in its `tests/` folder, a `feature-map/<id>.toml` entry, and journeys in `apps/desktop/journeys/` that launch the built app and prove it works. Journeys use the `Screen` from `journeys/support`, which finds elements only by the typed identifiers in contracts (`TallyUi`); views set `data-testid` from them. Data a journey starts from comes from `packages/fixtures`, which the shipped app can't import. Tests assert whole values (`toEqual`), never parts.

## Checks

```sh
python3 scripts/check.py        # compiler, lint, deps, arch, settings, tests, verify: all must PASS
python3 scripts/package.py      # the macOS installers, with every journey run against the app (CI builds and installs every platform's)
```

Run it before handing back. If it stops because the cache folder is unavailable (e.g. an external drive isn't mounted), report that; don't build elsewhere. A failure names the rule and how to fix it.

Use the `verify` skill (`.agents/skills/verify`) to explore the running app and to write journeys. `verify` runs every feature-map journey against the built app and writes screenshots and `.build/evidence/latest/evidence.md`. For behaviour changes, look at them and include the path in your report.

## Never weaken enforcement

Never suppress, disable, weaken or bypass a check. That includes `// oxlint-disable`, `// eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `@effect-diagnostics`, `any`, `as` casts, `!`, `declare`, `.skip`/`.only`, and editing the root config files, `arch/`, `tools.toml`, `scripts/`, the journeys, or CI.

**If the right fix isn't possible within the rules, stop and report:** what you were trying to do, which rule blocks it, and what you'd change. A clear report is a successful outcome.

## Don't write unrequested docs

No new markdown files, rule files or explanatory comments unless asked. Comments are for what code can't express.
