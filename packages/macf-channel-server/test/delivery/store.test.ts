import { describe, it, expect } from 'vitest';
import { OutboxEntrySchema, InboxEntrySchema } from '../../src/delivery/store.js';

describe('OutboxEntrySchema', () => {
  it('accepts a well-formed entry', () => {
    const result = OutboxEntrySchema.safeParse({
      id: 'msg-1',
      target: 'science-agent',
      payload: { event: 'custom', message: 'hi' },
      enqueuedAt: 1000,
      nextAttemptAt: 1000,
      attemptCount: 0,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty id or target', () => {
    expect(
      OutboxEntrySchema.safeParse({
        id: '',
        target: 'science-agent',
        payload: null,
        enqueuedAt: 0,
        nextAttemptAt: 0,
        attemptCount: 0,
      }).success,
    ).toBe(false);
    expect(
      OutboxEntrySchema.safeParse({
        id: 'msg-1',
        target: '',
        payload: null,
        enqueuedAt: 0,
        nextAttemptAt: 0,
        attemptCount: 0,
      }).success,
    ).toBe(false);
  });

  it('rejects a negative or non-integer attemptCount', () => {
    expect(
      OutboxEntrySchema.safeParse({
        id: 'msg-1',
        target: 'x',
        payload: null,
        enqueuedAt: 0,
        nextAttemptAt: 0,
        attemptCount: -1,
      }).success,
    ).toBe(false);
    expect(
      OutboxEntrySchema.safeParse({
        id: 'msg-1',
        target: 'x',
        payload: null,
        enqueuedAt: 0,
        nextAttemptAt: 0,
        attemptCount: 1.5,
      }).success,
    ).toBe(false);
  });
});

describe('InboxEntrySchema', () => {
  it('accepts a well-formed entry', () => {
    const result = InboxEntrySchema.safeParse({
      id: 'msg-1',
      payload: { hello: 'world' },
      receivedAt: 1000,
      processed: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty id', () => {
    expect(
      InboxEntrySchema.safeParse({
        id: '',
        payload: null,
        receivedAt: 0,
        processed: false,
      }).success,
    ).toBe(false);
  });

  it('rejects a non-boolean processed field', () => {
    expect(
      InboxEntrySchema.safeParse({
        id: 'msg-1',
        payload: null,
        receivedAt: 0,
        processed: 'nope',
      }).success,
    ).toBe(false);
  });
});
