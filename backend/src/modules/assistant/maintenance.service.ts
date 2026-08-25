import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { MeetingsRepository } from '../meetings/meetings.repository';
import { ProjectsRepository } from '../projects/projects.repository';
import { SecretaryService } from '../secretary/secretary.service';
import { pickDoneColumn } from '../tasks/task-columns';
import { TasksRepository } from '../tasks/tasks.repository';
import { TasksService } from '../tasks/tasks.service';
import {
  Candidate, DEFAULT_THRESHOLDS, dedupKey, limitCandidates, proposalText, Thresholds, undoOf,
} from './maintenance-rules';
import { MaintenanceRepository, ProposalRow } from './maintenance.repository';

/**
 * Zero-Maintenance: уборка брошенного.
 *
 * Единственное место ассистента, где даже автопилот не даёт права действовать.
 * Система собирает предложения, а закрывает, архивирует и отклоняет — человек.
 * Причина простая: напоминание можно проигнорировать, а закрытую без спроса задачу
 * человек может не заметить вовсе — и узнать об этом от заказчика.
 *
 * Второе правило: всё сделанное обратимо, и кнопка отката стоит рядом с записью
 * о выполненном, а не в глубине настроек.
 */
@Injectable()
export class MaintenanceService {
  private readonly log = new Logger('Maintenance');

  constructor(
    private readonly repo: MaintenanceRepository,
    private readonly tasks: TasksService,
    private readonly tasksRepo: TasksRepository,
    private readonly projects: ProjectsRepository,
    private readonly meetings: MeetingsRepository,
    private readonly secretary: SecretaryService,
  ) {}

  // ---------- чтение и настройка ----------

  list(tenantId: string) {
    return this.repo.list(tenantId).then((rows) => rows.map(view));
  }

  enabled(tenantId: string) {
    return this.repo.enabled(tenantId).then((maintenance) => ({ maintenance }));
  }

  async setEnabled(tenantId: string, role: string, enabled: boolean) {
    if (role !== 'owner') throw AppException.forbidden('Уборку включает владелец');
    return { maintenance: await this.repo.setEnabled(tenantId, enabled) };
  }

  // ---------- сбор предложений ----------

  /** Один проход по организации. Пороги параметром — тесты задают свои. */
  async runTenant(tenantId: string, thresholds: Thresholds = DEFAULT_THRESHOLDS): Promise<number> {
    const [tasks, projects, drafts] = await Promise.all([
      this.repo.staleTasks(tenantId, thresholds.taskDays),
      this.repo.idleProjects(tenantId, thresholds.projectDays),
      this.repo.staleDrafts(tenantId, thresholds.draftDays),
    ]);

    let created = 0;
    for (const c of limitCandidates([...tasks, ...projects, ...drafts])) {
      const candidate: Candidate = { ...c, days: Number(c.days) };
      const undo = await this.stateFor(tenantId, candidate);
      if (!undo) continue; // вернуть будет некуда — не предлагаем вовсе
      const row = await this.repo.create({
        tenantId,
        kind: candidate.kind,
        subjectType: candidate.kind === 'task_stale' ? 'task' : candidate.kind === 'project_idle' ? 'project' : 'draft',
        subjectId: candidate.subjectId,
        title: candidate.title,
        text: proposalText(candidate),
        undo,
        dedupKey: dedupKey(candidate),
      });
      if (row) created++;
    }
    return created;
  }

  /** Прежнее состояние объекта — оно же путь назад. */
  private async stateFor(tenantId: string, c: Candidate): Promise<Record<string, unknown> | null> {
    if (c.kind === 'task_stale') {
      const t = await this.tasksRepo.findById(tenantId, c.subjectId);
      if (!t) return null;
      return undoOf(c, { columnId: String(t.column_id), position: Number(t.position), projectId: String(t.project_id) });
    }
    if (c.kind === 'project_idle') return undoOf(c, { status: 'active' });
    return undoOf(c, { status: 'pending' });
  }

  // ---------- решения человека ----------

  /**
   * Выполнить предложенное.
   *
   * Задачу закрываем переносом в «Готово», если такая колонка есть: тогда сработают
   * все обычные пути — доска, уведомления, база знаний. Колонки нет — закрываем
   * напрямую, но помним, где задача стояла.
   */
  async apply(tenantId: string, user: { userId: string; role: string }, id: string) {
    const p = await this.gate(tenantId, user, id);
    if (p.status !== 'pending') throw AppException.conflict('Это предложение уже обработано');

    if (p.kind === 'task_stale') {
      const columns = await this.projects.listColumns(tenantId, String(p.undo.projectId));
      const done = pickDoneColumn(columns as { id: string; name: string }[]);
      if (done) await this.tasks.move(tenantId, p.subject_id, { columnId: done.id, position: 0, confirmGate: true }, user.userId);
      else await this.tasksRepo.closeTask(tenantId, p.subject_id);
    } else if (p.kind === 'project_idle') {
      await this.projects.setArchived(tenantId, p.subject_id, true);
    } else {
      await this.meetings.markDraftRejected(p.subject_id);
    }

    await this.repo.setStatus(tenantId, id, 'applied', user.userId);
    void this.secretary.record({
      tenantId, userId: user.userId, kind: 'maintenance',
      summary: `Убрано: ${p.title}`,
      subjectType: p.subject_type === 'draft' ? null : (p.subject_type as 'task' | 'project'),
      subjectId: p.subject_type === 'draft' ? null : p.subject_id,
    });
    return { applied: true };
  }

  /** «Не надо»: больше об этом объекте не спрашиваем — ключ повтора остаётся занятым. */
  async dismiss(tenantId: string, user: { userId: string; role: string }, id: string) {
    const p = await this.gate(tenantId, user, id);
    if (p.status !== 'pending') throw AppException.conflict('Это предложение уже обработано');
    await this.repo.setStatus(tenantId, id, 'dismissed', user.userId);
    return { dismissed: true };
  }

  /** Вернуть как было. Ради этой кнопки всё и затевалось. */
  async undo(tenantId: string, user: { userId: string; role: string }, id: string) {
    const p = await this.gate(tenantId, user, id);
    if (p.status !== 'applied') throw AppException.conflict('Возвращать нечего');

    if (p.kind === 'task_stale') {
      const columnId = String(p.undo.columnId ?? '');
      const position = Number(p.undo.position ?? 0);
      if (columnId) {
        await this.tasks.move(tenantId, p.subject_id, { columnId, position, confirmGate: true }, user.userId);
      }
      // перенос из «Готово» переоткрывает задачу сам; если колонки не было — открываем руками
      await this.tasksRepo.reopenTask(tenantId, p.subject_id);
    } else if (p.kind === 'project_idle') {
      await this.projects.setArchived(tenantId, p.subject_id, false);
    } else {
      await this.meetings.restoreDraft(p.subject_id);
    }

    await this.repo.setStatus(tenantId, id, 'reverted', user.userId);
    return { reverted: true };
  }

  /**
   * Уборка — управленческое действие: доску чистит тот, кто за неё отвечает.
   * Рядовому сотруднику это не запрет из недоверия, а снятие ответственности:
   * закрыть чужую забытую задачу — решение не его уровня.
   */
  private async gate(tenantId: string, user: { userId: string; role: string }, id: string): Promise<ProposalRow> {
    if (user.role !== 'owner' && user.role !== 'manager') {
      throw AppException.forbidden('Уборкой доски занимается владелец или руководитель');
    }
    const p = await this.repo.byId(tenantId, id);
    if (!p) throw AppException.notFound('Предложение не найдено');
    return p;
  }
}

function view(r: ProposalRow) {
  return {
    id: r.id,
    kind: r.kind,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    title: r.title,
    text: r.text,
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by_name,
  };
}
