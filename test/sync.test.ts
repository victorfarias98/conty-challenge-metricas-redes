import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { FakeProvider } from "../src/fake-provider.ts";
import { PermanentProviderError, type PostSnapshot, RateLimitedError, TransientProviderError } from "../src/provider.ts";
import type { RetryPolicy } from "../src/retry.ts";
import type { ConnectionMetrics, SyncRun } from "../src/sync.ts";

type App = ReturnType<typeof createApp>;

const RETRY: RetryPolicy = { maxAttempts: 4, maxWaitMs: 60_000, baseDelayMs: 500 };
const START = Date.parse("2026-03-20T12:00:00.000Z");
const FIRST_WINDOW = { since: "2026-03-01T00:00:00.000Z", until: "2026-03-10T00:00:00.000Z" };
// Sobrepõe a primeira janela entre os dias 5 e 10.
const OVERLAPPING_WINDOW = { since: "2026-03-05T00:00:00.000Z", until: "2026-03-15T00:00:00.000Z" };

function post(day: number, views: number, capturedAt = "2026-03-20T10:00:00.000Z"): PostSnapshot {
  return {
    post_id: `post_${String(day).padStart(2, "0")}`,
    published_at: new Date(Date.UTC(2026, 2, day, 12)).toISOString(),
    captured_at: capturedAt,
    views,
    likes: views / 10,
    comments: views / 100,
  };
}

// Publicados nos dias 2, 6, 8 e 12 de março: 6 e 8 caem nas duas janelas.
const POSTS = [post(2, 1000), post(6, 2000), post(8, 3000), post(12, 4000)];

let app: App;
let provider: FakeProvider;
let nowMs: number;
let waits: number[];
let connectionId: string;

async function sync(window: { since: string; until: string }): Promise<Response> {
  return app.request(`/connections/${connectionId}/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(window),
  });
}

async function syncOk(window: { since: string; until: string }): Promise<SyncRun> {
  const res = await sync(window);
  expect(res.status).toBe(200);
  return (await res.json()) as SyncRun;
}

async function metrics(): Promise<ConnectionMetrics> {
  return (await (await app.request(`/connections/${connectionId}/metrics`)).json()) as ConnectionMetrics;
}

beforeEach(async () => {
  nowMs = START;
  waits = [];
  provider = new FakeProvider(POSTS);
  app = createApp(openDatabase(), {
    provider,
    retry: RETRY,
    clock: () => new Date(nowMs),
    // Relógio controlado: dormir só avança o tempo.
    sleep: async (ms) => {
      waits.push(ms);
      nowMs += ms;
    },
  });
  const res = await app.request("/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "instagram", account_id: "ana", access_token: "token-ficticio" }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body).not.toHaveProperty("access_token");
  connectionId = String(body.id);
});

describe("idempotência do sync", () => {
  it("grava os posts da janela com a hora em que foram buscados", async () => {
    const run = await syncOk(FIRST_WINDOW);

    expect(run).toMatchObject({ status: "succeeded", attempts: 1, snapshots_received: 3, snapshots_new: 3 });
    const result = await metrics();
    expect(result.totals).toEqual({ posts: 3, views: 6000, likes: 600, comments: 60 });
    expect(result.posts[0]).toMatchObject({
      post_id: "post_02",
      captured_at: "2026-03-20T10:00:00.000Z",
      fetched_at: "2026-03-20T12:00:00.000Z",
    });
    expect(result.last_fetched_at).toBe("2026-03-20T12:00:00.000Z");
  });

  it("não conta duas vezes o post que cai em duas janelas sobrepostas", async () => {
    await syncOk(FIRST_WINDOW);
    nowMs += 3_600_000;

    const second = await syncOk(OVERLAPPING_WINDOW);

    expect(second).toMatchObject({ snapshots_received: 3, snapshots_new: 1 });
    const result = await metrics();
    expect(result.totals).toEqual({ posts: 4, views: 10000, likes: 1000, comments: 100 });
    expect(result.posts.map((entry) => entry.snapshots)).toEqual([1, 1, 1, 1]);
    // O post 6 foi visto de novo: o número não mudou, mas a última busca sim.
    expect(result.posts[1]).toMatchObject({
      post_id: "post_06",
      fetched_at: "2026-03-20T12:00:00.000Z",
      last_fetched_at: "2026-03-20T13:00:00.000Z",
    });
  });

  it("repetir a mesma janela não muda nenhum número", async () => {
    await syncOk(FIRST_WINDOW);
    const again = await syncOk(FIRST_WINDOW);
    expect(again.snapshots_new).toBe(0);
    expect((await metrics()).totals.views).toBe(6000);
  });

  it("ignora o item que o provedor repete dentro da mesma resposta", async () => {
    provider.duplicateFirstItem = true;
    const run = await syncOk(FIRST_WINDOW);
    expect(run).toMatchObject({ snapshots_received: 4, snapshots_new: 3 });
    expect((await metrics()).totals).toMatchObject({ posts: 3, views: 6000 });
  });

  it("uma medição mais nova substitui o número atual sem somar com a anterior", async () => {
    await syncOk(FIRST_WINDOW);
    provider.setPosts([post(2, 1500, "2026-03-21T10:00:00.000Z"), post(6, 2000), post(8, 3000)]);

    const run = await syncOk(FIRST_WINDOW);

    expect(run.snapshots_new).toBe(1);
    const result = await metrics();
    expect(result.posts[0]).toMatchObject({ post_id: "post_02", views: 1500, snapshots: 2 });
    expect(result.totals.views).toBe(6500);
  });

  it("uma medição antiga que chega depois não rebaixa o número atual", async () => {
    provider.setPosts([post(2, 1500, "2026-03-21T10:00:00.000Z")]);
    await syncOk(FIRST_WINDOW);
    provider.setPosts([post(2, 1000, "2026-03-20T10:00:00.000Z")]);

    await syncOk(FIRST_WINDOW);

    expect((await metrics()).posts[0]).toMatchObject({ views: 1500, captured_at: "2026-03-21T10:00:00.000Z", snapshots: 2 });
  });
});

describe("falha transitória", () => {
  it("sobrevive a dois timeouts seguidos com backoff", async () => {
    provider.failNextWith(new TransientProviderError("timeout"), new TransientProviderError("timeout"));
    const run = await syncOk(FIRST_WINDOW);
    expect(run).toMatchObject({ status: "succeeded", attempts: 3, waited_ms: 1500 });
    expect(waits).toEqual([500, 1000]);
  });

  it("desiste depois do número máximo de tentativas e registra a execução como falha", async () => {
    provider.failNextWith(...Array.from({ length: 20 }, () => new TransientProviderError("timeout")));

    const res = await sync(FIRST_WINDOW);

    expect(res.status).toBe(502);
    const body = (await res.json()) as { run: SyncRun };
    expect(body.run).toMatchObject({ status: "failed", attempts: RETRY.maxAttempts, snapshots_new: 0 });
    expect(provider.calls).toHaveLength(RETRY.maxAttempts);
    expect((await metrics()).totals.posts).toBe(0);
  });

  it("não tenta de novo quando o token é recusado", async () => {
    provider.failNextWith(new PermanentProviderError("token inválido"));
    const res = await sync(FIRST_WINDOW);
    expect(res.status).toBe(502);
    expect(provider.calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("mantém a página já gravada quando a seguinte falha, e a nova tentativa não duplica", async () => {
    provider.setPageSize(2);
    provider.failNextWith(null);
    provider.failNextWith(...Array.from({ length: RETRY.maxAttempts }, () => new TransientProviderError("timeout")));

    const failed = await sync(FIRST_WINDOW);

    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { run: SyncRun }).run).toMatchObject({ status: "failed", snapshots_new: 2 });
    expect((await metrics()).totals.posts).toBe(2);

    const retried = await syncOk(FIRST_WINDOW);
    expect(retried).toMatchObject({ snapshots_received: 3, snapshots_new: 1 });
    expect((await metrics()).totals).toMatchObject({ posts: 3, views: 6000 });
  });
});

describe("limite de taxa", () => {
  it("espera o Retry-After do 429 antes de tentar de novo", async () => {
    provider.failNextWith(new RateLimitedError(30_000));

    const run = await syncOk(FIRST_WINDOW);

    expect(waits).toEqual([30_000]);
    expect(run).toMatchObject({ status: "succeeded", attempts: 2, waited_ms: 30_000 });
    // O relógio andou exatamente o prazo pedido entre o início e o fim.
    expect(Date.parse(run.finished_at ?? "") - Date.parse(run.started_at)).toBe(30_000);
  });

  it("não espera além do teto: registra o limite e devolve o prazo que o provedor pediu", async () => {
    provider.failNextWith(new RateLimitedError(RETRY.maxWaitMs + 1000));

    const res = await sync(FIRST_WINDOW);

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("61");
    const body = (await res.json()) as { run: SyncRun };
    expect(body.run).toMatchObject({ status: "rate_limited", attempts: 1, waited_ms: 0, retry_after_ms: 61_000 });
    expect(waits).toEqual([]);
  });

  it("para depois do teto de tentativas quando o 429 não cessa", async () => {
    provider.failNextWith(...Array.from({ length: 20 }, () => new RateLimitedError(1000)));
    const res = await sync(FIRST_WINDOW);
    expect(res.status).toBe(502);
    expect(provider.calls).toHaveLength(RETRY.maxAttempts);
    expect(waits).toEqual([1000, 1000, 1000]);
  });
});

describe("entrada", () => {
  it("recusa janela invertida ou que não é data", async () => {
    expect((await sync({ since: FIRST_WINDOW.until, until: FIRST_WINDOW.since })).status).toBe(422);
    expect((await sync({ since: "ontem", until: FIRST_WINDOW.until })).status).toBe(422);
  });

  it("guarda o histórico das execuções", async () => {
    await syncOk(FIRST_WINDOW);
    provider.failNextWith(new PermanentProviderError("token inválido"));
    await sync(OVERLAPPING_WINDOW);

    const body = (await (await app.request(`/connections/${connectionId}/sync-runs`)).json()) as { runs: SyncRun[] };

    expect(body.runs.map((run) => run.status)).toEqual(["succeeded", "failed"]);
  });
});
