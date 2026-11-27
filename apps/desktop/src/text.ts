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
  ["PLAYWRIGHT_BROWSERS_PATH", "ms-playwright"],
] as const;

/** The system compiler each variable names, so the build never picks up another `cc` on PATH. */
const COMPILERS = [
  ["CC", "/usr/bin/cc"],
  ["CXX", "/usr/bin/c++"],
  ["CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER", "/usr/bin/cc"],
  ["CARGO_TARGET_X86_64_APPLE_DARWIN_LINKER", "/usr/bin/cc"],
] as const;

const decodeTomlBasicBody = (body: string, multiline: boolean): string | undefined => {
  let out = "";
  for (let i = 0; i < body.length; ) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch ?? "";
      i += 1;
      continue;
    }
    const esc = body[i + 1];
    if (esc === undefined) return undefined;
    if (multiline && (esc === " " || esc === "\t" || esc === "\r" || esc === "\n")) {
      let k = i + 1;
      let sawNewline = false;
      while (k < body.length && (body[k] === " " || body[k] === "\t" || body[k] === "\r" || body[k] === "\n")) {
        if (body[k] === "\n") sawNewline = true;
        k += 1;
      }
      if (!sawNewline) return undefined;
      i = k;
      continue;
    }
    const simple: Readonly<Record<string, string>> = {
      b: "\b",
      t: "\t",
      n: "\n",
      f: "\f",
      r: "\r",
      '"': '"',
      "\\": "\\",
    };
    const mapped = simple[esc];
    if (mapped !== undefined) {
      out += mapped;
      i += 2;
      continue;
    }
    if (esc === "u" || esc === "U") {
      const len = esc === "u" ? 4 : 8;
      const hex = body.slice(i + 2, i + 2 + len);
      if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) return undefined;
      const cp = Number.parseInt(hex, 16);
      if ((cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) return undefined;
      out += String.fromCodePoint(cp);
      i += 2 + len;
      continue;
    }
    return undefined;
  }
  return out;
};

const skipTomlCompound = (src: string, start: number): number => {
  let i = start;
  let depth = 0;
  while (i < src.length) {
    if (src.startsWith('"""', i)) {
      i += 3;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src.startsWith('"""', i)) {
          let q = 0;
          while (q < 5 && src[i + q] === '"') q += 1;
          i += q;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (src.startsWith("'''", i)) {
      i += 3;
      while (i < src.length && !src.startsWith("'''", i)) i += 1;
      let q = 0;
      while (q < 5 && src[i + q] === "'") q += 1;
      i += q;
      continue;
    }
    const ch = src[i];
    if (ch === '"') {
      i += 1;
      while (i < src.length && src[i] !== '"') {
        i += src[i] === "\\" ? 2 : 1;
      }
      i += 1;
    } else if (ch === "'") {
      i += 1;
      while (i < src.length && src[i] !== "'") i += 1;
      i += 1;
    } else if (ch === "#") {
      while (i < src.length && src[i] !== "\n") i += 1;
    } else if (ch === "[" || ch === "{") {
      depth += 1;
      i += 1;
    } else if (ch === "]" || ch === "}") {
      depth -= 1;
      i += 1;
      if (depth <= 0) return i;
    } else {
      i += 1;
    }
  }
  return i;
};

const readTomlKeySegment = (src: string, start: number): { readonly key: string; readonly next: number } | undefined => {
  let i = start;
  if (src[i] === '"') {
    i += 1;
    const bodyStart = i;
    while (i < src.length && src[i] !== '"' && src[i] !== "\n" && src[i] !== "\r") {
      i += src[i] === "\\" ? 2 : 1;
    }
    if (src[i] !== '"') return undefined;
    const decoded = decodeTomlBasicBody(src.slice(bodyStart, i), false);
    return decoded === undefined ? undefined : { key: decoded, next: i + 1 };
  }
  if (src[i] === "'") {
    i += 1;
    const bodyStart = i;
    while (i < src.length && src[i] !== "'" && src[i] !== "\n" && src[i] !== "\r") i += 1;
    if (src[i] !== "'") return undefined;
    return { key: src.slice(bodyStart, i), next: i + 1 };
  }
  const bodyStart = i;
  while (i < src.length && /[A-Za-z0-9_-]/.test(src[i] ?? "")) i += 1;
  return i > bodyStart ? { key: src.slice(bodyStart, i), next: i } : undefined;
};

const parseTomlPositiveInt = (raw: string): number | undefined => {
  const dec = /^[+-]?(?:0|[1-9](?:_?\d)*)$/.test(raw);
  const radix = /^0(?:x[0-9a-fA-F](?:_?[0-9a-fA-F])*|o[0-7](?:_?[0-7])*|b[01](?:_?[01])*)$/.test(raw);
  if (!dec && !radix) return undefined;
  const cleaned = (raw.startsWith("+") ? raw.slice(1) : raw).replaceAll("_", "");
  const parsed = BigInt(cleaned);
  return parsed >= 1n && parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : undefined;
};

const GIB = 1024 ** 3;

/** Default verify workers for a machine: one per two cores and per 4 GiB of memory, from 1 to 4. */
export const defaultVerifyWorkers = (cores: number, memoryBytes: number): number =>
  Math.max(1, Math.min(4, Math.floor(cores / 2), Math.floor(memoryBytes / (4 * GIB))));

/** Reads top-level `verify_workers` from `~/.config/b-stack/config.toml` text: defaults to `fallback`, undefined when invalid. */
export const parseVerifyWorkers = (configToml: string, fallback = 1): number | undefined => {
  let i = configToml.startsWith("\uFEFF") ? 1 : 0;
  const n = configToml.length;
  let seenTarget = false;
  let result: number | undefined;
  const skipWsAndComments = (): void => {
    while (i < n) {
      const ch = configToml[i];
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        i += 1;
      } else if (ch === "#") {
        while (i < n && configToml[i] !== "\n") i += 1;
      } else {
        break;
      }
    }
  };
  const skipSpaces = (): void => {
    while (i < n && (configToml[i] === " " || configToml[i] === "\t")) i += 1;
  };

  while (i < n) {
    skipWsAndComments();
    if (i >= n || configToml[i] === "[") break;
    const first = readTomlKeySegment(configToml, i);
    if (first === undefined) return undefined;
    i = first.next;
    skipSpaces();
    let dotted = false;
    while (configToml[i] === ".") {
      dotted = true;
      i += 1;
      skipSpaces();
      const sub = readTomlKeySegment(configToml, i);
      if (sub === undefined) return undefined;
      i = sub.next;
      skipSpaces();
    }
    if (configToml[i] !== "=") return undefined;
    i += 1;
    skipSpaces();
    const isTarget = !dotted && first.key === "verify_workers";
    if (isTarget) {
      if (seenTarget) return undefined;
      seenTarget = true;
    }
    if (configToml.startsWith('"""', i)) {
      if (isTarget) return undefined;
      i += 3;
      let closed = false;
      while (i < n) {
        if (configToml[i] === "\\") {
          i += configToml[i + 1] === "\r" && configToml[i + 2] === "\n" ? 3 : 2;
          continue;
        }
        if (configToml.startsWith('"""', i)) {
          let q = 0;
          while (q < 6 && configToml[i + q] === '"') q += 1;
          if (q === 6) return undefined;
          i += q;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) return undefined;
    } else if (configToml.startsWith("'''", i)) {
      if (isTarget) return undefined;
      i += 3;
      while (i < n && !configToml.startsWith("'''", i)) i += 1;
      if (!configToml.startsWith("'''", i)) return undefined;
      let q = 0;
      while (q < 6 && configToml[i + q] === "'") q += 1;
      if (q === 6) return undefined;
      i += q;
    } else if (configToml[i] === '"') {
      if (isTarget) return undefined;
      i += 1;
      while (i < n && configToml[i] !== '"' && configToml[i] !== "\n" && configToml[i] !== "\r") {
        i += configToml[i] === "\\" ? 2 : 1;
      }
      if (configToml[i] !== '"') return undefined;
      i += 1;
    } else if (configToml[i] === "'") {
      if (isTarget) return undefined;
      i += 1;
      while (i < n && configToml[i] !== "'" && configToml[i] !== "\n" && configToml[i] !== "\r") i += 1;
      if (configToml[i] !== "'") return undefined;
      i += 1;
    } else if (configToml[i] === "[" || configToml[i] === "{") {
      if (isTarget) return undefined;
      i = skipTomlCompound(configToml, i);
    } else {
      const valStart = i;
      while (i < n && configToml[i] !== "#" && configToml[i] !== "\r" && configToml[i] !== "\n") i += 1;
      const raw = configToml.slice(valStart, i).trim();
      if (isTarget) {
        const parsed = parseTomlPositiveInt(raw);
        if (parsed === undefined) return undefined;
        result = parsed;
      }
    }
    skipSpaces();
    if (configToml[i] === "#") {
      while (i < n && configToml[i] !== "\n") i += 1;
    }
    if (i < n && configToml[i] !== "\r" && configToml[i] !== "\n") return undefined;
  }
  return seenTarget ? result : fallback;
};

const UNSET_LINE = "unset pnpm_config_virtual_store_dir npm_config_virtual_store_dir";
const MKDIR_LINE = `mkdir -p ${CACHES.map(([name]) => `"$${name}"`).join(" ")}`;
const cacheExport = (name: string, sub: string): string => `export ${name}="\${${name}:-$BE/${sub}}"`;
const verifyWorkersExport = (verifyWorkers: number): string =>
  `export BSTACK_VERIFY_WORKERS="\${BSTACK_VERIFY_WORKERS:-${verifyWorkers}}"`;
const CHECK_CHANGED_WORKERS_LINE = `export CHECK_CHANGED_CONCURRENCY="$BSTACK_VERIFY_WORKERS"`;
const VITEST_WORKERS_LINE = `export VITEST_MAX_WORKERS="$BSTACK_VERIFY_WORKERS"`;
const GOMAXPROCS_LINE = `export GOMAXPROCS="\${GOMAXPROCS:-2}"`;

/**
 * The build environment script (`$T3_PATCHER_ENV`), sourced from a checkout's root: PATH is `path` with the
 * checkout's node_modules/.bin in front, C compilers and Rust's linker are the system's, and every cache defaults to a
 * folder under `folder` (made if missing) without overriding caller environment variables.
 */
export const buildEnv = (folder: string, path: string, verifyWorkers = 1): string =>
  [
    "# Source from the checkout root. Written by `t3-patcher init`; keeps the build's caches under $BE.",
    `BE=${quoted(folder)}`,
    `export PATH="$PWD/node_modules/.bin":${quoted(path)}`,
    // The patcher's own pnpm settings would put the checkout's packages in the patcher's virtual store.
    UNSET_LINE,
    // A tool on PATH named `cc` (a shell helper, say) would otherwise be what Rust links with.
    ...COMPILERS.map(([name, tool]) => `export ${name}=${tool}`),
    ...CACHES.map(([name, sub]) => cacheExport(name, sub)),
    verifyWorkersExport(verifyWorkers),
    CHECK_CHANGED_WORKERS_LINE,
    VITEST_WORKERS_LINE,
    GOMAXPROCS_LINE,
    MKDIR_LINE,
    "",
  ].join("\n");

const isGeneratedCacheExport = (trimmed: string, key: string, sub: string): boolean =>
  trimmed === `export ${key}="$BE/${sub}"` ||
  trimmed === `export ${key}="\${BE}/${sub}"` ||
  trimmed === `export ${key}=$BE/${sub}` ||
  trimmed === cacheExport(key, sub);

/** Refreshes patcher-managed lines in an existing `env.sh` (for `init --force`) while keeping user-authored lines. */
export const refreshBuildEnv = (existing: string, folder: string, path: string, verifyWorkers = 1): string => {
  const compilerMap = new Map<string, string>(COMPILERS);
  const cacheMap = new Map<string, string>(CACHES);
  const rawLines = existing.replace(/\r?\n$/, "").split(/\r?\n/);
  const seenCompilers = new Set<string>();
  const seenCaches = new Set<string>();
  let seenBe = false;
  let seenPath = false;
  let seenUnset = false;
  let seenVerifyWorkers = false;
  let seenCheckChangedWorkers = false;
  let seenVitestWorkers = false;
  let seenGomaxprocs = false;
  let mkdirIndex = -1;

  const updated = rawLines.map((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("BE=")) {
      seenBe = true;
      return `BE=${quoted(folder)}`;
    }
    if (/^(?:export\s+)?PATH=/.test(trimmed)) {
      seenPath = true;
      return line;
    }
    if (/^unset\s+pnpm_config_virtual_store_dir\b/.test(trimmed)) {
      seenUnset = true;
      return UNSET_LINE;
    }
    const exportMatch = /^export\s+([A-Za-z_][A-Za-z0-9_]*)=/.exec(trimmed);
    if (exportMatch !== null) {
      const key = exportMatch[1] ?? "";
      const compiler = compilerMap.get(key);
      if (compiler !== undefined) {
        seenCompilers.add(key);
        return `export ${key}=${compiler}`;
      }
      const cacheSub = cacheMap.get(key);
      if (cacheSub !== undefined) {
        seenCaches.add(key);
        return isGeneratedCacheExport(trimmed, key, cacheSub) ? cacheExport(key, cacheSub) : line;
      }
      if (key === "BSTACK_VERIFY_WORKERS") {
        seenVerifyWorkers = true;
        return verifyWorkersExport(verifyWorkers);
      }
      if (key === "CHECK_CHANGED_CONCURRENCY") {
        seenCheckChangedWorkers = true;
        return CHECK_CHANGED_WORKERS_LINE;
      }
      if (key === "VITEST_MAX_WORKERS") {
        seenVitestWorkers = true;
        return VITEST_WORKERS_LINE;
      }
      if (key === "GOMAXPROCS") {
        seenGomaxprocs = true;
        return GOMAXPROCS_LINE;
      }
    }
    if (trimmed === MKDIR_LINE) {
      mkdirIndex = index;
      return MKDIR_LINE;
    }
    return line;
  });

  const headerMissing: Array<string> = [
    ...(seenBe ? [] : [`BE=${quoted(folder)}`]),
    ...(seenPath ? [] : [`export PATH="$PWD/node_modules/.bin":${quoted(path)}`]),
  ];
  const bodyMissing: Array<string> = [
    ...(seenUnset ? [] : [UNSET_LINE]),
    ...COMPILERS.filter(([name]) => !seenCompilers.has(name)).map(([name, tool]) => `export ${name}=${tool}`),
    ...CACHES.filter(([name]) => !seenCaches.has(name)).map(([name, sub]) => cacheExport(name, sub)),
    ...(seenVerifyWorkers ? [] : [verifyWorkersExport(verifyWorkers)]),
    ...(seenCheckChangedWorkers ? [] : [CHECK_CHANGED_WORKERS_LINE]),
    ...(seenVitestWorkers ? [] : [VITEST_WORKERS_LINE]),
    ...(seenGomaxprocs ? [] : [GOMAXPROCS_LINE]),
  ];

  const withBody =
    mkdirIndex === -1
      ? [...updated, ...bodyMissing, MKDIR_LINE]
      : [...updated.slice(0, mkdirIndex), ...bodyMissing, ...updated.slice(mkdirIndex)];
  const firstCode = withBody.findIndex((line) => !line.trimStart().startsWith("#"));
  const at = firstCode === -1 ? withBody.length : firstCode;
  return [...withBody.slice(0, at), ...headerMissing, ...withBody.slice(at), ""].join("\n");
};
