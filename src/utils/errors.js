export class AppError extends Error {
  constructor(message, statusCode = 400, code = 'APP_ERROR', details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
export class NotFoundError extends AppError {
  constructor(msg = 'Not found') {
    super(msg, 404, 'NOT_FOUND');
  }
}
export class RateLimitError extends AppError {
  constructor(msg = 'Rate limited', details) {
    super(msg, 429, 'RATE_LIMITED', details);
  }
}
export class UpstreamProviderError extends AppError {
  constructor(msg, status = 502) {
    super(msg, status, 'UPSTREAM_ERROR');
  }
}
