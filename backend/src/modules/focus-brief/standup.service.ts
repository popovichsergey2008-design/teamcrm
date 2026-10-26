import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { localParts } from '../assistant/ping-rules';
import { zonedTime } from '../focus/close-day';
import type { Actor } from '../proactive/proactive.service';
import { ProactiveRepository, ProposalRow } from '../proactive/proactive.repository';
import type { StandupDraft } from '../secretary-skills/morning-rules';
import { TasksService } from '../tasks/tasks.service';

/**
 * Черновики утренней планерки (#1525, фича 6). Лежат в карточке утреннего брифа
 * руководителя в ящике секретаря; каждый — задача ему «в 1 клик». Карточка одна на
 * день (отпечаток брифа), поэтому повторный тик второй набор черновиков не создаёт;
 * повторное нажатие на уже поставленный черновик возвращает ту же задачу.
 */
@Injectable()
export class StandupService {
  constructor(
    private readonly tasks: TasksService,
    private readonly proposals: ProactiveRepository,
  ) {}

  async execute(a: Actor, p: ProposalRow, params: Record<string, unknown>) {
    if (a.role !== 'owner' && a.role !== 'manager') throw AppException.forbidden('Черновики планерки — для руководителя');
    const drafts = ((p.payload?.drafts as StandupDraft[] | undefined) ?? []).map((d) => ({ ...d }));
    const d = drafts.find((x) => x.ref === String(params.ref ?? ''));
    if (!d) throw AppException.validation('Такого черновика нет');
    const left = () => drafts.some((x) => !x.taskId);
    if (d.taskId) return { text: `Задача #${d.taskId} уже поставлена`, link: `/projects/${d.projectId}/task/${d.taskId}`, keepOpen: true };
    await this.tasks.assertProject(a.tenantId, d.projectId, { userId: a.userId, role: a.role });
    const tz = await this.proposals.timezoneOf(a.tenantId, a.userId);
    const evening = zonedTime(localParts(new Date(), tz).date, '18:00', tz);
    const task = await this.tasks.create(a.tenantId, {
      projectId: d.projectId,
      title: d.title,
      description: `${d.description}${d.link ? `\n\nИсточник: ${d.link}` : ''}`,
      assigneeId: a.userId,
      deadlineAt: evening.getTime() > Date.now() ? evening.toISOString() : undefined,
    } as any, a.userId, { workloadChecked: true, aiConfirm: { userId: a.userId, source: 'standup' } });
    d.taskId = String(task.id);
    await this.proposals.setPayload(String(p.id), { ...p.payload, drafts });
    return { text: `Задача #${task.id} поставлена: «${d.title}»`, link: `/projects/${task.project_id}/task/${task.id}`, keepOpen: left() };
  }
}
