import type { DatabaseSync } from "node:sqlite";
import {
  type Connection,
  type MetricsProvider,
  PLATFORMS,
  type Platform,
  type PostSnapshot,
  type ProviderPage,
  type SyncWindow,
} from "./provider.ts";
import { RateLimitTooLongError, type RetryPolicy, type RetryStats, type Sleep, withRetry } from "./retry.ts";

export type Clock = () => Date;

export type SyncRun = {
  id: string;
  connection_id: string;
  window_since: string;
  window_until: string;
  status: "running" | "succeeded" | "failed" | "rate_limited";
  attempts: number;
  waited_ms: number;
  snapshots_received: number;
  snapshots_new: number;
  error: string | null;
  retry_after_ms: number | null;
  started_at: string;
  finished_at: string | null;
};

export type PostMetrics = {
  post_id: string;
  published_at: string;
  views: number;
  likes: number;
  comments: number;
  // Quando o provedor mediu e quando nós buscamos.
  captured_at: string;
  fetched_at: string;
  last_fetched_at: string;
  snapshots: number;
};

export type ConnectionMetrics = {
  connection_id: string;
  posts: PostMetrics[];
  totals: { posts: number; views: number; likes: number; comments: number };
  last_fetched_at: string | null;
};

export class SyncError extends Error {
  readonly status: 404 | 409 | 422;
  readonly code: string;

  constructor(status: 404 | 409 | 422, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// A sincronização terminou sem sucesso. A execução fica gravada e viaja junto com o erro.
export class SyncRunFailed extends Error {
  readonly run: SyncRun;

  constructor(run: SyncRun) {
    super(run.error ?? "sincronização falhou");
    this.run = run;
  }
}

function instant(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function counter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function createMetricsSync(
  db: DatabaseSync,
  options: { provider: MetricsProvider; clock: Clock; sleep: Sleep; retry: RetryPolicy },
) {
  const { provider, clock, sleep, retry } = options;

  function connection(id: string): Connection {
    const row = db.prepare("SELECT id, platform, account_id, access_token FROM connections WHERE id = ?").get(id) as
      | Connection
      | undefined;
    if (!row) throw new SyncError(404, "connection_not_found", "conexão não encontrada");
    return row;
  }

  function run(id: string): SyncRun {
    return db.prepare("SELECT * FROM sync_runs WHERE id = ?").get(id) as SyncRun;
  }

  function createConnection(input: { platform?: unknown; account_id?: unknown; access_token?: unknown }) {
    const platform = PLATFORMS.find((candidate) => candidate === input.platform);
    const accountId = typeof input.account_id === "string" ? input.account_id.trim() : "";
    const accessToken = typeof input.access_token === "string" ? input.access_token.trim() : "";
    if (!platform) throw new SyncError(422, "platform_invalid", `platform deve ser um de: ${PLATFORMS.join(", ")}`);
    if (!accountId) throw new SyncError(422, "account_id_required", "account_id é obrigatório");
    if (!accessToken) throw new SyncError(422, "access_token_required", "access_token é obrigatório");
    if (db.prepare("SELECT 1 FROM connections WHERE platform = ? AND account_id = ?").get(platform, accountId)) {
      throw new SyncError(409, "connection_exists", "essa conta já está conectada");
    }
    const id = `con_${crypto.randomUUID()}`;
    const createdAt = clock().toISOString();
    db.prepare("INSERT INTO connections (id, platform, account_id, access_token, created_at) VALUES (?, ?, ?, ?, ?)").run(
      id,
      platform,
      accountId,
      accessToken,
      createdAt,
    );
    // O token nunca volta na resposta.
    return { id, platform: platform satisfies Platform, account_id: accountId, created_at: createdAt };
  }

  // Grava o que chegou e devolve quantos snapshots eram novos. Repetido é ignorado pela chave.
  function store(connectionId: string, snapshots: PostSnapshot[]): number {
    const fetchedAt = clock().toISOString();
    let created = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const snapshot of snapshots) {
        const publishedAt = instant(snapshot.published_at);
        const capturedAt = instant(snapshot.captured_at);
        const valid =
          typeof snapshot.post_id === "string" &&
          snapshot.post_id !== "" &&
          publishedAt !== null &&
          capturedAt !== null &&
          counter(snapshot.views) &&
          counter(snapshot.likes) &&
          counter(snapshot.comments);
        // Item malformado do provedor não derruba a página inteira; só não é contado.
        if (!valid) continue;
        db.prepare(
          `INSERT INTO posts (connection_id, post_id, published_at, first_fetched_at, last_fetched_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (connection_id, post_id) DO UPDATE SET last_fetched_at = excluded.last_fetched_at`,
        ).run(connectionId, snapshot.post_id, publishedAt, fetchedAt, fetchedAt);
        const result = db
          .prepare(
            `INSERT OR IGNORE INTO metric_snapshots (connection_id, post_id, captured_at, views, likes, comments, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(connectionId, snapshot.post_id, capturedAt, snapshot.views, snapshot.likes, snapshot.comments, fetchedAt);
        created += Number(result.changes);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return created;
  }

  async function sync(connectionId: string, input: { since?: unknown; until?: unknown }): Promise<SyncRun> {
    const target = connection(connectionId);
    const since = instant(input.since);
    const until = instant(input.until);
    if (!since || !until) throw new SyncError(422, "window_invalid", "since e until devem ser datas ISO 8601");
    if (since >= until) throw new SyncError(422, "window_invalid", "since deve ser anterior a until");
    const window: SyncWindow = { since, until };

    const runId = `run_${crypto.randomUUID()}`;
    db.prepare(
      "INSERT INTO sync_runs (id, connection_id, window_since, window_until, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)",
    ).run(runId, connectionId, since, until, clock().toISOString());

    const stats: RetryStats = { attempts: 0, waitedMs: 0 };
    let received = 0;
    let created = 0;
    const finish = (status: SyncRun["status"], error: string | null, retryAfterMs: number | null): SyncRun => {
      db.prepare(
        `UPDATE sync_runs SET status = ?, attempts = ?, waited_ms = ?, snapshots_received = ?, snapshots_new = ?,
           error = ?, retry_after_ms = ?, finished_at = ? WHERE id = ?`,
      ).run(status, stats.attempts, stats.waitedMs, received, created, error, retryAfterMs, clock().toISOString(), runId);
      return run(runId);
    };

    try {
      let cursor: string | null = null;
      do {
        const pageCursor: string | null = cursor;
        // O retry é por página: o que já foi gravado de páginas anteriores fica, e regravar é inofensivo.
        const page: ProviderPage = await withRetry(() => provider.fetchPage(target, window, pageCursor), retry, sleep, stats);
        received += page.snapshots.length;
        created += store(connectionId, page.snapshots);
        cursor = page.next_cursor;
      } while (cursor !== null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SyncRunFailed(
        error instanceof RateLimitTooLongError
          ? finish("rate_limited", message, error.retryAfterMs)
          : finish("failed", message, null),
      );
    }
    return finish("succeeded", null, null);
  }

  // O número atual de cada post é o do snapshot com maior captured_at. Um snapshot antigo que
  // chega depois entra no histórico e não rebaixa o número; o total soma um snapshot por post.
  function metrics(connectionId: string): ConnectionMetrics {
    connection(connectionId);
    const posts = db
      .prepare(
        `SELECT p.post_id, p.published_at, s.views, s.likes, s.comments, s.captured_at, s.fetched_at,
                p.last_fetched_at, s.snapshots
         FROM posts p
         JOIN (
           SELECT post_id, views, likes, comments, captured_at, fetched_at,
                  COUNT(*) OVER (PARTITION BY post_id) AS snapshots,
                  ROW_NUMBER() OVER (PARTITION BY post_id ORDER BY captured_at DESC) AS position
           FROM metric_snapshots WHERE connection_id = ?1
         ) s ON s.post_id = p.post_id AND s.position = 1
         WHERE p.connection_id = ?1
         ORDER BY p.published_at, p.post_id`,
      )
      .all(connectionId) as PostMetrics[];
    return {
      connection_id: connectionId,
      posts,
      totals: {
        posts: posts.length,
        views: posts.reduce((sum, post) => sum + post.views, 0),
        likes: posts.reduce((sum, post) => sum + post.likes, 0),
        comments: posts.reduce((sum, post) => sum + post.comments, 0),
      },
      last_fetched_at: posts.map((post) => post.last_fetched_at).sort().at(-1) ?? null,
    };
  }

  function runs(connectionId: string): SyncRun[] {
    connection(connectionId);
    return db
      .prepare("SELECT * FROM sync_runs WHERE connection_id = ? ORDER BY started_at, rowid")
      .all(connectionId) as SyncRun[];
  }

  return { createConnection, sync, metrics, runs };
}
