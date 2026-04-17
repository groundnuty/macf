/**
 * Base error class for all MACF errors.
 * Each subclass provides a unique `code` string for programmatic handling.
 */
export class MacfError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MacfError';
    this.code = code;
  }
}

export class ConfigError extends MacfError {
  constructor(message: string) {
    super('CONFIG_ERROR', message);
    this.name = 'ConfigError';
  }
}

export class McpChannelError extends MacfError {
  constructor(message: string) {
    super('MCP_CHANNEL_ERROR', message);
    this.name = 'McpChannelError';
  }
}

export class HttpsServerError extends MacfError {
  constructor(message: string) {
    super('HTTPS_SERVER_ERROR', message);
    this.name = 'HttpsServerError';
  }
}

export class PortUnavailableError extends MacfError {
  readonly port: number;

  constructor(port: number) {
    super('PORT_UNAVAILABLE', `Port ${port} is already in use`);
    this.name = 'PortUnavailableError';
    this.port = port;
  }
}

export class PortExhaustedError extends MacfError {
  constructor() {
    super('PORT_EXHAUSTED', 'Failed to find available port after 10 attempts');
    this.name = 'PortExhaustedError';
  }
}

export class ValidationError extends MacfError {
  constructor(message: string) {
    super('VALIDATION_ERROR', message);
    this.name = 'ValidationError';
  }
}

/**
 * Thrown by server-side handlers to request a specific HTTP status
 * code on the response. The HTTPS request-handler catches instances
 * of this error and maps `httpStatus` to the response code. Replaces
 * the pre-ultrareview pattern:
 *
 *   const err = new Error('message');
 *   (err as { status?: number }).status = 503;
 *   throw err;
 *
 * which relied on ad-hoc `as { status?: number }` casts at both throw
 * and catch sites. With `HttpError`, the contract is type-level: the
 * catch site narrows via `instanceof HttpError` and reads the typed
 * `httpStatus` field.
 *
 * Use for intentional, operator-visible failures (e.g. "signing not
 * available on this agent" → 503). Don't use for unexpected errors —
 * those should bubble up to the generic 500 path.
 */
export class HttpError extends MacfError {
  readonly httpStatus: number;

  constructor(httpStatus: number, message: string) {
    super('HTTP_ERROR', message);
    this.name = 'HttpError';
    this.httpStatus = httpStatus;
  }
}
