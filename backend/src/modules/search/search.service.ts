import { Injectable } from '@nestjs/common';
import { SearchRepository } from './search.repository';

/** Сколько показывать из каждого источника: длинный список в палитре всё равно не читают. */
const PER_SOURCE = 6;
/** #4922: страница поиска показывает раздел целиком — порциями по столько. */
const PAGE = 30;
/** Меньше двух символов — не запрос, а начало набора: по «а» найдётся половина базы. */
const MIN_QUERY = 2;

export const SEARCH_TYPES = ['tasks', 'projects', 'chats', 'messages', 'people', 'docs', 'meetings'] as const;
export type SearchType = typeof SEARCH_TYPES[number];

export type SearchResult = {
  query: string;
  tasks: unknown[];
  projects: unknown[];
  chats: unknown[];
  messages: unknown[];
  people: unknown[];
  docs: unknown[];
  meetings: unknown[];
};

@Injectable()
export class SearchService {
  constructor(private readonly repo: SearchRepository) {}

  /**
   * Поиск по всему, что человеку доступно.
   *
   * Источники опрашиваются параллельно и независимо: медленный или пустой источник не должен
   * задерживать остальные. Клиент имеет право видеть только своё, поэтому переписка и люди
   * ему не отдаются вовсе — у него отдельный портал.
   *
   * #4922: `type` — только один раздел (страница поиска, вкладка), `offset` — «Показать ещё».
   * `page` — страница поиска: по 30 из каждого раздела вместо шести, как в палитре.
   */
  async all(tenantId: string, userId: string, role: string, raw: string,
    opts: { type?: SearchType | null; offset?: number; page?: boolean } = {}): Promise<SearchResult> {
    const query = raw.trim().slice(0, 120);
    const empty: SearchResult = { query, tasks: [], projects: [], chats: [], messages: [], people: [], docs: [], meetings: [] };
    if (query.length < MIN_QUERY && !/^\d$/.test(query)) return empty;

    const internal = role !== 'client';
    const limit = opts.type ? PAGE : opts.page ? PAGE : PER_SOURCE;
    const offset = opts.type ? Math.max(0, Math.min(5000, opts.offset ?? 0)) : 0;
    const want = (t: SearchType) => !opts.type || opts.type === t;
    const viewer = { userId, role };
    const [tasks, projects, chats, messages, people, docs, meetings] = await Promise.all([
      want('tasks') ? this.repo.tasks(tenantId, query, limit, viewer, offset) : [],
      want('projects') ? this.repo.projects(tenantId, query, limit, viewer, offset) : [],
      internal && want('chats') ? this.repo.chats(tenantId, userId, query, limit, offset) : [],
      internal && want('messages') ? this.repo.messages(tenantId, userId, query, limit, offset) : [],
      internal && want('people') ? this.repo.people(tenantId, query, limit, offset) : [],
      internal && want('docs') ? this.repo.docs(tenantId, query, limit, offset) : [],
      internal && want('meetings') ? this.repo.meetings(tenantId, query, limit, viewer, offset) : [],
    ]);

    return {
      query,
      // в задаче, найденной по описанию, — кусок описания вокруг совпадения: видно, почему она тут
      tasks: (tasks as { description?: string | null }[]).map((t) => ({ ...t, description: t.description ? snippet(t.description, query) : null })),
      projects,
      chats,
      // сообщение в списке — это строка, а не переписка: показываем окрестность совпадения
      messages: (messages as any[]).map((m) => ({ ...m, body: snippet(m.body, query) })),
      people,
      docs,
      meetings,
    };
  }
}

/**
 * Кусок сообщения вокруг найденного слова.
 *
 * Показывать первые 200 символов бессмысленно: совпадение обычно в середине, и человек
 * видит начало чужого разговора вместо того, что искал. #4922: если вся фраза целиком не
 * встречается (слова стоят порознь), берём окрестность первого найденного слова.
 */
export function snippet(body: string, query: string, radius = 60): string {
  const text = body.replace(/\s+/g, ' ').trim();
  const low = text.toLowerCase().replace(/ё/g, 'е');
  const q = query.toLowerCase().replace(/ё/g, 'е').trim();
  let at = low.indexOf(q);
  let len = q.length;
  if (at < 0) {
    for (const w of q.replace(/[#№]/g, ' ').split(/\s+/).filter((x) => x.length >= 2)) {
      const i = low.indexOf(w);
      if (i >= 0) { at = i; len = w.length; break; }
    }
  }
  if (at < 0) return text.slice(0, radius * 2);
  const from = Math.max(0, at - radius);
  const to = Math.min(text.length, at + len + radius);
  return (from > 0 ? '…' : '') + text.slice(from, to) + (to < text.length ? '…' : '');
}
