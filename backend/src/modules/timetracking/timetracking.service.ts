import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { RealtimeService } from '../realtime/realtime.service';
import { EconomicsProducer } from '../economics/economics.producer';
import { TimeLogRow, TimeTrackingRepository } from './timetracking.repository';
import { FocusService } from '../focus/focus.service';

@Injectable()
export class TimeTrackingService {
  constructor(
    private readonly repo: TimeTrackingRepository,
    private readonly realtime: RealtimeService,
    private readonly economics: EconomicsProducer,
    private readonly focus: FocusService,
  ) {}

  async start(tenantId: string, userId: string, taskId: string) {
    const tp = await this.repo.taskProject(tenantId, taskId);
    if (!tp) throw AppException.notFound('Task not found');

    const { started, closed } = await this.repo.start(tenantId, userId, taskId);

    // Взял задачу в работу — статус в профиле ставится сам. По ТЗ это Zero-Click:
    // руками статус не меняет почти никто, и коллеги всё равно спрашивают «ты занят?».
    //
    // Ждём завершения, а не отпускаем в фон: интерфейс читает статус сразу после
    // старта таймера, и в гонке человек видел прежний статус — «нажал, а не встало».
    // Ошибку метод глотает сам, так что задержать старт таймера это не может.
    await this.focus.fromTaskStart(tenantId, userId, taskId, tp.title);

    // событие старта (нефинансовое) в комнату проекта
    this.realtime.emit(tenantId, tp.project_id, 'time.started', {
      taskId,
      userId,
      timeLogId: started.id,
      startedAt: started.timestamp_start,
    });

    // если закрылся предыдущий таймер на другой задаче — событие + пересчёт той задачи
    if (closed && closed.task_id !== taskId) {
      const prev = await this.repo.taskProject(tenantId, closed.task_id);
      if (prev) {
        this.realtime.emit(tenantId, prev.project_id, 'time.stopped', {
          taskId: closed.task_id,
          userId,
          timeLogId: closed.id,
        });
      }
      await this.enqueueRecompute(tenantId, closed.task_id);
    }
    return this.view(started);
  }

  async stop(tenantId: string, userId: string, taskId: string) {
    const stopped = await this.repo.stop(tenantId, userId, taskId);
    if (!stopped) throw AppException.notFound('No active timer for this task');

    const tp = await this.repo.taskProject(tenantId, taskId);
    if (tp) {
      this.realtime.emit(tenantId, tp.project_id, 'time.stopped', {
        taskId,
        userId,
        timeLogId: stopped.id,
        stoppedAt: stopped.timestamp_end,
      });
    }
    // закрытие записи → пересчёт себестоимости (Шаг 2.1/2.2)
    await this.enqueueRecompute(tenantId, taskId);
    return this.view(stopped);
  }

  async active(tenantId: string, userId: string) {
    const row = await this.repo.activeTimer(tenantId, userId);
    return row ? this.view(row) : null;
  }

  private enqueueRecompute(tenantId: string, taskId: string) {
    return this.economics.enqueue({
      kind: 'recompute_task',
      tenantId,
      taskId,
      reason: 'time_log_closed',
      dedupKey: `task:${taskId}`,
    });
  }

  private view(row: TimeLogRow) {
    return {
      id: row.id,
      taskId: row.task_id,
      userId: row.user_id,
      startedAt: row.timestamp_start,
      stoppedAt: row.timestamp_end,
    };
  }
}
