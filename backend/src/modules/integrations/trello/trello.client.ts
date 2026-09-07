/**
 * Клиент Trello REST API.
 *
 * Доступ — пара «ключ + токен», которую человек берёт сам на trello.com/power-ups/admin
 * (ключ) и по ссылке авторизации (токен). OAuth-приложение здесь не нужно: это
 * личный доступ пользователя к своим доскам, и для переезда его достаточно.
 *
 * Ключ и токен НИКОГДА не попадают в строку запроса в логах: Trello принимает их и
 * заголовком `Authorization`, и мы пользуемся именно им.
 */

const API = 'https://api.trello.com/1';

export interface TrBoard { id: string; name: string; closed: boolean; url?: string }
export interface TrList { id: string; name: string; pos: number; closed: boolean }
export interface TrLabel { id: string; name: string; color: string | null }
export interface TrMember { id: string; fullName: string; username: string; email?: string | null }
export interface TrCheckItem { id: string; name: string; state: string; pos: number }
export interface TrChecklist { id: string; name: string; checkItems: TrCheckItem[] }
export interface TrAttachment { id: string; name: string; url: string; isUpload: boolean; mimeType?: string | null; bytes?: number | null }
export interface TrCard {
  id: string;
  idShort?: number;
  name: string;
  desc: string;
  closed: boolean;
  dueComplete?: boolean;
  due: string | null;
  idList: string;
  idMembers: string[];
  labels: TrLabel[];
  pos: number;
  dateLastActivity?: string;
  checklists?: TrChecklist[];
  attachments?: TrAttachment[];
}
export interface TrComment {
  id: string;
  date: string;
  idMemberCreator: string;
  data: { text?: string };
}

export class TrelloClient {
  constructor(private readonly key: string, private readonly token: string) {}

  private headers(): Record<string, string> {
    return { Authorization: `OAuth oauth_consumer_key="${this.key}", oauth_token="${this.token}"` };
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      // 401 здесь означает ровно одно и лечится ровно одним действием — так и говорим
      if (res.status === 401) throw new Error('Trello не принял ключ или токен — проверьте оба и срок действия токена');
      throw new Error(`Trello ответил ${res.status}: ${text || 'ошибка'}`);
    }
    return res.json() as Promise<T>;
  }

  /** Проверка доступа при подключении: заодно узнаём, чей это аккаунт. */
  me(): Promise<{ id: string; fullName: string; username: string }> {
    return this.get('/members/me', { fields: 'id,fullName,username' });
  }

  /** Доски человека. Закрытые (архивные) тоже отдаём — пусть решает он. */
  boards(): Promise<TrBoard[]> {
    return this.get('/members/me/boards', { fields: 'id,name,closed,url', filter: 'all' });
  }

  lists(boardId: string): Promise<TrList[]> {
    return this.get(`/boards/${boardId}/lists`, { fields: 'id,name,pos,closed', filter: 'all' });
  }

  members(boardId: string): Promise<TrMember[]> {
    return this.get(`/boards/${boardId}/members`, { fields: 'id,fullName,username' });
  }

  /**
   * Карточки доски вместе с чек-листами и вложениями — одним запросом.
   *
   * Отдельными запросами на каждую карточку доска в 500 задач превращается в полторы
   * тысячи походов в сеть, а Trello ограничивает частоту (100 запросов за 10 секунд).
   */
  cards(boardId: string): Promise<TrCard[]> {
    return this.get(`/boards/${boardId}/cards`, {
      filter: 'all',
      fields: 'id,idShort,name,desc,closed,due,dueComplete,idList,idMembers,labels,pos,dateLastActivity',
      checklists: 'all',
      checklist_fields: 'id,name',
      attachments: 'true',
      attachment_fields: 'id,name,url,isUpload,mimeType,bytes',
    });
  }

  /** Комментарии доски: тоже пачкой, с постраничностью по 1000. */
  async comments(boardId: string): Promise<(TrComment & { data: { text?: string; card?: { id: string } } })[]> {
    const out: any[] = [];
    let before: string | undefined;
    // Trello отдаёт максимум 1000 действий за раз; идём вглубь, пока приходит полная страница
    for (let page = 0; page < 20; page++) {
      const chunk = await this.get<any[]>(`/boards/${boardId}/actions`, {
        filter: 'commentCard',
        limit: '1000',
        ...(before ? { before } : {}),
      });
      out.push(...chunk);
      if (chunk.length < 1000) break;
      before = chunk[chunk.length - 1]?.date;
      if (!before) break;
    }
    return out;
  }

  /** Скачать вложение. Только загруженные в Trello файлы: внешние ссылки остаются ссылками. */
  async download(url: string): Promise<Buffer> {
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`не скачался (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
}
