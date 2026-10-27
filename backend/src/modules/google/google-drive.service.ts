import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { projectVisibleSql, viewerParams } from '../../common/access/project-visibility';
import { DbService } from '../../database/db.service';
import { GoogleApiError, googleJson } from './google-api';
import { GoogleAuthService } from './google-auth.service';
import {
  buildDocRequests, clientDoc, DocBlock, DocKind, docName, meetingDoc, projectDoc, taskDoc,
} from './google-docs.content';

export type EntityType = 'task' | 'project' | 'client' | 'event';
export interface Viewer { tenantId: string; userId: string; role: string }

const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const DOCS = 'https://docs.googleapis.com/v1/documents';
const FILE_FIELDS = 'id,name,mimeType,webViewLink,iconLink,modifiedTime,owners(displayName),trashed';

interface LinkRow {
  id: string; entity_type: EntityType; entity_id: string; google_file_id: string; file_name: string;
  mime_type: string; web_view_link: string; icon_link: string | null; owner_name: string | null;
  modified_time: Date | null; origin: string; created_by: string; created_by_name: string | null; created_at: Date;
}

/** Какой документ уместен у какой сущности (§54). */
const DOC_FOR: Record<EntityType, DocKind> = {
  task: 'task_spec', project: 'project_brief', client: 'client_followup', event: 'meeting_protocol',
};

/**
 * Файлы Google Диска при задачах, проектах, клиентах и встречах (#1565, §37–49) и
 * документы Google, которые QEVO создаёт с данными из CRM (§54–60).
 *
 * Файл живёт в Google, у нас — только ссылка с названием и датой. Права Google мы не
 * меняем (§49): прикрепили файл к задаче — это не значит, что его расшарили всем её
 * участникам; у кого доступа нет, тот увидит это в самом Google.
 */
@Injectable()
export class GoogleDriveService {
  private readonly log = new Logger('GoogleDrive');

  constructor(
    private readonly db: DbService,
    private readonly auth: GoogleAuthService,
  ) {}

  async list(v: Viewer, type: EntityType, id: string) {
    await this.assertCanSee(v, type, id);
    const rows = await this.db.many<LinkRow>(
      `SELECT l.*, u.full_name AS created_by_name FROM google_drive_links l
         LEFT JOIN users u ON u.id = l.created_by
        WHERE l.tenant_id=$1 AND l.entity_type=$2 AND l.entity_id=$3
        ORDER BY l.created_at DESC`,
      [v.tenantId, type, id],
    );
    return rows.map((r) => this.view(r, v));
  }

  /**
   * Прикрепить выбранные в окне Google файлы. Окну на слово не верим (§41): каждый файл
   * спрашиваем у Google токеном самого человека — так видно, что файл есть и доступ к нему есть.
   */
  async link(v: Viewer, type: EntityType, id: string, fileIds: string[]) {
    await this.assertCanSee(v, type, id);
    const ids = [...new Set(fileIds.map((s) => String(s).trim()).filter((s) => /^[\w-]{10,128}$/.test(s)))].slice(0, 20);
    if (!ids.length) throw AppException.validation('Не выбрано ни одного файла');
    const { token } = await this.auth.tokenFor(v.tenantId, v.userId, 'drive');
    const failed: string[] = [];
    for (const fileId of ids) {
      try {
        const f = await googleJson<any>(`${DRIVE}/${encodeURIComponent(fileId)}`, token, {
          query: { fields: FILE_FIELDS, supportsAllDrives: true },
        });
        if (f.trashed) { failed.push(f.name ?? fileId); continue; }
        await this.save(v, type, id, f, 'picked');
      } catch (e) {
        failed.push(fileId);
        this.log.warn(`файл не прикреплён: ${(e as Error).message}`);
      }
    }
    return { items: await this.list(v, type, id), failed };
  }

  /** Отвязать (§44): удаляем связь, сам файл в Google остаётся. */
  async unlink(v: Viewer, linkId: string) {
    const row = await this.db.one<LinkRow>(`SELECT * FROM google_drive_links WHERE tenant_id=$1 AND id=$2`, [v.tenantId, linkId]);
    if (!row) throw AppException.notFound('Файл не найден');
    await this.assertCanSee(v, row.entity_type, row.entity_id);
    if (!this.canUnlink(row, v)) throw AppException.forbidden('Убрать файл может тот, кто его прикрепил, или руководитель');
    await this.db.query(`DELETE FROM google_drive_links WHERE id=$1`, [linkId]);
    return { removed: true };
  }

  /**
   * Создать Google-документ при сущности: пустой файл в Диске человека, затем текст
   * одной правкой (§55). Документ сразу прикреплён — его не нужно искать и прикладывать.
   */
  async createDoc(v: Viewer, type: EntityType, id: string, blank = false) {
    await this.assertCanSee(v, type, id);
    const { token } = await this.auth.tokenFor(v.tenantId, v.userId, 'drive');
    const tz = await this.timezone(v.tenantId);
    const kind: DocKind = blank ? 'blank' : DOC_FOR[type];
    const { subject, blocks } = await this.content(v, type, id, tz);
    const name = docName(kind, subject, tz);
    const file = await googleJson<any>(DRIVE, token, {
      method: 'POST',
      query: { fields: FILE_FIELDS },
      body: { name, mimeType: 'application/vnd.google-apps.document' },
    });
    if (!blank) {
      try {
        await googleJson(`${DOCS}/${encodeURIComponent(file.id)}:batchUpdate`, token, {
          method: 'POST', body: { requests: buildDocRequests(blocks) },
        });
      } catch (e) {
        // файл уже есть: пусть лучше будет пустой документ при задаче, чем никакого
        this.log.warn(`текст документа не вставлен: ${(e as Error).message}`);
      }
    }
    await this.save(v, type, id, file, 'created');
    await this.auth.audit(v.tenantId, v.userId, 'google.docs.created', { type, id, file: file.id });
    return { url: file.webViewLink as string, items: await this.list(v, type, id) };
  }

  private async save(v: Viewer, type: EntityType, id: string, f: any, origin: 'picked' | 'created') {
    await this.db.query(
      `INSERT INTO google_drive_links (tenant_id, entity_type, entity_id, google_file_id, file_name, mime_type,
          web_view_link, icon_link, owner_name, modified_time, origin, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (tenant_id, entity_type, entity_id, google_file_id) DO UPDATE SET
          file_name=EXCLUDED.file_name, mime_type=EXCLUDED.mime_type, web_view_link=EXCLUDED.web_view_link,
          icon_link=EXCLUDED.icon_link, owner_name=EXCLUDED.owner_name, modified_time=EXCLUDED.modified_time, updated_at=now()`,
      [v.tenantId, type, id, f.id, String(f.name ?? 'Без названия').slice(0, 500), String(f.mimeType ?? '').slice(0, 160),
        f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`, f.iconLink ?? null,
        f.owners?.[0]?.displayName ?? null, f.modifiedTime ?? null, origin, v.userId],
    );
  }

  private canUnlink(r: { created_by: string }, v: Viewer) {
    return String(r.created_by) === String(v.userId) || v.role === 'owner' || v.role === 'manager';
  }

  private view(r: LinkRow, v: Viewer) {
    return {
      id: String(r.id),
      fileId: r.google_file_id,
      name: r.file_name,
      mimeType: r.mime_type,
      url: r.web_view_link,
      iconUrl: r.icon_link,
      owner: r.owner_name,
      modifiedAt: r.modified_time,
      origin: r.origin,
      addedBy: r.created_by_name,
      addedAt: r.created_at,
      canRemove: this.canUnlink(r, v),
    };
  }

  /**
   * Видит ли человек сущность — по тем же правилам, что и сама сущность (§96).
   * Клиентам (внешним) Google-файлы команды не показываем вовсе.
   */
  async assertCanSee(v: Viewer, type: EntityType, id: string) {
    if (v.role === 'client') throw AppException.forbidden('Недоступно');
    if (!/^\d+$/.test(String(id))) throw AppException.notFound('Не найдено');
    const [user, all, client] = viewerParams({ userId: v.userId, role: v.role });
    let ok = false;
    if (type === 'task') {
      ok = !!(await this.db.one(
        `SELECT 1 FROM tasks t WHERE t.tenant_id=$1 AND t.id=$2 AND t.deleted_at IS NULL
            AND ${projectVisibleSql('t.project_id', { user: '$3', all: '$4', client: '$5' })}`,
        [v.tenantId, id, user, all, client],
      ));
    } else if (type === 'project') {
      ok = !!(await this.db.one(
        `SELECT 1 FROM projects p WHERE p.tenant_id=$1 AND p.id=$2
            AND ${projectVisibleSql('p.id', { user: '$3', all: '$4', client: '$5' })}`,
        [v.tenantId, id, user, all, client],
      ));
    } else if (type === 'client') {
      // клиентов команда видит всех (ТЗ-17) — проверяем только, что он есть
      ok = !!(await this.db.one(`SELECT 1 FROM clients WHERE tenant_id=$1 AND id=$2`, [v.tenantId, id]));
    } else if (type === 'event') {
      ok = !!(await this.db.one(
        `SELECT 1 FROM calendar_events e WHERE e.tenant_id=$1 AND e.id=$2
            AND ((e.scope='company' AND NOT e.is_private) OR e.owner_id=$3
                 OR EXISTS (SELECT 1 FROM calendar_participants p WHERE p.event_id=e.id AND p.user_id=$3))`,
        [v.tenantId, id, v.userId],
      ));
    }
    if (!ok) throw AppException.notFound('Не найдено');
  }

  private async timezone(tenantId: string) {
    const r = await this.db.one<{ timezone: string | null }>(`SELECT timezone FROM tenants WHERE id=$1`, [tenantId]);
    return r?.timezone || 'Europe/Moscow';
  }

  private async content(v: Viewer, type: EntityType, id: string, tz: string): Promise<{ subject: string; blocks: DocBlock[] }> {
    const base = await this.baseUrl();
    if (type === 'task') {
      const t = await this.db.one<any>(
        `SELECT t.id, t.title, t.description, t.deadline_at, t.project_id, p.name AS project,
                a.full_name AS assignee, m.full_name AS manager
           FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
           LEFT JOIN users a ON a.id=t.assignee_id LEFT JOIN users m ON m.id=t.created_by
          WHERE t.tenant_id=$1 AND t.id=$2`, [v.tenantId, id]);
      const checklist = await this.db.many<{ text: string }>(
        `SELECT text FROM task_checklist_items WHERE tenant_id=$1 AND task_id=$2 ORDER BY position`, [v.tenantId, id]);
      return {
        subject: t.title,
        blocks: taskDoc({
          title: t.title, project: t.project, assignee: t.assignee, manager: t.manager, deadline: t.deadline_at,
          description: t.description, checklist: checklist.map((c) => c.text),
          url: `${base}/projects/${t.project_id}/task/${t.id}`,
        }, tz),
      };
    }
    if (type === 'project') {
      const p = await this.db.one<any>(
        `SELECT p.id, p.name, p.description, o.full_name AS owner FROM projects p
           LEFT JOIN users o ON o.id=p.owner_user_id WHERE p.tenant_id=$1 AND p.id=$2`, [v.tenantId, id]);
      const members = await this.db.many<{ full_name: string }>(
        `SELECT u.full_name FROM project_members pm JOIN users u ON u.id=pm.user_id
          WHERE pm.project_id=$1 AND u.is_active ORDER BY u.full_name LIMIT 50`, [id]);
      return {
        subject: p.name,
        blocks: projectDoc({
          name: p.name, description: p.description, owner: p.owner, members: members.map((m) => m.full_name),
          openTasks: await this.openTasks(v.tenantId, 'project_id', id), url: `${base}/projects/${p.id}`,
        }, tz),
      };
    }
    if (type === 'client') {
      const c = await this.db.one<any>(`SELECT id, name, contact, description FROM clients WHERE tenant_id=$1 AND id=$2`, [v.tenantId, id]);
      const deals = await this.db.many<{ title: string; stage: string | null }>(
        `SELECT title, stage FROM deals WHERE tenant_id=$1 AND client_id=$2 ORDER BY updated_at DESC LIMIT 20`, [v.tenantId, id]);
      return {
        subject: c.name,
        blocks: clientDoc({
          name: c.name, contact: c.contact, notes: c.description, deals,
          openTasks: await this.openTasks(v.tenantId, 'client_id', id),
        }, tz),
      };
    }
    const e = await this.db.one<any>(
      `SELECT e.id, e.title, e.description, e.starts_at, e.ends_at, e.all_day, e.is_call, c.name AS client,
              (SELECT g.public_id FROM meet_guest_links g WHERE g.event_id = e.id AND g.kind='meeting' AND g.revoked_at IS NULL LIMIT 1) AS public_id
         FROM calendar_events e LEFT JOIN clients c ON c.id=e.client_id
        WHERE e.tenant_id=$1 AND e.id=$2`, [v.tenantId, id]);
    const people = await this.db.many<{ full_name: string }>(
      `SELECT u.full_name FROM calendar_participants p JOIN users u ON u.id=p.user_id
        WHERE p.event_id=$1 AND p.status <> 'declined' ORDER BY p.is_organizer DESC, u.full_name`, [id]);
    return {
      subject: e.title,
      blocks: meetingDoc({
        title: e.title, startsAt: e.starts_at, endsAt: e.ends_at, allDay: e.all_day,
        participants: people.map((p) => p.full_name), client: e.client, description: e.description,
        meetUrl: e.is_call && e.public_id ? `${base}/meet/${e.public_id}` : null,
      }, tz),
    };
  }

  private openTasks(tenantId: string, col: 'project_id' | 'client_id', id: string) {
    return this.db.many<{ title: string; assignee: string | null; deadline: Date | null }>(
      `SELECT t.title, u.full_name AS assignee, t.deadline_at AS deadline FROM tasks t
         LEFT JOIN users u ON u.id=t.assignee_id
        WHERE t.tenant_id=$1 AND t.${col}=$2 AND t.closed_at IS NULL AND t.deleted_at IS NULL AND t.merged_into_id IS NULL
        ORDER BY t.deadline_at NULLS LAST, t.id LIMIT 40`, [tenantId, id]);
  }

  private async baseUrl() {
    return (process.env.APP_BASE_URL || 'https://app.qevo.one').replace(/\/+$/, '');
  }

  /** Человеку — понятная причина, а не «Google ответил 403». */
  static humanError(e: unknown): string | null {
    if (!(e instanceof GoogleApiError)) return null;
    if (e.kind === 'scope') return 'Google не дал нужного разрешения — подключите его заново в «Настройки → Google»';
    if (e.status === 404) return 'Файл не найден в Google или к нему нет доступа';
    if (e.status === 403) return 'Google не разрешил это действие: нет доступа к файлу';
    if (e.kind === 'retry') return 'Google сейчас не отвечает — попробуйте через минуту';
    return null;
  }
}
