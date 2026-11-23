# T3 Patcher

T3 Patcher applies a stack of feature patches to the T3 Code app you have installed, checks them, builds the result and, if you ask, installs it.

A run:

1. Reads the installed app's version and checks out a fresh copy of T3 Code's source at that version's tag.
2. Applies each patch that is on, in stack order. A patch that doesn't apply cleanly is merged three ways. If conflicts are left, the resolver (an agent command) is asked to fix them. If any are still left, the run stops.
3. Runs the target's checks and each patch's checks.
4. Builds the app.
5. Runs each patch's journeys against the built app.
6. Saves every patch whose diff changed, rebased onto this version, so the patches follow T3 Code's releases.
7. If install was chosen, replaces the installed app and keeps a backup of the old one.

The run stops at the first step that fails and skips the rest. The last run's report is kept and is shown when the app opens again.

## Where things live

- `patches/<id>/` in this repository: the patches.
- `~/.t3/userdata/patcher/`: the patcher's user data. It holds `settings.json`, the stack (order, and which patches are on) and the last run's report. It sits outside the app, so it survives T3 Code upgrades. Pass `--userdata <folder>` to use another folder.
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
| `init [--patches <folder>] [--work <folder>] [--force]` | Writes default settings. Patches default to this repository's `patches/`. Existing settings are kept unless `--force` is given. |
| `status` | Shows the settings path, the installed version, the stack in order (on/off and titles) and the last run. |
| `apply [--install]` | Runs the stack and prints each step as it changes (`[status] kind name — note`). Exits 1 if a step failed. |
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
| `base` | `{ "version", "commit" }`: the T3 Code version and upstream commit the diff was last made against. |
| `checks` | `[{ "name", "run" }]`: shell commands run in the source folder after every patch is applied. |
| `journeys` | `[{ "name", "proves", "run" }]`: at least one. Each is a shell command that drives the built app (run in the source folder after the build), with what it proves. |
