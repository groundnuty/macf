/**
 * Tests for src/cli/proc-scan-darwin.ts — the PURE macOS parsers (DR-037 Phase
 * 3). The reader itself shells out to `ps`/`lsof` and is exercised only on a
 * real macOS host; the parsers below are the load-bearing, unit-testable logic
 * that turns their output into the shared `ProcReader` shapes.
 */
import { describe, it, expect } from 'vitest';
import {
  parseMacosPsSnapshot,
  parseLsofCwd,
  macosCommandToNul,
} from '../../src/cli/proc-scan-darwin.js';
import { classifyCmdline, channelServerPkgRootFromCmdline } from '../../src/cli/proc-scan.js';

describe('parseMacosPsSnapshot', () => {
  it('parses `ps -o pid= -o command=` lines into a pid→command map', () => {
    const raw = [
      '  501 /Users/o/.local/bin/claude --flag',
      ' 1234 node /x/@groundnuty/macf-channel-server/dist/server.js',
      '   77 -zsh',
      '', // blank line ignored
    ].join('\n');
    const map = parseMacosPsSnapshot(raw);
    expect(map.get('501')).toBe('/Users/o/.local/bin/claude --flag');
    expect(map.get('1234')).toBe('node /x/@groundnuty/macf-channel-server/dist/server.js');
    expect(map.get('77')).toBe('-zsh');
    expect(map.size).toBe(3);
  });
});

describe('parseLsofCwd', () => {
  it('extracts the cwd path from `lsof -Fn` output', () => {
    const raw = ['p1234', 'fcwd', 'n/Users/o/Dropbox/repos/groundnuty/macf', ''].join('\n');
    expect(parseLsofCwd(raw)).toBe('/Users/o/Dropbox/repos/groundnuty/macf');
  });

  it('returns null when no name field is present', () => {
    expect(parseLsofCwd('p1234\nfcwd\n')).toBeNull();
    expect(parseLsofCwd('')).toBeNull();
  });
});

describe('macosCommandToNul (feeds the shared classifiers)', () => {
  it('produces a NUL-separated blob classifyCmdline understands (claude)', () => {
    const nul = macosCommandToNul('/Users/o/.local/bin/claude --flag');
    expect(classifyCmdline(nul)).toBe('claude');
  });

  it('produces a blob classifyCmdline understands (channel-server) + pkg-root', () => {
    const nul = macosCommandToNul('node /x/@groundnuty/macf-channel-server/dist/server.js');
    expect(classifyCmdline(nul)).toBe('channel-server');
    expect(channelServerPkgRootFromCmdline(nul)).toBe('/x/@groundnuty/macf-channel-server');
  });

  it('is empty for an empty command', () => {
    expect(macosCommandToNul('   ')).toBe('');
  });
});
