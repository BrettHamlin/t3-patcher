import {
  Answer,
  type CaptureRequest,
  LibraryView,
  PatchManifest,
  type PatcherBridge,
  RunReport,
  Stack,
} from "@app/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A request to the main process that failed, in words. */
export class Refused extends Schema.TaggedError<Refused>()("Refused", { reason: Schema.String }) {
  override get message(): string {
    return this.reason;
  }
}

/** The main process as the window sees it: each bridge request, its answer checked. */
export interface Patcher {
  readonly library: Effect.Effect<LibraryView, Refused>;
  readonly saveStack: (stack: Stack) => Effect.Effect<LibraryView, Refused>;
  readonly apply: (install: boolean) => Effect.Effect<RunReport, Refused>;
  readonly lastReport: Effect.Effect<RunReport | null, Refused>;
  readonly workspace: (id: string) => Effect.Effect<string, Refused>;
  readonly capture: (request: typeof CaptureRequest.Encoded) => Effect.Effect<PatchManifest, Refused>;
  /** Calls `listener` with each report while a run goes on; returns a function that stops listening. */
  readonly onReport: (listener: (report: RunReport) => void) => () => void;
}

const ask = <A, I>(schema: Schema.Codec<A, I>, call: () => Promise<unknown>): Effect.Effect<A, Refused> =>
  Effect.tryPromise({ try: call, catch: () => new Refused({ reason: "the app didn't answer" }) }).pipe(
    Effect.flatMap((answer) =>
      Schema.decodeUnknownEffect(Answer(schema))(answer).pipe(
        Effect.mapError(() => new Refused({ reason: "the app answered something unexpected" })),
      ),
    ),
    Effect.flatMap((answer) => (answer.ok ? Effect.succeed(answer.value) : Effect.fail(new Refused({ reason: answer.error })))),
  );

const encodeStack = Schema.encodeEffect(Stack);
const decodeReport = Schema.decodeUnknownOption(RunReport);

export const bridgePatcher = (bridge: PatcherBridge): Patcher => ({
  library: ask(LibraryView, () => bridge.library()),
  saveStack: (stack) =>
    encodeStack(stack).pipe(
      Effect.mapError(() => new Refused({ reason: "not a stack" })),
      Effect.flatMap((encoded) => ask(LibraryView, () => bridge.saveStack(encoded))),
    ),
  apply: (install) => ask(RunReport, () => bridge.apply(install)),
  lastReport: ask(Schema.NullOr(RunReport), () => bridge.lastReport()),
  workspace: (id) => ask(Schema.String, () => bridge.workspace(id)),
  capture: (request) => ask(PatchManifest, () => bridge.capture(request)),
  onReport: (listener) =>
    bridge.onReport((report) => {
      const decoded = decodeReport(report);
      if (Option.isSome(decoded)) listener(decoded.value);
    }),
});
