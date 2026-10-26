import { meetingVisibleSql, projectVisibleSql, ProjectViewer, viewerParams } from '../../common/access/project-visibility';
import { VISIBLE as FEED_VISIBLE } from '../feed/feed.repository';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface FileRow {
  id: string;
  tenant_id: string;
  object_key: string;
  file_name: string;
  content_type: string;
  size_bytes: string;
  owner_kind: string;
  owner_id: string | null;
  uploaded_by: string;
  created_at: Date;
}

@Injectable()
export class FilesRepository {
  constructor(private readonly db: DbService) {}

  create(input: {
    tenantId: string;
    objectKey: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    ownerKind: string;
    ownerId: string | null;
    uploadedBy: string;
  }): Promise<FileRow> {
    return this.db.one<FileRow>(
      `INSERT INTO files (tenant_id, object_key, file_name, content_type, size_bytes, owner_kind, owner_id, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        input.tenantId,
        input.objectKey,
        input.fileName,
        input.contentType,
        input.sizeBytes,
        input.ownerKind,
        input.ownerId,
        input.uploadedBy,
      ],
    ) as Promise<FileRow>;
  }

  /**
   * Можно ли человеку скачать файл (ТЗ-21, этап 0). Раньше хватало номера и компании:
   * запись созвона закрытого проекта открывал любой. Теперь — по владельцу файла:
   * вложение задачи — по проекту, запись встречи — по встрече, файл чата — участникам,
   * файл новости — тем, кому видна новость. Свой загруженный файл — всегда; аватары,
   * логотип и прочее служебное — как раньше.
   *
   * Новый вид файла, привязанный к проекту, обязан получить здесь свою ветку: иначе он
   * попадёт в `ELSE TRUE` и откроется любому в компании по номеру (#4659, этап 0).
   */
  async canDownload(tenantId: string, id: string, viewer: ProjectViewer): Promise<boolean> {
    const [user, all, client] = viewerParams(viewer);
    const proj = (expr: string) => projectVisibleSql(expr, { user: '$2', all: '$4', client: '$5' });
    const row = await this.db.one<{ ok: boolean }>(
      `SELECT (f.uploaded_by = $2::bigint OR CASE f.owner_kind
          WHEN 'task_attachment' THEN f.owner_id IS NULL OR EXISTS (
            SELECT 1 FROM tasks t WHERE t.id = f.owner_id AND t.tenant_id = $1 AND ${proj('t.project_id')})
          -- фрагмент созвона у задачи (ТЗ-25): права задачи — решение заказчика 11.10
          WHEN 'task_audio_proof' THEN f.owner_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM tasks t WHERE t.id = f.owner_id AND t.tenant_id = $1 AND t.deleted_at IS NULL AND ${proj('t.project_id')})
          WHEN 'meeting_recording' THEN f.owner_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM meetings m WHERE m.id = f.owner_id AND m.tenant_id = $1
               AND ${meetingVisibleSql('m', { user: '$2', all: '$4', client: '$5' })})
          WHEN 'chat_message' THEN f.owner_id IS NULL OR EXISTS (
            SELECT 1 FROM chats c WHERE c.id = f.owner_id AND c.tenant_id = $1
               AND ((c.kind = 'project' AND (c.project_id IS NULL OR ${proj('c.project_id')}))
                    OR EXISTS (SELECT 1 FROM chat_members cm WHERE cm.chat_id = c.id AND cm.user_id = $2::bigint)))
          -- голосовой бриф (ТЗ-21) — личный: только тому, кому его записали (он же «загрузил»)
          WHEN 'assistant_brief' THEN FALSE
          -- файл Инфоцентра проекта (#4659): тем, кто видит проект; клиенту Инфоцентр не показываем
          WHEN 'project_hub' THEN NOT $5::boolean AND f.owner_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM projects hp WHERE hp.id = f.owner_id AND hp.tenant_id = $1 AND ${proj('hp.id')})
          WHEN 'feed_post' THEN NOT $5::boolean AND EXISTS (
            SELECT 1 FROM feed_posts fp WHERE fp.id = f.owner_id AND ${FEED_VISIBLE('fp')})
          ELSE TRUE END) AS ok
         FROM files f WHERE f.tenant_id = $1 AND f.id = $6`,
      [tenantId, user, all, all, client, id],
    );
    return !!row?.ok;
  }

  findById(tenantId: string, id: string): Promise<FileRow | null> {
    return this.db.one<FileRow>(`SELECT * FROM files WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await this.db.query(`DELETE FROM files WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }
}
