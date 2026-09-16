import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { ForecastService } from '../forecast/forecast.service';
import { SecretaryService } from '../secretary/secretary.service';
import { AssistantRepository } from './assistant.repository';
import { AssigneeSuggestion, DeadlineSuggestion, pickAssignee, suggestDeadline } from './gap-rules';
import { GapsRepository } from './gaps.repository';

/** Столько строк за раз: разбор пустых полей должен занимать минуты, а не вечер. */
const BATCH = 8;

export interface GapRow {
  taskId: string;
  title: string;
  projectId: string;
  projectName: string;
  assignee?: AssigneeSuggestion;
  deadline?: DeadlineSuggestion;
}

/**
 * Латание дыр в данных.
 *
 * Секретарь не сообщает «у вас 45 задач без срока» — от такой новости ничего не
 * меняется. Он приносит готовые ответы: этой задаче предлагаю такого исполнителя,
 * потому что он вёл проект; этой — такой срок, потому что похожие закрываются за
 * четыре дня. Человеку остаётся согласиться, поправить или сказать «не этой».
 *
 * Назначение идёт тем же путём, что и руками, — через прогноз: он предупреждает
 * о перегрузе человека. Секретарь не должен уметь того, чего не может сотрудник.
 */
@Injectable()
export class GapsService {
  constructor(
    private readonly repo: GapsRepository,
    private readonly assistant: AssistantRepository,
    private readonly forecast: ForecastService,
    private readonly secretary: SecretaryService,
  ) {}

  /** Что предложить заполнить. Пусто — значит, всё на месте, и это тоже ответ. */
  async list(tenantId: string, now = new Date()): Promise<{
    noAssignee: GapRow[]; noDeadline: GapRow[]; counts: { noAssignee: number; noDeadline: number };
  }> {
    const [tasksNoAssignee, tasksNoDeadline, counts, work] = await Promise.all([
      this.repo.withoutAssignee(tenantId, BATCH),
      this.repo.withoutDeadline(tenantId, BATCH),
      this.repo.counts(tenantId),
      this.assistant.workHours(tenantId),
    ]);

    // Команду проекта спрашиваем один раз на проект: у задач одного проекта
    // кандидаты одни и те же, а лишние запросы здесь заметны на глаз.
    const teams = new Map<string, Awaited<ReturnType<GapsRepository['workers']>>>();
    const noAssignee: GapRow[] = [];
    for (const t of tasksNoAssignee) {
      if (!teams.has(t.project_id)) teams.set(t.project_id, await this.repo.workers(tenantId, t.project_id));
      const pick = pickAssignee(teams.get(t.project_id) ?? []);
      if (!pick) continue; // предлагать некого — молчим
      noAssignee.push({
        taskId: t.id, title: t.title, projectId: t.project_id, projectName: t.project_name, assignee: pick,
      });
    }

    const noDeadline = tasksNoDeadline.map((t) => ({
      taskId: t.id, title: t.title, projectId: t.project_id, projectName: t.project_name,
      deadline: suggestDeadline({
        estimateHours: t.estimate_hours ? Number(t.estimate_hours) : null,
        medianDays: t.median_days ? Number(t.median_days) : null,
        now,
        weekendDays: work.weekendDays,
      }),
    }));

    return { noAssignee, noDeadline, counts };
  }

  /**
   * Применить предложение.
   *
   * Значения приходят с клиента, а не берутся заново: человек мог поправить и
   * исполнителя, и дату — согласие с предложением и согласие с конкретным значением
   * это разные вещи.
   */
  async apply(
    tenantId: string, actorId: string, role: string,
    input: { taskId: string; assigneeId?: string; deadline?: string; confirmOverload?: boolean },
  ) {
    this.gate(role);
    if (!input.assigneeId && !input.deadline) throw AppException.validation('Нечего применять');

    // Назначаем тем же путём, что и руками, — через прогноз: он предупредит, если
    // человек и так перегружен. Секретарь не должен уметь то, чего не может человек.
    if (input.assigneeId) {
      const res: any = await this.forecast.assign(
        tenantId, String(input.taskId), String(input.assigneeId), actorId, input.confirmOverload === true,
      );
      if (res?.warning) return { applied: false, ...res }; // ждём подтверждения перегруза
    }
    if (input.deadline) {
      const deadlineAt = `${input.deadline}T18:00:00`; // день без времени — конец рабочего дня
      await this.forecast.setEstimateDeadline(tenantId, String(input.taskId), { deadline: deadlineAt });
    }

    void this.secretary.record({
      tenantId, userId: actorId, kind: 'gap_fix',
      summary: input.assigneeId && input.deadline ? 'Заполнены исполнитель и срок'
        : input.assigneeId ? 'Назначен исполнитель по предложению секретаря'
          : 'Поставлен срок по предложению секретаря',
      subjectType: 'task', subjectId: String(input.taskId),
    });
    return { applied: true };
  }

  /** «Не этой»: часть задач пуста намеренно, и спрашивать о них второй раз нельзя. */
  async skip(tenantId: string, actorId: string, role: string, taskId: string, kind: 'assignee' | 'deadline') {
    this.gate(role);
    await this.repo.skip(tenantId, taskId, kind, actorId);
    return { skipped: true };
  }

  /** Раздавать работу и назначать сроки — дело руководителя, а не любого сотрудника. */
  private gate(role: string): void {
    if (role !== 'owner' && role !== 'manager') {
      throw AppException.forbidden('Заполнять эти поля может руководитель');
    }
  }
}
