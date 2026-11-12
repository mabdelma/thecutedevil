// Shared error types. Owner: core. See web/COMMERCE_ARCH.md section d ("error conventions").

/** An error that maps to an HTTP answer: { error: { code, message, fields? } }. */
export class AppError extends Error {
  constructor(code, status = 400, message = code, extra = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.fields = extra.fields;
    this.details = extra.details;
  }
}

/** Thrown by payment providers and supplier adapters. `retryable` drives the job queue backoff. */
export class ProviderError extends Error {
  constructor(code, message = code, { retryable = false, status, provider } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.provider = provider;
  }
}

export const notImplemented = (what) => new AppError('NOT_IMPLEMENTED', 501, `${what} is not implemented yet`);
