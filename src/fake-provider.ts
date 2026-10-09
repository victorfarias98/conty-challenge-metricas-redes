import type { Connection, MetricsProvider, PostSnapshot, ProviderPage, SyncWindow } from "./provider.ts";

// Provedor simulado. Guarda os posts em memória e devolve páginas por data de publicação.
// As falhas são roteirizadas: cada chamada consome a próxima da fila antes de responder.
export class FakeProvider implements MetricsProvider {
  readonly calls: Array<{ account_id: string; window: SyncWindow; cursor: string | null }> = [];
  readonly #failures: Array<Error | null> = [];
  #posts: PostSnapshot[];
  #pageSize: number;
  // Quando ligado, repete o primeiro snapshot de cada página, como um provedor que reenvia item.
  duplicateFirstItem = false;

  constructor(posts: PostSnapshot[] = [], pageSize = 50) {
    this.#posts = posts;
    this.#pageSize = pageSize;
  }

  setPosts(posts: PostSnapshot[]): void {
    this.#posts = posts;
  }

  setPageSize(pageSize: number): void {
    this.#pageSize = pageSize;
  }

  // null na fila significa "esta chamada responde normalmente".
  failNextWith(...errors: Array<Error | null>): void {
    this.#failures.push(...errors);
  }

  async fetchPage(connection: Connection, window: SyncWindow, cursor: string | null): Promise<ProviderPage> {
    this.calls.push({ account_id: connection.account_id, window, cursor });
    const failure = this.#failures.shift();
    if (failure) throw failure;

    const inWindow = this.#posts
      .filter((post) => post.published_at >= window.since && post.published_at < window.until)
      .sort((left, right) => left.published_at.localeCompare(right.published_at) || left.post_id.localeCompare(right.post_id));
    const start = cursor === null ? 0 : Number(cursor);
    const page = inWindow.slice(start, start + this.#pageSize);
    const first = page[0];
    const end = start + this.#pageSize;
    return {
      snapshots: this.duplicateFirstItem && first ? [first, ...page] : page,
      next_cursor: end < inWindow.length ? String(end) : null,
    };
  }
}
