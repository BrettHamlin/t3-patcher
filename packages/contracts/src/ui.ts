// Identifiers the renderer puts on elements (data-testid={StackUi.toggle.value}) and journeys find them by. A UiId can be
// made only here: its constructor needs a token that never leaves this file, and its private field means no other
// object passes for one. So a view or journey can't make one, or pass a string where one is expected.
const token: unique symbol = Symbol("UiId");

export class UiId {
  readonly value: string;
  private readonly made: typeof token;

  constructor(made: typeof token, value: string) {
    this.made = made;
    this.value = value;
  }
}

export const uiId = (value: string): UiId => new UiId(token, value);
