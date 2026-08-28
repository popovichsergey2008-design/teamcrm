import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { REVIEW_COLUMN_NAMES } from '../tasks/task-columns';
import { RealtimeService } from '../realtime/realtime.service';
import { SecretaryService } from '../secretary/secretary.service';
import { TelegramMirror } from '../notifications/telegram-mirror.service';
import { AssistantRepository } from './assistant.repository';
import { EveningFacts, eveningKey, eveningText, isEveningTime } from './evening-rules';
import { greetingFor, localParts } from './ping-rules';

/**
 * Вечерний свод для тех, кто отвечает за результат.
 *
 * Владелец сегодня узнаёт о сорванном сроке от заказчика, а не от системы: чтобы
 * увидеть картину, надо обойти доски руками. Все нужные цифры давно считаются для
 * «Пульса команды» — не хватало одного сообщения в конце дня.
 *
 * Получатели — владелец и руководители: свод говорит о чужой работе, и рядовому
 * сотруднику это лишняя тревога, а не помощь.
 */
@Injectable()
export class EveningService {
  private readonly log = new Logger('AssistantEvening');

  constructor(
    private readonly db: DbService,
    private readonly repo: AssistantRepository,
    private readonly realtime: RealtimeService,
    private readonly secretary: SecretaryService,
    private readonly telegram: TelegramMirror,
  ) {}

  /** Проход по организации: кому пора подводить итоги — тому и подводим. */
  async runTenant(tenantId: string, now = new Date()): Promise<number> {
    const [work, managers] = await Promise.all([
      this.repo.workHours(tenantId),
      this.db.many<{ id: string; timezone: string | null }>(
        `SELECT u.id::text, u.timezone FROM users u
           JOIN roles r ON r.id = u.role_id
          WHERE u.tenant_id=$1 AND u.is_active AND r.code IN ('owner','manager')`,
        [tenantId],
      ),
    ]);
    const endMinutes = toMinutes(work.workEnd);

    let sent = 0;
    for (const m of managers) {
      const { hour, minute, dow, date } = localParts(now, m.timezone);
      if (work.weekendDays.includes(dow) || work.holidays.includes(date)) continue;
      if (!isEveningTime(hour * 60 + minute, endMinutes)) continue;

      const key = eveningKey(m.id, date);
      if (await this.repo.byKey(tenantId, key)) continue; // сегодня уже подводили

      const facts = await this.facts(tenantId, m.timezone);
      const text = eveningText(facts, greetingFor(now, m.timezone));
      if (!text) continue; // день без событий — молчим

      const row = await this.repo.create({
        tenantId, userId: m.id, kind: 'evening', taskId: null, text, status: 'sent', dedupKey: key,
      });
      if (!row) continue;

      this.realtime.emitToUsers(tenantId, [m.id], 'assistant.ping', { id: String(row.id), text, taskId: null });
      void this.telegram.push(tenantId, m.id, text);
      void this.secretary.record({
        tenantId, userId: m.id, kind: 'evening', summary: 'Итоги дня для руководителя',
      });
      sent++;
    }
    return sent;
  }

  /**
   * Показать свод, не дожидаясь вечера.
   *
   * Нужен и человеку («что там у меня накопилось»), и проверке: ждать конца рабочего
   * дня, чтобы убедиться, что свод собирается, — не тот способ ловить ошибки.
   */
  async preview(tenantId: string, timezone: string | null, now = new Date()) {
    const facts = await this.facts(tenantId, timezone);
    return { text: eveningText(facts, greetingFor(now, timezone)), facts };
  }

  /**
   * Факты дня одним заходом.
   *
   * «Сегодня» считаем по поясу получателя: для человека в Новосибирске рабочий день
   * заканчивается тогда, когда в Москве он в разгаре, и «сдано за день» у них разное.
   */
  private async facts(tenantId: string, timezone: string | null): Promise<EveningFacts> {
    const tz = timezone || 'Europe/Moscow';
    const [done, review, overdue, atRisk] = await Promise.all([
      this.db.many<{ title: string; assignee_name: string | null }>(
        `SELECT t.title, u.full_name AS assignee_name
           FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
          WHERE t.tenant_id=$1 AND t.closed_at IS NOT NULL
            AND (t.closed_at AT TIME ZONE $2::text)::date = (now() AT TIME ZONE $2::text)::date
          ORDER BY t.closed_at DESC LIMIT 20`,
        [tenantId, tz],
      ),
      this.db.many<{ title: string; hours: number }>(
        `SELECT t.title, EXTRACT(EPOCH FROM (now() - t.updated_at)) / 3600 AS hours
           FROM tasks t JOIN board_columns c ON c.id = t.column_id
          WHERE t.tenant_id=$1 AND t.closed_at IS NULL AND lower(c.name) = ANY($2::text[])
          ORDER BY t.updated_at LIMIT 20`,
        [tenantId, REVIEW_COLUMN_NAMES],
      ),
      this.db.one<{ tasks: string; people: string }>(
        `SELECT COUNT(*) AS tasks, COUNT(DISTINCT t.assignee_id) AS people
           FROM tasks t JOIN board_columns c ON c.id = t.column_id
          WHERE t.tenant_id=$1 AND t.closed_at IS NULL
            AND t.deadline_at < now() AND lower(c.name) <> ALL($2::text[])`,
        [tenantId, REVIEW_COLUMN_NAMES],
      ),
      // Светофор рисков считает прогноз (Этап 4) — здесь только читаем его вывод.
      this.db.many<{ title: string; assignee_name: string | null }>(
        `SELECT t.title, u.full_name AS assignee_name
           FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
          WHERE t.tenant_id=$1 AND t.closed_at IS NULL
            AND t.risk_level IN ('red','yellow')
            AND t.deadline_at BETWEEN now() AND now() + interval '7 days'
          ORDER BY t.deadline_at LIMIT 20`,
        [tenantId],
      ),
    ]).catch((e) => {
      this.log.warn(`факты дня не собрались: ${(e as Error).message}`);
      return [[], [], null, []] as const;
    });

    return {
      done: done.map((d) => ({ title: d.title, assigneeName: d.assignee_name })),
      review: review.map((r) => ({ title: r.title, hours: Number(r.hours) })),
      overdue: { tasks: Number(overdue?.tasks ?? 0), people: Number(overdue?.people ?? 0) },
      atRisk: atRisk.map((r) => ({ title: r.title, assigneeName: r.assignee_name })),
    };
  }
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m || 0);
}
