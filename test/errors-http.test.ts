/**
 * Tests for HttpError (ultrareview A7).
 *
 * The class replaces the pre-refactor pattern:
 *   const err = new Error('msg');
 *   (err as { status?: number }).status = 503;
 *   throw err;
 * which relied on ad-hoc casts at both throw and catch sites. With
 * HttpError, the contract is type-level: catch narrows via instanceof
 * and reads the typed `httpStatus` field.
 */
import { describe, it, expect } from 'vitest';
import { HttpError, MacfError } from '../src/errors.js';

describe('HttpError', () => {
  it('stores httpStatus + message', () => {
    const err = new HttpError(503, 'CA key not available');
    expect(err.httpStatus).toBe(503);
    expect(err.message).toBe('CA key not available');
  });

  it('has MacfError as prototype for error-class ecosystem uniformity', () => {
    const err = new HttpError(401, 'auth failed');
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toBeInstanceOf(MacfError);
    expect(err).toBeInstanceOf(Error);
  });

  it('exposes the standard MacfError.code field', () => {
    const err = new HttpError(400, 'bad request');
    expect(err.code).toBe('HTTP_ERROR');
  });

  it('narrows correctly in a catch block', () => {
    // The type-level goal: `instanceof HttpError` narrows so the
    // catch site can read .httpStatus without a cast.
    const thrown = new HttpError(409, 'conflict');
    try {
      throw thrown;
    } catch (err) {
      if (err instanceof HttpError) {
        // TypeScript narrowed — no cast needed to access httpStatus.
        expect(err.httpStatus).toBe(409);
      } else {
        expect.fail('expected HttpError');
      }
    }
  });

  it('error name is the class name (for stack traces)', () => {
    expect(new HttpError(500, 'x').name).toBe('HttpError');
  });
});
