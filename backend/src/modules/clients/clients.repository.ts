import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

/** Кто смотрит и в каком охвате: `own` — только свои клиенты (п. 46, scope assigned). */
export type ClientScope = { userId: string; own: boolean };

export interface ListFilters {
  q?: string | null;
  view?: string | null;      // all · mine · attention · no_owner · archive
  status?: string | null;
  type?: string | null;
  segment?: string | null;
  source?: string | null;
  ownerId?: string | null;
  hasDeals?: boolean;
  hasOverdue?: boolean;
  hasOpenTasks?: boolean;
  inactiveDays?: number | null;
  createdFrom?: string | null;
  createdTo?: string | null;
  sort?: string | null;      // activity · name · created · status · owner · deals
  dir?: string | null;
  page?: number | null;
  ids?: string[] | null;
}

export const PAGE_SIZE = 50;

/**
 * Задачи клиента: привязанные к нему прямо и задачи его проектов (решение заказчика —
 * задачу можно отнести к клиенту и не только через проект). Явная привязка важнее:
 * задача с другим клиентом в клиентском проекте считается за тот, что указан.
 */
const TASKS_OF = (c: string) => `
  FROM tasks t LEFT JOIN projects tp ON tp.id = t.project_id
 WHERE t.tenant_id = ${c}.tenant_id AND t.deleted_at IS NULL
   AND (t.client_id = ${c}.id OR (t.client_id IS NULL AND tp.client_id = ${c}.id))`;

/** Охват: свой клиент — я ответственный или в команде клиента. */
const OWN = (c: string, p: string) => `(${c}.owner_user_id = ${p}::bigint OR EXISTS (
  SELECT 1 FROM client_members cm WHERE cm.client_id = ${c}.id AND cm.user_id = ${p}::bigint))`;

@Injectable()
export class ClientsRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Список клиентов (п. 10–16, 63): страницами, фильтры и сортировка — на сервере.
   * Счётчики (контакты, сделки, задачи, просрочка) и «последняя активность» — одним
   * запросом: активность — самое свежее из записи клиента, его задач и переписки.
   */
  async list(tenantId: string, scope: ClientScope, f: ListFilters) {
    const params: unknown[] = [tenantId, scope.userId];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where: string[] = ['c.tenant_id = $1'];
    if (scope.own) where.push(OWN('c', '$2'));

    const view = f.view ?? 'all';
    if (view === 'archive') where.push('c.archived_at IS NOT NULL');
    else where.push('c.archived_at IS NULL');
    if (view === 'mine') where.push(OWN('c', '$2'));
    if (view === 'no_owner') where.push('c.owner_user_id IS NULL');
    if (view === 'attention') {
      where.push(`(tk.overdue > 0 OR act.at < now() - interval '14 days' OR dl.stalled_days >= 14 OR c.owner_user_id IS NULL)`);
      where.push(`c.status NOT IN ('lost', 'inactive')`);
    }
    if (f.ids?.length) where.push(`c.id = ANY(${add(f.ids)}::bigint[])`);
    if (f.status) where.push(`c.status = ${add(f.status)}`);
    if (f.type) where.push(`c.type = ${add(f.type)}`);
    if (f.segment) where.push(`c.segment = ${add(f.segment)}`);
    if (f.source) where.push(`c.source = ${add(f.source)}`);
    if (f.ownerId === 'none') where.push('c.owner_user_id IS NULL');
    else if (f.ownerId) where.push(`c.owner_user_id = ${add(f.ownerId)}::bigint`);
    if (f.hasDeals) where.push('dl.open > 0');
    if (f.hasOverdue) where.push('tk.overdue > 0');
    if (f.hasOpenTasks) where.push('tk.open > 0');
    if (f.inactiveDays) where.push(`act.at < now() - make_interval(days => ${add(f.inactiveDays)}::int)`);
    if (f.createdFrom) where.push(`c.created_at >= ${add(f.createdFrom)}::date`);
    if (f.createdTo) where.push(`c.created_at < ${add(f.createdTo)}::date + 1`);

    const q = String(f.q ?? '').trim();
    if (q) {
      // Поиск по названию, юр. названию, сайту, ИНН, контактам (имя, почта, телефон) и сделкам (п. 13).
      const like = add(`%${q.toLowerCase()}%`);
      const digits = q.replace(/\D/g, '');
      const phone = digits.length >= 5 ? add(`%${digits}%`) : null;
      where.push(`(lower(c.name) LIKE ${like} OR lower(COALESCE(c.legal_name, '')) LIKE ${like}
        OR c.normalized_name LIKE ${like} OR lower(COALESCE(c.website, '')) LIKE ${like}
        OR COALESCE(c.tax_id, '') LIKE ${like}
        OR EXISTS (SELECT 1 FROM client_contacts cc WHERE cc.client_id = c.id AND cc.archived_at IS NULL
                     AND (lower(cc.first_name || ' ' || COALESCE(cc.last_name, '')) LIKE ${like}
                          OR COALESCE(cc.email_norm, '') LIKE ${like}
                          ${phone ? `OR COALESCE(cc.phone_norm, '') LIKE ${phone}` : ''}))
        OR EXISTS (SELECT 1 FROM deals d WHERE d.client_id = c.id AND lower(d.title) LIKE ${like}))`);
    }

    const dir = f.dir === 'asc' ? 'ASC' : 'DESC';
    const order = ({
      name: `lower(c.name) ${f.dir === 'desc' ? 'DESC' : 'ASC'}`,
      created: `c.created_at ${dir}`,
      status: `c.status ${dir}, lower(c.name)`,
      owner: `lower(ou.full_name) ${dir} NULLS LAST, lower(c.name)`,
      deals: `dl.amount ${dir} NULLS LAST, lower(c.name)`,
    } as Record<string, string>)[f.sort ?? ''] ?? `act.at ${dir} NULLS LAST, c.id DESC`;

    const page = Math.max(1, Math.trunc(Number(f.page) || 1));
    const limit = add(PAGE_SIZE);
    const offset = add((page - 1) * PAGE_SIZE);

    const rows = await this.db.many<any>(
      `SELECT c.id, c.name, c.type, c.status, c.segment, c.source, c.city, c.website,
              c.owner_user_id, ou.full_name AS owner_name, c.archived_at, c.created_at,
              c.next_action, c.next_action_at,
              act.at AS activity_at,
              (SELECT count(*)::int FROM client_contacts cc WHERE cc.client_id = c.id AND cc.archived_at IS NULL) AS contacts,
              pc.name AS primary_contact,
              dl.open AS open_deals, dl.amount AS deals_amount, dl.stalled_days,
              tk.open AS open_tasks, tk.overdue AS overdue_tasks,
              count(*) OVER () AS total
         FROM clients c
         LEFT JOIN users ou ON ou.id = c.owner_user_id
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE t.closed_at IS NULL)::int AS open,
                  count(*) FILTER (WHERE t.closed_at IS NULL AND t.deadline_at < now())::int AS overdue,
                  max(t.updated_at) AS touched
             ${TASKS_OF('c')}
         ) tk ON TRUE
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS open, sum(d.amount) AS amount,
                  max(EXTRACT(DAY FROM now() - d.updated_at))::int AS stalled_days
             FROM deals d
            WHERE d.client_id = c.id AND d.archived_at IS NULL AND d.stage IN ('new', 'negotiation', 'proposal', 'approval')
         ) dl ON TRUE
         LEFT JOIN LATERAL (
           SELECT GREATEST(c.last_activity_at, tk.touched,
                    (SELECT max(ch.last_message_at) FROM chats ch WHERE ch.tenant_id = c.tenant_id AND ch.client_id = c.id)) AS at
         ) act ON TRUE
         LEFT JOIN LATERAL (
           SELECT trim(cc.first_name || ' ' || COALESCE(cc.last_name, '')) AS name
             FROM client_contacts cc WHERE cc.client_id = c.id AND cc.is_primary AND cc.archived_at IS NULL LIMIT 1
         ) pc ON TRUE
        WHERE ${where.join(' AND ')}
        ORDER BY ${order}
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return { rows, total: Number(rows[0]?.total ?? 0), page, pageSize: PAGE_SIZE };
  }

  /** Сколько требуют внимания / без ответственного — счётчики для меню и быстрых видов. */
  async counters(tenantId: string, scope: ClientScope) {
    const own = scope.own ? `AND ${OWN('c', '$2')}` : '';
    return this.db.one<{ mine: number; no_owner: number; overdue: number; total: number }>(
      `SELECT count(*) FILTER (WHERE ${OWN('c', '$2')})::int AS mine,
              count(*) FILTER (WHERE c.owner_user_id IS NULL)::int AS no_owner,
              count(*) FILTER (WHERE EXISTS (SELECT 1 ${TASKS_OF('c')} AND t.closed_at IS NULL AND t.deadline_at < now()))::int AS overdue,
              count(*)::int AS total
         FROM clients c WHERE c.tenant_id = $1 AND c.archived_at IS NULL ${own}`,
      [tenantId, scope.userId],
    );
  }

  /** Виден ли клиент этому человеку (охват «только свои»). */
  async visible(tenantId: string, id: string, scope: ClientScope): Promise<any | null> {
    return this.db.one<any>(
      `SELECT c.*, ou.full_name AS owner_name, g.name AS department_name
         FROM clients c
         LEFT JOIN users ou ON ou.id = c.owner_user_id
         LEFT JOIN groups g ON g.id = c.department_id
        WHERE c.tenant_id = $1 AND c.id = $3 ${scope.own ? `AND ${OWN('c', '$2')}` : ''}`,
      [tenantId, scope.userId, id],
    );
  }

  async create(tenantId: string, userId: string, v: Record<string, unknown>) {
    return this.db.one<{ id: string }>(
      `INSERT INTO clients (tenant_id, name, type, legal_name, status, segment, source, owner_user_id, website, domain,
                            country, city, address, tax_id, registration_number, description, normalized_name,
                            created_by, last_activity_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())
       RETURNING id`,
      [tenantId, v.name, v.type ?? 'company', v.legalName ?? null, v.status ?? 'active', v.segment ?? null,
        v.source ?? null, v.ownerId ?? null, v.website ?? null, v.domain ?? null, v.country ?? null, v.city ?? null,
        v.address ?? null, v.taxId ?? null, v.registrationNumber ?? null, v.description ?? null, v.normalizedName ?? null, userId],
    );
  }

  /** Правка: только переданные поля. Список колонок закрыт — имя из запроса в SQL не попадает. */
  async update(tenantId: string, id: string, patch: Record<string, unknown>) {
    const COLS: Record<string, string> = {
      name: 'name', type: 'type', legalName: 'legal_name', status: 'status', segment: 'segment', source: 'source',
      ownerId: 'owner_user_id', departmentId: 'department_id', website: 'website', domain: 'domain', country: 'country',
      city: 'city', address: 'address', taxId: 'tax_id', registrationNumber: 'registration_number',
      description: 'description', normalizedName: 'normalized_name', nextAction: 'next_action',
      nextActionAt: 'next_action_at', nextActionSource: 'next_action_source',
    };
    const sets: string[] = [];
    const params: unknown[] = [tenantId, id];
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in COLS) || v === undefined) continue;
      params.push(v === '' ? null : v);
      sets.push(`${COLS[k]} = $${params.length}`);
    }
    if (!sets.length) return;
    await this.db.query(`UPDATE clients SET ${sets.join(', ')}, updated_at = now() WHERE tenant_id = $1 AND id = $2`, params);
  }

  async setArchived(tenantId: string, id: string, archived: boolean) {
    await this.db.query(
      `UPDATE clients SET archived_at = CASE WHEN $3 THEN now() ELSE NULL END, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, archived],
    );
  }

  async hardDelete(tenantId: string, id: string) {
    await this.db.query(`DELETE FROM clients WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  }

  touch(tenantId: string, clientId: string) {
    return this.db.query(`UPDATE clients SET last_activity_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, clientId]);
  }

  /** Событие в ленту клиента + «последняя активность». Ошибка ленты действие не роняет. */
  async log(tenantId: string, clientId: string, actorId: string | null, kind: string, title: string,
    entity?: { type: string; id: string } | null, detail: Record<string, unknown> = {}) {
    try {
      await this.db.query(
        `INSERT INTO client_activity (tenant_id, client_id, actor_id, kind, title, entity_type, entity_id, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [tenantId, clientId, actorId, kind, title.slice(0, 300), entity?.type ?? null, entity?.id ?? null, JSON.stringify(detail)],
      );
      await this.touch(tenantId, clientId);
    } catch { /* лента — не повод отменять действие */ }
  }

  // ── дубли (п. 18, 77) ──────────────────────────────────────────────────────────
  duplicates(tenantId: string, v: { name: string; email: string | null; phone: string | null; domain: string | null; taxId: string | null; excludeId?: string | null }) {
    return this.db.many<any>(
      `SELECT c.id, c.name, c.website, c.archived_at,
              similarity(c.normalized_name, $2) AS sim,
              ARRAY_REMOVE(ARRAY[
                CASE WHEN $3::text IS NOT NULL AND EXISTS (SELECT 1 FROM client_contacts cc WHERE cc.client_id = c.id AND cc.email_norm = $3) THEN 'email' END,
                CASE WHEN $4::text IS NOT NULL AND EXISTS (SELECT 1 FROM client_contacts cc WHERE cc.client_id = c.id AND cc.phone_norm = $4) THEN 'phone' END,
                CASE WHEN $5::text IS NOT NULL AND c.domain = $5 THEN 'domain' END,
                CASE WHEN $6::text IS NOT NULL AND c.tax_id = $6 THEN 'tax_id' END,
                CASE WHEN $2 <> '' AND (c.normalized_name = $2 OR similarity(c.normalized_name, $2) >= 0.6) THEN 'name' END
              ], NULL) AS matched
         FROM clients c
        WHERE c.tenant_id = $1 AND ($7::bigint IS NULL OR c.id <> $7::bigint)
          AND (($2 <> '' AND (c.normalized_name = $2 OR c.normalized_name % $2))
               OR ($5::text IS NOT NULL AND c.domain = $5)
               OR ($6::text IS NOT NULL AND c.tax_id = $6)
               OR EXISTS (SELECT 1 FROM client_contacts cc WHERE cc.client_id = c.id
                           AND (($3::text IS NOT NULL AND cc.email_norm = $3) OR ($4::text IS NOT NULL AND cc.phone_norm = $4))))
        ORDER BY sim DESC NULLS LAST
        LIMIT 5`,
      [tenantId, v.name, v.email, v.phone, v.domain, v.taxId, v.excludeId ?? null],
    );
  }

  // ── контакты ───────────────────────────────────────────────────────────────────
  contacts(clientId: string) {
    return this.db.many<any>(
      `SELECT * FROM client_contacts WHERE client_id = $1 AND archived_at IS NULL ORDER BY is_primary DESC, id`,
      [clientId],
    );
  }

  contact(tenantId: string, id: string) {
    return this.db.one<any>(`SELECT * FROM client_contacts WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL`, [tenantId, id]);
  }

  async addContact(tenantId: string, clientId: string, v: Record<string, any>) {
    if (v.isPrimary) await this.db.query(`UPDATE client_contacts SET is_primary = FALSE WHERE client_id = $1`, [clientId]);
    const hasPrimary = await this.db.one(`SELECT 1 FROM client_contacts WHERE client_id = $1 AND is_primary AND archived_at IS NULL`, [clientId]);
    return this.db.one<{ id: string }>(
      `INSERT INTO client_contacts (tenant_id, client_id, first_name, last_name, position, phone, phone_norm, email, email_norm,
                                    telegram, whatsapp, preferred_channel, is_primary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [tenantId, clientId, v.firstName, v.lastName ?? null, v.position ?? null, v.phone ?? null, v.phoneNorm ?? null,
        v.email ?? null, v.emailNorm ?? null, v.telegram ?? null, v.whatsapp ?? null, v.preferredChannel ?? null,
        // первый контакт клиента — основной сам собой
        !!v.isPrimary || !hasPrimary],
    );
  }

  async updateContact(tenantId: string, id: string, clientId: string, v: Record<string, any>) {
    if (v.isPrimary === true) await this.db.query(`UPDATE client_contacts SET is_primary = FALSE WHERE client_id = $1 AND id <> $2`, [clientId, id]);
    const COLS: Record<string, string> = {
      firstName: 'first_name', lastName: 'last_name', position: 'position', phone: 'phone', phoneNorm: 'phone_norm',
      email: 'email', emailNorm: 'email_norm', telegram: 'telegram', whatsapp: 'whatsapp',
      preferredChannel: 'preferred_channel', isPrimary: 'is_primary',
    };
    const sets: string[] = [];
    const params: unknown[] = [tenantId, id];
    for (const [k, val] of Object.entries(v)) {
      if (!(k in COLS) || val === undefined) continue;
      params.push(val === '' ? null : val);
      sets.push(`${COLS[k]} = $${params.length}`);
    }
    if (!sets.length) return;
    await this.db.query(`UPDATE client_contacts SET ${sets.join(', ')}, updated_at = now() WHERE tenant_id = $1 AND id = $2`, params);
  }

  archiveContact(tenantId: string, id: string) {
    return this.db.query(`UPDATE client_contacts SET archived_at = now(), is_primary = FALSE WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  }

  async revealedRecently(tenantId: string, userId: string, contactId: string, field: string, ttl: number) {
    const r = await this.db.one(
      `SELECT 1 FROM contact_reveals WHERE tenant_id = $1 AND user_id = $2 AND contact_id = $3 AND field = $4
          AND created_at > now() - make_interval(secs => $5) LIMIT 1`,
      [tenantId, userId, contactId, field, ttl],
    );
    return !!r;
  }

  logReveal(o: { tenantId: string; userId: string; clientId: string; contactId: string; field: string; reason: string | null; ip: string | null; deviceId: string | null }) {
    return this.db.query(
      `INSERT INTO contact_reveals (tenant_id, user_id, client_id, contact_id, field, reason, ip, device_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [o.tenantId, o.userId, o.clientId, o.contactId, o.field, o.reason, o.ip, o.deviceId],
    );
  }

  // ── команда клиента ──────────────────────────────────────────────────────────────
  members(clientId: string) {
    return this.db.many<any>(
      `SELECT cm.user_id, cm.role, u.full_name, u.avatar_file_id FROM client_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.client_id = $1 ORDER BY cm.added_at`,
      [clientId],
    );
  }

  setMember(tenantId: string, clientId: string, userId: string, role: string) {
    return this.db.query(
      `INSERT INTO client_members (tenant_id, client_id, user_id, role) VALUES ($1,$2,$3,$4)
       ON CONFLICT (client_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [tenantId, clientId, userId, role],
    );
  }

  removeMember(clientId: string, userId: string) {
    return this.db.query(`DELETE FROM client_members WHERE client_id = $1 AND user_id = $2`, [clientId, userId]);
  }

  userInTenant(tenantId: string, userId: string) {
    return this.db.one(`SELECT id, full_name FROM users WHERE tenant_id = $1 AND id = $2 AND is_active`, [tenantId, userId]);
  }

  // ── заметки ─────────────────────────────────────────────────────────────────────
  notes(clientId: string, viewerId: string, boss: boolean) {
    return this.db.many<any>(
      `SELECT n.*, u.full_name AS author_name FROM client_notes n LEFT JOIN users u ON u.id = n.author_id
        WHERE n.client_id = $1 AND n.deleted_at IS NULL AND (NOT n.is_private OR n.author_id = $2::bigint OR $3::boolean)
        ORDER BY n.pinned DESC, n.created_at DESC LIMIT 200`,
      [clientId, viewerId, boss],
    );
  }

  addNote(tenantId: string, clientId: string, authorId: string, body: string, pinned: boolean, isPrivate: boolean) {
    return this.db.one<{ id: string }>(
      `INSERT INTO client_notes (tenant_id, client_id, author_id, body, pinned, is_private) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [tenantId, clientId, authorId, body, pinned, isPrivate],
    );
  }

  note(tenantId: string, id: string) {
    return this.db.one<any>(`SELECT * FROM client_notes WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, [tenantId, id]);
  }

  updateNote(id: string, v: { body?: string; pinned?: boolean; isPrivate?: boolean }) {
    return this.db.query(
      `UPDATE client_notes SET body = COALESCE($2, body), pinned = COALESCE($3, pinned), is_private = COALESCE($4, is_private), updated_at = now() WHERE id = $1`,
      [id, v.body ?? null, v.pinned ?? null, v.isPrivate ?? null],
    );
  }

  deleteNote(id: string) {
    return this.db.query(`UPDATE client_notes SET deleted_at = now() WHERE id = $1`, [id]);
  }

  // ── сделки ──────────────────────────────────────────────────────────────────────
  deals(clientId: string) {
    return this.db.many<any>(
      `SELECT d.*, u.full_name AS owner_name FROM deals d LEFT JOIN users u ON u.id = d.owner_user_id
        WHERE d.client_id = $1 AND d.archived_at IS NULL
        ORDER BY (d.stage IN ('won', 'lost')), d.close_date NULLS LAST, d.created_at DESC`,
      [clientId],
    );
  }

  deal(tenantId: string, id: string) {
    return this.db.one<any>(`SELECT * FROM deals WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL`, [tenantId, id]);
  }

  addDeal(tenantId: string, clientId: string, v: Record<string, any>) {
    return this.db.one<{ id: string }>(
      `INSERT INTO deals (tenant_id, client_id, title, stage, amount, currency, probability, owner_user_id, next_action, close_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [tenantId, clientId, v.title, v.stage ?? 'new', v.amount ?? null, v.currency ?? 'RUB', v.probability ?? null,
        v.ownerId ?? null, v.nextAction ?? null, v.closeDate ?? null],
    );
  }

  async updateDeal(tenantId: string, id: string, v: Record<string, any>) {
    const COLS: Record<string, string> = {
      title: 'title', stage: 'stage', amount: 'amount', currency: 'currency', probability: 'probability',
      ownerId: 'owner_user_id', nextAction: 'next_action', closeDate: 'close_date', lostReason: 'lost_reason',
    };
    const sets: string[] = [];
    const params: unknown[] = [tenantId, id];
    for (const [k, val] of Object.entries(v)) {
      if (!(k in COLS) || val === undefined) continue;
      params.push(val === '' ? null : val);
      sets.push(`${COLS[k]} = $${params.length}`);
    }
    if (!sets.length) return;
    await this.db.query(`UPDATE deals SET ${sets.join(', ')}, updated_at = now() WHERE tenant_id = $1 AND id = $2`, params);
  }

  archiveDeal(tenantId: string, id: string) {
    return this.db.query(`UPDATE deals SET archived_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  }

  // ── связи ───────────────────────────────────────────────────────────────────────
  projects(tenantId: string, clientId: string) {
    return this.db.many<any>(
      `SELECT p.id, p.name, p.status, u.full_name AS pm_name,
              (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL) AS total,
              (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.closed_at IS NOT NULL) AS done
         FROM projects p LEFT JOIN users u ON u.id = p.owner_user_id
        WHERE p.tenant_id = $1 AND p.client_id = $2
        ORDER BY p.status = 'archived', p.created_at DESC`,
      [tenantId, clientId],
    );
  }

  linkProject(tenantId: string, clientId: string, projectId: string | null, unlinkId?: string) {
    if (unlinkId) return this.db.query(`UPDATE projects SET client_id = NULL WHERE tenant_id = $1 AND id = $2 AND client_id = $3`, [tenantId, unlinkId, clientId]);
    return this.db.query(`UPDATE projects SET client_id = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, projectId, clientId]);
  }

  tasks(tenantId: string, clientId: string, filter: string, reviewNames: string[]) {
    const extra = filter === 'overdue' ? 'AND t.closed_at IS NULL AND t.deadline_at < now()'
      : filter === 'approval' ? 'AND t.closed_at IS NULL AND lower(bc.name) = ANY($3::text[])'
      : filter === 'all' ? '' : 'AND t.closed_at IS NULL';
    return this.db.many<any>(
      `SELECT t.id, t.title, t.project_id, tp.name AS project_name, t.deadline_at, t.priority, t.closed_at,
              ua.full_name AS assignee_name, bc.name AS column_name
         FROM tasks t LEFT JOIN projects tp ON tp.id = t.project_id
         JOIN board_columns bc ON bc.id = t.column_id
         LEFT JOIN users ua ON ua.id = t.assignee_id
        WHERE t.tenant_id = $1 AND t.deleted_at IS NULL
          AND (t.client_id = $2 OR (t.client_id IS NULL AND tp.client_id = $2)) ${extra}
        ORDER BY t.closed_at IS NOT NULL, t.deadline_at NULLS LAST, t.created_at DESC
        LIMIT 200`,
      filter === 'approval' ? [tenantId, clientId, reviewNames] : [tenantId, clientId],
    );
  }

  /** Встречи: события календаря клиента и созвоны по его проектам. */
  meetings(tenantId: string, clientId: string) {
    return this.db.many<any>(
      `SELECT 'event' AS kind, e.id, e.title, e.starts_at, e.ends_at, e.meet_room_id
         FROM calendar_events e WHERE e.tenant_id = $1 AND e.client_id = $2
       UNION ALL
       SELECT 'meeting' AS kind, m.id, m.title, COALESCE(m.happened_at, m.created_at) AS starts_at, NULL AS ends_at, NULL AS meet_room_id
         FROM meetings m LEFT JOIN projects p ON p.id = m.project_id
        WHERE m.tenant_id = $1 AND (m.client_id = $2 OR p.client_id = $2)
       ORDER BY starts_at DESC LIMIT 100`,
      [tenantId, clientId],
    );
  }

  /** Переписка: внешние чаты клиента, связанные чаты и чаты его проектов — без копий сообщений. */
  chats(tenantId: string, clientId: string, viewerId: string) {
    return this.db.many<any>(
      `SELECT DISTINCT ON (ch.id) ch.id, ch.title, ch.kind, ch.is_external, ch.last_message_at
         FROM chats ch
         LEFT JOIN projects p ON p.id = ch.project_id
        WHERE ch.tenant_id = $1
          AND (ch.client_id = $2 OR p.client_id = $2
               OR EXISTS (SELECT 1 FROM conversation_links l WHERE l.chat_id = ch.id AND l.entity_type = 'client' AND l.entity_id = $2))
          AND EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = ch.id AND m.user_id = $3::bigint)
        ORDER BY ch.id, ch.last_message_at DESC NULLS LAST`,
      [tenantId, clientId, viewerId],
    );
  }

  files(clientId: string) {
    return this.db.many<any>(
      `SELECT cf.id, cf.category, cf.created_at, f.id AS file_id, f.file_name, f.content_type, f.size_bytes, u.full_name AS uploaded_by_name
         FROM client_files cf JOIN files f ON f.id = cf.file_id LEFT JOIN users u ON u.id = cf.uploaded_by
        WHERE cf.client_id = $1 ORDER BY cf.created_at DESC`,
      [clientId],
    );
  }

  fileOwned(tenantId: string, fileId: string) {
    return this.db.one<any>(`SELECT id, file_name FROM files WHERE tenant_id = $1 AND id = $2`, [tenantId, fileId]);
  }

  addFile(tenantId: string, clientId: string, fileId: string, category: string, userId: string) {
    return this.db.one<{ id: string }>(
      `INSERT INTO client_files (tenant_id, client_id, file_id, category, uploaded_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [tenantId, clientId, fileId, category, userId],
    );
  }

  removeFile(tenantId: string, clientId: string, id: string) {
    return this.db.one<any>(`DELETE FROM client_files WHERE tenant_id = $1 AND client_id = $2 AND id = $3 RETURNING id`, [tenantId, clientId, id]);
  }

  /**
   * Лента (п. 40): свои события клиента + задачи (созданы/закрыты), встречи и
   * переписка по дням — из своих таблиц, без копий.
   */
  activity(tenantId: string, clientId: string, kind: string | null, limit = 100) {
    const k = kind && kind !== 'all' ? kind : null;
    return this.db.many<any>(
      `SELECT * FROM (
         SELECT 'a' || a.id AS id, a.kind, a.title, a.created_at AS at, u.full_name AS actor_name, a.entity_type, a.entity_id::text
           FROM client_activity a LEFT JOIN users u ON u.id = a.actor_id WHERE a.client_id = $2
         UNION ALL
         SELECT 't' || t.id, 'task', 'Задача создана: ' || t.title, t.created_at, u.full_name, 'task', t.id::text
           FROM tasks t LEFT JOIN projects tp ON tp.id = t.project_id LEFT JOIN users u ON u.id = t.created_by
          WHERE t.tenant_id = $1 AND t.deleted_at IS NULL
            AND (t.client_id = $2 OR (t.client_id IS NULL AND tp.client_id = $2))
         UNION ALL
         SELECT 'tc' || t.id, 'task', 'Задача закрыта: ' || t.title, t.closed_at, NULL, 'task', t.id::text
           FROM tasks t LEFT JOIN projects tp ON tp.id = t.project_id
          WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND t.closed_at IS NOT NULL
            AND (t.client_id = $2 OR (t.client_id IS NULL AND tp.client_id = $2))
         UNION ALL
         SELECT 'e' || e.id, 'meeting', 'Встреча: ' || e.title, e.starts_at, NULL, 'event', e.id::text
           FROM calendar_events e WHERE e.tenant_id = $1 AND e.client_id = $2 AND e.starts_at <= now()
         UNION ALL
         SELECT 'm' || ch.id || '-' || d::date, 'chat', 'Переписка в «' || COALESCE(ch.title, 'чате') || '»: ' || n || ' сообщ.', d, NULL, 'chat', ch.id::text
           FROM (SELECT cm.chat_id, date_trunc('day', cm.created_at) AS d, count(*) AS n
                   FROM chat_messages cm JOIN chats c2 ON c2.id = cm.chat_id
                  WHERE c2.tenant_id = $1 AND c2.client_id = $2 AND cm.created_at > now() - interval '90 days'
                  GROUP BY cm.chat_id, date_trunc('day', cm.created_at)) x
           JOIN chats ch ON ch.id = x.chat_id
       ) ev
       WHERE ($3::text IS NULL OR ev.kind = $3)
       ORDER BY at DESC LIMIT $4`,
      [tenantId, clientId, k, limit],
    );
  }

  // ── сохранённые виды ─────────────────────────────────────────────────────────────
  views(tenantId: string, userId: string) {
    return this.db.many<any>(`SELECT * FROM client_saved_views WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at`, [tenantId, userId]);
  }

  addView(tenantId: string, userId: string, name: string, filter: unknown, sort: unknown) {
    return this.db.one<{ id: string }>(
      `INSERT INTO client_saved_views (tenant_id, user_id, name, filter_json, sort_json) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb) RETURNING id`,
      [tenantId, userId, name, JSON.stringify(filter ?? {}), JSON.stringify(sort ?? {})],
    );
  }

  removeView(tenantId: string, userId: string, id: string) {
    return this.db.query(`DELETE FROM client_saved_views WHERE tenant_id = $1 AND user_id = $2 AND id = $3`, [tenantId, userId, id]);
  }
}
