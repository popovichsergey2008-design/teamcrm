import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { ApprovalsRepository } from './approvals.repository';
import { RealtimeService } from '../realtime/realtime.service';

export const APPROVAL_KINDS = ['budget', 'invoice', 'vacation', 'question', 'other'] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly repo: ApprovalsRepository,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Попросить решение.
   *
   * Адресат обязателен и ровно один: «согласуйте кто-нибудь» не согласует никто.
   * Самому себе вопрос не задают — это была бы просто заметка, для них есть задачи.
   */
  async create(tenantId: string, authorId: string, input: {
    approverId: string; kind?: string; subject: string; details?: string; taskId?: string; dueAt?: string;
  }) {
    if (String(input.approverId) === String(authorId)) {
      throw AppException.validation('Согласование просят у другого человека, а не у себя');
    }
    const kind = APPROVAL_KINDS.includes((input.kind ?? '') as ApprovalKind) ? input.kind! : 'question';

    const row = await this.repo.create({
      tenantId,
      authorId,
      approverId: String(input.approverId),
      kind,
      subject: input.subject.trim().slice(0, 200),
      details: input.details?.trim().slice(0, 2000) || null,
      taskId: input.taskId ? String(input.taskId) : null,
      dueAt: input.dueAt ?? null,
    });

    // Человека, у которого спросили, нужно уведомить сразу: вопрос, о котором не знают,
    // ничем не лучше вопроса, заданного в переписке.
    this.realtime.emitToUsers(tenantId, [String(input.approverId)], 'approval.created', {
      id: row!.id, subject: row!.subject, kind,
    });
    return row;
  }

  inbox(tenantId: string, userId: string) {
    return this.repo.inbox(tenantId, userId);
  }

  sent(tenantId: string, userId: string, includeDecided: boolean) {
    return this.repo.sent(tenantId, userId, includeDecided);
  }

  /**
   * Решение по согласованию.
   *
   * Отказ обязан нести причину. «Нет» без объяснения возвращается новым вопросом через
   * час — это не бюрократия, а экономия следующего круга переписки.
   */
  async decide(tenantId: string, userId: string, id: string, approve: boolean, note?: string) {
    const row = await this.repo.byId(tenantId, id);
    if (!row) throw AppException.notFound('Согласование не найдено');
    if (String(row.approver_id) !== String(userId)) {
      throw AppException.forbidden('Решение принимает тот, у кого спросили');
    }
    if (row.status !== 'pending') throw AppException.conflict('Решение уже принято');
    const comment = note?.trim().slice(0, 500) || null;
    if (!approve && !comment) throw AppException.validation('Объясните отказ — без причины он вернётся новым вопросом');

    const updated = await this.repo.decide(tenantId, id, approve ? 'approved' : 'rejected', comment);
    if (!updated) throw AppException.conflict('Решение уже принято');

    this.realtime.emitToUsers(tenantId, [String(row.author_id)], 'approval.decided', {
      id, approved: approve, note: comment,
    });
    // В журнал «AI Секретаря» это НЕ пишем: там только то, что система сделала сама.
    // Решение принял человек, и записывать его себе в заслуги нечестно — счётчик
    // сэкономленного времени сразу перестал бы что-либо значить.
    return updated;
  }

  /** Отозвать свой вопрос: обстоятельства изменились, решение больше не нужно. */
  async cancel(tenantId: string, userId: string, id: string) {
    const row = await this.repo.byId(tenantId, id);
    if (!row) throw AppException.notFound('Согласование не найдено');
    if (String(row.author_id) !== String(userId)) {
      throw AppException.forbidden('Отозвать вопрос может только тот, кто его задал');
    }
    if (row.status !== 'pending') throw AppException.conflict('Решение уже принято');
    return this.repo.decide(tenantId, id, 'cancelled', null);
  }
}
