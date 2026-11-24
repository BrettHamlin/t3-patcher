// The CLI's words: its command line in, and the stack and runs as lines of text out.
import type { LibraryView, RunReport, Step, UpdateItem } from "@app/contracts";

/** The command line: words that aren't options, each option's value, and the flags given. */
export interface Line {
  readonly words: ReadonlyArray<string>;
  readonly options: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

/** Options that take a value: `--name value`. Anything else starting with `--` is a flag. */
const valued = (word: string): boolean =>
  ["--userdata", "--data", "--patches", "--work", "--title", "--summary", "--t3", "--relaunch"].includes(word);

export const parse = (argv: ReadonlyArray<string>): Line => {
  const words: Array<string> = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let at = 0; at < argv.length; at += 1) {
    const word = argv[at] ?? "";
    const value = argv[at + 1];
    if (valued(word) && value !== undefined) {
      options.set(word.slice(2), value);
      at += 1;
    } else if (word.startsWith("--")) {
      flags.add(word.slice(2));
    } else {
      words.push(word);
    }
  }
  return { words, options, flags };
};

/** Each patch in stack order: "<n>. <id> [on|off] — <title>". */
export const stackLines = (view: LibraryView): ReadonlyArray<string> =>
  view.stack.entries.map((entry, index) => {
    const title = view.patches.find((patch) => patch.id === entry.id)?.title ?? "";
    return `${index + 1}. ${entry.id} [${entry.enabled ? "on" : "off"}] — ${title}`;
  });

/** "passed", "failed at <step>: <note>", or "unfinished" for a run that stopped without either. */
export const outcome = (report: RunReport): string => {
  const failed = report.steps.find((step) => step.status === "failed");
  if (failed !== undefined) return `failed at ${failed.name}: ${failed.note}`;
  return report.steps.every((step) => step.status === "passed" || step.status === "skipped") ? "passed" : "unfinished";
};

/** "[<status>] <kind> <name> — <note>", without the note when there is none. */
export const stepLine = (step: Step): string =>
  `[${step.status}] ${step.kind} ${step.name}${step.note === "" ? "" : ` — ${step.note}`}`;

/** "<name> <from> → <to>", or "<name> added, version <to>" for a patch the update adds. */
const changeText = (item: UpdateItem): string =>
  item.from === "" ? `${item.name} added, version ${item.to}` : `${item.name} ${item.from} → ${item.to}`;

/** "updating: <change>, …", or "updating: nothing new (rebuilding)" when nothing changes. */
export const updatingLine = (items: ReadonlyArray<UpdateItem>): string =>
  `updating: ${items.length === 0 ? "nothing new (rebuilding)" : items.map(changeText).join(", ")}`;

/** `text` as one shell word that the shell takes literally. */
const quoted = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/** Each variable that names a cache the build uses, and its folder under the build environment folder. */
const CACHES = [
  ["TMPDIR", "tmp"],
  ["XDG_CACHE_HOME", "xdg-cache"],
  ["ELECTRON_CACHE", "electron-cache"],
  ["ELECTRON_BUILDER_CACHE", "electron-builder-cache"],
  ["pnpm_config_store_dir", "pnpm-store"],
  ["pnpm_config_cache_dir", "pnpm-cache"],
  ["CARGO_HOME", "cargo-home"],
  ["npm_config_cache", "npm-cache"],
  ["COREPACK_HOME", "corepack"],
  ["electron_config_cache", "electron-cache"],
] as const;

/**
 * The build environment script (`$T3_PATCHER_ENV`), sourced from a checkout's root: PATH is `path` with the
 * checkout's node_modules/.bin in front, and every cache is a folder under `folder`, made if missing.
 */
export const buildEnv = (folder: string, path: string): string =>
  [
    "# Source from the checkout root. Written by `t3-patcher init`; keeps the build's caches under $BE.",
    `BE=${quoted(folder)}`,
    `export PATH="$PWD/node_modules/.bin":${quoted(path)}`,
    // The patcher's own pnpm settings would put the checkout's packages in the patcher's virtual store.
    "unset pnpm_config_virtual_store_dir npm_config_virtual_store_dir",
    ...CACHES.map(([name, sub]) => `export ${name}="$BE/${sub}"`),
    `mkdir -p ${CACHES.map(([name]) => `"$${name}"`).join(" ")}`,
    "",
  ].join("\n");
