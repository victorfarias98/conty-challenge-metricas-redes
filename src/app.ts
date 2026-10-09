import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import type { MetricsProvider } from "./provider.ts";
import { DEFAULT_RETRY_POLICY, type RetryPolicy, type Sleep } from "./retry.ts";
import { type Clock, SyncError, SyncRunFailed, createMetricsSync } from "./sync.ts";

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function createApp(
  db: DatabaseSync,
  options: { provider: MetricsProvider; clock?: Clock; sleep?: Sleep; retry?: RetryPolicy },
) {
  const metricsSync = createMetricsSync(db, {
    provider: options.provider,
    clock: options.clock ?? (() => new Date()),
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    retry: options.retry ?? DEFAULT_RETRY_POLICY,
  });
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof SyncError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    if (error instanceof SyncRunFailed) {
      // A execução já está gravada; o corpo devolve o que aconteceu com ela.
      if (error.run.status === "rate_limited" && error.run.retry_after_ms !== null) {
        c.header("retry-after", String(Math.ceil(error.run.retry_after_ms / 1000)));
        return c.json({ error: { code: "provider_rate_limited", message: error.message }, run: error.run }, 503);
      }
      return c.json({ error: { code: "provider_failed", message: error.message }, run: error.run }, 502);
    }
    console.error(error);
    return c.json({ error: { code: "internal_error", message: "erro interno" } }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/connections", async (c) => c.json(metricsSync.createConnection(await jsonBody(c)), 201));

  app.post("/connections/:id/sync", async (c) => c.json(await metricsSync.sync(c.req.param("id"), await jsonBody(c))));

  app.get("/connections/:id/metrics", (c) => c.json(metricsSync.metrics(c.req.param("id"))));

  app.get("/connections/:id/sync-runs", (c) => c.json({ runs: metricsSync.runs(c.req.param("id")) }));

  return app;
}
