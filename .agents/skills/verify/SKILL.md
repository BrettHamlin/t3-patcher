---
name: verify
description: Run this desktop app and prove a feature works the way a user sees it, with screenshot evidence. Use before handing back any behaviour change, when adding a feature, or to explore the running app.
---

# Verify

`python3 scripts/verify.py` is the one driver for the running app. Don't improvise Electron or Playwright scripts.

## Prove a change: the gate

```sh
python3 scripts/verify.py          # same as check.py's verify gate
python3 scripts/package.py         # the same journeys and checks against the packaged app
```

It checks the feature map, builds the renderer and the desktop app, runs every journey in `apps/desktop/journeys/` against the built app, and writes `.build/evidence/latest/evidence.md` with a screenshot at every checkpoint. Read the screenshots. A passing journey whose screenshots show the wrong thing is a bad journey: fix it.

## Explore the running app

```sh
python3 scripts/verify.py look --fresh                                  # a new, empty data folder; opens, screenshots, closes
python3 scripts/verify.py look fill tally-name apple click tally-add    # steps by test id; the data folder is kept
```

Each look prints and saves `.build/look/look.png` and every element's test id and text (`.build/look/look.txt`). Read the screenshot. `--data <folder>` uses another data folder. Exploring is for looking and judging; it's not proof. Once a behaviour works, write the journey that proves it.

## Add a feature

1. `python3 scripts/new_feature.py <name>` creates the package, its feature-map entry, a test and a journey; the test and journey fail until you write them.
2. Give the feature's elements identifiers in contracts: a `<Screen>Ui` object of `uiId("screen-thing")` values next to the feature's types in `packages/contracts`. Only contracts can make a `UiId`. Views set `data-testid={<Screen>Ui.thing}`; nothing else counts.
3. Write the journey with the `Screen` from `journeys/support/app.ts`: `launch(journey, await dataFolder(journey))`, then `fill`, `click`, `waitForText`, `lines` (all take `UiId`s), `checkpoint("what it shows")` for the evidence, and `close`. Use `whileReadOnly` to make saving fail. Journey bodies can't import Playwright or Electron; if the Screen lacks something, add it to `journeys/support` (code-owned) or stop and report.
4. Start from saved data with `packages/fixtures` (a devDependency only the journeys may use), never by adding a test mode to the app.
5. In `feature-map/<id>.toml`, name the feature's packages in `modules` and each journey with what it `proves`. A journey belongs to one feature only.
6. Keep `apps/desktop/journeys/smoke.json` about the app's main path: CI runs it against the Windows and Linux packages, where journeys can't run.

## Rules

- Drive the real user path through the real app: the journeys launch the same build that ships.
- Check durable effects, not just the window: close, launch again on the same data folder, and check again.
- Assert whole values (`toEqual(["apple 2", "pear 1"])`), not parts.
- If a journey fails, fix the app. **Never weaken a journey to make it pass.** If you can't make it pass within the rules, stop and report.
