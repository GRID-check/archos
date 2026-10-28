// @ts-check
// The module seams of the UI, checked by dependency-cruiser in `task fe:lint`
// (`bun run lint:seams`). Why each rule exists, and how the baselines move:
// docs/contributing/module-seams.md.
//
// The layers point one way: app → features → components → lib. lib is the
// headless core the routes, the agent door and every feature share, so it knows
// no UI; components is the shared kit, so it knows no feature; a feature
// reaches another only through that feature's index, and never in a circle (the
// circle is checked by scripts/module-seams-reporter.mjs, which this tool cannot
// express). Edges that broke a rule before the check existed are listed in
// `.dependency-cruiser-known-violations.json`. That list may only shrink.
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, 'src');
const TEST_FILE = '\\.(spec|test)\\.[cm]?[jt]sx?$';

/**
 * Every module that starts with `import 'server-only'`. Read from the source
 * on each run, so a new server-only module is guarded the moment it exists.
 * @returns {string[]}
 */
function serverOnlyModules() {
  /** @type {string[]} */
  const found = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !new RegExp(TEST_FILE).test(entry.name)) {
        if (/^import ['"]server-only['"];?\s*$/m.test(fs.readFileSync(full, 'utf8'))) {
          found.push(path.relative(__dirname, full).split(path.sep).join('/'));
        }
      }
    }
  };
  walk(SRC);
  return found;
}

/** @param {string} p */
const escapeRegExp = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SERVER_ONLY = `^(${serverOnlyModules().map(escapeRegExp).join('|')})$`;

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'lib-imports-ui',
      comment:
        'lib/ is the headless core: the routes, the agent door and every feature share it. ' +
        'It must not reach up into features/ or components/. Move the shared piece down into lib/.',
      severity: 'error',
      from: { path: '^src/lib/' },
      to: { path: '^src/(features|components)/' },
    },
    {
      name: 'lib-imports-app',
      comment:
        'lib/ must not reach into app/. The one exception is the agent door: each operation in ' +
        'lib/agent-api/catalog/ loads the route it names, because the route stays the gate (ADR-0122).',
      severity: 'error',
      from: { path: '^src/lib/', pathNot: '^src/lib/agent-api/catalog/' },
      to: { path: '^src/app/' },
    },
    {
      name: 'components-import-features',
      comment:
        'components/ is the shared kit and knows no feature. Pass the feature in as props, ' +
        'or move the piece into the feature that owns it.',
      severity: 'error',
      from: { path: '^src/components/' },
      to: { path: '^src/features/' },
    },
    {
      name: 'feature-deep-import',
      comment:
        "A feature reaches another feature only through that feature's index (or a top-level module), " +
        'never into its components/, hooks/, stores/ or lib/. Export it from the index, or move it to lib/.',
      severity: 'error',
      from: { path: '^src/features/([^/]+)/' },
      to: {
        path: '^src/features/[^/]+/(components|hooks|stores|lib)/',
        pathNot: '^src/features/$1/',
      },
    },
    {
      name: 'client-imports-server-only',
      comment:
        "A module that imports 'server-only' must not reach the browser bundle. Client code " +
        '(features/, components/, hooks/) may name its types with `import type`, nothing more.',
      severity: 'error',
      from: { path: '^src/(features|components|hooks)/' },
      to: { path: SERVER_ONLY, dependencyTypesNot: ['type-only'] },
    },
  ],
  options: {
    includeOnly: '^src/',
    exclude: { path: [TEST_FILE, '^src/(test-utils|mocks)/'] },
    doNotFollow: { path: 'node_modules' },
    // Keep `import type` edges: a type-only import still couples two modules,
    // and `client-imports-server-only` has to tell the two kinds apart.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'],
    },
    // The ratchet: regenerating the baseline only removes entries, and an entry
    // whose violation is gone fails the check until it is removed, so a fixed
    // edge cannot quietly come back.
    baseline: { mode: 'shrink-only', staleEntriesSeverity: 'error' },
  },
};
