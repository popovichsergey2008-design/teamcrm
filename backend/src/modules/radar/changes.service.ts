import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { AppException } from '../../common/http/app-exception';
import { projectVisibleSql, viewerParams } from '../../common/access/project-visibility';
import { SecurityService } from '../security/security.service';
import { can } from '../security/permissions';
import { zonedTime } from '../focus/close-day';
import { CHANGE_KINDS, CHANGE_LABEL, ChangeKind, digestText, kindsOf, FIELD_KEYS, FIELD_LABEL, FieldKey, kindSql, returnRate, summarize } from './change-rules';

type Actor = { tenantId: string; userId: string; role: string };

export interface ChangeFilter {
  /** ГГГГ-ММ-ДД, местные дни включительно. */
  from: string;
  to: string;
  tz?: string | null;
  projectId?: string | null;
  userId?: string | null;
  /** actor — кто двигал; assignee — чья задача (§11). */
  by?: 'actor' | 'assignee';
}

interface Row {
  id: string; taskId: string; title: string; projectId: string | null; projectName: string | null;
  from: string; to: string; fromColumn: string | null; toColumn: string | null;
  actorId: string | null; actorName: string | null; actorType: string;
  assigneeId: string | null; assigneeName: string | null; source: string; changedAt: Date;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STAGE_RU: Record<string, string> = {
  work: 'В работе', testing: 'Тестирование', review: 'Проверка', approval: 'Приёмка',
  waiting_external: 'Ждёт клиента', done: 'Готово', blocked: 'Заблокирована',
};
const PRIORITY_RU: Record<string, string> = { low: 'низкий', normal: 'обычный', high: 'высокий', urgent: 'срочный' };
const kindsOfRow = (r: { from: string; to: string }) => kindsOf(r.from, r.to);
const SOURCE_RU: Record<string, string> = { MANUAL: 'вручную', AI: 'ИИ', AUTOMATION: 'автоматика', API: 'API', IMPORT: 'синхронизация' };

/**
 * Изменения по задачам в «Пульсе команды» (ТЗ-32, решение 13.10: только в «Пульсе»).
 *
 * Цифры считает сервер по журналу переходов; экран их не пересчитывает (§25). Видно
 * только то, что в проектах, доступных смотрящему (§28); разбивку по людям видит каждый,
 * кому открыт «Пульс» (решение 13.10: «все, у кого есть доступ к проекту»).
 */
@Injectable()
export class ChangesService {
  constructor(private readonly db: DbService, private readonly security: SecurityService) {}

  private async need(a: Actor) {
    if (!can(await this.security.permissionsOf(a.tenantId, a.userId), 'radar.view')) {
      throw AppException.forbidden('«Пульс команды» открыт руководству — доступ выдаёт владелец');
    }
  }

  private bounds(f: ChangeFilter) {
    if (!DATE.test(f.from) || !DATE.test(f.to) || f.from > f.to) throw AppException.validation('Неверный период');
    const days = (new Date(`${f.to}T00:00:00Z`).getTime() - new Date(`${f.from}T00:00:00Z`).getTime()) / 86_400_000;
    if (days > 366) throw AppException.validation('Период — не больше года');
    const tz = f.tz && f.tz.length <= 64 ? f.tz : 'Europe/Moscow';
    const next = new Date(`${f.to}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    try {
      return { start: zonedTime(f.from, '00:00', tz), end: zonedTime(next.toISOString().slice(0, 10), '00:00', tz) };
    } catch {
      throw AppException.validation('Неизвестный часовой пояс');
    }
  }

  private async rows(a: Actor, f: ChangeFilter, extra: { kind?: ChangeKind; cursor?: string | null; limit: number }): Promise<Row[]> {
    const { start, end } = this.bounds(f);
    const vals: unknown[] = [a.tenantId, start, end, ...viewerParams(a)];
    const where = [
      'x.tenant_id = $1', 'x.changed_at >= $2', 'x.changed_at < $3',
      projectVisibleSql('x.project_id', { user: '$4', all: '$5', client: '$6' }),
    ];
    if (f.projectId) { vals.push(f.projectId); where.push(`x.project_id = $${vals.length}::bigint`); }
    if (f.userId) {
      vals.push(f.userId);
      where.push(f.by === 'assignee' ? `x.assignee_user_id = $${vals.length}::bigint` : `x.actor_user_id = $${vals.length}::bigint`);
    }
    if (extra.kind) where.push(kindSql(extra.kind, 'x'));
    if (extra.cursor && /^\d+$/.test(extra.cursor)) { vals.push(extra.cursor); where.push(`x.id < $${vals.length}::bigint`); }
    vals.push(extra.limit);
    return this.db.many<Row>(
      `SELECT x.id::text, x.task_id::text AS "taskId", tk.title, x.project_id::text AS "projectId", p.name AS "projectName",
              x.from_stage AS "from", x.to_stage AS "to", fc.name AS "fromColumn", tc.name AS "toColumn",
              x.actor_user_id::text AS "actorId", ua.full_name AS "actorName", x.actor_type AS "actorType",
              x.assignee_user_id::text AS "assigneeId", ub.full_name AS "assigneeName", x.source, x.changed_at AS "changedAt"
         FROM task_status_transitions x
         JOIN tasks tk ON tk.id = x.task_id AND tk.deleted_at IS NULL
    LEFT JOIN projects p ON p.id = x.project_id
    LEFT JOIN board_columns fc ON fc.id = x.from_column_id
    LEFT JOIN board_columns tc ON tc.id = x.to_column_id
    LEFT JOIN users ua ON ua.id = x.actor_user_id
    LEFT JOIN users ub ON ub.id = x.assignee_user_id
        WHERE ${where.join(' AND ')}
        ORDER BY x.id DESC
        LIMIT $${vals.length}`,
      vals,
    );
  }

  /** Смена исполнителя, срока, приоритета, проекта за период — те же фильтры. */
  private async fieldRows(a: Actor, f: ChangeFilter, extra: { field?: FieldKey; cursor?: string | null; limit: number }) {
    const { start, end } = this.bounds(f);
    const vals: unknown[] = [a.tenantId, start, end, ...viewerParams(a)];
    const where = [
      'x.tenant_id = $1', 'x.changed_at >= $2', 'x.changed_at < $3',
      projectVisibleSql('x.project_id', { user: '$4', all: '$5', client: '$6' }),
    ];
    if (f.projectId) { vals.push(f.projectId); where.push(`x.project_id = $${vals.length}::bigint`); }
    if (f.userId) {
      vals.push(f.userId);
      where.push(f.by === 'assignee' ? `x.assignee_user_id = $${vals.length}::bigint` : `x.actor_user_id = $${vals.length}::bigint`);
    }
    if (extra.field) { vals.push(extra.field); where.push(`x.field = $${vals.length}`); }
    if (extra.cursor && /^\d+$/.test(extra.cursor)) { vals.push(extra.cursor); where.push(`x.id < $${vals.length}::bigint`); }
    vals.push(extra.limit);
    return this.db.many<{
      id: string; taskId: string; title: string; projectId: string | null; projectName: string | null; field: FieldKey;
      oldValue: string | null; newValue: string | null; actorName: string | null; actorType: string; assigneeName: string | null;
      source: string; changedAt: Date;
    }>(
      `SELECT x.id::text, x.task_id::text AS "taskId", tk.title, x.project_id::text AS "projectId", p.name AS "projectName", x.field,
              CASE x.field WHEN 'assignee' THEN (SELECT full_name FROM users WHERE id = x.old_value::bigint)
                           WHEN 'project' THEN (SELECT name FROM projects WHERE id = x.old_value::bigint) ELSE x.old_value END AS "oldValue",
              CASE x.field WHEN 'assignee' THEN (SELECT full_name FROM users WHERE id = x.new_value::bigint)
                           WHEN 'project' THEN (SELECT name FROM projects WHERE id = x.new_value::bigint) ELSE x.new_value END AS "newValue",
              ua.full_name AS "actorName", x.actor_type AS "actorType", ub.full_name AS "assigneeName", x.source, x.changed_at AS "changedAt"
         FROM task_field_changes x
         JOIN tasks tk ON tk.id = x.task_id AND tk.deleted_at IS NULL
    LEFT JOIN projects p ON p.id = x.project_id
    LEFT JOIN users ua ON ua.id = x.actor_user_id
    LEFT JOIN users ub ON ub.id = x.assignee_user_id
        WHERE ${where.join(' AND ')}
        ORDER BY x.id DESC
        LIMIT $${vals.length}`,
      vals,
    );
  }

  /** С какого момента ведётся журнал (§30): раньше цифр нет, а не «ноль». */
  private async since(tenantId: string): Promise<string | null> {
    const r = await this.db.one<{ at: Date | null }>(
      `SELECT min(changed_at) AS at FROM task_status_transitions WHERE tenant_id = $1`, [tenantId]);
    return r?.at ? new Date(r.at).toISOString() : null;
  }

  async summary(a: Actor, f: ChangeFilter) {
    await this.need(a);
    const rows = await this.rows(a, f, { limit: 50_000 });
    const by = f.by === 'assignee' ? 'assignee' : 'actor';
    const fieldRows = await this.fieldRows(a, f, { limit: 50_000 });
    const fields = Object.fromEntries(FIELD_KEYS.map((k) => [k, fieldRows.filter((r) => r.field === k).length])) as Record<FieldKey, number>;
    const s = summarize(rows.map((r) => ({ taskId: r.taskId, actorId: r.actorId, assigneeId: r.assigneeId, from: r.from, to: r.to })), by);
    const names = new Map<string, string>();
    for (const r of rows) {
      if (r.actorId && r.actorName) names.set(r.actorId, r.actorName);
      if (r.assigneeId && r.assigneeName) names.set(r.assigneeId, r.assigneeName);
    }
    return {
      by,
      kinds: CHANGE_KINDS.map((k) => ({ key: k, label: CHANGE_LABEL[k] })),
      totals: s.totals,
      unique: s.unique,
      returnRate: returnRate(s.totals),
      transitions: s.transitions,
      users: s.users.map((u) => ({
        userId: u.userId,
        name: u.userId ? names.get(u.userId) ?? 'Сотрудник' : (by === 'actor' ? 'Автоматика и синхронизация' : 'Без исполнителя'),
        counts: u.counts, total: u.total,
      })),
      fields,
      fieldKinds: FIELD_KEYS.map((k) => ({ key: k, label: FIELD_LABEL[k] })),
      digest: digestText(
        f.from === f.to ? (f.to === new Intl.DateTimeFormat('en-CA', { timeZone: f.tz || 'Europe/Moscow' }).format(new Date()) ? 'Сегодня' : `За ${f.to.split('-').reverse().join('.')}`)
          : `С ${f.from.split('-').reverse().join('.')} по ${f.to.split('-').reverse().join('.')}`,
        s.totals,
        Object.values(rows.filter((r) => kindsOfRow(r).includes('returned_to_work'))
          .reduce((acc, r) => { const k = r.projectName ?? '—'; acc[k] = { name: k, n: (acc[k]?.n ?? 0) + 1 }; return acc; }, {} as Record<string, { name: string; n: number }>)),
      ),
      journalSince: await this.since(a.tenantId),
    };
  }

  /** Список по клику на цифру (§13): задача, проект, кто, чья, откуда → куда, когда. */
  async events(a: Actor, f: ChangeFilter & { kind?: string | null; cursor?: string | null }) {
    await this.need(a);
    // смена поля: kind = field:assignee | field:deadline | ...
    const field = String(f.kind ?? '').startsWith('field:') ? String(f.kind).slice(6) as FieldKey : null;
    if (field && FIELD_KEYS.includes(field)) {
      const rows = await this.fieldRows(a, f, { field, cursor: f.cursor, limit: 51 });
      const page = rows.slice(0, 50);
      const show = (v: string | null) => {
        if (!v) return '—';
        if (field === 'deadline') return new Date(v).toLocaleDateString('ru-RU', { timeZone: f.tz || 'Europe/Moscow' });
        if (field === 'priority') return PRIORITY_RU[v] ?? v;
        return v;
      };
      return {
        items: page.map((r) => ({
          id: r.id, taskId: r.taskId, title: r.title, projectId: r.projectId, projectName: r.projectName,
          from: r.field, to: r.field, fromLabel: show(r.oldValue), toLabel: show(r.newValue),
          actorName: r.actorName, actorType: r.actorType, assigneeName: r.assigneeName,
          source: r.source, sourceLabel: SOURCE_RU[r.source] ?? r.source, changedAt: r.changedAt,
        })),
        nextCursor: rows.length > 50 ? page[page.length - 1].id : null,
      };
    }
    const kind = CHANGE_KINDS.includes(f.kind as ChangeKind) ? (f.kind as ChangeKind) : undefined;
    const rows = await this.rows(a, f, { kind, cursor: f.cursor, limit: 51 });
    const page = rows.slice(0, 50);
    return {
      items: page.map((r) => ({
        id: r.id, taskId: r.taskId, title: r.title, projectId: r.projectId, projectName: r.projectName,
        from: r.from, to: r.to, fromLabel: r.fromColumn ?? STAGE_RU[r.from] ?? r.from, toLabel: r.toColumn ?? STAGE_RU[r.to] ?? r.to,
        actorName: r.actorName, actorType: r.actorType, assigneeName: r.assigneeName,
        source: r.source, sourceLabel: SOURCE_RU[r.source] ?? r.source, changedAt: r.changedAt,
      })),
      nextCursor: rows.length > 50 ? page[page.length - 1].id : null,
    };
  }

  /** CSV (§29): те же записи, что на экране, — для Excel («;» и BOM). */
  async exportCsv(a: Actor, f: ChangeFilter & { kind?: string | null }) {
    await this.need(a);
    const kind = CHANGE_KINDS.includes(f.kind as ChangeKind) ? (f.kind as ChangeKind) : undefined;
    const rows = await this.rows(a, f, { kind, limit: 50_000 });
    const tz = f.tz && f.tz.length <= 64 ? f.tz : 'Europe/Moscow';
    const fmt = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Дата', 'Проект', 'Задача', 'Название', 'Кто изменил', 'Исполнитель', 'Откуда', 'Куда', 'Источник'];
    const lines = rows.map((r) => [
      fmt.format(new Date(r.changedAt)), r.projectName, `#${r.taskId}`, r.title, r.actorName ?? (r.actorType === 'SYSTEM_AGENT' ? 'ИИ' : 'автоматика'),
      r.assigneeName, r.fromColumn ?? STAGE_RU[r.from] ?? r.from, r.toColumn ?? STAGE_RU[r.to] ?? r.to, SOURCE_RU[r.source] ?? r.source,
    ].map(cell).join(';'));
    void this.security.record({
      tenantId: a.tenantId, actorId: a.userId, event: 'radar.changes_exported', resourceType: 'task', metadata: { count: rows.length, filter: f },
    }).catch(() => undefined);
    return `﻿${[head.map(cell).join(';'), ...lines].join('\r\n')}`;
  }
}
