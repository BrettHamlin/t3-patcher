// The CLI's words: its command line in, and the stack and runs as lines of text out.
import type { LibraryView, RunReport, Step } from "@app/contracts";

/** The command line: words that aren't options, each option's value, and the flags given. */
export interface Line {
  readonly words: ReadonlyArray<string>;
  readonly options: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

/** Options that take a value: `--name value`. Anything else starting with `--` is a flag. */
const valued = (word: string): boolean =>
  ["--userdata", "--data", "--patches", "--work", "--title", "--summary"].includes(word);

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
