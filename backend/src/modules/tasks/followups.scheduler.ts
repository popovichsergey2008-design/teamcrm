import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { withinWorkHours } from '../assistant/ping-rules';
import { humanDeadline } from './deadline-notice';
import { ASK_FROM_MS, askText, shouldAsk } from './followup-rules';
import { FollowupCandidate, FollowupsRepository } from './followups.repository';

/**
 * Раз в четверть часа. Окно вопроса — два часа шириной (4–6 часов до срока), так что
 * пятнадцати минут хватает с запасом, а нагрузки нет: запрос идёт по индексу срока.
 */
const TICK_MS = 15 * 60_000;

const FALLBACK_TZ = 'Europe/Moscow';

/**
 * Догоняющий вопрос по задаче (ТЗ-11, разд. 50).
 *
 * За 4–6 часов до срока исполнителя спрашивают, как идёт работа, и дают три ответа:
 * успеваю, есть блокер, нужен перенос. Смысл не в напоминании — их и так хватает, — а
 * в том, чтобы постановщик узнал о срыве ДО срока, когда ещё можно что-то сделать.
 *
 * «No-nagging» из названия раздела ТЗ означает ровно одно: спросить ОДИН раз про ОДИН
 * срок. Ответил — больше не тронем. Перенесли срок — спросим про новый.
 *
 * Ночью и в выходной не спрашиваем вовсе, а не откладываем: вопрос в три часа ночи
 * работу не ускорит, а доверие потратит. Если окно пришлось на нерабочее время, этот
 * срок останется без вопроса — и это честнее, чем разбудить.
 */
@Injectable()
export class FollowupsScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('TaskFollowups');
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private readonly repo: FollowupsRepository) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // unref: незавершённый таймер не должен держать процесс при остановке
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let asked = 0;
    try {
      const rows = await this.repo.due(now, ASK_FROM_MS);
      for (const row of rows) {
        try {
          if (await this.ask(row, now)) asked++;
        } catch (e) {
          this.log.warn(`задача ${row.task_id}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      this.log.error(`проход не удался: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
    return asked;
  }

  private async ask(row: FollowupCandidate, now: Date): Promise<boolean> {
    const tz = row.timezone || row.org_timezone || FALLBACK_TZ;
    const working = withinWorkHours(now, tz, {
      workStart: String(row.work_start).slice(0, 5),
      workEnd: String(row.work_end).slice(0, 5),
      weekendDays: row.weekend_days ?? [0, 6],
      holidays: row.holidays ?? [],
    });

    if (!shouldAsk({
      deadlineAt: new Date(row.deadline_at),
      now,
      closed: row.closed,
      waitingApproval: row.waiting_approval,
      hasAssignee: !!row.assignee_id,
      asked: row.asked,
      working,
    })) return false;

    const text = askText(row.title, humanDeadline(new Date(row.deadline_at), tz));
    const pingId = await this.repo.addPing({
      tenantId: row.tenant_id,
      userId: String(row.assignee_id),
      taskId: row.task_id,
      text,
      // Ключ по задаче И сроку: перенесли срок — это новый повод спросить.
      dedupKey: `followup:${row.task_id}:${row.deadline_at}`,
    });

    /*
      Отметку ставим даже если напоминание не завелось (его уже создал другой
      экземпляр приложения): «спросили» — про факт вопроса, а не про строку в сводке.
    */
    const first = await this.repo.remember(
      row.tenant_id, row.task_id, String(row.assignee_id), row.deadline_at, pingId,
    );
    if (!first) return false;

    this.log.log(`задача ${row.task_id}: спросили исполнителя о ходе работы`);
    return true;
  }
}
