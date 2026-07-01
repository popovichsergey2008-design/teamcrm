/**
 * Низкоуровневый клиент Битрикс24 REST поверх входящего вебхука.
 * base — URL вида https://<portal>.bitrix24.ru/rest/<uid>/<token>/ (со слэшем).
 * Пагинация по start/next; бэкофф на лимите запросов (~2 rps на облаке).
 */
export class BitrixError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export class BitrixClient {
  private readonly base: string;

  constructor(webhookUrl: string) {
    this.base = webhookUrl.endsWith('/') ? webhookUrl : webhookUrl + '/';
  }

  /** Домен портала (для отображения). */
  get portal(): string {
    try {
      return new URL(this.base).host;
    } catch {
      return '';
    }
  }

  async call<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    const MAX = 5;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX; attempt++) {
      try {
        const res = await fetch(this.base + method, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(30000),
        });
        const data: any = await res.json().catch(() => ({}));
        if (data && data.error) {
          const code = String(data.error);
          // лимит запросов — подождать и повторить
          if (/QUERY_LIMIT|OVERLOAD|too many/i.test(code + (data.error_description ?? ''))) {
            await this.sleep(600 * attempt);
            continue;
          }
          throw new BitrixError(code, data.error_description || code);
        }
        if (!res.ok) throw new BitrixError('HTTP_' + res.status, `Битрикс вернул ${res.status}`);
        return data.result as T;
      } catch (e) {
        lastErr = e;
        if (e instanceof BitrixError) throw e;
        // сетевые/таймаут — короткий повтор
        if (attempt < MAX) {
          await this.sleep(400 * attempt);
          continue;
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new BitrixError('NETWORK', 'Сбой связи с Битриксом');
  }

  /** Постраничный обход (start/next). pick достаёт массив из result. */
  async list<T = any>(
    method: string,
    params: Record<string, any>,
    pick: (result: any) => T[] = (r) => r as T[],
  ): Promise<T[]> {
    const out: T[] = [];
    let start = 0;
    for (let guard = 0; guard < 1000; guard++) {
      const res = await fetch(this.base + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...params, start }),
        signal: AbortSignal.timeout(30000),
      });
      const data: any = await res.json().catch(() => ({}));
      if (data && data.error) throw new BitrixError(String(data.error), data.error_description || String(data.error));
      out.push(...(pick(data.result) ?? []));
      if (typeof data.next === 'number') start = data.next;
      else break;
    }
    return out;
  }

  // ── типовые запросы ──
  profile() {
    return this.call('profile');
  }
  users() {
    return this.list('user.get', {});
  }
  groups() {
    return this.list('sonet_group.get', {});
  }
  async stages(groupId: string): Promise<any[]> {
    const r = await this.call<any>('task.stages.get', { entityId: groupId });
    // может вернуться объект-карта {id: {...}} или массив
    return Array.isArray(r) ? r : Object.values(r ?? {});
  }
  tasks(groupId: string) {
    return this.list(
      'tasks.task.list',
      {
        filter: { GROUP_ID: groupId },
        select: [
          'ID', 'TITLE', 'DESCRIPTION', 'RESPONSIBLE_ID', 'CREATED_BY', 'STAGE_ID',
          'STATUS', 'PRIORITY', 'DEADLINE', 'GROUP_ID', 'CLOSED_DATE', 'TAGS', 'CHANGED_DATE',
        ],
      },
      (res) => res?.tasks ?? [],
    );
  }
  async comments(taskId: string): Promise<any[]> {
    const r = await this.call<any>('task.commentitem.getlist', { TASKID: taskId });
    return Array.isArray(r) ? r : Object.values(r ?? {});
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
