import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { RealtimeService } from '../realtime/realtime.service';
import { Presence, resolvePresence } from './presence-resolver';

export type ManualStatus = 'busy' | 'away' | null;

/** Кто смотрит: от роли и проектов зависит, раскрывать ли название задачи. */
export type Viewer = { userId: string; role: string };

export type TeamPresence = Presence & {
  userId: string;
  fullName: string;
  avatarUrl: string | null;
  /** название задачи — только если смотрящему виден её проект, иначе null */
  taskTitle: string | null;
};

/**
 * Присутствие людей — то, что Chat Bar пишет под именем, и «Команда сейчас» в фокусе.
 *
 * «В сети» — сокет живой (память RealtimeService). «Был 12 минут назад» — время
 * последнего соединения, пишем в базу при входе и выходе: если писать при каждом
 * запросе, база получала бы обновление на каждый чих. «Занят» / «отошёл» — только
 * руками (решение заказчика: автоматики по бездействию не нужно). «На мите» здесь
 * не хранится — это живые созвоны, их знает медиа-модуль: он сам передаёт сюда
 * проверку (useCallProbe), иначе модули ссылались бы друг на друга по кругу.
 *
 * С ТЗ-16 все источники сводятся в ОДНО состояние (presence-resolver) и при любом
 * изменении уходит событие `presence.updated` — колеги видят «в глубоком фокусе до
 * 15:40» сразу, а не после перезагрузки.
 */
@Injectable()
export class PresenceService {
  private readonly log = new Logger(PresenceService.name);
  private callProbe: (tenantId: string, userId: string) => boolean = () => false;

  constructor(private readonly db: DbService, private readonly realtime: RealtimeService) {}

  /** Медиа-модуль сообщает, как узнать «человек сейчас в созвоне». */
  useCallProbe(probe: (tenantId: string, userId: string) => boolean): void {
    this.callProbe = probe;
  }

  /** Отметка «был здесь» — при входе и при выходе сокета. Ошибки глотаем: это не то, ради чего рвать соединение. */
  async touch(tenantId: string, userId: string): Promise<void> {
    try {
      await this.db.query(`UPDATE users SET last_seen_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, userId]);
    } catch { /* журнал присутствия — не критичный путь */ }
  }

  /** Сводка по компании: кто в сети, кого когда видели, кто что о себе поставил. */
  async snapshot(tenantId: string) {
    const rows = await this.db.many<{ id: string; last_seen_at: Date | null; presence_status: string | null }>(
      `SELECT id, last_seen_at, presence_status FROM users WHERE tenant_id = $1 AND is_active`,
      [tenantId],
    );
    const online = new Set(this.realtime.onlineUsers(tenantId));
    return rows.map((r) => ({
      userId: String(r.id),
      online: online.has(String(r.id)),
      lastSeenAt: r.last_seen_at,
      status: (r.presence_status as ManualStatus) ?? null,
    }));
  }

  /**
   * Свой статус. Знают о нём все в компании сразу: «занят» ставят ровно затем,
   * чтобы к тебе не шли — значит, увидеть это должны раньше, чем напишут.
   */
  async setStatus(tenantId: string, userId: string, status: ManualStatus) {
    if (status !== null && status !== 'busy' && status !== 'away') {
      throw AppException.validation('Статус — «занят», «отошёл» или ничего');
    }
    await this.db.query(
      `UPDATE users SET presence_status = $3 WHERE tenant_id = $1 AND id = $2`,
      [tenantId, userId, status],
    );
    this.realtime.emitToTenant(tenantId, 'user.status.changed', { userId, status });
    this.changed(tenantId, userId);
    return { status };
  }

  /**
   * Состояния сотрудников (без клиентов). `onlyUserId` — один человек.
   *
   * Название задачи — только если её проект виден смотрящему (ТЗ, п. 52 и 108):
   * «Сергей в глубоком фокусе до 15:40» видят все, над чем именно — те, кому можно.
   * Руководство видит всё, как и в списке проектов.
   */
  async team(tenantId: string, viewer: Viewer, onlyUserId?: string): Promise<TeamPresence[]> {
    const boss = viewer.role === 'owner' || viewer.role === 'manager';
    const params: unknown[] = [tenantId, viewer.userId, boss];
    let one = '';
    if (onlyUserId) { params.push(onlyUserId); one = `AND u.id = $${params.length}`; }
    const rows = await this.db.many<any>(
      `SELECT u.id, u.full_name, u.avatar_file_id, u.presence_status,
              f.kind, f.note, f.task_id, f.until,
              fs.id AS session_id, fs.task_id AS session_task_id, fs.planned_end_at AS session_end,
              CASE WHEN t.id IS NOT NULL AND ($3::boolean OR p.visibility = 'all'
                        OR p.owner_user_id = $2::bigint
                        OR EXISTS (SELECT 1 FROM project_members pm
                                    WHERE pm.project_id = p.id AND pm.user_id = $2::bigint))
                   THEN t.title END AS task_title
         FROM users u
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN user_focus f ON f.tenant_id = u.tenant_id AND f.user_id = u.id
                               AND (f.until IS NULL OR f.until > now())
         LEFT JOIN focus_sessions fs ON fs.tenant_id = u.tenant_id AND fs.user_id = u.id AND fs.status = 'running'
         LEFT JOIN tasks t ON t.id = COALESCE(fs.task_id, f.task_id) AND t.deleted_at IS NULL
         LEFT JOIN projects p ON p.id = t.project_id
        WHERE u.tenant_id = $1 AND u.is_active AND r.code <> 'client' ${one}
        ORDER BY u.full_name`,
      params,
    );
    const online = new Set(this.realtime.onlineUsers(tenantId));
    const now = new Date();
    return rows.map((r) => {
      const userId = String(r.id);
      const p = resolvePresence({
        online: online.has(userId),
        inCall: this.callProbe(tenantId, userId),
        focus: r.kind ? { kind: r.kind, note: r.note, taskId: r.task_id ? String(r.task_id) : null, until: r.until } : null,
        manual: (r.presence_status as ManualStatus) ?? null,
        session: r.session_id
          ? { id: String(r.session_id), taskId: r.session_task_id ? String(r.session_task_id) : null, plannedEndAt: r.session_end }
          : null,
      }, now);
      // Подпись к фокусу «работаю над задачей» — это и есть название задачи: прячем
      // её вместе с названием, иначе закрытая задача утекает через подпись.
      const hidden = p.taskId && !r.task_title;
      return {
        ...p,
        note: hidden && r.kind === 'task' ? null : p.note,
        taskId: hidden ? null : p.taskId,
        userId, fullName: r.full_name, avatarUrl: r.avatar_file_id ? `/api/files/${r.avatar_file_id}` : null,
        taskTitle: p.taskId && r.task_title ? r.task_title : null,
      };
    });
  }

  /**
   * Состояние человека изменилось — рассылаем компании.
   *
   * Каждому своё не считаем: событие несёт только состояние без названия задачи, а
   * название клиент дозапрашивает (`GET /team/pulse/:id`) — так правило видимости
   * проектов живёт в одном месте. Ошибки глотаем: статус не повод ронять действие.
   */
  changed(tenantId: string, userId: string): void {
    void this.team(tenantId, { userId, role: 'member' }, userId)
      .then(([p]) => {
        if (!p) return;
        // В общую рассылку не кладём ни задачу, ни подпись при ней: подпись автофокуса —
        // это название задачи, а компания одна на всех смотрящих.
        this.realtime.emitToTenant(tenantId, 'presence.updated', {
          ...p, taskTitle: null, taskId: null, note: p.taskId ? null : p.note,
        });
      })
      .catch((e) => this.log.warn(`presence.updated не разослан: ${e instanceof Error ? e.message : e}`));
  }
}
