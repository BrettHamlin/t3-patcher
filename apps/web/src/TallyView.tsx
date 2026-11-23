import { TallyUi, type Tally } from "@app/contracts";
import { entries, parseItemName, record, type TallyStore } from "@app/tally";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { useState } from "react";

export interface TallyViewProps {
  readonly initial: Tally;
  readonly store: Layer.Layer<TallyStore>;
}

export function TallyView({ initial, store }: TallyViewProps) {
  const [tally, setTally] = useState(initial);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  // One record at a time: each one loads, counts and saves, so two at once would lose a count. The name is locked
  // too, so a save that clears it never clears one typed meanwhile.
  const [saving, setSaving] = useState(false);

  const add = () => {
    setSaving(true);
    Effect.runFork(
      parseItemName(name).pipe(
        Effect.flatMap(record),
        Effect.match({
          onFailure: (failure) => setError(failure.message),
          onSuccess: (next) => {
            setTally(next);
            setError("");
            setName("");
          },
        }),
        Effect.ensuring(Effect.sync(() => setSaving(false))),
        Effect.provide(store),
      ),
    );
  };

  const items = entries(tally);
  return (
    <main>
      <input
        data-testid={TallyUi.name.value}
        value={name}
        onChange={(event) => setName(event.target.value)}
        disabled={saving}
        aria-label="Item name"
      />
      <button type="button" data-testid={TallyUi.add.value} onClick={add} disabled={saving}>
        Add
      </button>
      <p data-testid={TallyUi.error.value} role="alert">
        {error}
      </p>
      <ul data-testid={TallyUi.items.value}>
        {items.length === 0 ? <li>(empty)</li> : items.map(([item, count]) => <li key={item}>{`${item} ${count}`}</li>)}
      </ul>
    </main>
  );
}
