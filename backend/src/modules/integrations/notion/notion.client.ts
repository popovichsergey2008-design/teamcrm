/**
 * Клиент Notion API.
 *
 * Доступ — токен внутренней интеграции (`ntn_…`), который человек создаёт на
 * notion.so/my-integrations и даёт ей доступ к нужным страницам через «Connections».
 * Без этого шага API не увидит НИЧЕГО и вернёт пустой список — самая частая причина
 * «импорт ничего не нашёл», поэтому она проговаривается в интерфейсе.
 *
 * Версия API закреплена: Notion меняет формат ответов между версиями, и незакреплённая
 * версия однажды тихо сломает разбор свойств.
 */

const API = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';

export interface NoDatabase {
  id: string;
  title: { plain_text: string }[];
  properties: Record<string, { id: string; type: string; [k: string]: unknown }>;
  url?: string;
}

export interface NoPage {
  id: string;
  url?: string;
  archived?: boolean;
  created_time?: string;
  last_edited_time?: string;
  properties: Record<string, any>;
}

export interface NoBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [k: string]: any;
}

export interface NoUser {
  id: string;
  name?: string;
  person?: { email?: string };
  type?: string;
}

export class NotionClient {
  constructor(private readonly token: string) {}

  private async call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const res = await fetch(API + path, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Notion-Version': VERSION,
        'Content-Type': 'application/json',
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      if (res.status === 401) throw new Error('Notion не принял токен — проверьте его в notion.so/my-integrations');
      if (res.status === 404) {
        throw new Error('Notion не видит эту страницу: дайте интеграции доступ через «Connections» в самой базе');
      }
      throw new Error(`Notion ответил ${res.status}: ${text || 'ошибка'}`);
    }
    return res.json() as Promise<T>;
  }

  /** Проверка токена при подключении: заодно узнаём имя интеграции. */
  me(): Promise<{ id: string; name?: string; bot?: { workspace_name?: string } }> {
    return this.call('/users/me');
  }

  /** Базы данных, к которым интеграции ДАЛИ доступ. Остальных она не увидит вовсе. */
  async databases(): Promise<NoDatabase[]> {
    const out: NoDatabase[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await this.call<{ results: NoDatabase[]; next_cursor: string | null; has_more: boolean }>(
        '/search',
        { method: 'POST', body: { filter: { property: 'object', value: 'database' }, page_size: 100, start_cursor: cursor } },
      );
      out.push(...(res.results ?? []));
      if (!res.has_more || !res.next_cursor) break;
      cursor = res.next_cursor;
    }
    return out;
  }

  database(id: string): Promise<NoDatabase> {
    return this.call(`/databases/${id}`);
  }

  /** Страницы базы. Постранично по 100 — иначе на большой базе ответ не придёт вовсе. */
  async pages(databaseId: string, limit = 2000): Promise<NoPage[]> {
    const out: NoPage[] = [];
    let cursor: string | undefined;
    while (out.length < limit) {
      const res = await this.call<{ results: NoPage[]; next_cursor: string | null; has_more: boolean }>(
        `/databases/${databaseId}/query`,
        { method: 'POST', body: { page_size: 100, start_cursor: cursor } },
      );
      out.push(...(res.results ?? []));
      if (!res.has_more || !res.next_cursor) break;
      cursor = res.next_cursor;
    }
    return out;
  }

  /** Содержимое страницы: первый уровень блоков. Вложенность разворачиваем при разборе. */
  async blocks(pageId: string): Promise<NoBlock[]> {
    const out: NoBlock[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await this.call<{ results: NoBlock[]; next_cursor: string | null; has_more: boolean }>(
        `/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`,
      );
      out.push(...(res.results ?? []));
      if (!res.has_more || !res.next_cursor) break;
      cursor = res.next_cursor;
    }
    return out;
  }

  /** Люди рабочего пространства: по ним ищем исполнителей. */
  async users(): Promise<NoUser[]> {
    const res = await this.call<{ results: NoUser[] }>('/users?page_size=100');
    return (res.results ?? []).filter((u) => u.type !== 'bot');
  }
}
