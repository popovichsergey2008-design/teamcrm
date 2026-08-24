import { Injectable } from '@nestjs/common';
import { SearchRepository } from './search.repository';

/** Сколько показывать из каждого источника: длинный список в палитре всё равно не читают. */
const PER_SOURCE = 6;
/** Меньше двух символов — не запрос, а начало набора: по «а» найдётся половина базы. */
const MIN_QUERY = 2;

export type SearchResult = {
  query: string;
  tasks: unknown[];
  projects: unknown[];
  chats: unknown[];
  messages: unknown[];
  people: unknown[];
  docs: unknown[];
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
   */
  async all(tenantId: string, userId: string, role: string, raw: string): Promise<SearchResult> {
    const query = raw.trim().slice(0, 120);
    const empty: SearchResult = { query, tasks: [], projects: [], chats: [], messages: [], people: [], docs: [] };
    if (query.length < MIN_QUERY) return empty;

    const internal = role !== 'client';
    const [tasks, projects, chats, messages, people, docs] = await Promise.all([
      this.repo.tasks(tenantId, query, PER_SOURCE),
      this.repo.projects(tenantId, query, PER_SOURCE),
      internal ? this.repo.chats(tenantId, userId, query, PER_SOURCE) : [],
      internal ? this.repo.messages(tenantId, userId, query, PER_SOURCE) : [],
      internal ? this.repo.people(tenantId, query, PER_SOURCE) : [],
      internal ? this.repo.docs(tenantId, query, PER_SOURCE) : [],
    ]);

    return {
      query,
      tasks,
      projects,
      chats,
      // сообщение в списке — это строка, а не переписка: показываем окрестность совпадения
      messages: (messages as any[]).map((m) => ({ ...m, body: snippet(m.body, query) })),
      people,
      docs,
    };
  }
}

/**
 * Кусок сообщения вокруг найденного слова.
 *
 * Показывать первые 200 символов бессмысленно: совпадение обычно в середине, и человек
 * видит начало чужого разговора вместо того, что искал.
 */
export function snippet(body: string, query: string, radius = 60): string {
  const text = body.replace(/\s+/g, ' ').trim();
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text.slice(0, radius * 2);
  const from = Math.max(0, at - radius);
  const to = Math.min(text.length, at + query.length + radius);
  return (from > 0 ? '…' : '') + text.slice(from, to) + (to < text.length ? '…' : '');
}
