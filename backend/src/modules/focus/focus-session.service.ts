import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { RealtimeService } from '../realtime/realtime.service';
import { PresenceService } from '../presence/presence.service';
import { SecurityService } from '../security/security.service';

type Me = { tenantId: string; userId: string; role: string };

/** По умолчанию — 50 минут работы и 10 минут перерыва (п. 43–44). */
export const DEFAULT_FOCUS_MINUTES = 50;
export const BREAK_MINUTES = 10;

/**
 * Глубокая работа (ТЗ-16, волна 4).
 *
 * Таймер считает сервер: начало, плановый конец и пауза лежат в базе, а «осталось»
 * каждый клиент вычисляет из planned_end_at и времени сервера (п. 48). Поэтому
 * перезагрузка его не сбрасывает, телефон и компьютер показывают одно и то же, а
 * свёрнутое приложение ничего не теряет.
 *
 * Пока сессия идёт, человек «в глубоком фокусе» для всех: так считает общее
 * состояние присутствия, push и Telegram молчат (InboxRepository.isQuiet), а
 * пробиться можно только «постучать срочно» — один раз за сессию от каждого.
 */
@Injectable()
export class FocusSessionService {
  constructor(
    private readonly db: DbService,
    private readonly realtime: RealtimeService,
    private readonly presence: PresenceService,
    private readonly security: SecurityService,
  ) {}

  private live(tenantId: string, userId: string) {
    return this.db.one<any>(
      `SELECT s.*, t.title AS task_title, t.description AS task_description, t.project_id
         FROM focus_sessions s
         LEFT JOIN tasks t ON t.id = s.task_id AND t.deleted_at IS NULL
        WHERE s.tenant_id = $1 AND s.user_id = $2 AND s.status IN ('running', 'paused')`,
      [tenantId, userId],
    );
  }

  private view(s: any) {
    if (!s) return null;
    const now = Date.now();
    const end = new Date(s.planned_end_at).getTime();
    const remaining = s.status === 'paused'
      ? Math.max(0, end - new Date(s.paused_at).getTime())
      : Math.max(0, end - now);
    return {
      id: String(s.id),
      status: s.status as 'running' | 'paused',
      plannedMinutes: Number(s.planned_minutes),
      startedAt: s.started_at,
      plannedEndAt: s.planned_end_at,
      pausedAt: s.paused_at,
      // клиенту — и конец, и время сервера: часы на устройстве могут врать
      serverNow: new Date(now).toISOString(),
      remainingSeconds: Math.round(remaining / 1000),
      // время вышло, а человек ещё не ответил «готово / ещё фокус / перерыв»
      finished: s.status === 'running' && end <= now,
      interruptions: Number(s.interruptions_count),
      notes: s.notes ?? '',
      itemId: s.focus_day_item_id ? String(s.focus_day_item_id) : null,
      task: s.task_id && s.task_title
        ? { id: String(s.task_id), title: s.task_title, description: s.task_description ?? null, projectId: String(s.project_id) }
        : null,
    };
  }

  private changed(me: Me, event: string) {
    this.presence.changed(me.tenantId, me.userId);
    // второе устройство человека подхватывает сессию сразу (п. 133)
    this.realtime.emitToUsers(me.tenantId, [me.userId], event, {});
  }

  async current(me: Me) {
    return this.view(await this.live(me.tenantId, me.userId));
  }

  /**
   * Перед стартом: нет ли встречи раньше, чем кончится фокус (п. 132). Если есть —
   * экран предложит «фокус до встречи» вместо полного.
   */
  async preflight(me: Me, minutes = DEFAULT_FOCUS_MINUTES) {
    const row = await this.db.one<any>(
      `SELECT e.title, e.starts_at
         FROM calendar_events e
         JOIN calendar_participants cp ON cp.event_id = e.id AND cp.user_id = $2 AND cp.status <> 'declined'
        WHERE e.tenant_id = $1 AND NOT e.all_day
          AND e.starts_at > now() AND e.starts_at < now() + make_interval(mins => $3::int)
        ORDER BY e.starts_at LIMIT 1`,
      [me.tenantId, me.userId, minutes],
    );
    if (!row) return { meeting: null };
    const left = Math.max(1, Math.floor((new Date(row.starts_at).getTime() - Date.now()) / 60_000));
    return { meeting: { title: row.title, startsAt: row.starts_at, minutesLeft: left } };
  }

  async start(me: Me, input: { taskId?: string | null; itemId?: string | null; minutes?: number }) {
    const minutes = Math.max(5, Math.min(120, Math.trunc(input.minutes ?? DEFAULT_FOCUS_MINUTES)));
    if (input.taskId) {
      // своя задача или видимая — чужую закрытую работу таймером не откроешь
      const ok = await this.db.one<{ ok: boolean }>(
        `SELECT TRUE AS ok FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.tenant_id = $1 AND t.id = $2 AND t.deleted_at IS NULL
            AND ($4::boolean OR t.assignee_id = $3::bigint OR t.created_by = $3::bigint OR p.visibility = 'all'
                 OR p.owner_user_id = $3::bigint
                 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $3::bigint))`,
        [me.tenantId, input.taskId, me.userId, me.role === 'owner' || me.role === 'manager'],
      );
      if (!ok) throw AppException.notFound('Задача не найдена');
    }
    try {
      await this.db.one<any>(
        `INSERT INTO focus_sessions (tenant_id, user_id, task_id, focus_day_item_id, planned_minutes, planned_end_at)
         VALUES ($1, $2, $3, $4, $5::int, now() + make_interval(mins => $5::int))
         RETURNING id`,
        [me.tenantId, me.userId, input.taskId ?? null, input.itemId ?? null, minutes],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw AppException.conflict('Фокус уже идёт — сначала завершите его');
      throw e;
    }
    // план дня «в работе» — человек начал главное (п. 10)
    await this.db.query(
      `UPDATE focus_day_plans SET status = 'in_progress', updated_at = now()
        WHERE tenant_id = $1 AND user_id = $2 AND status IN ('proposed', 'accepted', 'modified')
          AND id = (SELECT plan_id FROM focus_day_items WHERE id = $3)`,
      [me.tenantId, me.userId, input.itemId ?? null],
    );
    this.changed(me, 'focus.session.started');
    return this.current(me);
  }

  private async mine(me: Me, id: string) {
    const s = await this.live(me.tenantId, me.userId);
    if (!s || String(s.id) !== String(id)) throw AppException.notFound('Фокус уже завершён');
    return s;
  }

  async pause(me: Me, id: string) {
    const s = await this.mine(me, id);
    if (s.status === 'running') {
      await this.db.query(`UPDATE focus_sessions SET status = 'paused', paused_at = now() WHERE id = $1`, [s.id]);
      this.changed(me, 'focus.session.paused');
    }
    return this.current(me);
  }

  /** Продолжить: конец сдвигается ровно на длину паузы — пауза не съедает фокус. */
  async resume(me: Me, id: string) {
    const s = await this.mine(me, id);
    if (s.status === 'paused') {
      await this.db.query(
        `UPDATE focus_sessions
            SET status = 'running', planned_end_at = planned_end_at + (now() - paused_at), paused_at = NULL
          WHERE id = $1`,
        [s.id],
      );
      this.changed(me, 'focus.session.resumed');
    }
    return this.current(me);
  }

  /** Заметки по ходу — сохраняем сразу: закрыл вкладку — заметка не пропала. */
  async notes(me: Me, id: string, notes: string) {
    const s = await this.mine(me, id);
    await this.db.query(`UPDATE focus_sessions SET notes = $2 WHERE id = $1`, [s.id, notes.slice(0, 4000)]);
    return { ok: true };
  }

  /**
   * Закончить. `outcome`: completed — отработал (вышло время или «готово раньше»),
   * cancelled — бросил. Перерыв после фокуса — статус «перерыв» на 10 минут (п. 60).
   */
  async finish(me: Me, id: string, outcome: 'completed' | 'cancelled', takeBreak = false) {
    const s = await this.mine(me, id);
    const ended = await this.db.one<any>(
      `UPDATE focus_sessions SET status = $2, ended_at = now(), paused_at = NULL WHERE id = $1 RETURNING *`,
      [s.id, outcome],
    );
    if (takeBreak) {
      await this.db.query(
        `INSERT INTO user_focus (tenant_id, user_id, kind, note, task_id, until, updated_at)
         VALUES ($1, $2, 'break', 'перерыв после фокуса', NULL, now() + make_interval(mins => $3::int), now())
         ON CONFLICT (tenant_id, user_id) DO UPDATE
           SET kind = 'break', note = EXCLUDED.note, task_id = NULL, until = EXCLUDED.until, updated_at = now()`,
        [me.tenantId, me.userId, BREAK_MINUTES],
      );
    }
    this.changed(me, 'focus.session.completed');
    const worked = Math.max(0, Math.round((new Date(ended.ended_at).getTime() - new Date(ended.started_at).getTime()) / 60_000));
    return { id: String(ended.id), status: ended.status, notes: ended.notes ?? '', taskId: ended.task_id ? String(ended.task_id) : null, minutes: Math.min(worked, Number(ended.planned_minutes)) };
  }

  /**
   * «Постучать срочно» (п. 53–55): только в идущий фокус, только с правом
   * `focus.knock`, один раз за сессию от каждого. Стук проходит сквозь тишину —
   * ради этого он и есть. Журнал — сама таблица стуков.
   */
  async knock(me: Me, toUserId: string, reason?: string | null) {
    await this.security.require(me.tenantId, me.userId, 'focus.knock', 'Стучать в глубокий фокус вам не разрешено');
    if (String(toUserId) === String(me.userId)) throw AppException.validation('Себе стучать незачем');
    const target = await this.db.one<any>(
      `SELECT s.id, s.planned_end_at FROM focus_sessions s
        WHERE s.tenant_id = $1 AND s.user_id = $2 AND s.status = 'running' AND s.planned_end_at > now()`,
      [me.tenantId, toUserId],
    );
    if (!target) throw AppException.conflict('Человек уже не в глубоком фокусе — просто напишите ему');
    const ins = await this.db.one<{ id: string }>(
      `INSERT INTO focus_knocks (tenant_id, session_id, from_user_id, to_user_id, reason)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (session_id, from_user_id) DO NOTHING RETURNING id`,
      [me.tenantId, target.id, me.userId, toUserId, reason?.trim().slice(0, 200) || null],
    );
    if (!ins) throw AppException.conflict('Вы уже стучали в этот фокус — дождитесь, пока он закончится');
    await this.db.query(`UPDATE focus_sessions SET interruptions_count = interruptions_count + 1 WHERE id = $1`, [target.id]);
    const from = await this.db.one<{ full_name: string }>(`SELECT full_name FROM users WHERE id = $1`, [me.userId]);
    this.realtime.emitToUsers(me.tenantId, [toUserId], 'focus.knock', {
      fromUserId: me.userId, fromName: from?.full_name ?? 'Коллега', reason: reason?.trim() || null,
    });
    return { ok: true, until: target.planned_end_at };
  }
}
