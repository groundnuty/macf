import { describe, it, expect } from 'vitest';
import { toVariableSegment } from '../../src/registry/variable-name.js';

describe('toVariableSegment', () => {
  it('uppercases plain alphanumeric names', () => {
    expect(toVariableSegment('macf')).toBe('MACF');
    expect(toVariableSegment('cli')).toBe('CLI');
  });

  it('converts hyphens to underscores', () => {
    expect(toVariableSegment('academic-resume')).toBe('ACADEMIC_RESUME');
    expect(toVariableSegment('cv-architect')).toBe('CV_ARCHITECT');
  });

  it('handles multiple hyphens', () => {
    expect(toVariableSegment('foo-bar-baz')).toBe('FOO_BAR_BAZ');
  });

  it('preserves existing underscores', () => {
    expect(toVariableSegment('with_underscore')).toBe('WITH_UNDERSCORE');
    expect(toVariableSegment('mix-of_both')).toBe('MIX_OF_BOTH');
  });

  it('passes through already-uppercase input', () => {
    expect(toVariableSegment('MACF')).toBe('MACF');
    expect(toVariableSegment('CODE_AGENT')).toBe('CODE_AGENT');
  });

  it('produces identical output for equivalent inputs', () => {
    // Case-insensitive + hyphen/underscore-equivalent inputs collapse
    expect(toVariableSegment('code-agent')).toBe(toVariableSegment('CODE_AGENT'));
    expect(toVariableSegment('Code-Agent')).toBe(toVariableSegment('code_agent'));
  });

  it('handles digits', () => {
    expect(toVariableSegment('worker-a8f3c2')).toBe('WORKER_A8F3C2');
    expect(toVariableSegment('v1-0-0')).toBe('V1_0_0');
  });
});
