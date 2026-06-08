export class CloverApiError extends Error {
  readonly name = "CloverApiError";
  readonly status: number | null;
  readonly code: string | null;
  readonly body: unknown;
  readonly requestPath: string | null;
  readonly requestMethod: string | null;
  readonly isRetryable: boolean;

  constructor(opts: {
    message: string;
    status: number | null;
    code?: string | null;
    body?: unknown;
    requestPath?: string | null;
    requestMethod?: string | null;
  }) {
    super(opts.message);
    this.status = opts.status;
    this.code = opts.code ?? null;
    this.body = opts.body;
    this.requestPath = opts.requestPath ?? null;
    this.requestMethod = opts.requestMethod ?? null;
    this.isRetryable =
      opts.status === 429 ||
      (opts.status !== null && opts.status >= 500 && opts.status < 600);
    Object.setPrototypeOf(this, CloverApiError.prototype);
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, CloverApiError);
    }
  }

  toClientString(): string {
    const parts: string[] = [];
    if (this.status !== null) parts.push(`HTTP ${this.status}`);
    if (this.code) parts.push(`code=${this.code}`);
    if (this.requestMethod && this.requestPath) {
      parts.push(`${this.requestMethod} ${this.requestPath}`);
    }
    const header = parts.length > 0 ? `[${parts.join(" ")}] ` : "";
    return `${header}${this.message}${this.isRetryable ? " (retryable)" : ""}`;
  }
}
