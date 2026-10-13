import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { ProjectViewer, projectVisibleSql, viewerParams } from '../../common/access/project-visibility';
import { Resolution, ResolverInput, ResolverProject, resolveProject } from './project-resolver';

export interface ResolveRequest {
  text: string;
  sourceProjectId?: string | null;
  chatProjectId?: string | null;
  meetingProjectId?: string | null;
  routeProjectId?: string | null;
  clientId?: string | null;
  /** Участники разговора: автор, собеседник, упомянутые. */
  peopleIds?: (string | null | undefined)[];
  model?: ResolverInput['model'];
}

export type ResolutionSource = 'chat_draft' | 'voice' | 'nl' | 'meeting' | 'chat_analysis' | 'bot' | 'commitment';

/**
 * Определитель проекта с данными (ТЗ-31): собирает из базы то, что правилам нужно, —
 * ТОЛЬКО живые и видимые человеку проекты (права до догадок, §23), их другие названия
 * и клиентов, где работают участники разговора, недавние задачи человека.
 */
@Injectable()
export class ProjectResolverService {
  private readonly log = new Logger('ProjectResolver');

  constructor(private readonly db: DbService) {}

  /** Проекты, из которых вообще можно выбирать: не архив, не демо, видны человеку. */
  async candidates(tenantId: string, viewer: ProjectViewer): Promise<ResolverProject[]> {
    const rows = await this.db.many<{ id: string; name: string; aliases: string[] | null; client_id: string | null; client_name: string | null }>(
      `SELECT p.id::text, p.name, p.aliases, p.client_id::text, c.name AS client_name
         FROM projects p
    LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.tenant_id = $1 AND p.status <> 'archived' AND NOT p.is_demo
          AND ${projectVisibleSql('p.id', { user: '$2', all: '$3', client: '$4' })}
        ORDER BY p.name`,
      [tenantId, ...viewerParams(viewer)],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, aliases: r.aliases ?? [], clientId: r.client_id, clientName: r.client_name }));
  }

  async resolve(tenantId: string, viewer: ProjectViewer, req: ResolveRequest): Promise<Resolution & { projects: ResolverProject[] }> {
    const projects = await this.candidates(tenantId, viewer);
    const people = [...new Set((req.peopleIds ?? []).filter(Boolean).map(String))];
    const [memberships, recent] = await Promise.all([
      people.length ? this.memberships(tenantId, people) : Promise.resolve([]),
      this.recent(tenantId, viewer.userId),
    ]);
    const r = resolveProject({
      text: req.text ?? '',
      projects,
      sourceProjectId: req.sourceProjectId ?? null,
      chatProjectId: req.chatProjectId ?? null,
      meetingProjectId: req.meetingProjectId ?? null,
      routeProjectId: req.routeProjectId ?? null,
      clientId: req.clientId ?? null,
      people: people.length >= 2 ? memberships : undefined,
      recent,
      model: req.model ?? null,
    });
    return { ...r, projects };
  }

  /**
   * Где работает человек: участник или ответственный проекта, либо ставил/делал там
   * задачи за последний месяц (участников у открытых проектов часто не заводят).
   */
  private async memberships(tenantId: string, userIds: string[]) {
    const rows = await this.db.many<{ user_id: string; project_id: string }>(
      `SELECT DISTINCT x.user_id::text, x.project_id::text FROM (
         SELECT pm.user_id, pm.project_id FROM project_members pm
           JOIN projects p ON p.id = pm.project_id AND p.tenant_id = $1
          WHERE pm.user_id = ANY($2::bigint[])
         UNION
         SELECT p.owner_user_id, p.id FROM projects p WHERE p.tenant_id = $1 AND p.owner_user_id = ANY($2::bigint[])
         UNION
         SELECT u.uid, t.project_id FROM tasks t
           CROSS JOIN LATERAL (VALUES (t.assignee_id), (t.created_by)) AS u(uid)
          WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND t.updated_at > now() - interval '30 days'
            AND u.uid = ANY($2::bigint[])
       ) x`,
      [tenantId, userIds],
    );
    return userIds.map((id) => ({ userId: id, projectIds: rows.filter((r) => r.user_id === id).map((r) => r.project_id) }));
  }

  /** Недавние задачи человека по проектам — слабый сигнал. */
  private async recent(tenantId: string, userId: string): Promise<Record<string, number>> {
    const rows = await this.db.many<{ project_id: string; n: number }>(
      `SELECT project_id::text, count(*)::int AS n FROM tasks
        WHERE tenant_id = $1 AND deleted_at IS NULL AND updated_at > now() - interval '14 days'
          AND (created_by = $2::bigint OR assignee_id = $2::bigint)
        GROUP BY project_id`,
      [tenantId, userId],
    ).catch(() => []);
    return Object.fromEntries(rows.map((r) => [r.project_id, r.n]));
  }

  /**
   * Исправление выбора (§25): предложили один проект — выбрали другой, или оставили.
   * Пишем всегда, когда было предложение; без предложения — «выбрал сам».
   */
  async feedback(tenantId: string, userId: string, source: ResolutionSource, p: {
    predictedProjectId: string | null; selectedProjectId: string | null; confidence?: number | null;
    resolution?: string | null; reasonCodes?: string[]; taskId?: string | null;
  }): Promise<void> {
    const outcome = !p.predictedProjectId ? 'chosen' : String(p.predictedProjectId) === String(p.selectedProjectId) ? 'accepted' : 'changed';
    await this.db.query(
      `INSERT INTO project_resolution_feedback
         (tenant_id, user_id, source_type, predicted_project_id, selected_project_id, confidence, resolution, reason_codes, outcome, task_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10)`,
      [tenantId, userId, source, p.predictedProjectId, p.selectedProjectId, p.confidence ?? null, p.resolution ?? null,
        p.reasonCodes ?? [], outcome, p.taskId ?? null],
    ).catch((e) => this.log.warn(`отзыв о проекте: ${(e as Error).message}`));
  }
}
