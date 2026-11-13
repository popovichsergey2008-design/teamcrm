import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { AppException } from '../../common/http/app-exception';
import { detectSecrets, SECRET_MOVED, SecretKind, textFingerprint } from '../../common/secrets';
import { IntegrationCryptoService } from '../integrations/crypto.service';
import { ChatsRepository } from '../chats/chats.repository';
import { RealtimeService } from '../realtime/realtime.service';

export interface Viewer { userId: string; role: string }

interface MessageCtx {
  id: string; chat_id: string; author_id: string | null; body: string;
  chat_kind: string; project_id: string | null; chat_role: string | null; is_member: boolean;
}

const KIND_TITLE: Record<SecretKind, string> = {
  password: 'Пароль', token: 'Ключ доступа', card: 'Номер карты', cvv: 'CVV', private_key: 'Закрытый ключ', connection: 'Пароль базы',
};

/**
 * «Секреты» проекта (#4902, п. 13): пароли и ключи из переписки — в одно закрытое место.
 *
 * Кто видит: владелец и руководитель — все проекты; остальные — только проекты, где
 * они участники или владельцы. «Открытый проект» здесь НЕ даёт доступа: открытость
 * про задачи и обсуждения, а пароль от боевого сервера — не для всей компании.
 */
@Injectable()
export class ProjectSecretsService {
  private readonly log = new Logger('ProjectSecrets');

  constructor(
    private readonly db: DbService,
    private readonly crypto: IntegrationCryptoService,
    private readonly chats: ChatsRepository,
    private readonly realtime: RealtimeService,
  ) {}

  /** Сообщение и то, кем человек приходится его чату. Чужое — 404, а не 403: не подсказываем. */
  private async message(tenantId: string, messageId: string, v: Viewer): Promise<MessageCtx> {
    if (v.role === 'client') throw AppException.forbidden('Чаты команды недоступны');
    const m = await this.db.one<MessageCtx>(
      `SELECT m.id::text, m.chat_id::text, m.author_id::text, m.body, c.kind AS chat_kind,
              COALESCE(c.project_id, c.linked_project_id)::text AS project_id,
              cm.role AS chat_role, (cm.user_id IS NOT NULL) AS is_member
         FROM chat_messages m
         JOIN chats c ON c.id = m.chat_id
    LEFT JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $3::bigint
        WHERE m.tenant_id = $1 AND m.id = $2::bigint AND m.deleted_at IS NULL`,
      [tenantId, messageId, v.userId],
    );
    // тот же порог, что у самого чата: проектный — вся команда, остальные — участники
    if (!m || (m.chat_kind !== 'project' && !m.is_member)) throw AppException.notFound('Сообщение не найдено');
    return m;
  }

  /** Может ли человек видеть секреты проекта. */
  private async canSeeProject(tenantId: string, projectId: string, v: Viewer): Promise<boolean> {
    if (v.role === 'client') return false;
    const row = await this.db.one<{ ok: boolean; all: boolean }>(
      `SELECT TRUE AS ok, ($3::boolean OR p.owner_user_id = $4::bigint OR EXISTS (
                SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $4::bigint)) AS all
         FROM projects p WHERE p.tenant_id = $1 AND p.id = $2::bigint`,
      [tenantId, projectId, v.role === 'owner' || v.role === 'manager', v.userId],
    );
    return !!row?.all;
  }

  /** Отрезки секретов сообщения — когда лента увидела, что после правки старые устарели. */
  async spans(tenantId: string, messageId: string, v: Viewer) {
    const m = await this.message(tenantId, messageId, v);
    return { spans: detectSecrets(m.body), of: textFingerprint(m.body) };
  }

  /**
   * Перенести секрет из сообщения в «Секреты» проекта.
   *
   * Переносит автор сообщения, администратор чата, владелец или руководитель: чужую
   * реплику правим только по праву, а не потому что увидели в ней пароль. Отрезок
   * должен совпасть с найденным детектором — произвольный кусок чужого текста так
   * не вырезать.
   */
  async moveFromMessage(
    tenantId: string, messageId: string, v: Viewer,
    input: { start: number; end: number; title?: string | null; projectId?: string | null },
  ) {
    const m = await this.message(tenantId, messageId, v);
    const mayEdit = String(m.author_id) === String(v.userId) || m.chat_role === 'admin' || v.role === 'owner' || v.role === 'manager';
    if (!mayEdit) throw AppException.forbidden('Перенести может автор сообщения или администратор чата');
    const span = detectSecrets(m.body).find((s) => s.start === input.start && s.end === input.end);
    if (!span) throw AppException.validation('Секрет в сообщении не найден — обновите ленту');
    const projectId = m.project_id ?? (input.projectId ? String(input.projectId) : null);
    if (!projectId) throw AppException.validation('Чат не привязан к проекту — выберите проект', { needProject: true });
    if (!(await this.canSeeProject(tenantId, projectId, v))) throw AppException.forbidden('Нет доступа к проекту');

    const value = m.body.slice(span.start, span.end);
    const title = String(input.title ?? '').trim().slice(0, 160) || this.guessTitle(m.body, span.start, span.kind);
    const body = m.body.slice(0, span.start) + SECRET_MOVED + m.body.slice(span.end);
    const saved = await this.db.withTransaction(async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO project_secrets (tenant_id, project_id, title, kind, value_enc, source_message_id, created_by)
         VALUES ($1, $2::bigint, $3, $4, $5, $6::bigint, $7::bigint) RETURNING id::text`,
        [tenantId, projectId, title, span.kind, this.crypto.encrypt(value), m.id, v.userId],
      );
      await c.query(`UPDATE chat_messages SET body = $3, edited_at = now() WHERE tenant_id = $1 AND id = $2::bigint`, [tenantId, m.id, body]);
      return r.rows[0];
    });
    // Ленты у всех участников обновляются тем же событием, что и обычная правка.
    const chat = await this.chats.get(tenantId, m.chat_id);
    if (chat) {
      const to = chat.kind === 'project' ? await this.chats.teamIds(tenantId) : await this.chats.memberIds(chat.id);
      const left = detectSecrets(body);
      this.realtime.emitToUsers(tenantId, to, 'chat.message_edited', {
        chatId: m.chat_id, messageId: m.id, body, secret_spans: left, secret_of: textFingerprint(body),
      });
    }
    this.log.log(`секрет ${saved.id} перенесён из сообщения ${m.id} в проект ${projectId}`); // без значения
    return { id: saved.id, title, projectId, body };
  }

  /** «Пароль от dev-сайта» — из подписи перед значением, иначе по виду секрета. */
  private guessTitle(body: string, start: number, kind: SecretKind): string {
    const before = body.slice(Math.max(0, start - 80), start).split('\n').pop() ?? '';
    const label = before.replace(/[\s:=—–-]+$/u, '').trim();
    return (label.length >= 3 ? label : KIND_TITLE[kind]).slice(0, 160);
  }

  /** Секреты, перенесённые из этого сообщения: по клику на «🔒 в Секретах проекта». */
  async ofMessage(tenantId: string, messageId: string, v: Viewer) {
    const m = await this.message(tenantId, messageId, v);
    const rows = await this.db.many<{ id: string; project_id: string; title: string; kind: string; created_at: Date }>(
      `SELECT id::text, project_id::text, title, kind, created_at FROM project_secrets
        WHERE tenant_id = $1 AND source_message_id = $2::bigint AND deleted_at IS NULL ORDER BY id`,
      [tenantId, m.id],
    );
    const out = [];
    for (const r of rows) if (await this.canSeeProject(tenantId, r.project_id, v)) out.push(r);
    return { items: out, hidden: rows.length - out.length };
  }

  async list(tenantId: string, projectId: string, v: Viewer) {
    if (!(await this.canSeeProject(tenantId, projectId, v))) throw AppException.forbidden('Нет доступа к секретам проекта');
    const items = await this.db.many(
      `SELECT s.id::text, s.title, s.kind, s.created_at, s.source_message_id::text, u.full_name AS created_by_name
         FROM project_secrets s LEFT JOIN users u ON u.id = s.created_by
        WHERE s.tenant_id = $1 AND s.project_id = $2::bigint AND s.deleted_at IS NULL
        ORDER BY s.created_at DESC LIMIT 500`,
      [tenantId, projectId],
    );
    return { items };
  }

  private async row(tenantId: string, id: string, v: Viewer) {
    const r = await this.db.one<{ id: string; project_id: string; value_enc: string; created_by: string | null }>(
      `SELECT id::text, project_id::text, value_enc, created_by::text FROM project_secrets
        WHERE tenant_id = $1 AND id = $2::bigint AND deleted_at IS NULL`,
      [tenantId, id],
    );
    if (!r || !(await this.canSeeProject(tenantId, r.project_id, v))) throw AppException.notFound('Секрет не найден');
    return r;
  }

  /** Значение — только по отдельному запросу и только тем, кто в проекте. */
  async reveal(tenantId: string, id: string, v: Viewer) {
    const r = await this.row(tenantId, id, v);
    try {
      return { value: this.crypto.decrypt(r.value_enc) };
    } catch {
      throw AppException.conflict('Секрет не расшифровался — сменился ключ шифрования');
    }
  }

  async remove(tenantId: string, id: string, v: Viewer) {
    const r = await this.row(tenantId, id, v);
    if (String(r.created_by) !== String(v.userId) && v.role !== 'owner' && v.role !== 'manager') {
      throw AppException.forbidden('Удалить может тот, кто перенёс, владелец или руководитель');
    }
    await this.db.query(`UPDATE project_secrets SET deleted_at = now(), value_enc = '' WHERE tenant_id = $1 AND id = $2::bigint`, [tenantId, id]);
    return { deleted: true };
  }
}
