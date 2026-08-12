/**
 * Низкоуровневый клиент YouGile REST API v2 (авторизация — API-ключ компании, Bearer).
 * База настраивается (YOUGILE_API_BASE) — для e2e подменяется на локальный мок.
 * Пагинация: ?limit&offset, ответ { content:[], paging:{ limit, offset, next, count } }.
 */
export class YougileError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface YgProject { id: string; title: string; deleted?: boolean }
export interface YgBoard { id: string; title: string; projectId: string; deleted?: boolean }
export interface YgColumn { id: string; title: string; boardId: string; color?: number; deleted?: boolean }
export interface YgUser { id: string; email?: string | null; realName?: string | null; status?: string }
export interface YgTask {
  id: string; title: string; description?: string | null; columnId: string;
  completed?: boolean; archived?: boolean; deleted?: boolean;
  assigned?: string[]; createdBy?: string | null; timestamp?: number;
  deadline?: { deadline?: number; startDate?: number; withTime?: boolean } | null;
}

const PAGE = 50;

export class YougileClient {
  private readonly base: string;

  constructor(private readonly apiKey: string, base?: string) {
    const b = base || process.env.YOUGILE_API_BASE || 'https://ru.yougile.com/api-v2';
    this.base = b.endsWith('/') ? b.slice(0, -1) : b;
  }

  private async req<T = any>(path: string): Promise<T> {
    const MAX = 5;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX; attempt++) {
      try {
        const res = await fetch(this.base + path, {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(30000),
        });
        if (res.status === 401 || res.status === 403) throw new YougileError('AUTH', 'Ключ YouGile недействителен или нет прав');
        if (res.status === 429) { await this.sleep(attempt * 800); continue; } // rate limit — бэкофф
        if (!res.ok) throw new YougileError('HTTP', `YouGile HTTP ${res.status}`);
        return (await res.json()) as T;
      } catch (e) {
        lastErr = e;
        if (e instanceof YougileError && e.code === 'AUTH') throw e;
        await this.sleep(attempt * 500);
      }
    }
    throw (lastErr instanceof Error ? lastErr : new YougileError('NETWORK', 'YouGile недоступен'));
  }

  /** Постранично собирает весь список объекта. */
  private async all<T>(resource: string, query: Record<string, string> = {}): Promise<T[]> {
    const out: T[] = [];
    let offset = 0;
    for (let guard = 0; guard < 2000; guard++) {
      const qs = new URLSearchParams({ ...query, limit: String(PAGE), offset: String(offset) }).toString();
      const page = await this.req<{ content: T[]; paging?: { next?: boolean } }>(`/${resource}?${qs}`);
      const items = page?.content ?? [];
      out.push(...items);
      if (!page?.paging?.next || items.length === 0) break;
      offset += PAGE;
    }
    return out;
  }

  private sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

  /** Проверка ключа (лёгкий вызов). */
  async validate(): Promise<boolean> {
    await this.req('/users?limit=1');
    return true;
  }

  listProjects() { return this.all<YgProject>('projects'); }
  listBoards() { return this.all<YgBoard>('boards'); }
  listColumns() { return this.all<YgColumn>('columns'); }
  listUsers() { return this.all<YgUser>('users'); }
  /** Задачи колонки (сервер фильтрует по columnId; клиентский фильтр — страховка). */
  async listTasks(columnId: string): Promise<YgTask[]> {
    const rows = await this.all<YgTask>('tasks', { columnId });
    return rows.filter((t) => String(t.columnId) === String(columnId));
  }
}
