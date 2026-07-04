import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { BoardService } from '../board/board.service';
import { InvitesService } from '../team/invites.service';
import { PortalRepository } from './portal.repository';

/**
 * Клиентский портал «маржа-сейф» (фича №9). Единый безопасный путь отдачи данных роли client.
 * Сериализатор — WHITELIST полей: физически не может вернуть финансы/внутренние метрики.
 */
@Injectable()
export class PortalService {
  constructor(
    private readonly repo: PortalRepository,
    private readonly board: BoardService,
    private readonly invites: InvitesService,
  ) {}

  // ── управление (owner/manager) ──
  createClient(tenantId: string, name: string, contact?: string) {
    if (!name?.trim()) throw AppException.validation('Укажите название клиента');
    return this.repo.createClient(tenantId, name.trim(), contact?.trim() || null);
  }

  listClients(tenantId: string) {
    return this.repo.listClients(tenantId);
  }

  async inviteClientUser(tenantId: string, invitedBy: string, clientId: string, email: string) {
    if (!(await this.repo.clientExists(tenantId, clientId))) throw AppException.notFound('Клиент не найден');
    if (!email?.trim()) throw AppException.validation('Укажите e-mail');
    return this.invites.create(tenantId, invitedBy, { email: email.trim(), role: 'client', clientId });
  }

  async assignProject(tenantId: string, projectId: string, clientId: string | null) {
    if (clientId && !(await this.repo.clientExists(tenantId, clientId))) throw AppException.notFound('Клиент не найден');
    if (!(await this.repo.assignProjectClient(tenantId, projectId, clientId))) throw AppException.notFound('Проект не найден');
    return { assigned: true };
  }

  // ── портал (role client) ──
  private async myClientId(tenantId: string, userId: string): Promise<string> {
    const clientId = await this.repo.clientIdOfUser(tenantId, userId);
    if (!clientId) throw AppException.forbidden('Аккаунт клиента не привязан к заказчику');
    return clientId;
  }

  async myProjects(tenantId: string, userId: string) {
    const clientId = await this.myClientId(tenantId, userId);
    return this.repo.clientProjects(tenantId, clientId);
  }

  async myBoard(tenantId: string, userId: string, projectId: string) {
    const clientId = await this.myClientId(tenantId, userId);
    if (!(await this.repo.projectBelongsToClient(tenantId, projectId, clientId))) throw AppException.notFound('Проект не найден');
    // board.getBoard с ролью client уже стрипует финансы; поверх — жёсткий whitelist
    const board = await this.board.getBoard(tenantId, projectId, 'client');
    return this.clientView(board);
  }

  /** Жёсткий whitelist: только нефинансовые поля. Никаких cost/budget/risk_pct/ставок/оценок/исполнителей. */
  private clientView(board: any) {
    return {
      project: { id: board.project.id, name: board.project.name, status: board.project.status },
      columns: (board.columns ?? []).map((c: any) => ({
        id: c.id,
        name: c.name,
        position: c.position,
        tasks: (c.tasks ?? []).map((t: any) => ({
          id: t.id,
          title: t.title,
          column_id: t.column_id,
          position: t.position,
          status: t.status,
          is_blocked: t.is_blocked,
          risk_level: t.risk_level ?? null,            // светофор без risk_pct (Этап 4)
          predicted_finish_at: t.predicted_finish_at ?? null,
          deadline_at: t.deadline_at ?? null,
          labels: t.labels ?? [],
          commentsCount: t.commentsCount ?? 0,
          checklistTotal: t.checklistTotal ?? 0,
          checklistDone: t.checklistDone ?? 0,
        })),
      })),
    };
  }
}
