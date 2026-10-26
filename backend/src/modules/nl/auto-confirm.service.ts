import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { AppException } from '../../common/http/app-exception';
import { Actor, ProactiveService } from '../proactive/proactive.service';
import { ProactiveRepository, ProposalRow } from '../proactive/proactive.repository';
import { fingerprint } from '../proactive/proactive-rules';
import { confirmMessage, ConfirmSource, isConfirmSource } from './auto-task';
import { AutoConfirmInfo, scheduleAutoConfirm, SNAP_SQL } from './auto-confirm.schedule';
import { OrgService } from '../org/org.service';
import { directionHasLead, leadOptions } from '../org/org-rules';
import { isSkill, Skill, SKILL_LABEL } from '../team/skills';

/** Как часто смотреть, не подошло ли время сообщения: 30 секунд ± 5. */
const TICK_MS = 5_000;

interface DueRow {
  task_id: string; tenant_id: string; user_id: string; snap: string;
  info: (Partial<AutoConfirmInfo>) | null;
}

/**
 * «Задача поставлена от вас — проверьте» через 30 секунд после автоматической постановки (#4615).
 *
 * Отложенная запись в базе, а не setTimeout: перезапуск сервера посреди этих 30 секунд
 * не теряет сообщение, а два API при выкатке (blue/green) не пришлют его дважды —
 * строку забирает тот, кто первым отметил её отправленной.
 *
 * Сообщение — карточка ящика секретаря с кнопками «Ок» (задача подтверждена
 * постановщиком) и «Править» (открыть карточку) + строка в центре уведомлений со
 * всплывашкой, push и Telegram. С #4665 оно не подчиняется правилам подсказок
 * секретаря (выключатели, лимит, «больше не предлагать») — см. ProactiveService.proposeDirect.
 */
@Injectable()
export class AutoConfirmService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('AutoConfirm');
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly db: DbService,
    private readonly proactive: ProactiveService,
    private readonly proactiveRepo: ProactiveRepository,
    /** #4615, 23.10: «Кто отвечает за направление?» и обучение на правках. */
    private readonly org: OrgService,
  ) {}

  onModuleInit(): void {
    this.proactive.register({ skill: 'autotask', execute: (a, p, action) => this.execute(a, p, action) });
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try { await this.flush(); } catch (e) { this.log.warn(`проход: ${(e as Error).message}`); } finally { this.busy = false; }
  }

  /** Запомнить: через 30 секунд спросить постановщика. Возвращает, когда придёт сообщение. */
  async schedule(tenantId: string, userId: string, taskId: string, info: AutoConfirmInfo): Promise<string | null> {
    return scheduleAutoConfirm(this.db, tenantId, userId, taskId, info);
  }

  /**
   * Голос в форме «Новая задача» (#4618 → #4665): задачу создаёт обычная ручка задач,
   * а сообщение заказывает форма следом. Только своя и только что созданная задача —
   * чтобы ручкой нельзя было слать сообщения о чужих или старых задачах.
   */
  async scheduleOwn(tenantId: string, userId: string, taskId: string, source: ConfirmSource): Promise<{ confirmAt: string | null }> {
    const own = await this.db.one<{ id: string }>(
      `SELECT id::text FROM tasks
        WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL
          AND created_by = $3 AND created_at > now() - interval '15 minutes'`,
      [tenantId, taskId, userId],
    );
    if (!own) throw AppException.notFound('Задача не найдена');
    return { confirmAt: await scheduleAutoConfirm(this.db, tenantId, userId, taskId, { projectWhy: null, assigneeWhy: null, source }) };
  }

  /**
   * Отправить всё, чему пришло время. `now` подменяется в тестах. Строка помечается
   * отправленной до отправки: сбой доставки не повторяет сообщение по кругу.
   */
  async flush(now: Date = new Date(), tenantId: string | null = null): Promise<number> {
    // tenantId — только в тестах: другие наборы оставляют свои отложенные сообщения
    const rows = await this.db.many<DueRow>(
      `UPDATE task_auto_confirm SET sent_at = now()
        WHERE task_id IN (SELECT task_id FROM task_auto_confirm
                           WHERE sent_at IS NULL AND due_at <= $1 AND ($2::bigint IS NULL OR tenant_id = $2::bigint)
                           ORDER BY due_at LIMIT 50 FOR UPDATE SKIP LOCKED)
       RETURNING task_id::text, tenant_id::text, user_id::text, snap, info`,
      [now, tenantId],
    );
    let sent = 0;
    for (const r of rows) {
      try { if (await this.send(r)) sent += 1; } catch (e) { this.log.warn(`задача ${r.task_id}: ${(e as Error).message}`); }
    }
    return sent;
  }

  private async send(r: DueRow): Promise<boolean> {
    const t = await this.db.one<{
      id: string; title: string; project_id: string; priority: string; deadline_at: Date | null; snap: string;
      project_name: string; assignee_name: string | null; manager_id: string | null; manager_name: string | null;
    }>(
      `SELECT t.id::text, t.title, t.project_id::text, t.priority, t.deadline_at, ${SNAP_SQL} AS snap,
              p.name AS project_name, ua.full_name AS assignee_name,
              t.created_by::text AS manager_id, um.full_name AS manager_name
         FROM tasks t JOIN projects p ON p.id = t.project_id
         LEFT JOIN users ua ON ua.id = t.assignee_id
         LEFT JOIN users um ON um.id = t.created_by
        WHERE t.tenant_id=$1 AND t.id=$2 AND t.deleted_at IS NULL`,
      [r.tenant_id, r.task_id],
    );
    if (!t) return false; // удалили за эти полминуты — спрашивать не о чем
    const [tags, tz] = await Promise.all([
      this.db.many<{ name: string }>(
        `SELECT l.name FROM task_labels tl JOIN labels l ON l.id = tl.label_id
          WHERE tl.tenant_id=$1 AND tl.task_id=$2 ORDER BY l.name`, [r.tenant_id, r.task_id],
      ).catch(() => []),
      this.proactiveRepo.timezoneOf(r.tenant_id, r.user_id).catch(() => 'Europe/Moscow'),
    ]);
    const edited = !!r.snap && t.snap !== r.snap;
    const msg = confirmMessage({
      taskId: t.id, title: t.title, assigneeName: t.assignee_name, projectName: t.project_name,
      deadlineAt: t.deadline_at, priority: t.priority, tags: tags.map((x) => x.name),
      projectWhy: r.info?.projectWhy ?? null, assigneeWhy: r.info?.assigneeWhy ?? null,
      edited, timeZone: tz,
      source: isConfirmSource(r.info?.source) ? r.info!.source! : null,
      // постановщиком стал автор поручения (встреча, переписка), а человек лишь подтвердил
      managerName: t.manager_id && t.manager_id !== String(r.user_id) ? t.manager_name ?? 'коллега' : null,
    });
    const link = `/projects/${t.project_id}/task/${t.id}`;
    /*
      #4615, 23.10: у направления нет руководителя — спросить прямо здесь: «Кто отвечает
      за <направление>?» [человек1] [человек2] [человек3]. Выбор назначает его
      руководителем направления (создаёт или правит отдел) — следующие задачи пойдут ему.
    */
    const skill = isSkill(r.info?.noLeadFor) ? (r.info!.noLeadFor as Skill) : null;
    let ask: { id: string; name: string }[] = [];
    if (skill) {
      const org = await this.org.snapshot(r.tenant_id).catch(() => null);
      if (org && !directionHasLead(org, skill)) ask = leadOptions(org, skill, 3);
    }
    const row = await this.proactive.propose({
      tenantId: r.tenant_id, userId: r.user_id, skill: 'autotask', kind: 'confirm',
      sourceType: 'task', sourceId: t.id, sourceAt: new Date(), sourceLabel: `Задача #${t.id}`, sourceLink: link,
      title: msg.title, summary: msg.summary, why: msg.why,
      recommend: ask.length
        ? `проверить задачу и ответить: кто отвечает за «${SKILL_LABEL[skill!]}»? — выберите человека, и такие задачи будут сразу уходить ему`
        : 'проверить задачу: всё ок — «Ок», нет — «Править»',
      effect: ask.length
        ? '«Ок» отметит задачу проверенной вами; «Править» откроет её карточку; имя — назначит руководителя направления.'
        : '«Ок» отметит задачу проверенной вами; «Править» откроет её карточку.',
      priority: 1, confidence: 0.95,
      actions: [
        { key: 'ok', label: 'Ок', risk: 'low_write', primary: true },
        { key: 'edit', label: 'Править', link },
        ...ask.map((p) => ({ key: `lead:${p.id}`, label: `За «${SKILL_LABEL[skill!]}» — ${p.name}`, risk: 'low_write' as const })),
      ],
      payload: { taskId: t.id, projectId: t.project_id, edited, ...(ask.length ? { skill } : {}) },
      fingerprint: fingerprint({ skill: 'autotask', sourceType: 'task', sourceId: t.id }),
      expiresAt: new Date(Date.now() + 3 * 86400_000),
      // #4665: ответ на действие самого постановщика — доходит всегда (центр, всплывашка, push, Telegram)
      direct: { eventKey: 'task.auto_confirm', taskId: t.id, short: msg.short, fields: msg.fields },
    });
    if (!row) this.log.warn(`задача ${t.id}: сообщение-подтверждение не создано`);
    return !!row;
  }

  /** Кнопки карточки: «Ок» — подтверждено постановщиком; «Править» — открыть задачу. */
  private async execute(a: Actor, p: ProposalRow, action: string) {
    const taskId = String((p.payload as { taskId?: string }).taskId ?? p.source_id);
    const projectId = String((p.payload as { projectId?: string }).projectId ?? '');
    const link = projectId ? `/projects/${projectId}/task/${taskId}` : null;
    if (action === 'edit') return { text: 'Откройте задачу и поправьте', link, keepOpen: true };
    // #4615, 23.10: руководитель направления — из сообщения-подтверждения или карточки обучения
    const pay = p.payload as { skill?: string; userId?: string };
    if (action.startsWith('lead:') || action === 'lead_yes') {
      if (!['owner', 'manager'].includes(a.role)) throw AppException.forbidden('Структуру компании меняют владелец и руководитель');
      const skill = isSkill(pay.skill) ? pay.skill : null;
      const userId = action === 'lead_yes' ? String(pay.userId ?? '') : action.slice(5);
      if (!skill || !userId) throw AppException.validation('Не понял, кого назначить');
      const d = await this.org.setDirectionLead(a.tenantId, skill, userId);
      const name = (await this.db.one<{ name: string }>(`SELECT full_name AS name FROM users WHERE tenant_id=$1 AND id=$2`, [a.tenantId, userId]))?.name ?? 'Сотрудник';
      const text = `Готово: ${name} — руководитель направления «${SKILL_LABEL[skill]}» (отдел «${d.departmentName}»). Такие задачи теперь сразу уходят ему.`;
      // в сообщении-подтверждении «Ок» ещё нужен — карточка остаётся открытой
      return { text, link: '/settings/team', keepOpen: action !== 'lead_yes' };
    }
    if (action === 'lead_no') return { text: 'Хорошо, оставлю как есть', link: null };
    if (action !== 'ok') throw AppException.validation('Неизвестное действие');
    const done = await this.db.one<{ id: string }>(
      `UPDATE tasks SET manager_confirmed_at = now()
        WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING id::text`,
      [a.tenantId, taskId],
    );
    if (!done) throw AppException.notFound('Задача не найдена — возможно, её удалили');
    return { text: 'Готово: задача проверена', link };
  }
}
