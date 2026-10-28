#!/usr/bin/env node
// dependency-cruiser, parsing TypeScript with TypeScript 6.
//
// dependency-cruiser reads .ts/.tsx through the TypeScript compiler API and
// accepts `typescript` >=2 <7. Our `typescript` is 7.x, which ships no compiler
// API (ADR-0103), so dependency-cruiser would silently skip every .ts file and
// report a clean graph. `typescript-api` is TypeScript 6 under an alias, the
// parser the specs already use; this hook points dependency-cruiser's
// `typescript` at it, in this process only. Delete the hook once TypeScript 7.1
// ships its API and dependency-cruiser accepts it.
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'typescript' || specifier.startsWith('typescript/')) {
      return nextResolve(`typescript-api${specifier.slice('typescript'.length)}`, context);
    }
    return nextResolve(specifier, context);
  },
});

// dependency-cruiser imports a reporter plugin from inside its own package, so
// a relative `plugin:./x.mjs` would resolve there. Anchor it to this directory.
process.argv = process.argv.map((arg) =>
  arg.startsWith('plugin:.') ? `plugin:${pathToFileURL(path.resolve(arg.slice('plugin:'.length))).href}` : arg
);

// The CLI is not in the package's exports, so it is imported by path.
await import(new URL('../node_modules/dependency-cruiser/bin/dependency-cruiser.mjs', import.meta.url).href);
