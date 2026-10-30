#!/usr/bin/env node
// Screenshot every route of the built website, full page, at each width.
//   bun run capture [--base URL] [--out DIR] [--widths 1440,390] [--only /path-prefix]
// Default: builds, serves it with the production server (runtime/server.mjs, what the Dockerfile
// runs) on a free port, captures, stops the server. Every image is loaded before the shot (lazy
// ones too) and the scrollbar is hidden, so a 390 shot is 390 px of layout, as on a phone.
// Needs the agent-browser CLI on PATH. Chromium comes from AGENT_BROWSER_EXECUTABLE_PATH,
// defaulting to /opt/pw-browsers/chromium where that file exists.
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(SITE, 'dist');
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const BASE = arg('--base', null);
const OUT = resolve(arg('--out', join(SITE, '.capture')));
const WIDTHS = arg('--widths', '1440,768,390,360').split(',').map(Number);
const ONLY = arg('--only', '/');
const SESSION = `capture-${process.pid}`;
const CALL_MS = 60_000;
const env = { ...process.env };
if (!env.AGENT_BROWSER_EXECUTABLE_PATH && existsSync('/opt/pw-browsers/chromium')) {
  env.AGENT_BROWSER_EXECUTABLE_PATH = '/opt/pw-browsers/chromium';
}

// One agent-browser call, in our one session. Stdin is closed and the call has a hard timeout.
function ab(...args) {
  const r = spawnSync('agent-browser', ['--session', SESSION, ...args], {
    env, encoding: 'utf8', timeout: CALL_MS, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) throw new Error(`agent-browser ${args[0]} failed: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout;
}

function routes() {
  const sitemaps = readdirSync(join(DIST, 'client')).filter((f) => /^sitemap-\d+\.xml$/.test(f));
  const locs = sitemaps.flatMap((f) => [...readFileSync(join(DIST, 'client', f), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)]);
  return [...new Set(locs.map((m) => new URL(m[1]).pathname))].filter((p) => p.startsWith(ONLY)).sort();
}

// Hide the scrollbar (a phone's is an overlay), load every lazy image and wait until all are
// decoded, then report the horizontal overflow. `eval` awaits the promise.
const SETTLE = `(async () => {
  document.documentElement.style.scrollbarWidth = 'none';
  for (const img of document.images) img.loading = 'eager';
  await Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)));
  return JSON.stringify([document.documentElement.scrollWidth - innerWidth]);
})()`;

const nameOf = (path) => path.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') || 'index';

function build() {
  const r = spawnSync('bun', ['run', 'build'], { cwd: SITE, stdio: 'inherit', timeout: 600_000 });
  if (r.status !== 0) throw new Error('build failed');
}

async function serve() {
  const port = 4500 + Math.floor(Math.random() * 400);
  const proc = spawn(process.execPath, [join(SITE, 'runtime/server.mjs')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) }, stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(base + '/');
      return { base, stop: () => proc.kill() };
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  proc.kill();
  throw new Error('server did not start');
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const server = BASE ? { base: BASE, stop() {} } : (build(), await serve());
  const started = Date.now();
  const problems = [];
  let shots = 0;
  try {
    ab('set', 'media', 'reduced-motion'); // the site honours it: animations finish at once
    for (const width of WIDTHS) {
      for (const path of routes()) {
        const name = `${nameOf(path)}-${width}`;
        try {
          ab('set', 'viewport', String(width), '900');
          ab('open', server.base + path);
          ab('wait', '200');
          const [overflow] = JSON.parse(JSON.parse(ab('--json', 'eval', SETTLE)).data.result);
          if (overflow > 0) problems.push(`${name}: horizontal overflow ${overflow}px`);
          ab('screenshot', '--full', join(OUT, `${name}.png`));
          shots++;
        } catch (e) {
          problems.push(`${name}: ${e.message.split('\n')[0]}`);
        }
      }
    }
  } finally {
    spawnSync('agent-browser', ['--session', SESSION, 'close'], { env, timeout: CALL_MS, stdio: 'ignore' });
    server.stop();
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`${shots} screenshots in ${seconds}s -> ${OUT}`);
  for (const p of problems) console.log(`  ${p}`);
  process.exitCode = problems.some((p) => !p.includes('overflow')) ? 1 : 0;
}

main().catch((e) => {
  console.error(e.message);
  process.exit(2);
});
