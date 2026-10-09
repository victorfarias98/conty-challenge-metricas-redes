import { PermanentProviderError, RateLimitedError } from "./provider.ts";

export type RetryPolicy = {
  // Total de tentativas por chamada ao provedor, contando a primeira. É o que impede o loop infinito.
  maxAttempts: number;
  // Teto de qualquer espera, seja backoff ou Retry-After.
  maxWaitMs: number;
  // Backoff de falha transitória: baseDelayMs, o dobro, o dobro de novo, até maxWaitMs.
  baseDelayMs: number;
};

export type Sleep = (ms: number) => Promise<void>;
export type RetryStats = { attempts: number; waitedMs: number };

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 4, maxWaitMs: 60_000, baseDelayMs: 500 };

// O provedor pediu uma espera maior que o teto. Esperar menos só renderia outro 429,
// então a chamada desiste e informa quanto tempo o provedor pediu.
export class RateLimitTooLongError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number, maxWaitMs: number) {
    super(`provedor pediu espera de ${retryAfterMs} ms, acima do teto de ${maxWaitMs} ms`);
    this.retryAfterMs = retryAfterMs;
  }
}

export class RetriesExhaustedError extends Error {
  readonly attempts: number;
  readonly lastError: unknown;

  constructor(attempts: number, lastError: unknown) {
    super(`provedor falhou em ${attempts} tentativas: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

export function backoffMs(policy: RetryPolicy, failedAttempts: number): number {
  return Math.min(policy.maxWaitMs, policy.baseDelayMs * 2 ** (failedAttempts - 1));
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  sleep: Sleep,
  stats: RetryStats,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    stats.attempts += 1;
    try {
      return await operation();
    } catch (error) {
      if (error instanceof PermanentProviderError) throw error;
      if (attempt >= policy.maxAttempts) throw new RetriesExhaustedError(attempt, error);

      // 429 com Retry-After: espera exatamente o que o provedor mandou. Sem o cabeçalho, cai no backoff.
      const requested = error instanceof RateLimitedError ? error.retryAfterMs : null;
      if (requested !== null && requested > policy.maxWaitMs) {
        throw new RateLimitTooLongError(requested, policy.maxWaitMs);
      }
      const waitMs = requested ?? backoffMs(policy, attempt);
      await sleep(waitMs);
      stats.waitedMs += waitMs;
    }
  }
}
