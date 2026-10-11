import { Injectable, OnModuleInit } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { Actor, ProactiveService } from '../proactive/proactive.service';
import type { ProposalRow } from '../proactive/proactive.repository';
import { SecurityService } from '../security/security.service';
import { TasksService } from '../tasks/tasks.service';

/** Кнопки карточки «риск перегруза»: перенести срок, передать, оставить (§30). */
@Injectable()
export class WorkloadActionsService implements OnModuleInit {
  constructor(
    private readonly proactive: ProactiveService,
    private readonly tasks: TasksService,
    private readonly security: SecurityService,
  ) {}

  onModuleInit(): void {
    this.proactive.register({ skill: 'workload', execute: (a, p, action) => this.execute(a, p, action) });
  }

  private async execute(a: Actor, p: ProposalRow, action: string) {
    const taskId = String(p.payload.taskId);
    if (action === 'move_deadline') {
      const to = p.payload.alternativeDeadline ? new Date(String(p.payload.alternativeDeadline)) : null;
      if (!to) throw AppException.validation('Нет предложенного срока');
      await this.tasks.setDeadlineByDecision(a.tenantId, taskId, { userId: a.userId, role: a.role }, to);
      return { text: `Срок перенесён на ${to.toLocaleDateString('ru-RU')}` };
    }
    if (action === 'reassign') {
      const to = p.payload.alternativeAssignee ? String(p.payload.alternativeAssignee) : null;
      if (!to) throw AppException.validation('Некому передать');
      const t = await this.tasks.update(a.tenantId, taskId, { assigneeId: to } as any, a.userId);
      return { text: 'Задача передана', link: `/projects/${t.project_id}/task/${t.id}` };
    }
    if (action === 'keep') {
      void this.security.record({
        tenantId: a.tenantId, actorId: a.userId, event: 'workload.override', resourceType: 'task', resourceId: taskId,
        metadata: { before: p.payload.before ?? null, after: p.payload.after ?? null, from: 'proposal' },
      }).catch(() => undefined);
      return { text: 'Оставлено как есть' };
    }
    throw AppException.validation('Такого действия нет');
  }
}
