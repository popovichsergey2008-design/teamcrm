import { randomBytes } from 'crypto';

/**
 * Низкоуровневый клиент YouGile REST API v2 (авторизация — API-ключ компании, Bearer).
 * База настраивается (YOUGILE_API_BASE) — для e2e подменяется на локальный мок.
 * Пагинация: ?limit&offset, ответ { content:[], paging:{ limit, offset, next, count } }.
 * Запись (E4, выгрузка CRM → YouGile): POST/PUT /tasks, /columns, /boards,
 * POST /chats/{id}/messages, POST /upload-file (multipart).
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
  /** { id стикера: id состояния } — здесь же лежит приоритет (в YouGile это кастомный стикер). */
  stickers?: Record<string, string> | null;
}
/** Кастомный стикер компании с состояниями (GET /string-stickers). */
export interface YgSticker {
  id: string; name?: string; boardId?: string; deleted?: boolean;
  states?: { id: string; name?: string; color?: number; deleted?: boolean }[];
}
export interface YgFile { name?: string; url?: string; size?: number }
/** Тело записи задачи (POST /tasks, PUT /tasks/{id}) — только поля, которые ведёт CRM. */
export interface YgTaskWrite {
  title?: string; description?: string; columnId?: string; assigned?: string[];
  completed?: boolean; archived?: boolean; deleted?: boolean;
  deadline?: { deadline: number; withTime?: boolean } | null;
  stickers?: Record<string, string>;
}
export interface YgMessage {
  id: string | number; deleted?: boolean; text?: string | null; fromUserId?: string | null;
  timestamp?: number; label?: string | null; files?: YgFile[];
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

  /**
   * Запись (POST/PUT). Повторы осторожные: 429 безопасен всегда (запрос отклонён),
   * сеть и 5xx повторяем только для идемпотентного PUT — повтор POST мог бы создать дубль.
   */
  private async send<T = any>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> {
    const idempotent = method === 'PUT';
    const MAX = 4;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.base + path, {
          method,
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body ?? {}),
          signal: AbortSignal.timeout(30000),
        });
      } catch (e) {
        lastErr = e;
        if (!idempotent) throw new YougileError('NETWORK', `YouGile недоступен: ${(e as Error).message}`);
        await this.sleep(attempt * 500);
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new YougileError('AUTH', 'Ключ YouGile недействителен или нет прав');
      if (res.status === 429) { await this.sleep(attempt * 800); lastErr = new YougileError('HTTP', 'YouGile HTTP 429'); continue; }
      if (res.status >= 500 && idempotent) { lastErr = new YougileError('HTTP', `YouGile HTTP ${res.status}`); await this.sleep(attempt * 500); continue; }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // 400 — YouGile не принял тело (например неизвестное поле); вызывающий может упростить запрос
        throw new YougileError(res.status === 400 ? 'BAD_REQUEST' : 'HTTP', `YouGile HTTP ${res.status} ${text}`.trim().slice(0, 300));
      }
      return (await res.json().catch(() => ({}))) as T;
    }
    throw (lastErr instanceof Error ? lastErr : new YougileError('NETWORK', 'YouGile недоступен'));
  }

  createTask(body: YgTaskWrite) { return this.send<{ id: string }>('POST', '/tasks', body); }
  updateTask(id: string, body: YgTaskWrite) { return this.send('PUT', `/tasks/${encodeURIComponent(id)}`, body); }
  createColumn(body: { title: string; boardId: string; color?: number }) { return this.send<{ id: string }>('POST', '/columns', body); }
  updateColumn(id: string, body: { title?: string; color?: number; deleted?: boolean }) { return this.send('PUT', `/columns/${encodeURIComponent(id)}`, body); }
  updateBoard(id: string, body: { title?: string }) { return this.send('PUT', `/boards/${encodeURIComponent(id)}`, body); }
  /** Сообщение в чат задачи (chatId = id задачи). Пишется от имени владельца API-ключа. */
  sendMessage(chatId: string, text: string) {
    return this.send<{ id?: string | number }>('POST', `/chats/${encodeURIComponent(chatId)}/messages`, { text });
  }

  /**
   * Загрузка файла (multipart). Тело собираем руками — так не зависим от глобальных
   * FormData/Blob и точно контролируем заголовок filename для не-ASCII имён.
   */
  async uploadFile(buffer: Buffer, name: string, contentType: string): Promise<{ url: string | null }> {
    const boundary = `----teamcrm${randomBytes(12).toString('hex')}`;
    const safe = name.replace(/["\r\n]/g, '_');
    const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${ascii}"; ` +
      `filename*=UTF-8''${encodeURIComponent(safe)}\r\nContent-Type: ${contentType}\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const res = await fetch(this.base + '/upload-file', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat([head, buffer, tail]),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new YougileError('HTTP', `upload-file HTTP ${res.status}`);
    const j = (await res.json().catch(() => ({}))) as { url?: string; fullUrl?: string };
    const url = j.fullUrl || j.url || null;
    return { url: url && !url.startsWith('http') ? new URL(this.base).origin + (url.startsWith('/') ? url : '/' + url) : url };
  }

  /** Проверка ключа (лёгкий вызов). */
  async validate(): Promise<boolean> {
    await this.req('/users?limit=1');
    return true;
  }

  listProjects() { return this.all<YgProject>('projects'); }
  listBoards() { return this.all<YgBoard>('boards'); }
  listColumns() { return this.all<YgColumn>('columns'); }
  listUsers() { return this.all<YgUser>('users'); }
  /** Кастомные стикеры компании — среди них живёт приоритет. */
  listStringStickers() { return this.all<YgSticker>('string-stickers'); }
  /** Задачи колонки (сервер фильтрует по columnId; клиентский фильтр — страховка). */
  async listTasks(columnId: string): Promise<YgTask[]> {
    const rows = await this.all<YgTask>('tasks', { columnId });
    return rows.filter((t) => String(t.columnId) === String(columnId));
  }

  /** Одна задача по id (для живой синхронизации по событию вебхука). null — не найдена. */
  async getTask(id: string): Promise<YgTask | null> {
    try { return await this.req<YgTask>(`/tasks/${encodeURIComponent(id)}`); }
    catch (e) { if (e instanceof YougileError && e.code === 'HTTP') return null; throw e; }
  }

  /** Сообщения чата задачи (в YouGile chatId = id задачи). Файлы — в message.files. */
  taskMessages(taskId: string) {
    return this.all<YgMessage>(`chats/${encodeURIComponent(taskId)}/messages`);
  }

  // ── вебхуки (E3, живая синхронизация) ──
  listWebhooks() { return this.all<{ id: string; url: string; event: string; deleted?: boolean }>('webhooks'); }
  async createWebhook(url: string, event: string): Promise<void> {
    const res = await fetch(this.base + '/webhooks', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, event }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new YougileError('HTTP', `webhook create HTTP ${res.status}`);
  }

  /** Скачивание файла YouGile (относительный url → добавляем origin; авторизация Bearer). */
  async download(url: string): Promise<Buffer> {
    const abs = url.startsWith('http') ? url : new URL(this.base).origin + (url.startsWith('/') ? url : '/' + url);
    const res = await fetch(abs, { headers: { Authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new YougileError('HTTP', `file HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
