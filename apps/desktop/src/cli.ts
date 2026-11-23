// The window's operations without a window, for agents. Usage: node apps/desktop/dist/cli.cjs <command> [--userdata <folder>]
import { Progress } from "@app/apply";
import { CaptureRequest, type PatchId, type RunReport, type Settings, type Stack, type Step } from "@app/contracts";
import { defaultSettings, loadReport, saveSettings } from "@app/files";
import { library, moved, parsePatchId, toggled } from "@app/stack";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  applyStack,
  capturePatch,
  changeStack,
  defaultUserdata,
  installedVersion,
  servicesFor,
  settingsFile,
  settingsIn,
  stackServices,
  userdataFolder,
  workspaceFor,
} from "./services.ts";
import { type Line, outcome, parse, stackLines, stepLine } from "./text.ts";

const USAGE = `usage: t3-patcher <command> [--userdata <folder>]
  init [--patches <folder>] [--work <folder>] [--force]
  status
  apply [--install]
  workspace <id>
  capture <id> --title <text> --summary <text>
  enable <id>
  disable <id>
  move <id> up|down`;

class Usage extends Schema.TaggedError<Usage>()("Usage", { what: Schema.String }) {
  override get message(): string {
    return `${this.what}\n${USAGE}`;
  }
}

class Refused extends Schema.TaggedError<Refused>()("Refused", { why: Schema.String }) {
  override get message(): string {
    return this.why;
  }
}

/** Prints each step when its status or note changes. */
const printer = Layer.effect(Progress)(
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<Step>>([]);
    return {
      report: Effect.fn("Progress.report")(function* (report: RunReport) {
        const before = yield* Ref.getAndSet(seen, report.steps);
        for (const [index, step] of report.steps.entries()) {
          const was = before[index];
          if (was === undefined || was.status !== step.status || was.note !== step.note) {
            yield* Console.log(stepLine(step));
          }
        }
      }),
    };
  }),
);

/** The work folder when none is given: <cache folder>/t3-patcher, from $BSTACK_CACHE_DIR or ~/.config/b-stack/config.toml. */
const cacheWork = Effect.fn("cacheWork")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configured = yield* Config.option(Config.String("BSTACK_CACHE_DIR"));
  if (Option.isSome(configured) && configured.value !== "") return path.join(configured.value, "t3-patcher");
  const file = path.join(home, ".config/b-stack/config.toml");
  const text = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : "";
  const cache = /^\s*cache_dir\s*=\s*"([^"]+)"/m.exec(text)?.[1];
  if (cache !== undefined) return path.join(cache, "t3-patcher");
  return yield* new Refused({
    why: "no work folder: pass --work <folder>, or set $BSTACK_CACHE_DIR or cache_dir in ~/.config/b-stack/config.toml",
  });
});

const init = Effect.fn("init")(function* (userdata: string, home: string, line: Line) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* settingsFile(userdata);
  if ((yield* fs.exists(file)) && !line.flags.has("force")) {
    return yield* new Refused({ why: `settings already exist at ${file}: pass --force to replace them` });
  }
  const patches = path.resolve(line.options.get("patches") ?? path.join(import.meta.dirname, "../../../patches"));
  const given = line.options.get("work");
  const work = given === undefined ? yield* cacheWork(home) : path.resolve(given);
  yield* saveSettings(userdata, defaultSettings({ patches, work }));
  yield* Console.log(`saved ${file}\npatches: ${patches}\nwork: ${work}`);
});

const status = Effect.fn("status")(function* (userdata: string, settings: Settings) {
  const services = servicesFor(userdata, settings);
  yield* Console.log(`settings: ${yield* settingsFile(userdata)}`);
  const version = yield* installedVersion.pipe(
    Effect.match({ onFailure: (failure) => `unknown (${failure.message})`, onSuccess: (found) => found }),
    Effect.provide(services),
  );
  yield* Console.log(`installed: ${settings.target.name} ${version}`);
  const lines = stackLines(yield* library.pipe(Effect.provide(stackServices(userdata, settings))));
  yield* Console.log(["stack:", ...(lines.length === 0 ? ["(no patches)"] : lines)].join("\n  "));
  const last = yield* loadReport(userdata);
  yield* Console.log(
    Option.isSome(last) ? `last run: ${outcome(last.value)} (version ${last.value.version})` : "last run: none",
  );
});

/** Change the stack with `change`, save it and print it. */
const restack = Effect.fn("restack")(function* (
  userdata: string,
  settings: Settings,
  raw: string,
  change: (stack: Stack, id: PatchId) => Stack | undefined,
) {
  const services = stackServices(userdata, settings);
  const id = yield* parsePatchId(raw);
  const view = yield* library.pipe(Effect.provide(services));
  if (!view.stack.entries.some((entry) => entry.id === id)) return yield* new Refused({ why: `no patch named ${id}` });
  const next = change(view.stack, id);
  const saved = next === undefined ? view : yield* changeStack(next).pipe(Effect.provide(services));
  yield* Console.log(stackLines(saved).join("\n"));
});

const command = Effect.fn("command")(function* (argv: ReadonlyArray<string>) {
  const line = parse(argv);
  const home = yield* Config.String("HOME");
  const userdata = userdataFolder(argv, defaultUserdata(home));
  const [name, first, second] = line.words;
  if (name === "init") {
    yield* init(userdata, home, line);
    return 0;
  }
  if (name === undefined) return yield* new Usage({ what: "no command" });
  const settings = yield* settingsIn(userdata);
  const services = servicesFor(userdata, settings);
  const needId = (): Effect.Effect<string, Usage> =>
    first === undefined ? Effect.fail(new Usage({ what: `${name} needs a patch name` })) : Effect.succeed(first);
  switch (name) {
    case "status":
      yield* status(userdata, settings);
      return 0;
    case "apply": {
      const report = yield* applyStack(userdata, settings, line.flags.has("install")).pipe(
        Effect.provide(Layer.merge(services, printer)),
      );
      yield* Console.log(outcome(report));
      return report.steps.some((step) => step.status === "failed") ? 1 : 0;
    }
    case "workspace":
      yield* Console.log(yield* workspaceFor(settings, yield* needId()).pipe(Effect.provide(services)));
      return 0;
    case "capture": {
      const request = yield* Schema.decodeEffect(CaptureRequest)({
        id: yield* needId(),
        title: line.options.get("title") ?? "",
        summary: line.options.get("summary") ?? "",
      }).pipe(Effect.mapError(() => new Usage({ what: "capture needs a valid patch name, --title and --summary" })));
      const manifest = yield* capturePatch(settings, request).pipe(Effect.provide(services));
      yield* Console.log(`captured ${manifest.id}`);
      return 0;
    }
    case "enable":
    case "disable": {
      const on = name === "enable";
      yield* restack(userdata, settings, yield* needId(), (stack, id) =>
        stack.entries.some((entry) => entry.id === id && entry.enabled !== on) ? toggled(stack, id) : undefined,
      );
      return 0;
    }
    case "move": {
      if (second !== "up" && second !== "down") return yield* new Usage({ what: "move needs up or down" });
      yield* restack(userdata, settings, yield* needId(), (stack, id) => moved(stack, id, second === "up" ? -1 : 1));
      return 0;
    }
    default:
      return yield* new Usage({ what: `unknown command ${name}` });
  }
});

const program = command(process.argv.slice(2)).pipe(
  Effect.catch((failure) => Console.error(`t3-patcher: ${failure.message}`).pipe(Effect.as(1))),
  Effect.catchDefect((defect) => Console.error(`t3-patcher: unexpected failure: ${String(defect)}`).pipe(Effect.as(2))),
  Effect.provide(NodeServices.layer),
);

Effect.runPromise(program).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.exitCode = 2;
  },
);
