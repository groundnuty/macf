/**
 * Tests for the auto-responder config distribution seam (DR-033, macf#645):
 * seed-if-absent, validate-if-present, never-clobber. The SCHEMA + matcher live
 * in @groundnuty/macf-core (tested in that package); this covers only the fs
 * behaviour + the Inv-2 reporting split.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPromptResponses } from '@groundnuty/macf-core';
import {
  seedPromptResponsesConfig,
  workspacePromptResponsesPath,
  PROMPT_RESPONSES_FILENAME,
} from '../../src/cli/prompt-responses.js';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'macf-prompt-responses-'));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('workspacePromptResponsesPath', () => {
  it('resolves to .claude/.macf/prompt-responses.json', () => {
    expect(workspacePromptResponsesPath(workspace)).toBe(
      join(workspace, '.claude', '.macf', PROMPT_RESPONSES_FILENAME),
    );
  });
});

describe('seedPromptResponsesConfig — absent', () => {
  it('writes the canonical seed and creates .claude/.macf/', () => {
    const result = seedPromptResponsesConfig(workspace);
    expect(result.action).toBe('seeded');
    const path = workspacePromptResponsesPath(workspace);
    expect(existsSync(path)).toBe(true);

    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    // Valid + Inv-2 clean seed with the canonical ceremony entries.
    const loaded = loadPromptResponses(raw);
    expect(loaded.accepted.map((e) => e.name)).toEqual(['dev-channels', 'resume-summary', 'rating-survey']);
    expect(loaded.refused).toHaveLength(0);
    expect(loaded.warned).toHaveLength(0);
    // Carries an operator `_comment` note.
    expect((raw as Record<string, unknown>)['_comment']).toContain('Interactive-prompt auto-responder allowlist');
  });
});

describe('seedPromptResponsesConfig — present (never clobber)', () => {
  it('preserves an existing operator-edited file byte-for-byte', () => {
    const path = workspacePromptResponsesPath(workspace);
    mkdirSync(join(workspace, '.claude', '.macf'), { recursive: true });
    const operatorConfig = JSON.stringify({
      schema_version: '1',
      entries: [
        { name: 'my-prompt', frame_contains: ['Custom thing'], option_text: 'Custom thing', send: '1', max_fires: 1 },
      ],
    });
    writeFileSync(path, operatorConfig);

    const result = seedPromptResponsesConfig(workspace);
    expect(result.action).toBe('preserved');
    // Not rewritten.
    expect(readFileSync(path, 'utf-8')).toBe(operatorConfig);
    if (result.action === 'preserved') {
      expect(result.loaded.accepted.map((e) => e.name)).toEqual(['my-prompt']);
    }
  });

  it('surfaces Inv-2 refused + warned entries without dropping them from disk', () => {
    const path = workspacePromptResponsesPath(workspace);
    mkdirSync(join(workspace, '.claude', '.macf'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: '1',
        entries: [
          { name: 'destructive', frame_contains: ['delete all'], option_text: 'yes', send: '1', max_fires: 1 },
          { name: 'authz', frame_contains: ['allow this'], option_text: 'allow this', send: '1', max_fires: 1 },
          { name: 'fine', frame_contains: ['Resume'], option_text: 'Resume', send: '2', max_fires: 1 },
        ],
      }),
    );

    const result = seedPromptResponsesConfig(workspace);
    expect(result.action).toBe('preserved');
    if (result.action === 'preserved') {
      expect(result.loaded.refused.map((r) => r.entry.name)).toEqual(['destructive']);
      expect(result.loaded.warned.map((w) => w.entry.name)).toEqual(['authz']);
      expect(result.loaded.accepted.map((e) => e.name)).toEqual(['authz', 'fine']);
    }
  });

  it('reports invalid (never throws) on malformed JSON', () => {
    const path = workspacePromptResponsesPath(workspace);
    mkdirSync(join(workspace, '.claude', '.macf'), { recursive: true });
    writeFileSync(path, '{ this is not json');

    const result = seedPromptResponsesConfig(workspace);
    expect(result.action).toBe('invalid');
  });

  it('reports invalid on a schema-violating config', () => {
    const path = workspacePromptResponsesPath(workspace);
    mkdirSync(join(workspace, '.claude', '.macf'), { recursive: true });
    writeFileSync(path, JSON.stringify({ schema_version: '1', entries: [{ name: 'x' }] }));

    const result = seedPromptResponsesConfig(workspace);
    expect(result.action).toBe('invalid');
  });

  it('flags canonical seed entries this file predates (macf#703)', () => {
    // Shapes a real pre-#703 live workspace: only the original two entries
    // the seed shipped before `rating-survey` was added.
    const path = workspacePromptResponsesPath(workspace);
    mkdirSync(join(workspace, '.claude', '.macf'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: '1',
        entries: [
          {
            name: 'dev-channels',
            frame_contains: ['I am using this for local development'],
            option_text: 'I am using this for local development',
            send: '1',
            max_fires: 1,
          },
          {
            name: 'resume-summary',
            frame_contains: ['Resume full session as-is'],
            option_text: 'Resume full session as-is',
            send: '2',
            max_fires: 1,
          },
        ],
      }),
    );

    const result = seedPromptResponsesConfig(workspace);
    expect(result.action).toBe('preserved');
    if (result.action === 'preserved') {
      expect(result.missingFromCanonicalSeed).toEqual(['rating-survey']);
    }
  });

  it('reports no missing entries when the file already carries every canonical name', () => {
    // A freshly-seeded file, re-validated on the next `macf update` — should
    // never flag itself as missing its own contents.
    seedPromptResponsesConfig(workspace);
    const result = seedPromptResponsesConfig(workspace);
    expect(result.action).toBe('preserved');
    if (result.action === 'preserved') {
      expect(result.missingFromCanonicalSeed).toEqual([]);
    }
  });

  it('does not flag a canonical name the operator refused via Inv-2 as missing', () => {
    // If an operator's own entry happens to collide in name with a canonical
    // one and gets Inv-2-refused, that's a present-but-dangerous entry, not
    // an absent one — `missingFromCanonicalSeed` must not double-count it.
    const path = workspacePromptResponsesPath(workspace);
    mkdirSync(join(workspace, '.claude', '.macf'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: '1',
        entries: [{ name: 'rating-survey', frame_contains: ['delete all'], option_text: 'yes', send: '1' }],
      }),
    );

    const result = seedPromptResponsesConfig(workspace);
    expect(result.action).toBe('preserved');
    if (result.action === 'preserved') {
      expect(result.loaded.refused.map((r) => r.entry.name)).toEqual(['rating-survey']);
      expect(result.missingFromCanonicalSeed).toEqual(['dev-channels', 'resume-summary']);
    }
  });
});
