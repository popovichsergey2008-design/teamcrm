import { Injectable } from '@nestjs/common';
import { meetingVisibleSql, projectVisibleSql, ProjectViewer, viewerParams } from '../../common/access/project-visibility';
import { DbService } from '../../database/db.service';
import { stageSql } from '../tasks/responsibility';

export interface LinkTaskRow {
  id: string;
  project_id: string;
  title: string;
  assignee_id: string | null;
  assignee_name: string | null;
  deadline_at: Date | null;
  closed_at: Date | null;
  created_by: string | null;
  reviewer_id: string | null;
  column_name: string | null;
  stage: string;
  comments: number;
}

export interface LinkMeetingRow {
  id: string;
  title: string;
  at: Date;
  duration_sec: number | null;
  status: string;
  decisions: number;
  tasks: number;
}

/**
 * Данные для карточек ссылок — пачкой: в ленте десятки сообщений, и запрос на каждую
 * ссылку по отдельности положил бы чат при открытии.
 *
 * Видимость — тем же правилом, что у «было/стало» и поиска: проект виден по общему
 * правилу ИЛИ человек сам в задаче. Чужое просто не попадает в выборку — сервис
 * отвечает «скрыто», и название закрытой задачи не уходит в чат.
 */
@Injectable()
export class LinkCardsRepository {
  constructor(private readonly db: DbService) {}

  tasks(tenantId: string, ids: string[], viewer: ProjectViewer): Promise<LinkTaskRow[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.db.many<LinkTaskRow>(
      `SELECT t.id::text, t.project_id::text, t.title, t.assignee_id::text, ua.full_name AS assignee_name,
              t.deadline_at, t.closed_at, t.created_by::text, t.reviewer_id::text,
              bc.name AS column_name, ${stageSql('t')} AS stage,
              -- комментарии людей: служебные «срок сдвинут» в счёт обсуждения не идут
              (SELECT COUNT(*)::int FROM task_comments c
                WHERE c.tenant_id = t.tenant_id AND c.task_id = t.id AND NOT c.is_system) AS comments
         FROM tasks t
    LEFT JOIN users ua ON ua.id = t.assignee_id
    LEFT JOIN board_columns bc ON bc.id = t.column_id
        WHERE t.tenant_id = $1 AND t.id = ANY($2::bigint[]) AND t.deleted_at IS NULL
          AND (${projectVisibleSql('t.project_id', { user: '$3', all: '$4', client: '$5' })}
               OR t.assignee_id = $3::bigint OR t.created_by = $3::bigint
               OR EXISTS (SELECT 1 FROM task_participants tp WHERE tp.task_id = t.id AND tp.user_id = $3::bigint))`,
      [tenantId, ids, ...viewerParams(viewer)],
    );
  }

  meetings(tenantId: string, ids: string[], viewer: ProjectViewer): Promise<LinkMeetingRow[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.db.many<LinkMeetingRow>(
      `SELECT m.id::text, m.title, COALESCE(m.happened_at, m.created_at) AS at, m.duration_sec, m.status,
              COALESCE((SELECT CASE WHEN jsonb_typeof(ms.decisions) = 'array' THEN jsonb_array_length(ms.decisions) END
                          FROM meeting_summaries ms WHERE ms.meeting_id = m.id), 0)::int AS decisions,
              -- задачи, которые из встречи действительно поставили, а не черновики
              (SELECT COUNT(*)::int FROM meeting_task_drafts d
                WHERE d.meeting_id = m.id AND d.task_id IS NOT NULL) AS tasks
         FROM meetings m
        WHERE m.tenant_id = $1 AND m.id = ANY($2::bigint[])
          AND ${meetingVisibleSql('m', { user: '$3', all: '$4', client: '$5' })}`,
      [tenantId, ids, ...viewerParams(viewer)],
    );
  }
}
