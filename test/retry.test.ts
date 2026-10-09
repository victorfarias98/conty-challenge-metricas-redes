import { describe, expect, it } from "vitest";
import { PermanentProviderError, RateLimitedError, TransientProviderError, parseRetryAfter } from "../src/provider.ts";
import {
  RateLimitTooLongError,
  RetriesExhaustedError,
  type RetryPolicy,
  type RetryStats,
  backoffMs,
  withRetry,
} from "../src/retry.ts";

const POLICY: RetryPolicy = { maxAttempts: 4, maxWaitMs: 60_000, baseDelayMs: 500 };

function harness(failures: Error[]) {
  const waits: number[] = [];
  const stats: RetryStats = { attempts: 0, waitedMs: 0 };
  let calls = 0;
  const operation = async () => {
    calls += 1;
    const failure = failures.shift();
    if (failure) throw failure;
    return "ok";
  };
  const sleep = async (ms: number) => {
    waits.push(ms);
  };
  return { run: () => withRetry(operation, POLICY, sleep, stats), waits, stats, calls: () => calls };
}

describe("Retry-After", () => {
  const now = new Date("2026-03-10T12:00:00.000Z");

  it("lê o cabeçalho em segundos", () => {
    expect(parseRetryAfter("30", now)).toBe(30_000);
  });

  it("lê o cabeçalho como data HTTP, relativo ao relógio", () => {
    expect(parseRetryAfter("Tue, 10 Mar 2026 12:00:45 GMT", now)).toBe(45_000);
  });

  it("devolve null quando o cabeçalho falta ou não dá para ler", () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("daqui a pouco", now)).toBeNull();
  });
});

describe("retry com teto", () => {
  it("espera exatamente o Retry-After do 429 e tenta de novo", async () => {
    const { run, waits, stats } = harness([new RateLimitedError(30_000)]);
    await expect(run()).resolves.toBe("ok");
    expect(waits).toEqual([30_000]);
    expect(stats).toEqual({ attempts: 2, waitedMs: 30_000 });
  });

  it("não espera quando o Retry-After passa do teto, e informa o prazo pedido", async () => {
    const { run, waits, calls } = harness([new RateLimitedError(POLICY.maxWaitMs + 1)]);
    const error = await run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitTooLongError);
    expect((error as RateLimitTooLongError).retryAfterMs).toBe(POLICY.maxWaitMs + 1);
    expect(waits).toEqual([]);
    expect(calls()).toBe(1);
  });

  it("aceita Retry-After igual ao teto", async () => {
    const { run, waits } = harness([new RateLimitedError(POLICY.maxWaitMs)]);
    await expect(run()).resolves.toBe("ok");
    expect(waits).toEqual([POLICY.maxWaitMs]);
  });

  it("usa backoff quando o 429 vem sem Retry-After", async () => {
    const { run, waits } = harness([new RateLimitedError(null)]);
    await run();
    expect(waits).toEqual([500]);
  });

  it("dobra a espera a cada falha transitória e para no número máximo de tentativas", async () => {
    const failures = Array.from({ length: 10 }, () => new TransientProviderError("timeout"));
    const { run, waits, calls } = harness(failures);
    const error = await run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RetriesExhaustedError);
    expect(calls()).toBe(POLICY.maxAttempts);
    expect(waits).toEqual([500, 1000, 2000]);
  });

  it("para também quando o provedor responde 429 sem parar", async () => {
    const failures = Array.from({ length: 10 }, () => new RateLimitedError(1000));
    const { run, calls } = harness(failures);
    await expect(run()).rejects.toBeInstanceOf(RetriesExhaustedError);
    expect(calls()).toBe(POLICY.maxAttempts);
  });

  it("não tenta de novo um erro permanente", async () => {
    const { run, waits, calls } = harness([new PermanentProviderError("token inválido")]);
    await expect(run()).rejects.toBeInstanceOf(PermanentProviderError);
    expect(calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  it("limita o backoff ao teto", () => {
    expect(backoffMs(POLICY, 20)).toBe(POLICY.maxWaitMs);
  });
});
