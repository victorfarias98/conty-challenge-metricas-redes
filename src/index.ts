import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";
import { FakeProvider } from "./fake-provider.ts";
import { RateLimitedError, TransientProviderError } from "./provider.ts";
import { DEFAULT_RETRY_POLICY } from "./retry.ts";

// Provedor simulado para rodar à mão: dez posts em março de 2026, e a primeira chamada de cada
// subida do servidor sofre um timeout e um 429 de 2 segundos antes de responder.
const provider = new FakeProvider(
  Array.from({ length: 10 }, (_, index) => ({
    post_id: `post_${index + 1}`,
    published_at: new Date(Date.UTC(2026, 2, 1 + index * 2, 12)).toISOString(),
    captured_at: "2026-03-25T12:00:00.000Z",
    views: 1000 * (index + 1),
    likes: 100 * (index + 1),
    comments: 10 * (index + 1),
  })),
  4,
);
provider.failNextWith(new TransientProviderError("timeout simulado"), new RateLimitedError(2000));

const db = openDatabase(process.env.DB_PATH ?? "data/metricas.sqlite");
const port = Number(process.env.PORT ?? 3004);
const retry = {
  maxAttempts: Number(process.env.SYNC_MAX_ATTEMPTS ?? DEFAULT_RETRY_POLICY.maxAttempts),
  maxWaitMs: Number(process.env.SYNC_MAX_WAIT_MS ?? DEFAULT_RETRY_POLICY.maxWaitMs),
  baseDelayMs: Number(process.env.SYNC_BASE_DELAY_MS ?? DEFAULT_RETRY_POLICY.baseDelayMs),
};

serve({ fetch: createApp(db, { provider, retry }).fetch, port }, (info) => {
  console.log(`métricas em http://127.0.0.1:${info.port}`);
});
