import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RecurrenceRow, ruleOf, TaskRecurrenceRepository } from './task-recurrence.repository';
import { TasksService } from './tasks.service';
import { TaskActivityRepository } from './task-activity.repository';
import { describeRule, nextRun } from './recurrence';

/**
 * Раз в пять минут. Повтор — не будильник: задача на день опоздать не может, а
 * запрос под индексом «что уже пора» стоит копейки. Чаще незачем, реже — и задача,
 * заведённая на 10:00, появляется к 11.
 */
const TICK_MS = 5 * 60_000;

/**
 * Регулярные задачи.
 *
 * «Отчёт каждый понедельник» заводится один раз: дальше система сама создаёт копию
 * задачи-образца к нужному дню. Копия проходит обычным путём создания задачи — с
 * уведомлением исполнителю, записью в историю, выгрузкой во внешние системы, — иначе
 * она была бы задачей второго сорта, о которой никто не узнал.
 *
 * ГЛАВНОЕ ПРАВИЛО (решение заказчика): ПО РАСПИСАНИЮ, НО НЕ ПЛОДИТЬ. Если прежняя
 * задача повтора ещё не закрыта, новую не создаём — переносим срок у старой и пишем
 * это в историю. Иначе к концу месяца на доске висит тридцать одинаковых «Отчётов»,
 * и человек перестаёт видеть их вовсе. Пропуск при этом не прячется: сдвинутый срок
 * и запись в журнале показывают, что срок наступал.
 */
@Injectable()
export class RecurrenceScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('TaskRecurrence');
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly repo: TaskRecurrenceRepository,
    private readonly tasks: TasksService,
    private readonly activity: TaskActivityRepository,
  ) {}

  onModuleInit(): void {
    // unref: незавершённый таймер не должен держать процесс при остановке
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Проход: забрать созревшие расписания и выполнить каждое. */
  async tick(now = new Date()): Promise<number> {
    if (this.busy) return 0; // предыдущий проход ещё идёт — второй только мешал бы
    this.busy = true;
    let made = 0;
    try {
      const due = await this.repo.due(now);
      for (const row of due) {
        try {
          if (await this.run(row, now)) made++;
        } catch (e) {
          // одно сломанное расписание не должно останавливать остальные
          this.log.warn(`повтор ${row.id}: ${(e as Error).message}`);
          // и не должно крутиться в цикле: сдвигаем на следующий срок в любом случае
          await this.repo.markRun(row.id, now, nextRun(ruleOf(row), now));
        }
      }
    } finally {
      this.busy = false;
    }
    return made;
  }

  /**
   * Одно срабатывание.
   *
   * Возвращает `true`, если задача создана, и `false`, если прежняя ещё в работе и мы
   * ограничились переносом срока.
   */
  private async run(row: RecurrenceRow, now: Date): Promise<boolean> {
    const rule = ruleOf(row);
    // Срок новой задачи — тот момент, на который расписание и сработало: человек
    // ждёт «понедельник, 10:00», а не «когда планировщик проснулся».
    const dueAt = new Date(row.next_run_at);
    const after = dueAt.getTime() > now.getTime() ? dueAt : now;
    const upcoming = nextRun(rule, after);

    const last = await this.repo.lastInstance(row.tenant_id, row.id);
    if (last && !last.closed_at) {
      // НЕ ПЛОДИМ. Прежняя задача жива — двигаем ей срок на новое срабатывание.
      await this.repo.pushDeadline(row.tenant_id, last.id, dueAt);
      await this.activity.log(row.tenant_id, last.id, null, 'recurrence_shifted', {
        rule: describeRule(rule),
        deadlineAt: dueAt.toISOString(),
      });
      await this.repo.markRun(row.id, now, upcoming);
      return false;
    }

    const template = await this.repo.template(row.tenant_id, row.task_id);
    if (!template) {
      // образец удалили — расписание больше не о чем; гасим, чтобы не крутилось
      await this.repo.remove(row.tenant_id, row.task_id);
      return false;
    }

    const [labelIds, checklist] = await Promise.all([
      this.repo.templateLabels(row.tenant_id, row.task_id),
      this.repo.templateChecklist(row.tenant_id, row.task_id),
    ]);

    const created = await this.tasks.create(
      row.tenant_id,
      {
        projectId: String(template.project_id),
        title: template.title,
        description: template.description ?? undefined,
        assigneeId: template.assignee_id ? String(template.assignee_id) : undefined,
        managerId: template.created_by ? String(template.created_by) : undefined,
        priority: template.priority ?? undefined,
        deadlineAt: dueAt.toISOString(),
        estimateHours: template.estimate_hours !== null ? Number(template.estimate_hours) : undefined,
        labelIds: labelIds.length ? labelIds : undefined,
        checklist: checklist.length ? checklist : undefined,
        requiresApproval: template.requires_approval !== false,
      } as never,
      // автор копии — постановщик образца: задача приходит от того же человека,
      // от кого приходила в прошлый раз, а не «от системы»
      template.created_by ? String(template.created_by) : null,
    );

    await this.repo.attachCopy(row.tenant_id, String(created.id), row.id);
    await this.activity.log(row.tenant_id, String(created.id), null, 'recurrence_created', {
      rule: describeRule(rule),
      fromTaskId: String(row.task_id),
    });
    await this.repo.markRun(row.id, now, upcoming);
    this.log.log(`повтор ${row.id} (${describeRule(rule)}) → задача ${created.id}`);
    return true;
  }
}
