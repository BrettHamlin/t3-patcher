// b-stack's lint rules (protected), loaded by oxlint as a JS plugin from vite.config.ts. Each rule's message says how
// to fix it; the rules and their tests live in b-stack's rules/ folder.
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import { definePlugin, defineRule, type ESTree, type Scope, type Variable } from "@oxlint/plugins";

const ROOT = NodePath.resolve(import.meta.dirname, "../..");

interface Role {
  readonly folders: ReadonlyArray<string>;
  readonly may_use: ReadonlyArray<string>;
  readonly external: ReadonlyArray<string>;
  readonly dev_external: ReadonlyArray<string>;
  readonly effect_modules?: "logic";
}
interface Shape {
  readonly scope: string;
  readonly roles: Readonly<Record<string, Role>>;
  readonly logic_effect_modules: ReadonlyArray<string>;
}
const SHAPE: Shape = JSON.parse(NodeFs.readFileSync(NodePath.join(ROOT, "arch/shape.json"), "utf8"));

/** The package folder (relative to the project) and role of a file, if it's in one of the shape's folders. */
const packageOf = (filename: string): { readonly folder: string; readonly role: string } | undefined => {
  const relative = NodePath.relative(ROOT, filename).split(NodePath.sep);
  for (const [role, spec] of Object.entries(SHAPE.roles)) {
    for (const folder of spec.folders) {
      const parts = folder.split("/");
      if (relative.length > parts.length && parts.every((part, i) => part === "*" || part === relative[i])) {
        return { folder: relative.slice(0, parts.length).join("/"), role };
      }
    }
  }
  return undefined;
};

interface Manifest {
  readonly name?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}
const manifests = new Map<string, Manifest>();
const manifest = (folder: string): Manifest => {
  const cached = manifests.get(folder);
  if (cached) return cached;
  const read: Manifest = JSON.parse(NodeFs.readFileSync(NodePath.join(ROOT, folder, "package.json"), "utf8"));
  manifests.set(folder, read);
  return read;
};

/** Test, journey and config files may also use the package's devDependencies. */
const isDevFile = (folder: string, filename: string): boolean => {
  const inner = NodePath.relative(NodePath.join(ROOT, folder), filename).split(NodePath.sep);
  return inner[0] === "tests" || inner[0] === "journeys" || (inner.length === 1 && /\.config\.ts$/.test(inner[0] ?? ""));
};

const packageName = (specifier: string): string => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
};

/** Visitors that call `found` with every module a file names: imports, re-exports, dynamic imports, import types. */
const moduleSources = (
  found: (node: ESTree.Node, specifier: string | undefined) => void,
): Record<string, (node: never) => void> => {
  const literal = (node: ESTree.Node, source: ESTree.Node | null | undefined): void => {
    if (!source) return;
    found(node, source.type === "Literal" && typeof source.value === "string" ? source.value : undefined);
  };
  return {
    ImportDeclaration: (node: ESTree.ImportDeclaration) => literal(node, node.source),
    ExportNamedDeclaration: (node: ESTree.ExportNamedDeclaration) => literal(node, node.source),
    ExportAllDeclaration: (node: ESTree.ExportAllDeclaration) => literal(node, node.source),
    ImportExpression: (node: ESTree.ImportExpression) => literal(node, node.source),
    TSImportType: (node: ESTree.TSImportType) => {
      if (node.argument.type === "TSLiteralType") literal(node, node.argument.literal);
    },
    TSExternalModuleReference: (node: ESTree.TSExternalModuleReference) => literal(node, node.expression),
  };
};

const moduleBoundaries = defineRule({
  meta: { type: "problem", docs: { description: "Imports stay inside what the package declares and its role allows." } },
  create(context) {
    const owner = packageOf(context.filename);
    if (!owner) return {};
    const role = SHAPE.roles[owner.role];
    const deps = manifest(owner.folder);
    const dev = isDevFile(owner.folder, context.filename);
    const check = (node: ESTree.Node, specifier: string): void => {
      if (specifier.startsWith(".")) {
        const written = NodePath.resolve(NodePath.dirname(context.filename), specifier);
        // Classify the file the import really reaches: TypeScript and the bundler read `./x.js` as `./x.ts`.
        const target =
          [
            written,
            written.replace(/\.(c|m)?js$/u, ".$1ts"),
            written.replace(/\.jsx?$/u, ".tsx"),
            // The renderer resolves like a bundler: no extension, or a folder's index.
            ...[".ts", ".tsx", "/index.ts", "/index.tsx"].map((suffix) => written + suffix),
          ].find((candidate) => NodeFs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) ?? written;
        if (!dev && isDevFile(owner.folder, target)) {
          context.report({
            node,
            message: `The app's own code can't import ${NodePath.relative(ROOT, target)}: test, journey and config files may use test setup (fixtures, devDependencies) that must never ship. Move shared code into src/.`,
          });
        }
        return; // the compiler checks that it stays inside the package (rootDir)
      }
      if (specifier.startsWith("node:")) return; // the compiler checks these per role
      const name = packageName(specifier);
      const self = name === manifest(owner.folder).name;
      const declared = self || name in (deps.dependencies ?? {}) || (dev && name in (deps.devDependencies ?? {}));
      if (!declared) {
        context.report({
          node,
          message: `${owner.folder} doesn't declare "${name}"${dev ? "" : " in dependencies"}. Add it to ${owner.folder}/package.json if the ${owner.role} role allows it (arch/shape.json); otherwise use what the package already has, or stop and report.`,
        });
        return;
      }
      if (role?.effect_modules === "logic" && name === "effect") {
        const module = specifier.slice("effect/".length);
        if (specifier === "effect" || !SHAPE.logic_effect_modules.includes(module)) {
          context.report({
            node,
            message: `"${specifier}" isn't allowed in a ${owner.role} package: logic imports one effect module at a time, from the list in arch/shape.json, and none of them do I/O (FileSystem, Path, HTTP and processes are platform packages' job). Declare a service for what you need and implement it in a platform package.`,
          });
        }
      }
    };
    return moduleSources((node, specifier) => {
      if (specifier === undefined) {
        context.report({ node, message: "Import a module by a string literal, so the module shape can be checked." });
      } else {
        check(node, specifier);
      }
    });
  },
});

const noAmbientDeclarations = defineRule({
  meta: { type: "problem", docs: { description: "No `declare`: every name the code uses comes from a real module or the role's own types." } },
  create(context) {
    const report = (node: ESTree.Node): void =>
      context.report({
        node,
        message: "Ambient declarations (`declare`) aren't allowed: they tell the compiler something exists without proving it. Import it from a module the package depends on; if the role lacks it, the code belongs in another role.",
      });
    return {
      VariableDeclaration: (node) => { if (node.declare) report(node); },
      TSDeclareFunction: (node) => report(node),
      ClassDeclaration: (node) => { if (node.declare) report(node); },
      TSModuleDeclaration: (node) => report(node),
      TSInterfaceDeclaration: (node) => { if (node.declare) report(node); },
      TSTypeAliasDeclaration: (node) => { if (node.declare) report(node); },
      TSEnumDeclaration: (node) => { if (node.declare) report(node); },
    };
  },
});

const CONTAINERS = new Set(["Map", "Set", "WeakMap", "WeakSet", "Array"]);

const noModuleState = defineRule({
  meta: { type: "problem", docs: { description: "No mutable module-level or static state." } },
  create(context) {
    const message = "Module-level and static mutable state isn't allowed: it's a hidden global any code can reach. Keep state in a value you pass in, or in an Effect service (a Ref inside a Layer) the composition root provides.";
    return {
      Program(node) {
        for (const statement of node.body) {
          const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
          if (declaration?.type === "VariableDeclaration" && declaration.kind !== "const") {
            context.report({ node: declaration, message });
          } else if (declaration?.type === "VariableDeclaration") {
            // A const can still hold mutable state: a Map, Set or array, or an object literal not frozen with `as const`.
            for (const declarator of declaration.declarations) {
              const value = declarator.init;
              const container =
                (value?.type === "NewExpression" && value.callee.type === "Identifier" && CONTAINERS.has(value.callee.name)) ||
                value?.type === "ArrayExpression" ||
                value?.type === "ObjectExpression";
              if (container) context.report({ node: declarator, message });
            }
          }
        }
      },
      PropertyDefinition: (node) => { if (node.static && !node.readonly) context.report({ node, message }); },
      StaticBlock: (node) => context.report({ node, message }),
    };
  },
});

const SKIPS = new Set(["skip", "only", "todo", "skipIf", "runIf", "fails"]);
// Test forms vitest/expect-expect can't check for an assertion: generated property tests, and tables of Effect tests.
const UNCHECKED = new Set(["prop"]);
const EFFECT_TESTS = new Set(["effect", "live", "scoped"]);

const memberName = (node: ESTree.Node): string =>
  node.type === "Identifier" ? node.name : node.type === "Literal" ? String(node.value) : "";

const noSkippedTests = defineRule({
  meta: { type: "problem", docs: { description: "Every test runs, in a form the assertion check can see." } },
  create(context) {
    const owner = packageOf(context.filename);
    const relative = NodePath.relative(ROOT, context.filename).split(NodePath.sep);
    // Test and journey files only: elsewhere `.only` or `.prop` is ordinary code.
    const inner = owner === undefined ? [] : NodePath.relative(NodePath.join(ROOT, owner.folder), context.filename).split(NodePath.sep);
    const isTest = inner[0] === "tests" || inner[0] === "journeys" || /\.(test|journey)\.tsx?$/.test(relative.at(-1) ?? "");
    if (!isTest) return {};
    return {
      MemberExpression(node) {
        const name = memberName(node.property);
        if (SKIPS.has(name)) {
          context.report({
            node,
            message: `Every test runs: \`.${name}\` isn't allowed. If a test can't pass, fix the code or the test, or stop and report.`,
          });
        }
        const object = node.object;
        const effectTable = name === "each" && object.type === "MemberExpression" && EFFECT_TESTS.has(memberName(object.property));
        if (UNCHECKED.has(name) || effectTable) {
          context.report({
            node,
            message: `\`.${name}\` registers tests the assertion check can't see. Write one it.effect (or it) that loops over its cases and asserts each with expect, like the property test in packages/features/tally/tests/property.test.ts.`,
          });
        }
      },
    };
  },
});

const UI_MESSAGE =
  "Use a typed identifier from contracts (e.g. TallyUi.add). Views set data-testid only from one (TallyUi.add.value), and journeys find elements only through the Screen in journeys/support, which takes UiIds; never by text, role or selector. Add the identifier to the screen's *Ui object in packages/contracts; if the Screen lacks what you need, stop and report.";

const typedUiIdentifiers = defineRule({
  meta: { type: "problem", docs: { description: "Elements are found only by typed identifiers from contracts." } },
  create(context) {
    const relative = NodePath.relative(ROOT, context.filename).split(NodePath.sep).join("/");
    const inContracts = relative.startsWith("packages/contracts/");
    // Every journey file except the code-owned support layer, which wraps Playwright in the typed Screen.
    const isJourney = relative.startsWith("apps/desktop/journeys/") && !relative.startsWith("apps/desktop/journeys/support/");
    // The identifier must be bound by an import from @app/contracts (not a local object, and not shadowed).
    const isContractsUi = (expression: ESTree.Node): boolean => {
      // <Screen>Ui.<thing>.value: the string a UiId carries.
      if (expression.type !== "MemberExpression" || expression.computed || memberName(expression.property) !== "value") return false;
      const node = expression.object;
      if (node.type !== "MemberExpression" || node.computed || node.object.type !== "Identifier" || !/Ui$/.test(node.object.name)) {
        return false;
      }
      // The binding TypeScript uses for this value: the reference's own resolution, so a type of the same name or a
      // shadowing local can't stand in for the import.
      const object = node.object;
      let variable: Variable | null | undefined;
      for (let scope: Scope | null = context.sourceCode.getScope(node); scope && variable === undefined; scope = scope.upper) {
        variable = scope.references.find((reference) => reference.identifier === object)?.resolved;
      }
      // Its value comes from the contracts import; any other declaration of the name may only be a type.
      const defs = variable?.defs ?? [];
      const imported = defs.filter(
        (definition) =>
          definition.type === "ImportBinding" &&
          definition.parent?.type === "ImportDeclaration" &&
          definition.parent.source.value === "@app/contracts",
      );
      const typeOnly = (definition: (typeof defs)[number]): boolean =>
        definition.node.type === "TSTypeAliasDeclaration" || definition.node.type === "TSInterfaceDeclaration";
      return imported.length === 1 && defs.every((definition) => imported.includes(definition) || typeOnly(definition));
    };
    const imports = moduleSources((node, specifier) => {
      const name = specifier === undefined ? undefined : packageName(specifier);
      const driver = name === undefined || name === "playwright-core" || name === "playwright" || name.startsWith("@playwright/") || name === "electron";
      if (isJourney && (driver || specifier?.split(/[\\/]/).includes("node_modules"))) {
        context.report({ node, message: `Journeys don't drive the app directly. ${UI_MESSAGE}` });
      }
    });
    return {
      ...imports,
      CallExpression(node: ESTree.CallExpression) {
        const callee = node.callee;
        const name = callee.type === "Identifier" ? callee.name : callee.type === "MemberExpression" && callee.property.type === "Identifier" ? callee.property.name : "";
        if (name === "uiId" && !inContracts) context.report({ node, message: `Only contracts make UiIds. ${UI_MESSAGE}` });
      },
      JSXSpreadAttribute(node: ESTree.JSXSpreadAttribute) {
        // A spread ({...props}) can carry any data-testid unchecked: pass attributes one by one.
        context.report({ node, message: `No spread attributes in JSX: pass each attribute explicitly, so data-testid can be checked. ${UI_MESSAGE}` });
      },
      JSXAttribute(node: ESTree.JSXAttribute) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "data-testid") return;
        const value = node.value;
        if (!(value?.type === "JSXExpressionContainer" && isContractsUi(value.expression))) {
          context.report({ node, message: `data-testid must be a contracts identifier, a *Ui object imported from @app/contracts (data-testid={TallyUi.add.value}). ${UI_MESSAGE}` });
        }
      },
    };
  },
});

const roleOf = (filename: string): string | undefined => packageOf(filename)?.role;

const typedIdentifiers = defineRule({
  meta: { type: "problem", docs: { description: "Only contracts make branded values." } },
  create(context) {
    if (roleOf(context.filename) === "contracts") return {};
    const message =
      "Only packages/contracts makes branded types and values: decode with the contracts' schema (it checks the value), never mint one here. If contracts lacks the type, add it there.";
    // Whether an identifier is bound to effect's Schema module (import * as Schema from "effect/Schema", or
    // import { Schema } from "effect"): then `.brand` on it mints a brand.
    const isSchemaModule = (identifier: ESTree.Node): boolean => {
      if (identifier.type !== "Identifier") return false;
      let variable: Variable | null | undefined;
      for (let scope: Scope | null = context.sourceCode.getScope(identifier); scope && variable === undefined; scope = scope.upper) {
        variable = scope.references.find((reference) => reference.identifier === identifier)?.resolved;
      }
      return (variable?.defs ?? []).some((definition) => {
        const parent = definition.parent;
        if (definition.type !== "ImportBinding" || parent?.type !== "ImportDeclaration") return false;
        const source = String(parent.source.value);
        const node = definition.node;
        return (source === "effect/Schema" && node.type === "ImportNamespaceSpecifier") ||
          (source === "effect" && node.type === "ImportSpecifier" && memberName(node.imported) === "Schema");
      });
    };
    return {
      ImportDeclaration(node) {
        const source = String(node.source.value);
        const runtime = node.importKind !== "type" &&
          (node.specifiers.length === 0 || node.specifiers.some((s) => s.type !== "ImportSpecifier" || s.importKind !== "type"));
        if (source === "effect/Brand" && runtime) context.report({ node, message });
        // import { brand } from "effect/Schema"
        for (const specifier of node.specifiers) {
          if (source === "effect/Schema" && specifier.type === "ImportSpecifier" && specifier.importKind !== "type" &&
            memberName(specifier.imported) === "brand") {
            context.report({ node: specifier, message });
          }
        }
      },
      MemberExpression(node) {
        if (memberName(node.property) === "brand" && isSchemaModule(node.object)) context.report({ node, message });
      },
      VariableDeclarator(node) {
        // const { brand } = Schema
        if (node.id.type === "ObjectPattern" && node.init && isSchemaModule(node.init) &&
          node.id.properties.some((p) => p.type === "Property" && memberName(p.key) === "brand")) {
          context.report({ node, message });
        }
      },
    };
  },
});

// Globals that reach the outside world without the compiler seeing an import.
const LOGIC_GLOBALS = new Set(["globalThis"]);
const RENDERER_GLOBALS = new Set([
  "globalThis", "localStorage", "sessionStorage", "indexedDB", "caches", "WebSocket", "XMLHttpRequest", "EventSource",
  "BroadcastChannel", "Worker", "SharedWorker", "fetch", "open",
]);

const noIoGlobals = defineRule({
  meta: { type: "problem", docs: { description: "Logic and the renderer reach the outside only through services." } },
  create(context) {
    const role = roleOf(context.filename);
    const banned = role === "contracts" || role === "feature" ? LOGIC_GLOBALS : role === "web" ? RENDERER_GLOBALS : undefined;
    if (!banned) return {};
    const message =
      role === "web"
        ? "The renderer reaches the outside world only through the preload's bridge (typed in packages/contracts/src/ipc.ts): add what you need to the bridge and the main process, never storage, sockets or requests here."
        : "Logic does no I/O, and globalThis is how code reaches globals the compiler would refuse. Declare an Effect service for what you need and implement it in a platform package.";
    const isGlobal = (identifier: ESTree.Node): boolean => {
      if (identifier.type !== "Identifier") return false;
      let variable: Variable | null | undefined;
      for (let scope: Scope | null = context.sourceCode.getScope(identifier); scope && variable === undefined; scope = scope.upper) {
        variable = scope.references.find((reference) => reference.identifier === identifier)?.resolved;
      }
      return !variable || variable.scope.type === "global";
    };
    return {
      // window.localStorage, self.fetch: the same globals, reached through the global object.
      MemberExpression(node: ESTree.MemberExpression) {
        if (role !== "web" || node.object.type !== "Identifier" || !["window", "self", "globalThis"].includes(node.object.name)) return;
        if (banned.has(memberName(node.property)) && isGlobal(node.object)) context.report({ node, message });
      },
      "Program:exit"(program: ESTree.Program) {
        const global = context.sourceCode.getScope(program);
        // A global is either declared by a lib (a variable of the global scope) or not (a reference passing through).
        const references = [
          ...global.through,
          ...[...banned].flatMap((name) => global.set.get(name)?.references ?? []),
        ];
        const seen = new Set<ESTree.Node>();
        for (const reference of references) {
          if (banned.has(reference.identifier.name) && !seen.has(reference.identifier)) {
            seen.add(reference.identifier);
            context.report({ node: reference.identifier, message });
          }
        }
      },
    };
  },
});

const noUncheckedNarrowing = defineRule({
  meta: { type: "problem", docs: { description: "Types narrow only through checks the compiler or a schema makes." } },
  create(context) {
    if (roleOf(context.filename) === "contracts") return {};
    const message =
      "Hand-written narrowing isn't allowed: a type predicate (`x is T`, `asserts x is T`) or an overload signature claims a type without checking it, a cast in disguise. Decode with an Effect Schema (Schema.is, Schema.decodeUnknown*), or put the guard in packages/contracts.";
    return {
      TSTypePredicate: (node) => context.report({ node, message }),
      MethodDefinition(node) {
        if (node.value.type === "TSEmptyBodyFunctionExpression") context.report({ node, message });
      },
      TSDeclareFunction: (node) => context.report({ node, message }),
    };
  },
});

export default definePlugin({
  meta: { name: "bstack" },
  rules: {
    "module-boundaries": moduleBoundaries,
    "no-ambient-declarations": noAmbientDeclarations,
    "no-module-state": noModuleState,
    "no-skipped-tests": noSkippedTests,
    "typed-ui-identifiers": typedUiIdentifiers,
    "typed-identifiers": typedIdentifiers,
    "no-io-globals": noIoGlobals,
    "no-unchecked-narrowing": noUncheckedNarrowing,
  },
});
