import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { ProjectsRepository } from '../projects/projects.repository';
import { RealtimeService } from '../realtime/realtime.service';
import { TaskRow, TasksRepository } from './tasks.repository';
import { TaskActivityRepository } from './task-activity.repository';
import { CreateTaskDto, MoveTaskDto, UpdateTaskDto } from './tasks.dto';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { IntegrationOutboxService } from '../integrations/outbox/integration-outbox.service';
import { isDoneColumn, isReviewColumn } from './task-columns';
import { handoffGate } from './handoff-gate';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class TasksService {
  constructor(
    private readonly repo: TasksRepository,
    private readonly projects: ProjectsRepository,
    private readonly realtime: RealtimeService,
    private readonly activity: TaskActivityRepository,
    private readonly knowledge: KnowledgeService,
    private readonly outbox: IntegrationOutboxService,
    private readonly notify: NotificationsService,
  ) {}

  /** Вкладки «Мои задачи» / «Порученные»: задачи по всем проектам, а не по одной доске. */
  listForUser(tenantId: string, userId: string, scope: 'mine' | 'delegated' | 'review', includeClosed: boolean) {
    return this.repo.listForUser(tenantId, userId, scope, includeClosed);
  }

  /**
   * Запланировать задачу на день (или снять план).
   *
   * Планирует только исполнитель: это личный план, а не поручение. Руководитель
   * распоряжается сроком и приоритетом — тем, что видно всем, — а не чужим днём;
   * иначе «фокус дня» превращается в ещё один канал раздачи указаний.
   */
  async setFocusDate(tenantId: string, taskId: string, userId: string, date: string | null) {
    const task = await this.repo.findById(tenantId, taskId);
    if (!task) throw AppException.notFound('Task not found');
    if (String(task.assignee_id ?? '') !== String(userId)) {
      throw AppException.forbidden('Планировать день может только исполнитель задачи');
    }
    if (task.closed_at) throw AppException.conflict('Задача уже завершена');
    return this.repo.setFocusDate(tenantId, taskId, date);
  }

  /**
   * Хвосты: незакрытое, запланированное на прошедшие дни.
   * `today` приходит с клиента — «сегодня» у человека и на сервере разные дни.
   */
  leftovers(tenantId: string, userId: string, today: string) {
    return this.repo.leftovers(tenantId, userId, today);
  }

  async create(tenantId: string, dto: CreateTaskDto, actorId: string | null = null): Promise<TaskRow> {
    const project = await this.projects.findById(tenantId, dto.projectId);
    if (!project) throw AppException.notFound('Project not found');

    const columns = await this.projects.listColumns(tenantId, dto.projectId);
    if (columns.length === 0) throw AppException.conflict('Project has no columns');
    const column = dto.columnId
      ? columns.find((c) => c.id === dto.columnId)
      : columns[0];
    if (!column) throw AppException.notFound('Column not found');

    const task = await this.repo.create({
      tenantId,
      projectId: dto.projectId,
      columnId: column.id,
      status: column.name,
      title: dto.title,
      description: dto.description ?? null,
      assigneeId: dto.assigneeId ?? null,
      createdBy: dto.managerId ?? actorId, // руководитель: явный из формы либо создатель
      priority: dto.priority ?? null,
      deadlineAt: dto.deadlineAt ?? null,
      estimateHours: dto.estimateHours ?? null,
      labelIds: dto.labelIds,
    });
    this.realtime.emit(tenantId, task.project_id, 'task.created', task as any);
    await this.activity.log(tenantId, task.id, actorId, 'created', { title: task.title });
    this.knowledge.enqueue(tenantId, 'task', task.id); // в базу знаний (открытые проекты тоже)
    await this.outbox.enqueue(tenantId, task.project_id, 'task.create', task.id); // выгрузка во внешнюю систему
    void this.notify.taskCreated(tenantId, task.id, actorId); // письмо исполнителю; ответа не ждём
    return task;
  }

  async update(tenantId: string, id: string, dto: UpdateTaskDto, actorId: string | null = null): Promise<TaskRow> {
    const existing = await this.repo.findById(tenantId, id);
    if (!existing) throw AppException.notFound('Task not found');

    const updated = await this.repo.update(tenantId, id, {
      title: dto.title,
      description: dto.description,
      assignee_id: dto.assigneeId,
      created_by: dto.managerId,
      is_blocked: dto.isBlocked,
      priority: dto.priority,
    });
    this.realtime.emit(tenantId, existing.project_id, 'task.updated', updated as any);
    const changed = Object.keys(dto).filter((k) => (dto as any)[k] !== undefined);
    await this.activity.log(tenantId, id, actorId, 'updated', { fields: changed });
    if (dto.title !== undefined || dto.description !== undefined) this.knowledge.enqueue(tenantId, 'task', id); // переиндексация при смене текста
    await this.outbox.enqueue(tenantId, existing.project_id, 'task.update', id);
    return updated as TaskRow;
  }

  /**
   * Удаление задачи.
   *
   * Задача с учтённым временем — особый случай. Раньше её нельзя было удалить вовсе:
   * часы попали в себестоимость проекта, и стереть их значит изменить P&L задним числом.
   * Но в тот же запрет попадали и явные ошибки — случайный запуск таймера на две секунды
   * запирал задачу навсегда, а убрать лишнюю запись из интерфейса нельзя.
   *
   * Теперь такую задачу удаляет ВЛАДЕЛЕЦ и только осознанно: сначала он видит, сколько
   * по ней учтено, и подтверждает. Часы и стоимость при удалении не пропадают —
   * они переезжают в архив и продолжают считаться в себестоимости проекта.
   */
  async remove(
    tenantId: string, id: string, actorId: string | null = null,
    actor?: { role: string; confirmTimeLoss?: boolean },
  ): Promise<{ deleted: true }> {
    const task = await this.repo.findById(tenantId, id);
    if (!task) throw AppException.notFound('Task not found');

    const hours = await this.repo.loggedHours(tenantId, id);
    if (hours > 0) {
      if (actor && actor.role !== 'owner') {
        throw AppException.forbidden(
          'По задаче учтено рабочее время — такую задачу удаляет только владелец компании.',
        );
      }
      if (!actor?.confirmTimeLoss) {
        throw AppException.conflict(
          `По задаче учтено ${formatHours(hours)} рабочего времени. Задача исчезнет с доски, `
          + 'но часы и их стоимость останутся в себестоимости проекта.',
          // секунды, а не часы: полторы секунды случайного таймера в часах округляются
          // в ноль, и деталь отказа переставала что-либо значить
          {
            timeLoss: { seconds: Math.round(hours * 3600), text: formatHours(hours) },
            hint: 'передайте confirmTimeLoss=true',
          },
        );
      }
    }

    await this.repo.remove(tenantId, id, actorId);
    this.realtime.emit(tenantId, task.project_id, 'task.deleted', { id, project_id: task.project_id } as any);
    void actorId; // историю задачи удалили вместе с ней — писать в неё запись не во что
    return { deleted: true };
  }

  async move(tenantId: string, id: string, dto: MoveTaskDto, actorId: string | null = null): Promise<TaskRow> {
    const task = await this.repo.findById(tenantId, id);
    if (!task) throw AppException.notFound('Task not found');

    const column = await this.projects.findColumn(tenantId, task.project_id, dto.columnId);
    if (!column) throw AppException.notFound('Target column not found');

    const missing = await this.handoffMissing(tenantId, task, column.name, actorId);
    if (missing.length && !dto.confirmGate) {
      throw AppException.conflict('Работа сдаётся не полностью', {
        gate: { column: column.name, missing },
        hint: 'передайте confirmGate=true, чтобы сдать всё равно',
      });
    }

    const moved = await this.repo.move(tenantId, id, dto.columnId, dto.position, column.name);
    // перенос в Done закрывает задачу (источник для Velocity/эмбеддингов); вынос — переоткрывает
    if (isDoneColumn(column.name)) {
      await this.repo.closeTask(tenantId, id);
      this.knowledge.enqueue(tenantId, 'task', id); // закрытая задача → в базу знаний
    } else if (task.closed_at) await this.repo.reopenTask(tenantId, id);
    this.realtime.emit(tenantId, moved.project_id, 'task.moved', moved as any);
    await this.activity.log(tenantId, id, actorId, 'moved', { to: column.name });
    // Обход гейта — не молчаливый: проверяющий должен видеть, чего в работе не хватало.
    if (missing.length) {
      await this.activity.log(tenantId, id, actorId, 'handoff_forced', {
        to: column.name, missing: missing.map((m) => m.text),
      });
    }
    await this.outbox.enqueue(tenantId, moved.project_id, 'task.move', id);
    // смена статуса = перенос в другую колонку; о своём же переносе человеку не пишем
    void this.notify.taskStatusChanged(tenantId, id, actorId, column.name, isDoneColumn(column.name));
    return moved;
  }

  /**
   * Приёмка работы: чего не хватает, чтобы сдавать.
   *
   * Спрашиваем только того, кто СДАЁТ свою работу, — исполнителя. Постановщик,
   * двигающий задачу в «Готово», как раз и есть проверяющий: ему этот диалог
   * показывал бы список претензий к чужой работе в момент, когда он её принимает.
   * Машинные переносы (агент, разбор дейлика) сюда не попадают: они идут без актора
   * или с confirmGate — диалог показывать некому.
   */
  private async handoffMissing(tenantId: string, task: TaskRow, columnName: string, actorId: string | null) {
    const handingOver = isReviewColumn(columnName) || isDoneColumn(columnName);
    if (!handingOver || !actorId || String(task.assignee_id ?? '') !== String(actorId)) return [];
    const [req, facts] = await Promise.all([
      this.repo.gateSettings(tenantId),
      this.repo.handoffFacts(tenantId, task.id, actorId),
    ]);
    return handoffGate(req, facts);
  }

  /** Условия приёмки компании: читают все, меняет владелец. */
  gateSettings(tenantId: string) {
    return this.repo.gateSettings(tenantId);
  }

  saveGateSettings(tenantId: string, role: string, req: { checklist: boolean; comment: boolean; attachment: boolean }) {
    if (role !== 'owner') throw AppException.forbidden('Условия приёмки задаёт владелец');
    return this.repo.saveGateSettings(tenantId, req);
  }
}

/** «2 ч 15 мин» / «40 сек» — человек должен сразу понять, о каком объёме речь. */
function formatHours(hours: number): string {
  const minutes = Math.round(hours * 60);
  if (minutes < 1) return `${Math.max(1, Math.round(hours * 3600))} сек`;
  if (minutes < 60) return `${minutes} мин`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}
