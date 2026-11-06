import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { RealtimeService } from '../realtime/realtime.service';
import { PresenceService } from '../presence/presence.service';
import { SecurityService } from '../security/security.service';
import { PushService } from '../notifications/push.service';

type Me = { tenantId: string; userId: string; role: string };

/** Глагол по имени (#4787, п. 13): «Анна оставила», «Сергей оставил». Мужские имена на -а/-я — исключения. */
const MALE_A = new Set(['илья', 'никита', 'кузьма', 'фома', 'лука', 'савва', 'саша', 'миша', 'дима', 'костя', 'сережа', 'серёжа', 'женя', 'ваня', 'вова', 'юра', 'гоша', 'паша', 'боря', 'лёша', 'леша', 'коля', 'петя', 'толя', 'гриша', 'слава']);
export function verb(fullName: string, male: string, female: string): string {
  const first = String(fullName ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return /[ая]$/.test(first) && !MALE_A.has(first) ? female : male;
}

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
    private readonly push: PushService,
  ) {}

  private live(tenantId: string, userId: string) {
    return this.db.one<any>(
      `SELECT s.*, t.title AS task_title, t.description AS task_description, t.project_id,
              (SELECT COALESCE(json_agg(json_build_object('id', x.id::text, 'title', x.title, 'projectId', x.project_id::text)
                                        ORDER BY array_position(s.task_ids, x.id)), '[]'::json)
                 FROM tasks x WHERE x.id = ANY(s.task_ids) AND x.deleted_at IS NULL) AS tasks_json
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
      // #4787, п. 12: все задачи фокуса и кто может обратиться срочно
      tasks: (s.tasks_json ?? []) as { id: string; title: string; projectId: string }[],
      urgentMode: (s.urgent_mode ?? 'all') as 'all' | 'selected' | 'nobody',
      urgentUserIds: ((s.urgent_user_ids ?? []) as unknown[]).map(String),
    };
  }

  private changed(me: Me, event: string) {
    this.presence.changed(me.tenantId, me.userId);
    // второе устройство человека подхватывает сессию сразу (п. 133)
    this.realtime.emitToUsers(me.tenantId, [me.userId], event, {});
  }

  /** Закрыт ли день и тихо ли до утра — чтобы приложение молчало на любом экране. */
  async workday(me: Me) {
    const row = await this.db.one<{ until: Date | null; quiet: boolean }>(
      `SELECT CASE WHEN workday_closed_until > now() THEN workday_closed_until END AS until,
              quiet_after_close AS quiet
         FROM users WHERE tenant_id = $1 AND id = $2`,
      [me.tenantId, me.userId],
    );
    return { closedUntil: row?.until ?? null, quiet: !!row?.until && row?.quiet !== false };
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

  async start(me: Me, input: {
    taskId?: string | null; itemId?: string | null; minutes?: number;
    /** #4787, п. 12: несколько задач, кто может обратиться срочно */
    taskIds?: string[]; urgentMode?: 'all' | 'selected' | 'nobody'; urgentUserIds?: string[];
  }) {
    const minutes = Math.max(5, Math.min(120, Math.trunc(input.minutes ?? DEFAULT_FOCUS_MINUTES)));
    const taskIds = [...new Set([...(input.taskId ? [String(input.taskId)] : []), ...(input.taskIds ?? []).map(String)])].slice(0, 10);
    for (const id of taskIds.slice(1)) await this.assertTaskVisible(me, id);
    input = { ...input, taskId: taskIds[0] ?? null };
    const urgentMode = input.urgentMode === 'selected' || input.urgentMode === 'nobody' ? input.urgentMode : 'all';
    const urgentUserIds = urgentMode === 'selected' ? [...new Set((input.urgentUserIds ?? []).map(String))].slice(0, 50) : [];
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
        `INSERT INTO focus_sessions (tenant_id, user_id, task_id, focus_day_item_id, planned_minutes, planned_end_at,
                                     task_ids, urgent_mode, urgent_user_ids)
         VALUES ($1, $2, $3, $4, $5::int, now() + make_interval(mins => $5::int), $6::bigint[], $7, $8::bigint[])
         RETURNING id`,
        [me.tenantId, me.userId, input.taskId ?? null, input.itemId ?? null, minutes, taskIds, urgentMode, urgentUserIds],
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

  private async assertTaskVisible(me: Me, taskId: string) {
    const ok = await this.db.one<{ ok: boolean }>(
      `SELECT TRUE AS ok FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.tenant_id = $1 AND t.id = $2 AND t.deleted_at IS NULL
          AND ($4::boolean OR t.assignee_id = $3::bigint OR t.created_by = $3::bigint OR p.visibility = 'all'
               OR p.owner_user_id = $3::bigint
               OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $3::bigint))`,
      [me.tenantId, taskId, me.userId, me.role === 'owner' || me.role === 'manager'],
    );
    if (!ok) throw AppException.notFound('Задача не найдена');
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
   * Закончившиеся по времени сессии — сообщить один раз (планировщик, раз в 30 секунд).
   * Сессию не закрываем: итог («готово», «ещё фокус», «перерыв») выбирает человек.
   */
  async notifyEnded(): Promise<number> {
    /*
      Забытые сессии (#1563). Время вышло, а человек не ответил «готово / ещё / перерыв»
      и ушёл: сессия висела «идёт» бесконечно — кнопка фокуса пропадала у всех задач,
      «не беспокоить» не снималось. Через 2 часа после конца — закрываем как сделанную
      (до запланированного конца); пауза дольше 8 часов — отменяем.
    */
    const stale = await this.db.many<{ tenant_id: string; user_id: string }>(
      `UPDATE focus_sessions
          SET status = CASE WHEN status = 'running' THEN 'completed' ELSE 'cancelled' END,
              ended_at = CASE WHEN status = 'running' THEN planned_end_at ELSE now() END
        WHERE (status = 'running' AND planned_end_at < now() - interval '2 hours')
           OR (status = 'paused' AND COALESCE(paused_at, started_at) < now() - interval '8 hours')
        RETURNING tenant_id::text, user_id::text`,
    ).catch(() => []);
    for (const r of stale) {
      this.presence.changed(r.tenant_id, r.user_id);
      this.realtime.emitToUsers(r.tenant_id, [r.user_id], 'focus.session.completed', {});
    }

    const rows = await this.db.many<any>(
      `UPDATE focus_sessions s SET end_notified_at = now()
        WHERE s.status = 'running' AND s.end_notified_at IS NULL
          AND s.planned_end_at <= now() AND s.planned_end_at > now() - interval '15 minutes'
        RETURNING s.tenant_id, s.user_id, s.planned_minutes,
                  (SELECT title FROM tasks WHERE id = s.task_id) AS task_title`,
    );
    for (const r of rows) {
      const tenantId = String(r.tenant_id);
      const userId = String(r.user_id);
      this.presence.changed(tenantId, userId);
      this.realtime.emitToUsers(tenantId, [userId], 'focus.session.ended', {});
      void this.push.focusEvent({
        tenantId, userId, kind: 'ended', title: 'Фокус завершён',
        body: r.task_title ? `${r.planned_minutes} минут над «${String(r.task_title).slice(0, 80)}». Что дальше?` : `${r.planned_minutes} минут без отвлечений. Что дальше?`,
      });
    }
    return rows.length;
  }

  /**
   * «Постучать срочно» (п. 53–55): только в идущий фокус, только с правом
   * `focus.knock`, один раз за сессию от каждого. Стук проходит сквозь тишину —
   * ради этого он и есть. Журнал — сама таблица стуков.
   */
  async knock(me: Me, toUserId: string, reason?: string | null) {
    await this.security.require(me.tenantId, me.userId, 'focus.knock', 'Стучать в глубокий фокус вам не разрешено');
    if (String(toUserId) === String(me.userId)) throw AppException.validation('Себе стучать незачем');
    // #4787, п. 12: при срочном обращении отправитель указывает причину
    if (!reason?.trim()) throw AppException.validation('Напишите, что случилось: без причины срочное обращение не отправляется');
    const target = await this.db.one<any>(
      `SELECT s.id, s.planned_end_at, s.urgent_mode, s.urgent_user_ids FROM focus_sessions s
        WHERE s.tenant_id = $1 AND s.user_id = $2 AND s.status = 'running' AND s.planned_end_at > now()`,
      [me.tenantId, toUserId],
    );
    if (!target) throw AppException.conflict('Человек уже не в глубоком фокусе — просто напишите ему');
    // кто может обратиться срочно — решает тот, кто в фокусе
    if (target.urgent_mode === 'nobody') {
      throw AppException.forbidden('Человек просил не отвлекать даже по срочному — напишите ему, он увидит после фокуса');
    }
    if (target.urgent_mode === 'selected' && !((target.urgent_user_ids ?? []) as unknown[]).map(String).includes(String(me.userId))) {
      throw AppException.forbidden('Срочно обратиться к нему сейчас могут только выбранные им люди — напишите сообщение');
    }
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
    void this.push.focusEvent({
      tenantId: me.tenantId, userId: toUserId, kind: 'knock',
      title: `${from?.full_name ?? 'Коллега'} стучит`, body: reason?.trim() || 'Просит отвлечься — срочно',
    });
    return { ok: true, until: target.planned_end_at };
  }

  /**
   * Сводка после фокуса (#4787, п. 13): вместо потока старых уведомлений — одна.
   * Что произошло, пока человек работал: комментарии к его задачам, сообщения ему,
   * изменения его встреч, кто стучал. Работает и для идущей, и для только что законченной.
   */
  async summary(me: Me, id: string) {
    const s = await this.db.one<any>(
      `SELECT * FROM focus_sessions WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
      [me.tenantId, me.userId, id],
    );
    if (!s) throw AppException.notFound('Фокус не найден');
    const from = s.started_at;
    const to = s.ended_at ?? new Date();
    const worked = Math.min(Number(s.planned_minutes), Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000)));
    const params = [me.tenantId, me.userId, from, to];
    const comments = await this.db.many<any>(
      `SELECT u.full_name, c.task_id, t.project_id, count(*)::int AS n
         FROM task_comments c
         JOIN tasks t ON t.id = c.task_id AND t.deleted_at IS NULL
         JOIN users u ON u.id = c.author_id
        WHERE c.tenant_id = $1 AND c.author_id <> $2 AND c.created_at BETWEEN $3 AND $4
          AND (t.assignee_id = $2 OR t.created_by = $2)
        GROUP BY u.full_name, c.task_id, t.project_id
        ORDER BY max(c.created_at) LIMIT 20`, params);
    const messages = await this.db.many<any>(
      `SELECT u.full_name, m.chat_id, count(*)::int AS n
         FROM chat_messages m
         JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $2
         JOIN users u ON u.id = m.author_id
        WHERE m.tenant_id = $1 AND m.author_id IS NOT NULL AND m.author_id <> $2 AND m.deleted_at IS NULL
          AND m.created_at BETWEEN $3 AND $4
        GROUP BY u.full_name, m.chat_id
        ORDER BY max(m.created_at) LIMIT 20`, params);
    const meetings = await this.db.many<any>(
      `SELECT e.id, e.title, e.starts_at, (p.created_at BETWEEN $3 AND $4) AS invited
         FROM calendar_events e
         JOIN calendar_participants p ON p.event_id = e.id AND p.user_id = $2
        WHERE e.tenant_id = $1 AND e.owner_id <> $2
          AND (e.updated_at BETWEEN $3 AND $4 OR p.created_at BETWEEN $3 AND $4)
        ORDER BY e.updated_at LIMIT 10`, params).catch(() => []);
    // только свои параметры: неиспользованный $N Postgres не может типизировать и падает
    const knocks = await this.db.many<any>(
      `SELECT u.full_name, k.reason FROM focus_knocks k JOIN users u ON u.id = k.from_user_id
        WHERE k.tenant_id = $1 AND k.session_id = $2`, [me.tenantId, s.id]);
    const when = (d: Date) => new Date(d).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
    const plural = (n: number, one: string, few: string, many: string) => {
      const m10 = n % 10; const m100 = n % 100;
      return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
    };
    const items = [
      ...knocks.map((k: any) => ({ kind: 'knock', text: `${k.full_name} ${verb(k.full_name, 'обращался', 'обращалась')} срочно${k.reason ? `: «${k.reason}»` : ''}`, link: null })),
      ...comments.map((c: any) => ({
        kind: 'comment',
        text: `${c.full_name} ${verb(c.full_name, 'оставил', 'оставила')} ${c.n > 1 ? `${c.n} ${plural(c.n, 'комментарий', 'комментария', 'комментариев')}` : 'комментарий'} к задаче №${c.task_id}`,
        link: { section: 'projects', projectId: String(c.project_id), taskId: String(c.task_id) },
      })),
      ...messages.map((m: any) => ({
        kind: 'message',
        text: `${m.full_name} ${verb(m.full_name, 'отправил', 'отправила')} ${m.n > 1 ? `${m.n} ${plural(m.n, 'сообщение', 'сообщения', 'сообщений')}` : 'сообщение'}`,
        link: { section: 'chat', chatId: String(m.chat_id) },
      })),
      ...meetings.map((e: any) => ({
        kind: 'meeting',
        text: e.invited ? `Приглашение на встречу «${e.title}» — ${when(e.starts_at)}` : `Встреча «${e.title}» изменена — теперь ${when(e.starts_at)}`,
        link: { section: 'calendar' },
      })),
    ];
    const taskIds = ((s.task_ids ?? []) as unknown[]).map(String);
    if (!taskIds.length && s.task_id) taskIds.push(String(s.task_id));
    const tasks = taskIds.length ? await this.db.many<any>(
      `SELECT id::text, title, project_id::text AS "projectId" FROM tasks WHERE tenant_id = $1 AND id = ANY($2::bigint[]) AND deleted_at IS NULL`,
      [me.tenantId, taskIds],
    ) : [];
    const outcomes = (s.outcomes ?? {}) as Record<string, string>;
    return {
      id: String(s.id), minutes: worked, startedAt: from, endedAt: s.ended_at ?? null,
      items,
      tasks: tasks.map((t: any) => ({ ...t, outcome: outcomes[t.id] ?? null })),
    };
  }

  /**
   * «Как продвинулась работа?» (п. 13): по каждой задаче — выполнена, продолжить позже,
   * нужно ещё время. Таймер задачи не закрывает: «выполнена» ведёт в её карточку,
   * где задача сдаётся обычным путём — со всеми проверками приёмки.
   */
  async outcomes(me: Me, id: string, results: { taskId: string; result: 'done' | 'later' | 'more' }[]) {
    const clean: Record<string, string> = {};
    for (const r of results ?? []) {
      if (['done', 'later', 'more'].includes(r.result)) clean[String(r.taskId)] = r.result;
    }
    const row = await this.db.one<{ id: string }>(
      `UPDATE focus_sessions SET outcomes = outcomes || $4::jsonb
        WHERE tenant_id = $1 AND user_id = $2 AND id = $3 RETURNING id`,
      [me.tenantId, me.userId, id, JSON.stringify(clean)],
    );
    if (!row) throw AppException.notFound('Фокус не найден');
    return this.summary(me, id);
  }

  /**
   * Запланированный в календаре фокус (п. 12): в его время — одно напоминание «пора
   * начинать» на все устройства. Сам статус «В фокусе» не включается, пока человек
   * не начал — запланированный на завтра блок сегодня ничего не меняет.
   */
  async remindPlanned(): Promise<number> {
    const rows = await this.db.many<any>(
      `UPDATE calendar_blocks b SET notified_at = now()
        WHERE b.kind = 'focus' AND b.notified_at IS NULL
          AND b.starts_at <= now() + interval '1 minute' AND b.starts_at > now() - interval '10 minutes'
        RETURNING b.id, b.tenant_id, b.user_id, b.task_ids,
                  GREATEST(10, LEAST(120, round(EXTRACT(EPOCH FROM (b.ends_at - GREATEST(b.starts_at, now()))) / 60)))::int AS minutes`,
    ).catch(() => []);
    for (const r of rows) {
      const tenantId = String(r.tenant_id);
      const userId = String(r.user_id);
      this.realtime.emitToUsers(tenantId, [userId], 'focus.block.due', {
        blockId: String(r.id), minutes: Number(r.minutes), taskIds: ((r.task_ids ?? []) as unknown[]).map(String),
      });
      void this.push.focusEvent({ tenantId, userId, kind: 'ended', title: 'Время глубокого фокуса', body: `Запланировано ${r.minutes} минут без отвлечений — начать?` });
    }
    return rows.length;
  }
}
