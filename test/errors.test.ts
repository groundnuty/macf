import { describe, it, expect } from 'vitest';
import {
  MacfError,
  ConfigError,
  McpChannelError,
  HttpsServerError,
  PortUnavailableError,
  PortExhaustedError,
  ValidationError,
} from '../src/errors.js';

describe('MacfError', () => {
  it('stores code and message', () => {
    const err = new MacfError('TEST_CODE', 'test message');
    expect(err.code).toBe('TEST_CODE');
    expect(err.message).toBe('test message');
    expect(err.name).toBe('MacfError');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('ConfigError', () => {
  it('has CONFIG_ERROR code', () => {
    const err = new ConfigError('missing var');
    expect(err.code).toBe('CONFIG_ERROR');
    expect(err.name).toBe('ConfigError');
    expect(err).toBeInstanceOf(MacfError);
  });
});

describe('McpChannelError', () => {
  it('has MCP_CHANNEL_ERROR code', () => {
    const err = new McpChannelError('push failed');
    expect(err.code).toBe('MCP_CHANNEL_ERROR');
    expect(err.name).toBe('McpChannelError');
  });
});

describe('HttpsServerError', () => {
  it('has HTTPS_SERVER_ERROR code', () => {
    const err = new HttpsServerError('bind failed');
    expect(err.code).toBe('HTTPS_SERVER_ERROR');
    expect(err.name).toBe('HttpsServerError');
  });
});

describe('PortUnavailableError', () => {
  it('includes port number', () => {
    const err = new PortUnavailableError(8847);
    expect(err.code).toBe('PORT_UNAVAILABLE');
    expect(err.port).toBe(8847);
    expect(err.message).toContain('8847');
  });
});

describe('PortExhaustedError', () => {
  it('has PORT_EXHAUSTED code', () => {
    const err = new PortExhaustedError();
    expect(err.code).toBe('PORT_EXHAUSTED');
    expect(err.message).toContain('10 attempts');
  });
});

describe('ValidationError', () => {
  it('has VALIDATION_ERROR code', () => {
    const err = new ValidationError('bad input');
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.name).toBe('ValidationError');
  });
});
