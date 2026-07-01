import { describe, it, expect } from 'vitest';
import { mintMessageId } from '../../src/delivery/message-id.js';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('mintMessageId', () => {
  it('mints a UUIDv4-shaped string', () => {
    const id = mintMessageId();
    expect(id).toMatch(UUID_V4_RE);
  });

  it('mints a fresh id on every call (never reused by the helper itself)', () => {
    const ids = new Set(Array.from({ length: 50 }, () => mintMessageId()));
    expect(ids.size).toBe(50);
  });
});
