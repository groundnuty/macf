/**
 * Tests for `buildAppManifest` — the pure App-manifest generator for
 * `macf bootstrap apply` (DR-043 §D2, Slice 2b of groundnuty/macf#838).
 *
 * The load-bearing case is the LOCKSTEP test: the generated document must agree
 * with BOTH canonical DR-019 surfaces — `MACF_REQUIRED_PERMISSIONS` (what
 * `macf doctor` verifies against) and the shipped
 * `templates/macf-app-manifest.json` (what the DR-035 shell bootstrap submits).
 * A silent divergence between "created with" and "verified against" produces a
 * fleet-wide 401 that falls back to user auth (the attribution trap, macf#72).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildAppManifest,
  repoHomepageUrl,
  MACF_APP_DEFAULT_EVENTS,
} from '../../../src/cli/bootstrap/app-manifest.js';
import { MACF_REQUIRED_PERMISSIONS } from '../../../src/cli/commands/doctor.js';

const REDIRECT = 'http://localhost:53123/callback';

function build() {
  return buildAppManifest({ fleetName: 'icsoc-2026', role: 'code-agent', redirectUrl: REDIRECT });
}

describe('buildAppManifest (macf#838 Slice 2b)', () => {
  it('derives the App name via deriveAppHandle — <fleet>-<role>, never a declared handle', () => {
    expect(build().name).toBe('icsoc-2026-code-agent');
  });

  it('carries the redirect_url verbatim (the ephemeral localhost listener, §D2 gate 1)', () => {
    expect(build().redirect_url).toBe(REDIRECT);
  });

  it('creates the App PRIVATE with an INACTIVE webhook (routing is workflow-based, not an inbound receiver)', () => {
    const m = build();
    expect(m.public).toBe(false);
    expect(m.hook_attributes.active).toBe(false);
  });

  it('derives default_permissions from MACF_REQUIRED_PERMISSIONS (no second hand-maintained list)', () => {
    const expected: Record<string, string> = {};
    for (const p of MACF_REQUIRED_PERMISSIONS) expected[p.name] = p.level;
    expect(build().default_permissions).toEqual(expected);
    // Spot-check the entry whose UI label differs from its API name (DR-019 §canonical-names).
    expect(build().default_permissions.actions_variables).toBe('write');
  });

  it('LOCKSTEP: matches the shipped templates/macf-app-manifest.json permissions + events', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    // test/cli/bootstrap → packages/macf
    const pkgRoot = join(here, '..', '..', '..');
    const template = JSON.parse(
      readFileSync(join(pkgRoot, 'templates', 'macf-app-manifest.json'), 'utf-8'),
    ) as { default_permissions: Record<string, string>; default_events: string[] };

    const m = build();
    expect(m.default_permissions).toEqual(template.default_permissions);
    expect([...m.default_events].sort()).toEqual([...template.default_events].sort());
  });

  it('uses the agent home-repo homepage when supplied, else the framework URL', () => {
    expect(build().url).toBe('https://github.com/groundnuty/macf');
    const withHome = buildAppManifest({
      fleetName: 'icsoc-2026',
      role: 'code-agent',
      redirectUrl: REDIRECT,
      homepageUrl: repoHomepageUrl('groundnuty/icsoc-2026-experiment'),
    });
    expect(withHome.url).toBe('https://github.com/groundnuty/icsoc-2026-experiment');
  });

  it('is pure — same inputs produce a deep-equal document', () => {
    expect(build()).toEqual(build());
  });

  it('does not share the exported events array (callers cannot mutate the constant)', () => {
    const m = build();
    expect(m.default_events).not.toBe(MACF_APP_DEFAULT_EVENTS);
    expect(m.default_events).toEqual(MACF_APP_DEFAULT_EVENTS);
  });
});
