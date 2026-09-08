import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { ProjectsRepository } from '../projects/projects.repository';
import { RealtimeService } from '../realtime/realtime.service';
import { TaskRow, TasksRepository } from './tasks.repository';
import { TaskActivityRepository } from './task-activity.repository';
import { ruleOf, TaskRecurrenceRepository } from './task-recurrence.repository';
import { describeRule, nextRun, normalizeRule } from './recurrence';
import { TaskReadsRepository } from './task-reads.repository';
import { CreateTaskDto, MoveTaskDto, UpdateTaskDto } from './tasks.dto';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { IntegrationOutboxService } from '../integrations/outbox/integration-outbox.service';
import { isDoneColumn, isReviewColumn } from './task-columns';
import { handoffGate } from './handoff-gate';
import { REGISTRY_PAGE_SIZE, RegistryFilters } from './task-registry';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class TasksService {
  constructor(
    private readonly repo: TasksRepository,
    private readonly projects: ProjectsRepository,
    private readonly realtime: RealtimeService,
    private readonly activity: TaskActivityRepository,
    private readonly reads: TaskReadsRepository,
    private readonly knowledge: KnowledgeService,
    private readonly outbox: IntegrationOutboxService,
    private readonly notify: NotificationsService,
    private readonly recurrence: TaskRecurrenceRepository,
  ) {}

  /**
   * «Я это видел».
   *
   * Ставится по открытию карточки: увидеть изменение можно, только открыв задачу.
   * Гасить счётчик прокруткой доски нельзя — он погас бы сам собой, ничего не показав.
   */
  markRead(tenantId: string, taskId: string, userId: string): Promise<void> {
    return this.reads.markRead(tenantId, taskId, userId);
  }

  /**
   * Реестр задач: всё по всем проектам одним списком.
   *
   * «Фокус дня» отвечает, что делать сегодня, и потому показывает только открытое и
   * только со сроком. Реестр отвечает на другой вопрос — «покажи ВСЁ, что я поставил» и
   * «всё, что на мне», — с историей, отбором и постраничностью.
   *
   * Общее число строк приходит окном в том же запросе: держать отдельный COUNT в
   * согласии с фильтрами не получится, он разъедется на первой правке.
   */
  async registry(tenantId: string, userId: string, filters: RegistryFilters) {
    const rows = await this.repo.registry(tenantId, userId, filters);
    const total = Number(rows[0]?.total ?? 0);
    // Красные счётчики — только по показанной странице: считать непрочитанное по всем
    // задачам организации ради пятидесяти строк незачем.
    const unread = new Map<string, number>();
    for (const u of await this.reads.byIds(tenantId, userId, rows.map((r) => String(r.id)))) {
      unread.set(String(u.task_id), Number(u.n));
    }
    const page = Math.max(1, Math.trunc(Number(filters.page) || 1));
    return {
      // total из строки убираем: он одинаков во всех и относится к выборке, а не к задаче
      items: rows.map((r) => ({
        ...r, total: undefined, unread: unread.get(String(r.id)) ?? 0,
      })),
      total,
      page,
      pageSize: REGISTRY_PAGE_SIZE,
      pages: Math.max(1, Math.ceil(total / REGISTRY_PAGE_SIZE)),
    };
  }

  /** Исполнители, встречающиеся в задачах, — для выпадающего фильтра реестра. */
  registryAssignees(tenantId: string) {
    return this.repo.registryAssignees(tenantId);
  }

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
      // умолчание — «с согласованием»: явно снять его должен человек, а не забывчивость
      requiresApproval: dto.requiresApproval !== false,
    });
    // Чек-лист, если задачу собрали заранее — голосом или из встречи.
    if (dto.checklist?.length) await this.repo.addChecklist(tenantId, task.id, dto.checklist);

    // Соисполнители и наблюдатели — с первой минуты: дописывать их потом руками
    // значит забыть половину.
    for (const id of dto.coAssigneeIds ?? []) {
      if (String(id) !== String(task.assignee_id ?? '')) {
        await this.repo.addParticipant(tenantId, task.id, String(id), 'co_assignee', actorId);
        void this.notify.participantAdded(tenantId, task.id, actorId, String(id), 'co_assignee');
      }
    }
    for (const id of dto.watcherIds ?? []) {
      await this.repo.addParticipant(tenantId, task.id, String(id), 'watcher', actorId);
      void this.notify.participantAdded(tenantId, task.id, actorId, String(id), 'watcher');
    }

    this.realtime.emit(tenantId, task.project_id, 'task.created', task as any);
    /*
      Персональный сигнал «это для тебя».

      `task.created` уходит в комнату проекта, а в ней сидит только тот, у кого
      сейчас открыта эта доска. Человек, работающий в другом разделе или в другой
      вкладке браузера, о новой задаче узнавал лишь из письма или из счётчика
      через минуту. Этим событием мигает заголовок вкладки — как в YouGile.

      Себе не шлём: собственное действие новостью не является.
    */
    const forYou = [
      task.assignee_id,
      ...(dto.coAssigneeIds ?? []),
      ...(dto.watcherIds ?? []),
    ].map((x) => String(x ?? '')).filter((id) => id && id !== String(actorId));
    if (forYou.length) {
      this.realtime.emitToUsers(tenantId, [...new Set(forYou)], 'task.for_you', {
        taskId: String(task.id),
        projectId: String(task.project_id),
        title: task.title,
      });
    }
    await this.activity.log(tenantId, task.id, actorId, 'created', { title: task.title });
    this.knowledge.enqueue(tenantId, 'task', task.id); // в базу знаний (открытые проекты тоже)
    await this.outbox.enqueue(tenantId, task.project_id, 'task.create', task.id); // выгрузка во внешнюю систему
    void this.notify.taskCreated(tenantId, task.id, actorId); // письмо исполнителю; ответа не ждём
    return task;
  }

  /**
   * Расписание повтора задачи.
   *
   * Живёт при задаче-образце: правят его там же, где завели, а копии узнаются по
   * значку. Возвращаем и человеческую подпись — на клиенте она нужна ровно та же,
   * и считать её дважды значит однажды разойтись в словах.
   */
  async getRecurrence(tenantId: string, taskId: string) {
    const row = await this.recurrence.byTask(tenantId, taskId);
    if (!row) return null;
    const rule = ruleOf(row);
    return {
      ...rule,
      id: String(row.id),
      taskId: String(row.task_id),
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      active: row.active,
      description: describeRule(rule),
    };
  }

  async setRecurrence(tenantId: string, taskId: string, input: unknown, actorId: string | null) {
    const task = await this.repo.findById(tenantId, taskId);
    if (!task) throw AppException.notFound('Task not found');
    const rule = normalizeRule(input as never);
    // Отказ, а не молчаливая починка: повтор, который сработает не тогда, хуже
    // отсутствующего — о нём уже перестали думать.
    if (!rule) throw AppException.validation('Расписание повтора задано неверно');

    const row = await this.recurrence.upsert(tenantId, taskId, rule, nextRun(rule, new Date()), actorId);
    await this.activity.log(tenantId, taskId, actorId, 'recurrence_set', { rule: describeRule(rule) });
    this.realtime.emit(tenantId, String(task.project_id), 'task.updated', { ...task, recurrence_id: row.id } as never);
    return this.getRecurrence(tenantId, taskId);
  }

  async clearRecurrence(tenantId: string, taskId: string, actorId: string | null) {
    const existing = await this.recurrence.byTask(tenantId, taskId);
    if (!existing) return { cleared: false };
    await this.recurrence.remove(tenantId, taskId);
    await this.activity.log(tenantId, taskId, actorId, 'recurrence_cleared', {});
    return { cleared: true };
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
    actor?: { confirmTimeLoss?: boolean },
  ): Promise<{ deleted: true }> {
    const task = await this.repo.findById(tenantId, id);
    if (!task) throw AppException.notFound('Task not found');

    // Учтённое время больше не запрещает удаление никому: заказчик решил, что задачи
    // удаляют все сотрудники. Осталось предупреждение в два шага — оно не про права,
    // а про то, что задача исчезнет навсегда, тогда как часы останутся в себестоимости.
    const hours = await this.repo.loggedHours(tenantId, id);
    if (hours > 0) {
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

    /*
     * Перенос в Done закрывает задачу — но только если её некому принимать.
     *
     * «Сделал» и «принято» — разные события. Когда у задачи включено согласование,
     * а двигает её не постановщик, работа СДАЁТСЯ: карточка встаёт в «Готово», но
     * задача не закрывается и ждёт ответа. Иначе исполнитель закрывал бы задачу сам,
     * а постановщик узнавал об этом из отчётов — если вообще узнавал.
     */
    const needsApproval = isDoneColumn(column.name)
      && task.requires_approval
      && !!task.created_by
      && String(task.created_by) !== String(actorId ?? '');

    if (isDoneColumn(column.name) && !needsApproval) {
      await this.repo.closeTask(tenantId, id);
      if (task.approval_state === 'pending') await this.repo.clearApproval(tenantId, id);
      this.knowledge.enqueue(tenantId, 'task', id); // закрытая задача → в базу знаний
    } else if (needsApproval) {
      await this.repo.requestApproval(tenantId, id, actorId);
      await this.activity.log(tenantId, id, actorId, 'approval_requested', { to: column.name });
      void this.notify.approvalRequested(tenantId, id, actorId);
    } else if (task.closed_at) {
      await this.repo.reopenTask(tenantId, id);
      if (task.approval_state === 'pending') await this.repo.clearApproval(tenantId, id);
    }
    this.realtime.emit(tenantId, moved.project_id, 'task.moved', moved as any);
    const moveId = await this.activity.log(tenantId, id, actorId, 'moved', { to: column.name });
    // Обход гейта — не молчаливый: проверяющий должен видеть, чего в работе не хватало.
    if (missing.length) {
      await this.activity.log(tenantId, id, actorId, 'handoff_forced', {
        to: column.name, missing: missing.map((m) => m.text),
      });
    }
    await this.outbox.enqueue(tenantId, moved.project_id, 'task.move', id);
    // Смена статуса = перенос именно В ДРУГУЮ колонку: перетаскивание внутри одной
    // меняет порядок, а не статус, и уведомлять о нём не о чем.
    //
    // Номер записи в ленте идёт в ключ повтора: без него задача, возвращённая в работу
    // и закрытая снова, второго уведомления не давала — ключ «эта задача, эта колонка»
    // уже был занят первым закрытием, и человек о повторной сдаче не узнавал.
    if (String(task.column_id) !== String(dto.columnId)) {
      void this.notify.taskStatusChanged(tenantId, id, actorId, column.name, isDoneColumn(column.name), moveId);
    }
    return moved;
  }

  // ── соисполнители и наблюдатели ──

  listParticipants(tenantId: string, taskId: string) {
    return this.repo.participants(tenantId, taskId);
  }

  /**
   * Добавить человека к задаче.
   *
   * Соисполнитель делает работу вместе с исполнителем и видит задачу в «Моих».
   * Наблюдатель следит и получает уведомления, но исполнителем не считается: в отчётах
   * и загрузке он не участвует, иначе цифры по команде поехали бы.
   *
   * Уведомляем добавленного: узнать, что тебя записали в задачу, из ленты изменений —
   * не лучший способ, а для наблюдателя это вообще единственный сигнал.
   */
  async addParticipant(
    tenantId: string, taskId: string, actorId: string, userId: string, role: 'co_assignee' | 'watcher',
  ) {
    const task = await this.repo.findById(tenantId, taskId);
    if (!task) throw AppException.notFound('Task not found');
    if (String(task.assignee_id ?? '') === String(userId) && role === 'co_assignee') {
      throw AppException.validation('Этот человек и так исполнитель задачи');
    }

    const added = await this.repo.addParticipant(tenantId, taskId, userId, role, actorId);
    if (!added) return this.repo.participants(tenantId, taskId); // уже был — молча

    await this.activity.log(tenantId, taskId, actorId, 'participant_added', { userId, role });
    void this.notify.participantAdded(tenantId, taskId, actorId, userId, role);
    const updated = (await this.repo.findById(tenantId, taskId))!;
    this.realtime.emit(tenantId, updated.project_id, 'task.updated', updated as any);
    return this.repo.participants(tenantId, taskId);
  }

  async removeParticipant(
    tenantId: string, taskId: string, actorId: string, userId: string, role: 'co_assignee' | 'watcher',
  ) {
    const task = await this.repo.findById(tenantId, taskId);
    if (!task) throw AppException.notFound('Task not found');
    await this.repo.removeParticipant(tenantId, taskId, userId, role);
    await this.activity.log(tenantId, taskId, actorId, 'participant_removed', { userId, role });
    this.realtime.emit(tenantId, task.project_id, 'task.updated', task as any);
    return this.repo.participants(tenantId, taskId);
  }

  /**
   * Постановщик принял работу.
   *
   * Только он: подтвердить свою же сдачу исполнитель не должен — иначе согласование
   * превращается в лишний клик. Владельцу разрешаем как последней инстанции: он
   * отвечает за компанию, и заблокированная задача уволившегося постановщика не должна
   * висеть вечно.
   */
  async approve(tenantId: string, id: string, actor: { userId: string; role: string }): Promise<TaskRow> {
    const task = await this.gateApproval(tenantId, id, actor);
    const columns = await this.projects.listColumns(tenantId, task.project_id);
    const done = columns.find((c) => isDoneColumn(c.name));

    if (done && task.column_id !== done.id) {
      await this.repo.move(tenantId, id, done.id, 0, done.name);
    }
    await this.repo.closeTask(tenantId, id);
    await this.repo.clearApproval(tenantId, id);
    await this.activity.log(tenantId, id, actor.userId, 'approval_confirmed', {});
    this.knowledge.enqueue(tenantId, 'task', id);

    const updated = (await this.repo.findById(tenantId, id))!;
    this.realtime.emit(tenantId, updated.project_id, 'task.updated', updated as any);
    void this.notify.taskStatusChanged(
      tenantId, id, actor.userId, done?.name ?? 'Готово', true,
      await this.activity.log(tenantId, id, actor.userId, 'moved', { to: done?.name ?? 'Готово' }),
    );
    return updated;
  }

  /**
   * Постановщик вернул работу в дело.
   *
   * Причина обязательна не из вредности: «верните и переделайте» без объяснения —
   * самый частый способ поссорить команду, а исполнителю всё равно придётся идти
   * и спрашивать, что не так.
   */
  async returnForRework(
    tenantId: string, id: string, actor: { userId: string; role: string }, reason: string,
  ): Promise<TaskRow> {
    const task = await this.gateApproval(tenantId, id, actor);
    const note = String(reason ?? '').trim();
    if (!note) throw AppException.validation('Напишите, что доработать');

    const columns = await this.projects.listColumns(tenantId, task.project_id);
    // возвращаем в первую рабочую колонку — не в «Готово» и не в «Проверку»
    const back = columns.find((c) => !isDoneColumn(c.name)) ?? columns[0];
    if (back && task.column_id !== back.id) {
      await this.repo.move(tenantId, id, back.id, 0, back.name);
    }
    if (task.closed_at) await this.repo.reopenTask(tenantId, id);
    await this.repo.clearApproval(tenantId, id);
    // Причина живёт в истории задачи: там её видно рядом с самим возвратом,
    // а не отдельным комментарием, который потеряется в переписке.
    await this.activity.log(tenantId, id, actor.userId, 'approval_returned', { reason: note.slice(0, 300) });

    const updated = (await this.repo.findById(tenantId, id))!;
    this.realtime.emit(tenantId, updated.project_id, 'task.updated', updated as any);
    void this.notify.approvalReturned(tenantId, id, actor.userId, note);
    return updated;
  }

  /** Включить или снять согласование — право постановщика (и владельца). */
  async setApprovalRequired(
    tenantId: string, id: string, actor: { userId: string; role: string }, value: boolean,
  ): Promise<TaskRow> {
    const task = await this.repo.findById(tenantId, id);
    if (!task) throw AppException.notFound('Task not found');
    this.assertCanDecide(task, actor);
    await this.repo.setRequiresApproval(tenantId, id, value);
    // снятое согласование освобождает уже сданную работу: держать её в ожидании
    // после «согласование больше не нужно» было бы издевательством
    if (!value && task.approval_state === 'pending') await this.repo.clearApproval(tenantId, id);
    await this.activity.log(tenantId, id, actor.userId, 'approval_setting', { requiresApproval: value });
    const updated = (await this.repo.findById(tenantId, id))!;
    this.realtime.emit(tenantId, updated.project_id, 'task.updated', updated as any);
    return updated;
  }

  private async gateApproval(tenantId: string, id: string, actor: { userId: string; role: string }) {
    const task = await this.repo.findById(tenantId, id);
    if (!task) throw AppException.notFound('Task not found');
    if (task.approval_state !== 'pending') throw AppException.conflict('Эта задача не ждёт подтверждения');
    this.assertCanDecide(task, actor);
    return task;
  }

  private assertCanDecide(task: TaskRow, actor: { userId: string; role: string }): void {
    const isManager = task.created_by && String(task.created_by) === String(actor.userId);
    if (!isManager && actor.role !== 'owner') {
      throw AppException.forbidden('Решение принимает постановщик задачи');
    }
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
