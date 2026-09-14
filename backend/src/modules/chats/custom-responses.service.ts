import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { AppException } from '../../common/http/app-exception';

export interface ResponseRow {
  id: string; tenant_id: string; created_by: string | null; trigger: string; match_kind: string;
  answer: string; scope: string; auto: boolean; enabled: boolean; hits: number;
  created_at: Date; updated_at: Date;
}

/**
 * Быстрые ответы (ТЗ-6, разд. 37–38).
 *
 * Администратор задаёт: «слово VPN → вот инструкция». Ответ уходит слово в слово,
 * мгновенно и без модели — это и дешевле, и предсказуемее: на вопрос про отпуск
 * компания обязана отвечать одинаково каждому, а модель каждый раз формулирует
 * чуть иначе.
 *
 * По умолчанию срабатывает ТОЛЬКО при обращении к боту. Отвечать без упоминания
 * можно включить у конкретного ответа — непрошеный бот в рабочем чате раздражает
 * сильнее, чем помогает.
 */
@Injectable()
export class CustomResponsesService {
  private readonly log = new Logger('CustomResponses');

  constructor(private readonly db: DbService) {}

  /**
   * Наружу отдаём вид, а не строку таблицы: имена колонок в базе змейкой, а экран
   * и договор API живут в camelCase — иначе каждый потребитель переводит их сам.
   */
  async list(tenantId: string): Promise<ResponseView[]> {
    const rows = await this.db.many<ResponseRow>(
      `SELECT * FROM ai_custom_responses WHERE tenant_id=$1 ORDER BY enabled DESC, id DESC`, [tenantId],
    );
    return rows.map(view);
  }

  async create(tenantId: string, userId: string, i: {
    trigger: string; answer: string; matchKind?: 'keyword' | 'exact'; scope?: 'all' | 'channels' | 'dms'; auto?: boolean;
  }): Promise<ResponseView> {
    const row = await this.db.one<ResponseRow>(
      `INSERT INTO ai_custom_responses (tenant_id, created_by, trigger, match_kind, answer, scope, auto)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [tenantId, userId, i.trigger.trim().slice(0, 300), i.matchKind ?? 'keyword', i.answer.trim(), i.scope ?? 'all', i.auto ?? false],
    );
    return view(row as ResponseRow);
  }

  async update(tenantId: string, id: string, p: {
    trigger?: string; answer?: string; matchKind?: 'keyword' | 'exact'; scope?: 'all' | 'channels' | 'dms';
    auto?: boolean; enabled?: boolean;
  }): Promise<ResponseView> {
    const row = await this.db.one<ResponseRow>(
      `UPDATE ai_custom_responses
          SET trigger    = COALESCE($3, trigger),
              answer     = COALESCE($4, answer),
              match_kind = COALESCE($5, match_kind),
              scope      = COALESCE($6, scope),
              auto       = COALESCE($7, auto),
              enabled    = COALESCE($8, enabled),
              updated_at = now()
        WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [tenantId, id, p.trigger ?? null, p.answer ?? null, p.matchKind ?? null, p.scope ?? null,
        p.auto ?? null, p.enabled ?? null],
    );
    if (!row) throw AppException.notFound('Быстрый ответ не найден');
    return view(row);
  }

  async remove(tenantId: string, id: string): Promise<{ deleted: boolean }> {
    const r = await this.db.query(`DELETE FROM ai_custom_responses WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    if (!(r.rowCount ?? 0)) throw AppException.notFound('Быстрый ответ не найден');
    return { deleted: true };
  }

  /**
   * Подобрать ответ на сообщение.
   *
   * `mentioned` — звали ли бота. Без обращения отвечают только те, у кого явно
   * включено «без упоминания»: иначе первое же слово «отпуск» в живом разговоре
   * получает ответ бота, и разговор ломается.
   */
  async match(tenantId: string, text: string, chatKind: string, mentioned: boolean): Promise<ResponseRow | null> {
    const body = normalize(text);
    if (!body) return null;
    const rows = await this.db.many<ResponseRow>(
      `SELECT * FROM ai_custom_responses WHERE tenant_id=$1 AND enabled ORDER BY id`, [tenantId],
    );
    const inChannels = chatKind === 'channel' || chatKind === 'group' || chatKind === 'project';
    for (const r of rows) {
      if (!mentioned && !r.auto) continue;
      if (r.scope === 'channels' && !inChannels) continue;
      if (r.scope === 'dms' && inChannels) continue;
      if (matches(r, body)) {
        void this.db.query(`UPDATE ai_custom_responses SET hits = hits + 1 WHERE id=$1`, [r.id]).catch(() => undefined);
        this.log.log(`быстрый ответ #${r.id} по триггеру «${r.trigger}»`);
        return r;
      }
    }
    return null;
  }
}

export interface ResponseView {
  id: string; trigger: string; answer: string;
  matchKind: string; scope: string; auto: boolean; enabled: boolean; hits: number;
}

function view(r: ResponseRow): ResponseView {
  return {
    id: String(r.id), trigger: r.trigger, answer: r.answer, matchKind: r.match_kind,
    scope: r.scope, auto: r.auto, enabled: r.enabled, hits: Number(r.hits),
  };
}

/**
 * Приводим к сравнимому виду: без регистра, без знаков и с «ё» как «е».
 * Люди пишут «VPN?», «впн», «Отпуск!!» — и ждут один и тот же ответ.
 */
export function normalize(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matches(r: Pick<ResponseRow, 'trigger' | 'match_kind'>, body: string): boolean {
  if (r.match_kind === 'exact') return body === normalize(r.trigger);
  /*
    Ключевые слова через запятую: срабатывает любое.

    По запятой режем ДО приведения — normalize выбрасывает знаки, и «vpn, впн»
    после неё превратилось бы в одну фразу «vpn впн», которой в сообщении нет.

    Одиночное слово ищем среди СЛОВ сообщения, а не вхождением строки: иначе «вид»
    находится внутри «видео» и бот отвечает невпопад.
  */
  const words = new Set(body.split(' '));
  return String(r.trigger).split(',').map((x) => normalize(x)).filter(Boolean)
    .some((key) => (key.includes(' ') ? body.includes(key) : words.has(key)));
}
