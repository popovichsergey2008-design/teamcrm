import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DeadlineCandidate, DeadlineNoticesRepository } from './deadline-notices.repository';
import { humanDeadline, noticeDue, noticeText, SOON_MS } from './deadline-notice';
import { TaskActivityRepository } from './task-activity.repository';
import { RealtimeService } from '../realtime/realtime.service';

/**
 * Раз в пять минут. Срок — не будильник: сказать «почти просрочена» на пять минут
 * позже не страшно, а запрос под индексом по deadline_at стоит копейки.
 */
const TICK_MS = 5 * 60_000;

/** Пояс по умолчанию: у исполнителя он может быть не задан. */
const FALLBACK_TZ = 'Europe/Moscow';

/**
 * Предупреждение о сроке прямо в обсуждении задачи (просьба заказчика, как в Битриксе).
 *
 * За сутки до срока и в момент, когда срок прошёл, в обсуждение падает системная
 * строка: «Пётр, задача почти просрочена. Крайний срок задачи 21 сентября 2026, 15:00».
 * Её видят все участники там, где обсуждают работу, а не в отдельной сводке, которую
 * надо ещё открыть.
 *
 * Вместе со строкой пишется событие в журнал задачи — от него зажигается счётчик
 * «Проекты и доски» в левой панели. Именно этого заказчик и просил: чтобы
 * предупреждение «падало в уведомления», а не тихо лежало внутри карточки.
 *
 * ПОЧЕМУ НЕ ШЛЁМ ПИСЬМО И PUSH. О своих сроках человек и так узнаёт из сводки
 * секретаря и из «Фокуса дня»; отдельное письмо на каждую задачу за сутки до срока
 * превращает почту в шум, после которого перестают читать и важное.
 */
@Injectable()
export class DeadlineNoticesScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('DeadlineNotices');
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly repo: DeadlineNoticesRepository,
    private readonly activity: TaskActivityRepository,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // unref: незавершённый таймер не должен держать процесс при остановке
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Проход: взять созревшие сроки и сказать по каждому ровно один раз. */
  async tick(now = new Date()): Promise<number> {
    if (this.busy) return 0; // предыдущий проход ещё идёт — второй только мешал бы
    this.busy = true;
    let said = 0;
    try {
      const rows = await this.repo.due(now, SOON_MS);
      for (const row of rows) {
        try {
          if (await this.say(row, now)) said++;
        } catch (e) {
          this.log.warn(`задача ${row.task_id}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      this.log.error(`проход не удался: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
    return said;
  }

  private async say(row: DeadlineCandidate, now: Date): Promise<boolean> {
    const deadline = new Date(row.deadline_at);
    const kind = noticeDue({
      deadlineAt: deadline,
      closed: row.closed,
      said: row.said ?? [],
      now,
    });
    if (!kind) return false;

    /*
      Сначала отметка, потом сообщение.

      Так безопаснее: при сбое между двумя действиями человек в худшем случае не
      увидит предупреждения, а не получит его трижды. Повторяющийся текст в обсуждении
      раздражает сильнее, чем пропущенный.
    */
    const first = await this.repo.remember(row.tenant_id, row.task_id, kind, row.deadline_at);
    if (!first) return false;

    const text = noticeText(kind, row.assignee_name, humanDeadline(deadline, row.timezone || FALLBACK_TZ));
    const comment = await this.repo.addSystemComment(row.tenant_id, row.task_id, text);

    /*
      Событие в журнал — с пустым автором.

      Счётчик непрочитанного считает чужие события: у системного автора нет, поэтому
      оно чужое для всех участников сразу, включая исполнителя. Ровно это и нужно —
      предупреждение адресовано в первую очередь ему.
    */
    await this.activity.log(row.tenant_id, row.task_id, null, `deadline_${kind}`, {
      deadlineAt: row.deadline_at,
      commentId: comment?.id ?? null,
    });

    this.realtime.emitScoped(
      row.tenant_id, row.project_id, 'task.comment_added',
      // false: строка внутренняя, в комнату заказчика её слать незачем
      { taskId: row.task_id, commentId: comment?.id ?? null, authorId: null }, false,
    );
    this.log.log(`задача ${row.task_id}: ${kind === 'soon' ? 'почти просрочена' : 'просрочена'}`);
    return true;
  }
}
