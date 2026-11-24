# T3 Patcher

T3 Patcher applies a stack of feature patches to the T3 Code app you have installed, checks them, builds the result and, if you ask, installs it.

A run:

1. Reads the installed app's version and checks out a fresh copy of T3 Code's source at that version's tag.
2. Applies each patch that is on, in stack order. A patch that doesn't apply cleanly is merged three ways. If conflicts are left, the resolver (an agent command) is asked to fix them. If any are still left, the run stops.
3. Runs the target's checks and each patch's checks.
4. Builds the app.
5. Runs each patch's journeys against the built app.
6. Saves every patch whose diff changed, rebased onto this version, so the patches follow T3 Code's releases.
7. If install was chosen, replaces the installed app and keeps a backup of the old one, and writes the installed record.

The run stops at the first step that fails and skips the rest. The last run's report is kept and is shown when the app opens again.

## Where things live

- `patches/<id>/` in this repository: the patches.
- `~/.t3/userdata/patcher/`: the patcher's user data. It holds `settings.json`, the stack (order, and which patches are on), the last run's report and `installed.json`. It sits outside the app, so it survives T3 Code upgrades. Pass `--userdata <folder>` to use another folder.
- `~/.t3/userdata/patches/<id>/`: runtime configuration for a patched feature, kept by that feature.
- The work folder (`work` in settings): source checkouts, logs, journey evidence and backups of replaced apps. `init` puts it at `<cache folder>/t3-patcher`. The cache folder comes from `$BSTACK_CACHE_DIR`, or `cache_dir` in `~/.config/b-stack/config.toml`.

## Command line

Every operation in the window is also a command, for agents and scripts:

```sh
python3 scripts/patcher.py <command> [--userdata <folder>]
```

The script installs the pinned tools, builds the app if its sources changed, and runs `node apps/desktop/dist/cli.cjs` with the same arguments.

| Command | What it does |
| --- | --- |
| `init [--patches <folder>] [--work <folder>] [--force]` | Writes default settings. Patches default to this repository's `patches/`. Existing settings are kept unless `--force` is given. Writes the build environment (every cache, the Playwright browsers included, under `<work>/build-env`) and links `~/Library/Caches/electron` there, because electron-builder downloads Electron to that folder whatever the environment says. |
| `status` | Shows the settings path, the installed version, the stack in order (on/off and titles) and the last run. |
| `apply [--install]` | Runs the stack and prints each step as it changes (`[status] kind name — note`). Exits 1 if a step failed. |
| `update [--t3 <version>] [--relaunch <pid>]` | Brings the published patches up to date: a clone of the patches repository's `origin`, at `<work>/published`, cloned the first time, then fast-forwarded to `main` (or reset to it, as it's a cache nothing else edits), so the checkout you author patches in is never touched. Patches new there join the stack off. Then applies the stack with the published patches and installs it. `--t3` builds that T3 Code version instead of the installed one; patches rebased onto it aren't saved (publish them from a workspace). `--relaunch` quits the app with that pid before replacing it and opens it again after. Each report is saved as the last run as it changes; it starts with the `pull` step and says what's updated. Nothing is installed unless every step passes. |
| `index [--patches <folder>]` | Writes `index.json`, the feed, in the patches folder (this repository's by default). |
| `workspace <id>` | Opens a workspace for patch `<id>` (new or existing) and prints its folder. The workspace is a checkout of the installed version with the patches before `<id>` applied. |
| `capture <id> --title <t> --summary <s>` | Saves the workspace's uncommitted changes as patch `<id>`. |
| `enable <id>`, `disable <id>` | Turns a patch on or off. |
| `move <id> up\|down` | Moves a patch one place earlier or later in the stack. |

On an error, a command prints one line and exits with a non-zero code.

## Patch format

`patches/<id>/changes.patch` is a git diff (`git diff --binary --full-index`) of the patch's changes.

`patches/<id>/patch.json` describes it:

| Field | Meaning |
| --- | --- |
| `id` | The patch's name: lowercase letters, digits and `-`, up to 48 characters. It matches the folder's name. |
| `title`, `summary` | What the patch does, as shown in the stack. |
| `version` | A whole number from 1; 1 when missing. Raise it with each change you publish: that's how the patched app sees an update. `capture` keeps it. |
| `base` | `{ "version", "commit" }`: the T3 Code version and upstream commit the diff was last made against. |
| `checks` | `[{ "name", "run" }]`: shell commands run in the source folder after every patch is applied. |
| `journeys` | `[{ "name", "proves", "run" }]`: at least one. Each is a shell command that drives the built app (run in the source folder after the build), with what it proves. |

## Updates

Patch updates are published from this repository's `main` branch: merging a pull request is a release. `patches/index.json` lists every patch's `id`, `title`, `summary` and `version`, sorted by id; run `python3 scripts/patcher.py index` after changing a patch (a test fails when it's stale). The app reads it from `https://raw.githubusercontent.com/BrettHamlin/t3-patcher/main/patches/index.json`.

After an install that passed, `<userdata>/installed.json` records `t3Version`, each installed patch's `{ id, version }`, `installedAt`, the `feed` URL, and `update`: `{ command, cwd, path }`, the absolute command that runs `update` with this user data folder and the PATH the patcher ran with, which the app runs it with (each folder once). `update` is left out when the checkout holding the patches folder has no `scripts/patcher.py` (e.g. an install from the packaged window); the app then says to update from the command line. The install step writes the record as soon as the app is replaced, before it's opened again. A patched T3 Code reads it to offer new patch versions and new T3 Code versions, and runs that command to install them.

