export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly ambiguous: boolean;
  readonly retryAfterMs: number;
  constructor(readonly code: string, options: {
    retryable?: boolean; ambiguous?: boolean; retryAfterMs?: number;
  } = {}) {
    super(code);
    this.name = "ProviderError";
    this.retryable = options.retryable ?? false;
    this.ambiguous = options.ambiguous ?? false;
    this.retryAfterMs = options.retryAfterMs ?? 0;
  }
}

export class StorageError extends Error {
  constructor(readonly code: string) { super(code); this.name = "StorageError"; }
}

export function safeCode(error: unknown): string {
  if (error instanceof ProviderError || error instanceof StorageError) return error.code;
  return "unexpected_error";
}

