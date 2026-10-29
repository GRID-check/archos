import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { siteUrl, stackBaseDomain } from './site-url.mjs';

const stack = (body: string) => {
  const file = join(mkdtempSync(join(tmpdir(), 'site-url-')), 'Pulumi.prod.yaml');
  writeFileSync(file, body);
  return file;
};

describe('the site URL', () => {
  test('the build argument wins, without a trailing slash', () => {
    const file = stack('config:\n  proj:baseDomain: live.example.org\n');
    expect(siteUrl({ env: { PUBLIC_SITE_URL: 'https://set.example.org/' }, stackFile: file, brandDomain: 'brand.example.org' })).toBe(
      'https://set.example.org',
    );
  });

  test('without it, the prod stack serves the site, so its baseDomain is the address', () => {
    const file = stack('config:\n  # comment\n  proj:baseDomain: live.example.org # the apex\n  proj:other: x\n');
    expect(siteUrl({ env: {}, stackFile: file, brandDomain: 'brand.example.org' })).toBe('https://live.example.org');
  });

  test('with neither, the brand domain', () => {
    expect(siteUrl({ env: {}, stackFile: '/nonexistent/Pulumi.prod.yaml', brandDomain: 'brand.example.org' })).toBe(
      'https://brand.example.org',
    );
  });

  test('reads only the baseDomain key', () => {
    expect(stackBaseDomain('config:\n  proj:dnsZoneName: zone.example.org\n')).toBeNull();
    expect(stackBaseDomain("config:\n  proj:baseDomain: 'q.example.org'\n")).toBe('q.example.org');
  });
});
