import { AuthorUi, type LibraryView, type PatchId, type RunReport, RunUi, type Stack, StackUi, type Step } from "@app/contracts";
import { moved, parsePatchId, toggled } from "@app/stack";
import * as Effect from "effect/Effect";
import { useEffect, useState } from "react";

import type { Patcher } from "./patcher.ts";

export interface PatcherViewProps {
  readonly patcher: Patcher;
  readonly view: LibraryView | undefined;
  /** Why the patches couldn't be shown, if they couldn't. */
  readonly problem: string;
  readonly report: RunReport | undefined;
}

const stackLines = (view: LibraryView | undefined): ReadonlyArray<string> =>
  (view?.stack.entries ?? []).map((entry, index) => {
    const title = view?.patches.find((patch) => patch.id === entry.id)?.title ?? "";
    return `${index + 1}. ${entry.id} [${entry.enabled ? "on" : "off"}] — ${title}`;
  });

const stepLine = (step: Step): string => `${step.status} ${step.kind} ${step.name}`;

const outcome = (report: RunReport | undefined, running: boolean): string => {
  if (report === undefined) return running ? "running…" : "";
  const failed = report.steps.find((step) => step.status === "failed");
  if (failed !== undefined) return `failed at ${failed.name}: ${failed.note}`;
  if (running || report.steps.some((step) => step.status === "pending" || step.status === "running")) return "running…";
  return "passed";
};

export function PatcherView({ patcher, view: initialView, problem, report: initialReport }: PatcherViewProps) {
  const [view, setView] = useState(initialView);
  const [patch, setPatch] = useState("");
  const [stackMessage, setStackMessage] = useState(problem);
  const [saving, setSaving] = useState(false);

  const [install, setInstall] = useState(false);
  const [report, setReport] = useState(initialReport);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");

  const [authorId, setAuthorId] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [authorMessage, setAuthorMessage] = useState("");
  const [authoring, setAuthoring] = useState(false);

  useEffect(() => patcher.onReport(setReport), [patcher]);

  const restack = (change: (stack: Stack, id: PatchId) => Stack) => {
    setSaving(true);
    Effect.runFork(
      Effect.gen(function* () {
        const stack = view?.stack;
        if (stack === undefined) return problem;
        const id = yield* parsePatchId(patch.trim());
        if (!stack.entries.some((entry) => entry.id === id)) return `no patch named ${id}`;
        setView(yield* patcher.saveStack(change(stack, id)));
        return "";
      }).pipe(
        Effect.match({ onFailure: (failure) => setStackMessage(failure.message), onSuccess: setStackMessage }),
        Effect.ensuring(Effect.sync(() => setSaving(false))),
      ),
    );
  };

  const apply = () => {
    setRunning(true);
    setRunError("");
    setReport(undefined);
    Effect.runFork(
      patcher.apply(install).pipe(
        Effect.match({ onFailure: (failure) => setRunError(failure.message), onSuccess: setReport }),
        Effect.ensuring(Effect.sync(() => setRunning(false))),
      ),
    );
  };

  const author = (work: Effect.Effect<string, { readonly message: string }>) => {
    setAuthoring(true);
    Effect.runFork(
      work.pipe(
        Effect.match({ onFailure: (failure) => setAuthorMessage(failure.message), onSuccess: setAuthorMessage }),
        Effect.ensuring(Effect.sync(() => setAuthoring(false))),
      ),
    );
  };

  const open = () => author(patcher.workspace(authorId.trim()));
  const capture = () =>
    author(
      Effect.gen(function* () {
        const manifest = yield* patcher.capture({ id: authorId.trim(), title: title.trim(), summary: summary.trim() });
        setView(yield* patcher.library);
        return `captured ${manifest.id}`;
      }),
    );

  const lines = stackLines(view);
  return (
    <main>
      <h1>T3 Patcher</h1>
      <section aria-labelledby="stack-heading">
        <h2 id="stack-heading">Stack</h2>
        <ul data-testid={StackUi.list.value} className="lines">
          {lines.length === 0 ? <li>(no patches)</li> : lines.map((line) => <li key={line}>{line}</li>)}
        </ul>
        <div className="row">
          <input
            data-testid={StackUi.patch.value}
            value={patch}
            onChange={(event) => setPatch(event.target.value)}
            placeholder="patch name"
            aria-label="Patch name"
          />
          <button type="button" data-testid={StackUi.toggle.value} onClick={() => restack(toggled)} disabled={saving}>
            On / off
          </button>
          <button type="button" data-testid={StackUi.up.value} onClick={() => restack((stack, id) => moved(stack, id, -1))} disabled={saving}>
            Up
          </button>
          <button type="button" data-testid={StackUi.down.value} onClick={() => restack((stack, id) => moved(stack, id, 1))} disabled={saving}>
            Down
          </button>
        </div>
        <p data-testid={StackUi.message.value} role="alert" className="message">
          {stackMessage}
        </p>
      </section>

      <section aria-labelledby="run-heading">
        <h2 id="run-heading">Run</h2>
        <div className="row">
          <label>
            <input
              type="checkbox"
              data-testid={RunUi.install.value}
              checked={install}
              onChange={(event) => setInstall(event.target.checked)}
              disabled={running}
            />
            Install when every check passes
          </label>
          <button type="button" data-testid={RunUi.apply.value} onClick={apply} disabled={running}>
            Apply
          </button>
        </div>
        <ul data-testid={RunUi.steps.value} className="lines steps">
          {(report?.steps ?? []).map((step) => (
            <li key={`${step.kind} ${step.name}`} className={step.status} data-note={step.note}>
              {stepLine(step)}
            </li>
          ))}
        </ul>
        <p data-testid={RunUi.outcome.value} role="status" className="message">
          {runError === "" ? outcome(report, running) : runError}
        </p>
      </section>

      <section aria-labelledby="author-heading">
        <h2 id="author-heading">Author</h2>
        <div className="fields">
          <input
            data-testid={AuthorUi.id.value}
            value={authorId}
            onChange={(event) => setAuthorId(event.target.value)}
            placeholder="patch name"
            aria-label="New or existing patch name"
          />
          <input
            data-testid={AuthorUi.title.value}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="title"
            aria-label="Title"
          />
          <input
            data-testid={AuthorUi.summary.value}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            placeholder="summary"
            aria-label="Summary"
          />
        </div>
        <div className="row">
          <button type="button" data-testid={AuthorUi.open.value} onClick={open} disabled={authoring}>
            Open workspace
          </button>
          <button type="button" data-testid={AuthorUi.capture.value} onClick={capture} disabled={authoring}>
            Capture
          </button>
        </div>
        <p data-testid={AuthorUi.message.value} role="status" className="message">
          {authorMessage}
        </p>
      </section>
    </main>
  );
}
