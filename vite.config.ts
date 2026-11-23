// Lint and test settings for the whole workspace (protected). `vp lint` and `vp test` read this file.
// Starts from T3 Code's vite.config.ts; the bstack/* rules are in arch/lint.
import { defineConfig } from "vite-plus";

const ERROR = "error";
const PARTIAL =
  "Assert the whole value with toEqual (or toBe, toStrictEqual, toBeInstanceOf), so a change the test didn't expect fails it. If the whole value can't be pinned down, stop and report.";

export default defineConfig({
  lint: {
    ignorePatterns: ["**/node_modules", "/dist", "/.build", "/.tools", "/arch/lint", "/scripts", "apps/*/dist"],
    plugins: ["eslint", "oxc", "typescript", "unicorn", "react", "import", "vitest"],
    jsPlugins: ["./arch/lint/index.ts"],
    categories: { correctness: ERROR, suspicious: ERROR, perf: ERROR },
    options: { typeAware: true, reportUnusedDisableDirectives: ERROR },
    rules: {
      // no-force-operations
      "typescript/no-explicit-any": ERROR,
      "typescript/no-non-null-assertion": ERROR,
      "typescript/consistent-type-assertions": [ERROR, { assertionStyle: "never" }],
      "typescript/no-unsafe-type-assertion": ERROR,
      "typescript/no-unsafe-argument": ERROR,
      "typescript/no-unsafe-assignment": ERROR,
      "typescript/no-unsafe-call": ERROR,
      "typescript/no-unsafe-member-access": ERROR,
      "typescript/no-unsafe-return": ERROR,
      // exhaustive-states
      "typescript/switch-exhaustiveness-check": [
        ERROR,
        { allowDefaultCaseForExhaustiveSwitch: false, considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true },
      ],
      // no-concurrency-escapes
      "typescript/no-floating-promises": [ERROR, { ignoreVoid: false }],
      "typescript/no-misused-promises": ERROR,
      "eslint/no-restricted-globals": [
        ERROR,
        { name: "setTimeout", message: "Raw timers aren't allowed: use Effect.sleep or a Schedule, which can be interrupted and tested with TestClock." },
        { name: "setInterval", message: "Raw timers aren't allowed: use Effect.repeat with a Schedule, which can be interrupted and tested with TestClock." },
        { name: "setImmediate", message: "Raw timers aren't allowed: use an Effect (Effect.yieldNow), which can be interrupted and tested." },
        { name: "queueMicrotask", message: "Raw scheduling isn't allowed: use an Effect, which can be interrupted and tested." },
      ],
      // no-suppressions
      "typescript/ban-ts-comment": [ERROR, { "ts-expect-error": true, "ts-ignore": true, "ts-nocheck": true, "ts-check": false }],
      "typescript/triple-slash-reference": [ERROR, { lib: "never", path: "never", types: "never" }],
      // retired-apis
      "typescript/no-deprecated": ERROR,
      "eslint/no-restricted-imports": [
        ERROR,
        {
          paths: [
            {
              name: "@effect/vitest",
              importNames: ["effect", "live", "scoped", "flakyTest", "prop"],
              message: "Register Effect tests as it.effect, it.live or it.scoped, which the assertion check (vitest/expect-expect) knows; flaky tests are fixed, not retried.",
            },
          ],
        },
      ],
      // module-boundaries, no-io-in-logic, explicit-dependencies
      "bstack/module-boundaries": ERROR,
      "bstack/no-ambient-declarations": ERROR,
      "bstack/no-module-state": ERROR,
      "typescript/no-require-imports": ERROR,
      "typescript/no-namespace": ERROR,
      "import/no-commonjs": ERROR,
      "eslint/no-eval": ERROR,
      "eslint/no-new-func": ERROR,
      "typescript/no-implied-eval": ERROR,
      // typed-ui-identifiers
      "bstack/typed-ui-identifiers": ERROR,
      // typed-identifiers, no-io-in-logic, no-force-operations
      "bstack/typed-identifiers": ERROR,
      "bstack/no-io-globals": ERROR,
      "bstack/no-unchecked-narrowing": ERROR,
      // exhaustive-tests: a test checks the whole value, so a change it didn't expect fails it
      "vitest/no-restricted-matchers": [
        ERROR,
        {
          toMatchObject: PARTIAL,
          toHaveProperty: PARTIAL,
          toBeTruthy: PARTIAL,
          toBeFalsy: PARTIAL,
          toBeDefined: PARTIAL,
          toContain: PARTIAL,
          toContainEqual: PARTIAL,
          toMatch: PARTIAL,
        },
      ],
      "eslint/no-restricted-properties": [
        ERROR,
        ...["objectContaining", "arrayContaining", "stringContaining", "stringMatching", "any", "anything"].map((property) => ({
          object: "expect",
          property,
          message: PARTIAL,
        })),
      ],
      "vitest/expect-expect": [
        ERROR,
        { assertFunctionNames: ["expect"], additionalTestBlockFunctions: ["it.effect", "it.live", "it.scoped"] },
      ],
      // tests-always-run
      "bstack/no-skipped-tests": ERROR,
      "vitest/no-standalone-expect": [ERROR, { additionalTestBlockFunctions: ["it.effect", "it.live", "it.scoped"] }],
      // Off as in T3 Code: React 17+ needs no React import for JSX, Effect generators return conditionally, and
      // Effect's tagged unions use `_tag`.
      "react/react-in-jsx-scope": "off",
      "typescript/consistent-return": "off",
      "eslint/no-underscore-dangle": "off",
      "eslint/no-unused-vars": [ERROR, { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["{packages,apps}/*/tests/**/*.test.{ts,tsx}", "packages/*/*/tests/**/*.test.{ts,tsx}"],
          environment: "node",
          allowOnly: false,
          // Flaky tests are fixed, not retried (T3 Code's setting).
          retry: 0,
          fakeTimers: {
            toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date", "performance"],
          },
        },
      },
      {
        // The verify gate's: journeys drive the built desktop app (scripts/verify.py).
        test: {
          name: "journeys",
          include: ["apps/desktop/journeys/**/*.journey.ts"],
          environment: "node",
          allowOnly: false,
          retry: 0,
          testTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
    passWithNoTests: false,
  },
});
