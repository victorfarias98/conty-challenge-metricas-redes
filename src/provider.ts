// Fronteira com a rede social. A regra de negócio (src/sync.ts) só conhece o que está neste arquivo.

export const PLATFORMS = ["instagram", "tiktok", "youtube", "x"] as const;
export type Platform = (typeof PLATFORMS)[number];

export type Connection = { id: string; platform: Platform; account_id: string; access_token: string };

// Uma leitura dos contadores de um post. Os números são totais acumulados, não incrementos.
export type PostSnapshot = {
  post_id: string;
  published_at: string;
  // Quando o provedor mediu. Junto com o post, identifica o snapshot.
  captured_at: string;
  views: number;
  likes: number;
  comments: number;
};

// Janela por data de publicação: since inclusivo, until exclusivo.
export type SyncWindow = { since: string; until: string };
export type ProviderPage = { snapshots: PostSnapshot[]; next_cursor: string | null };

export interface MetricsProvider {
  fetchPage(connection: Connection, window: SyncWindow, cursor: string | null): Promise<ProviderPage>;
}

// 429. retryAfterMs é null quando o provedor não mandou Retry-After.
export class RateLimitedError extends Error {
  readonly retryAfterMs: number | null;

  constructor(retryAfterMs: number | null) {
    super("provedor respondeu 429");
    this.retryAfterMs = retryAfterMs;
  }
}

// Timeout, conexão caída, 5xx: vale tentar de novo.
export class TransientProviderError extends Error {}

// Token inválido, conta inexistente: tentar de novo não resolve.
export class PermanentProviderError extends Error {}

// Retry-After vem em segundos ("30") ou como data HTTP. Devolve milissegundos a esperar.
export function parseRetryAfter(header: string | null | undefined, now: Date): number | null {
  const value = header?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now.getTime());
}
