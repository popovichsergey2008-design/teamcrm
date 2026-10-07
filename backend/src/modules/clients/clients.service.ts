import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SecurityService } from '../security/security.service';
import { can, maskContact, Permission, PermissionMap, scopeOf } from '../security/permissions';
import { REVIEW_COLUMN_NAMES } from '../tasks/task-columns';
import { readTable, splitHeader } from '../integrations/file/table-read';
import { ClientScope, ClientsRepository, ListFilters } from './clients.repository';
import {
  clientHealth, clientSummary, DEAL_STAGES, normalizeDomain, normalizeEmail, normalizeName, normalizePhone, OPEN_DEAL_STAGES,
} from './client-rules';
import { CLIENT_FIELDS, ClientField, FIELD_TITLES, guessMapping, parseRow } from './client-import';

export type Me = { tenantId: string; userId: string; role: string };
type Ctx = { perms: PermissionMap; scope: ClientScope; boss: boolean };

const CONTACT_FIELDS = ['phone', 'email', 'telegram', 'whatsapp'] as const;
type ContactField = (typeof CONTACT_FIELDS)[number];

/**
 * Раздел «Клиенты» (ТЗ-17).
 *
 * Права решает сервер (п. 74): видеть — `client.view` (охват «только свои» —
 * scope `assigned`), заводить/править/архивировать/удалять/выгружать — свои права,
 * контакты — существующие `contact.*` слоя безопасности, сделки — `crm.*`.
 * Удаление по умолчанию — архив (п. 48); удалить насовсем — отдельное право.
 */
@Injectable()
export class ClientsService {
  constructor(
    private readonly repo: ClientsRepository,
    private readonly security: SecurityService,
    private readonly realtime: RealtimeService,
    private readonly db: DbService,
  ) {}

  private async ctx(me: Me, need: Permission = 'client.view', what?: string): Promise<Ctx> {
    const perms = await this.security.permissionsOf(me.tenantId, me.userId);
    if (!can(perms, 'client.view')) throw AppException.forbidden('Раздел «Клиенты» вам закрыт — его открывает владелец организации');
    if (need !== 'client.view' && !can(perms, need)) throw AppException.forbidden(what ?? 'Это действие с клиентами вам не разрешено');
    return {
      perms,
      scope: { userId: me.userId, own: scopeOf(perms, 'client.view') === 'assigned' },
      boss: me.role === 'owner' || me.role === 'manager',
    };
  }

  private async client(me: Me, c: Ctx, id: string) {
    const row = await this.repo.visible(me.tenantId, id, c.scope);
    if (!row) throw AppException.notFound('Клиент не найден');
    return row;
  }

  private emit(me: Me, event: string, clientId: string) {
    this.realtime.emitToTenant(me.tenantId, event, { clientId });
  }

  // ── список ─────────────────────────────────────────────────────────────────────
  async list(me: Me, f: ListFilters) {
    const c = await this.ctx(me);
    const [res, counters] = await Promise.all([this.repo.list(me.tenantId, c.scope, f), this.repo.counters(me.tenantId, c.scope)]);
    const now = Date.now();
    return {
      items: res.rows.map((r) => {
        const days = r.activity_at ? Math.floor((now - new Date(r.activity_at).getTime()) / 86_400_000) : null;
        return {
          id: String(r.id), name: r.name, type: r.type, status: r.status, segment: r.segment, source: r.source,
          city: r.city, website: r.website, ownerId: r.owner_user_id ? String(r.owner_user_id) : null, ownerName: r.owner_name,
          archived: !!r.archived_at, createdAt: r.created_at, activityAt: r.activity_at,
          nextAction: r.next_action, nextActionAt: r.next_action_at, contacts: r.contacts, primaryContact: r.primary_contact || null,
          openDeals: r.open_deals, dealsAmount: r.deals_amount != null ? Number(r.deals_amount) : null,
          openTasks: r.open_tasks, overdueTasks: r.overdue_tasks,
          health: clientHealth({ overdueTasks: r.overdue_tasks, daysSinceActivity: days, dealStalledDays: r.open_deals ? r.stalled_days : null, status: r.status, archived: !!r.archived_at }),
        };
      }),
      total: res.total, page: res.page, pageSize: res.pageSize,
      counters,
      can: this.flags(c),
    };
  }

  private flags(c: Ctx) {
    return {
      create: can(c.perms, 'client.create'), edit: can(c.perms, 'client.edit'), archive: can(c.perms, 'client.archive'),
      delete: can(c.perms, 'client.delete'), export: can(c.perms, 'client.export'),
      deals: can(c.perms, 'crm.view'), editDeals: can(c.perms, 'crm.edit'),
      contacts: can(c.perms, 'contact.view'), reveal: can(c.perms, 'contact.reveal'),
    };
  }

  // ── создание и дубли ───────────────────────────────────────────────────────────
  async duplicates(me: Me, v: { name?: string; email?: string; phone?: string; website?: string; taxId?: string; excludeId?: string }) {
    await this.ctx(me);
    const rows = await this.repo.duplicates(me.tenantId, {
      name: normalizeName(v.name), email: normalizeEmail(v.email), phone: normalizePhone(v.phone),
      domain: normalizeDomain(v.website) ?? normalizeDomain(v.email), taxId: v.taxId?.replace(/\s/g, '') || null, excludeId: v.excludeId,
    });
    return rows.filter((r) => r.matched?.length).map((r) => ({
      id: String(r.id), name: r.name, website: r.website, archived: !!r.archived_at, matched: r.matched as string[],
    }));
  }

  /**
   * Быстрое создание (п. 17–18): название, тип, ответственный, телефон/почта, сайт,
   * источник. Похожий клиент уже есть — 409 со списком; «Создать всё равно» — force.
   * Объединять сами не объединяем никогда.
   */
  async create(me: Me, dto: any) {
    await this.ctx(me, 'client.create', 'Заводить клиентов вам не разрешено');
    const name = String(dto.name ?? '').trim();
    if (name.length < 2) throw AppException.validation('Укажите название или имя клиента');
    if (!dto.force) {
      const dups = await this.duplicates(me, { name, email: dto.email, phone: dto.phone, website: dto.website, taxId: dto.taxId });
      if (dups.length) throw AppException.conflict('Похоже, такой клиент уже есть', { duplicates: dups });
    }
    if (dto.ownerId && !(await this.repo.userInTenant(me.tenantId, dto.ownerId))) throw AppException.validation('Ответственный не найден');
    const row = await this.repo.create(me.tenantId, me.userId, {
      ...dto, name, normalizedName: normalizeName(name),
      domain: normalizeDomain(dto.website) ?? normalizeDomain(dto.email),
      ownerId: dto.ownerId === undefined ? me.userId : dto.ownerId, taxId: dto.taxId?.replace(/\s/g, '') || null,
      source: dto.source ?? 'manual',
    });
    const id = String(row!.id);
    if (dto.phone || dto.email || dto.telegram || dto.contactName) {
      const [first, ...rest] = String(dto.contactName ?? '').trim().split(/\s+/).filter(Boolean);
      await this.repo.addContact(me.tenantId, id, {
        firstName: first ?? (dto.type === 'person' ? name : 'Основной контакт'), lastName: rest.join(' ') || null,
        phone: dto.phone ?? null, phoneNorm: normalizePhone(dto.phone), email: dto.email ?? null, emailNorm: normalizeEmail(dto.email),
        telegram: dto.telegram ?? null, isPrimary: true,
      });
    }
    await this.repo.log(me.tenantId, id, me.userId, 'client', 'Клиент заведён');
    await this.security.record({ tenantId: me.tenantId, actorId: me.userId, event: 'client.created', resourceType: 'client', resourceId: id });
    this.emit(me, 'client.created', id);
    return { id };
  }

  async update(me: Me, id: string, dto: any) {
    const c = await this.ctx(me, 'client.edit', 'Править клиентов вам не разрешено');
    const before = await this.client(me, c, id);
    const patch: Record<string, unknown> = { ...dto };
    if (dto.name !== undefined) {
      const name = String(dto.name).trim();
      if (name.length < 2) throw AppException.validation('Название слишком короткое');
      patch.name = name;
      patch.normalizedName = normalizeName(name);
    }
    if (dto.website !== undefined) patch.domain = normalizeDomain(dto.website);
    if (dto.taxId !== undefined) patch.taxId = String(dto.taxId ?? '').replace(/\s/g, '') || null;
    if (dto.nextAction !== undefined) patch.nextActionSource = dto.nextAction ? 'manual' : null;
    if (dto.ownerId && !(await this.repo.userInTenant(me.tenantId, dto.ownerId))) throw AppException.validation('Ответственный не найден');
    await this.repo.update(me.tenantId, id, patch);
    if (dto.ownerId !== undefined && String(dto.ownerId ?? '') !== String(before.owner_user_id ?? '')) {
      const who = dto.ownerId ? (await this.repo.userInTenant(me.tenantId, dto.ownerId))?.full_name : null;
      await this.repo.log(me.tenantId, id, me.userId, 'client', who ? `Ответственный: ${who}` : 'Ответственный снят');
      await this.security.record({ tenantId: me.tenantId, actorId: me.userId, event: 'client.owner_changed', resourceType: 'client', resourceId: id, metadata: { to: dto.ownerId ?? null } });
    }
    if (dto.status !== undefined && dto.status !== before.status) await this.repo.log(me.tenantId, id, me.userId, 'client', `Статус: ${dto.status}`);
    if (dto.nextAction) await this.repo.log(me.tenantId, id, me.userId, 'client', `Следующее действие: ${dto.nextAction}`);
    this.emit(me, 'client.updated', id);
    return this.card(me, id);
  }

  async archive(me: Me, id: string, archived: boolean) {
    const c = await this.ctx(me, 'client.archive', 'Убирать клиентов в архив вам не разрешено');
    await this.client(me, c, id);
    await this.repo.setArchived(me.tenantId, id, archived);
    await this.repo.log(me.tenantId, id, me.userId, 'client', archived ? 'Клиент в архиве' : 'Клиент возвращён из архива');
    await this.security.record({ tenantId: me.tenantId, actorId: me.userId, event: archived ? 'client.archived' : 'client.restored', resourceType: 'client', resourceId: id });
    this.emit(me, 'client.archived', id);
    return { ok: true };
  }

  /** Насовсем — только из архива и только с отдельным правом (п. 48, 91). */
  async remove(me: Me, id: string) {
    const c = await this.ctx(me, 'client.delete', 'Удалять клиентов насовсем вам не разрешено');
    const row = await this.client(me, c, id);
    if (!row.archived_at) throw AppException.conflict('Сначала уберите клиента в архив');
    await this.security.record({ tenantId: me.tenantId, actorId: me.userId, event: 'client.deleted', resourceType: 'client', resourceId: id, metadata: { name: row.name } });
    await this.repo.hardDelete(me.tenantId, id);
    return { ok: true };
  }

  // ── карточка одним запросом (п. 64) ────────────────────────────────────────────
  async card(me: Me, id: string) {
    const c = await this.ctx(me);
    const row = await this.client(me, c, id);
    const [contacts, members, deals, projects, openTasks, overdue, meetings, pinned] = await Promise.all([
      this.contactsView(me, c, id),
      this.repo.members(id),
      can(c.perms, 'crm.view') ? this.repo.deals(id) : Promise.resolve([]),
      this.repo.projects(me.tenantId, id),
      this.repo.tasks(me.tenantId, id, 'open', REVIEW_COLUMN_NAMES),
      this.repo.tasks(me.tenantId, id, 'overdue', REVIEW_COLUMN_NAMES),
      this.repo.meetings(me.tenantId, id),
      this.repo.notes(id, me.userId, c.boss).then((n) => n.filter((x) => x.pinned).slice(0, 3)),
    ]);
    const now = new Date();
    const upcoming = meetings.filter((m) => new Date(m.starts_at) > now).sort((a, b) => +new Date(a.starts_at) - +new Date(b.starts_at));
    const past = meetings.filter((m) => new Date(m.starts_at) <= now);
    const lastAct = (await this.repo.activity(me.tenantId, id, null, 1))[0] ?? null;
    const openDeals = deals.filter((d) => OPEN_DEAL_STAGES.includes(d.stage));

    // Следующее действие (п. 42): записанное руками, иначе — ближайшая встреча или задача со сроком.
    const nearestTask = openTasks.filter((t) => t.deadline_at).sort((a, b) => +new Date(a.deadline_at) - +new Date(b.deadline_at))[0];
    const nextAction = row.next_action
      ? { text: row.next_action, at: row.next_action_at, source: row.next_action_source ?? 'manual' }
      : upcoming[0] ? { text: `Встреча «${upcoming[0].title}»`, at: upcoming[0].starts_at, source: 'meeting' }
      : nearestTask ? { text: `Задача «${nearestTask.title}»`, at: nearestTask.deadline_at, source: 'task' }
      : null;

    const summary = clientSummary({
      now, status: row.status,
      lastActivityAt: lastAct?.at ?? row.last_activity_at, lastActivityTitle: lastAct?.title ?? null,
      openDeals: openDeals.map((d) => ({ id: String(d.id), title: d.title, amount: d.amount != null ? Number(d.amount) : null, currency: d.currency, stage: d.stage, updatedAt: d.updated_at })),
      openTasks: openTasks.length, overdueTasks: overdue.map((t) => ({ id: String(t.id), title: t.title })),
      nextMeeting: upcoming[0] ? { id: String(upcoming[0].id), title: upcoming[0].title, startsAt: upcoming[0].starts_at } : null,
      nextAction: row.next_action ? { text: row.next_action, at: row.next_action_at } : null,
    });
    const daysSince = lastAct?.at ? Math.floor((now.getTime() - new Date(lastAct.at).getTime()) / 86_400_000) : null;
    const stalled = openDeals.length ? Math.max(...openDeals.map((d) => Math.floor((now.getTime() - new Date(d.updated_at).getTime()) / 86_400_000))) : null;

    return {
      client: {
        id: String(row.id), name: row.name, type: row.type, legalName: row.legal_name, status: row.status, segment: row.segment,
        source: row.source, ownerId: row.owner_user_id ? String(row.owner_user_id) : null, ownerName: row.owner_name,
        departmentId: row.department_id ? String(row.department_id) : null, departmentName: row.department_name,
        website: row.website, country: row.country, city: row.city, address: row.address, taxId: row.tax_id,
        registrationNumber: row.registration_number, description: row.description,
        archived: !!row.archived_at, createdAt: row.created_at, lastActivityAt: lastAct?.at ?? row.last_activity_at,
        nextAction: row.next_action, nextActionAt: row.next_action_at,
      },
      nextAction,
      health: clientHealth({ overdueTasks: overdue.length, daysSinceActivity: daysSince, dealStalledDays: stalled, status: row.status, archived: !!row.archived_at }),
      summary,
      contacts,
      team: members.map((m) => ({ userId: String(m.user_id), role: m.role, name: m.full_name, avatarUrl: m.avatar_file_id ? `/api/files/${m.avatar_file_id}` : null })),
      deals: deals.map(presentDeal),
      projects: projects.map((p) => ({ id: String(p.id), name: p.name, status: p.status, pmName: p.pm_name, total: p.total, done: p.done })),
      tasks: { open: openTasks.length, overdue: overdue.length, top: openTasks.slice(0, 5).map(presentTask) },
      meetings: { upcoming: upcoming.slice(0, 5).map(presentMeeting), past: past.slice(0, 5).map(presentMeeting) },
      pinnedNotes: pinned.map(presentNote),
      can: this.flags(c),
    };
  }

  async brief(me: Me, id: string) {
    const c = await this.ctx(me);
    const row = await this.client(me, c, id);
    return { id: String(row.id), name: row.name, status: row.status, archived: !!row.archived_at };
  }

  // ── контакты (п. 23–28) ─────────────────────────────────────────────────────────
  private async contactsView(me: Me, c: Ctx, clientId: string) {
    if (!can(c.perms, 'contact.view')) return { hidden: true, items: [] as any[], canReveal: false, requireReason: false };
    const policy = await this.security.policyOf(me.tenantId);
    const masked = policy.contacts.defaultAccess === 'masked';
    const rows = await this.repo.contacts(clientId);
    const items = [];
    for (const r of rows) {
      const fields: Record<string, { value: string | null; masked: boolean }> = {};
      for (const f of CONTACT_FIELDS) {
        const v = r[f] as string | null;
        if (!v) { fields[f] = { value: null, masked: false }; continue; }
        const open = !masked || await this.repo.revealedRecently(me.tenantId, me.userId, String(r.id), f, policy.contacts.revealTtlSeconds);
        // Полное значение при маске наружу не уходит — маску считает сервер (п. 26).
        fields[f] = { value: open ? v : maskContact(v, f === 'phone' || f === 'whatsapp' ? 'phone' : f === 'email' ? 'email' : 'text'), masked: !open };
      }
      items.push({
        id: String(r.id), firstName: r.first_name, lastName: r.last_name, position: r.position,
        preferredChannel: r.preferred_channel, isPrimary: r.is_primary, fields,
      });
    }
    return { hidden: false, items, canReveal: can(c.perms, 'contact.reveal'), requireReason: policy.contacts.requireReason };
  }

  async contacts(me: Me, clientId: string) {
    const c = await this.ctx(me);
    await this.client(me, c, clientId);
    return this.contactsView(me, c, clientId);
  }

  private contactValues(dto: any) {
    return {
      firstName: dto.firstName?.trim(), lastName: dto.lastName, position: dto.position,
      phone: dto.phone, phoneNorm: dto.phone !== undefined ? normalizePhone(dto.phone) : undefined,
      email: dto.email, emailNorm: dto.email !== undefined ? normalizeEmail(dto.email) : undefined,
      telegram: dto.telegram, whatsapp: dto.whatsapp, preferredChannel: dto.preferredChannel, isPrimary: dto.isPrimary,
    };
  }

  async addContact(me: Me, clientId: string, dto: any) {
    const c = await this.ctx(me, 'client.edit', 'Править клиентов вам не разрешено');
    await this.client(me, c, clientId);
    if (!dto.firstName?.trim()) throw AppException.validation('Укажите имя контакта');
    if (dto.email && !normalizeEmail(dto.email)) throw AppException.validation('Почта не похожа на адрес');
    const row = await this.repo.addContact(me.tenantId, clientId, this.contactValues(dto));
    await this.repo.log(me.tenantId, clientId, me.userId, 'contact', `Добавлен контакт: ${dto.firstName} ${dto.lastName ?? ''}`.trim(), { type: 'contact', id: String(row!.id) });
    this.emit(me, 'client.contact.created', clientId);
    return this.contactsView(me, c, clientId);
  }

  async updateContact(me: Me, contactId: string, dto: any) {
    const c = await this.ctx(me, 'client.edit', 'Править клиентов вам не разрешено');
    const ct = await this.repo.contact(me.tenantId, contactId);
    if (!ct) throw AppException.notFound('Контакт не найден');
    await this.client(me, c, String(ct.client_id));
    if (dto.email && !normalizeEmail(dto.email)) throw AppException.validation('Почта не похожа на адрес');
    await this.repo.updateContact(me.tenantId, contactId, String(ct.client_id), this.contactValues(dto));
    await this.repo.log(me.tenantId, String(ct.client_id), me.userId, 'contact', `Изменён контакт: ${ct.first_name}`, { type: 'contact', id: contactId });
    this.emit(me, 'client.contact.updated', String(ct.client_id));
    return this.contactsView(me, c, String(ct.client_id));
  }

  async removeContact(me: Me, contactId: string) {
    const c = await this.ctx(me, 'client.edit', 'Править клиентов вам не разрешено');
    const ct = await this.repo.contact(me.tenantId, contactId);
    if (!ct) throw AppException.notFound('Контакт не найден');
    await this.client(me, c, String(ct.client_id));
    await this.repo.archiveContact(me.tenantId, contactId);
    await this.repo.log(me.tenantId, String(ct.client_id), me.userId, 'contact', `Убран контакт: ${ct.first_name}`);
    return this.contactsView(me, c, String(ct.client_id));
  }

  /** Показать поле контакта: право, причина по политике, журнал (п. 26–28). */
  async reveal(me: Me, contactId: string, field: string, reason: string | null, meta: { ip: string | null; deviceId: string | null }) {
    const c = await this.ctx(me);
    if (!can(c.perms, 'contact.reveal')) throw AppException.forbidden('Раскрывать контакты вам не разрешено');
    if (!(CONTACT_FIELDS as readonly string[]).includes(field)) throw AppException.validation('Неизвестное поле контакта');
    const ct = await this.repo.contact(me.tenantId, contactId);
    if (!ct) throw AppException.notFound('Контакт не найден');
    await this.client(me, c, String(ct.client_id));
    const policy = await this.security.policyOf(me.tenantId);
    if (policy.contacts.requireReason && !String(reason ?? '').trim()) {
      throw AppException.validation('Укажите, зачем нужен контакт — этого требует политика компании');
    }
    await this.repo.logReveal({ tenantId: me.tenantId, userId: me.userId, clientId: String(ct.client_id), contactId, field, reason, ip: meta.ip, deviceId: meta.deviceId });
    await this.security.record({
      tenantId: me.tenantId, actorId: me.userId, event: 'contact.revealed', resourceType: 'client', resourceId: String(ct.client_id),
      ip: meta.ip, deviceId: meta.deviceId, metadata: { field, contactId, reason },
    });
    await this.repo.log(me.tenantId, String(ct.client_id), me.userId, 'reveal', `Открыт контакт: ${ct.first_name} (${field})`);
    return { field, value: ct[field as ContactField] ?? null, ttlSeconds: policy.contacts.revealTtlSeconds };
  }

  // ── команда ─────────────────────────────────────────────────────────────────────
  async setMember(me: Me, clientId: string, userId: string, role: string) {
    const c = await this.ctx(me, 'client.edit', 'Править клиентов вам не разрешено');
    await this.client(me, c, clientId);
    const u = await this.repo.userInTenant(me.tenantId, userId);
    if (!u) throw AppException.validation('Сотрудник не найден');
    await this.repo.setMember(me.tenantId, clientId, userId, role);
    await this.repo.log(me.tenantId, clientId, me.userId, 'client', `В команде клиента: ${u.full_name}`);
    return this.card(me, clientId);
  }

  async removeMember(me: Me, clientId: string, userId: string) {
    const c = await this.ctx(me, 'client.edit', 'Править клиентов вам не разрешено');
    await this.client(me, c, clientId);
    await this.repo.removeMember(clientId, userId);
    return this.card(me, clientId);
  }

  // ── заметки ─────────────────────────────────────────────────────────────────────
  async notes(me: Me, clientId: string) {
    const c = await this.ctx(me);
    await this.client(me, c, clientId);
    return (await this.repo.notes(clientId, me.userId, c.boss)).map(presentNote);
  }

  async addNote(me: Me, clientId: string, dto: { body: string; pinned?: boolean; isPrivate?: boolean }) {
    const c = await this.ctx(me);
    await this.client(me, c, clientId);
    const body = String(dto.body ?? '').trim();
    if (!body) throw AppException.validation('Пустая заметка');
    const n = await this.repo.addNote(me.tenantId, clientId, me.userId, body, !!dto.pinned, !!dto.isPrivate);
    // личную заметку в ленту не выносим — её содержимое не для всех
    if (!dto.isPrivate) await this.repo.log(me.tenantId, clientId, me.userId, 'note', `Заметка: ${body.slice(0, 120)}`, { type: 'note', id: String(n!.id) });
    else await this.repo.touch(me.tenantId, clientId);
    return this.notes(me, clientId);
  }

  async updateNote(me: Me, noteId: string, dto: { body?: string; pinned?: boolean; isPrivate?: boolean }) {
    const c = await this.ctx(me);
    const n = await this.repo.note(me.tenantId, noteId);
    if (!n) throw AppException.notFound('Заметка не найдена');
    await this.client(me, c, String(n.client_id));
    const mine = String(n.author_id) === String(me.userId);
    // текст правит только автор; закрепить может любой, кто правит клиента
    if ((dto.body !== undefined || dto.isPrivate !== undefined) && !mine) throw AppException.forbidden('Править чужую заметку нельзя');
    if (dto.pinned !== undefined && !mine && !can(c.perms, 'client.edit')) throw AppException.forbidden('Закреплять заметки вам не разрешено');
    await this.repo.updateNote(noteId, dto);
    return this.notes(me, String(n.client_id));
  }

  async deleteNote(me: Me, noteId: string) {
    const c = await this.ctx(me);
    const n = await this.repo.note(me.tenantId, noteId);
    if (!n) throw AppException.notFound('Заметка не найдена');
    await this.client(me, c, String(n.client_id));
    if (String(n.author_id) !== String(me.userId) && !c.boss) throw AppException.forbidden('Удалить можно только свою заметку');
    await this.repo.deleteNote(noteId);
    return this.notes(me, String(n.client_id));
  }

  // ── сделки (п. 29–30) ───────────────────────────────────────────────────────────
  async deals(me: Me, clientId: string) {
    const c = await this.ctx(me, 'crm.view', 'Сделки вам не открыты');
    await this.client(me, c, clientId);
    return (await this.repo.deals(clientId)).map(presentDeal);
  }

  private dealValues(dto: any) {
    if (dto.stage !== undefined && !(DEAL_STAGES as readonly string[]).includes(dto.stage)) throw AppException.validation('Неизвестная стадия сделки');
    return dto;
  }

  async addDeal(me: Me, clientId: string, dto: any) {
    const c = await this.ctx(me, 'crm.edit', 'Заводить сделки вам не разрешено');
    await this.client(me, c, clientId);
    if (!String(dto.title ?? '').trim()) throw AppException.validation('Назовите сделку');
    const d = await this.repo.addDeal(me.tenantId, clientId, { ...this.dealValues(dto), ownerId: dto.ownerId ?? me.userId });
    await this.repo.log(me.tenantId, clientId, me.userId, 'deal', `Сделка: ${dto.title}`, { type: 'deal', id: String(d!.id) });
    this.emit(me, 'client.deal.updated', clientId);
    return this.deals(me, clientId);
  }

  async updateDeal(me: Me, dealId: string, dto: any) {
    const c = await this.ctx(me, 'crm.edit', 'Править сделки вам не разрешено');
    const d = await this.repo.deal(me.tenantId, dealId);
    if (!d || !d.client_id) throw AppException.notFound('Сделка не найдена');
    await this.client(me, c, String(d.client_id));
    await this.repo.updateDeal(me.tenantId, dealId, this.dealValues(dto));
    if (dto.stage && dto.stage !== d.stage) await this.repo.log(me.tenantId, String(d.client_id), me.userId, 'deal', `Сделка «${d.title}»: ${STAGE_RU[dto.stage] ?? dto.stage}`, { type: 'deal', id: dealId });
    this.emit(me, 'client.deal.updated', String(d.client_id));
    return this.deals(me, String(d.client_id));
  }

  async removeDeal(me: Me, dealId: string) {
    const c = await this.ctx(me, 'crm.edit', 'Править сделки вам не разрешено');
    const d = await this.repo.deal(me.tenantId, dealId);
    if (!d || !d.client_id) throw AppException.notFound('Сделка не найдена');
    await this.client(me, c, String(d.client_id));
    await this.repo.archiveDeal(me.tenantId, dealId);
    await this.repo.log(me.tenantId, String(d.client_id), me.userId, 'deal', `Сделка убрана: ${d.title}`);
    return this.deals(me, String(d.client_id));
  }

  // ── связи ───────────────────────────────────────────────────────────────────────
  async projects(me: Me, clientId: string) {
    const c = await this.ctx(me);
    await this.client(me, c, clientId);
    return (await this.repo.projects(me.tenantId, clientId)).map((p) => ({ id: String(p.id), name: p.name, status: p.status, pmName: p.pm_name, total: p.total, done: p.done }));
  }

  async linkProject(me: Me, clientId: string, projectId: string, unlink = false) {
    const c = await this.ctx(me, 'client.edit', 'Править клиентов вам не разрешено');
    await this.client(me, c, clientId);
    await this.repo.linkProject(me.tenantId, clientId, unlink ? null : projectId, unlink ? projectId : undefined);
    await this.repo.log(me.tenantId, clientId, me.userId, 'project', unlink ? 'Проект отвязан' : 'Проект привязан', { type: 'project', id: projectId });
    return this.projects(me, clientId);
  }

  async tasks(me: Me, clientId: string, filter: string) {
    const c = await this.ctx(me);
    await this.client(me, c, clientId);
    return (await this.repo.tasks(me.tenantId, clientId, filter, REVIEW_COLUMN_NAMES)).map(presentTask);
  }

  async meetings(me: Me, clientId: string) {
    const c = await this.ctx(me);
    await this.client(me, c, clientId);
    const now = Date.now();
    const all = (await this.repo.meetings(me.tenantId, clientId)).map(presentMeeting);
    return { upcoming: all.filter((m) => +new Date(m.startsAt) > now).reverse(), past: all.filter((m) => +new Date(m.startsAt) <= now) };
  }

  async chats(me: Me, clientId: string) {
    const c = await this.ctx(me);
    await this.client(me, c, clientId);
    return (await this.repo.chats(me.tenantId, clientId, me.userId)).map((r) => ({
      id: String(r.id), title: r.title, kind: r.kind, external: !!r.is_external, lastMessageAt: r.last_message_at,
    }));
  }

  async files(me: Me, clientId: string) {
    const c = await this.ctx(me);
    await this.client(me, c, clientId);
    return (await this.repo.files(clientId)).map((f) => ({
      id: String(f.id), fileId: String(f.file_id), name: f.file_name, contentType: f.content_type, size: Number(f.size_bytes),
      category: f.category, uploadedBy: f.uploaded_by_name, createdAt: f.created_at,
    }));
  }

  async addFile(me: Me, clientId: string, fileId: string, category: string) {
    const c = await this.ctx(me, 'client.edit', 'Править клиентов вам не разрешено');
    await this.client(me, c, clientId);
    const f = await this.repo.fileOwned(me.tenantId, fileId);
    if (!f) throw AppException.notFound('Файл не найден');
    await this.repo.addFile(me.tenantId, clientId, fileId, category, me.userId);
    await this.repo.log(me.tenantId, clientId, me.userId, 'file', `Файл: ${f.file_name}`, { type: 'file', id: fileId });
    await this.security.record({ tenantId: me.tenantId, actorId: me.userId, event: 'client.file_attached', resourceType: 'client', resourceId: clientId, metadata: { fileId } });
    return this.files(me, clientId);
  }

  async removeFile(me: Me, clientId: string, id: string) {
    const c = await this.ctx(me, 'client.edit', 'Править клиентов вам не разрешено');
    await this.client(me, c, clientId);
    if (!(await this.repo.removeFile(me.tenantId, clientId, id))) throw AppException.notFound('Файл не найден');
    return this.files(me, clientId);
  }

  async activity(me: Me, clientId: string, kind: string | null) {
    const c = await this.ctx(me);
    await this.client(me, c, clientId);
    return (await this.repo.activity(me.tenantId, clientId, kind, 200)).map((a) => ({
      id: a.id, kind: a.kind, title: a.title, at: a.at, actor: a.actor_name, entityType: a.entity_type, entityId: a.entity_id,
    }));
  }

  // ── сохранённые виды, массовые действия, выгрузка (п. 15, 53–54) ───────────────
  async views(me: Me) { await this.ctx(me); return (await this.repo.views(me.tenantId, me.userId)).map((v) => ({ id: String(v.id), name: v.name, filter: v.filter_json, sort: v.sort_json })); }
  async addView(me: Me, name: string, filter: unknown, sort: unknown) { await this.ctx(me); await this.repo.addView(me.tenantId, me.userId, name.trim().slice(0, 80), filter, sort); return this.views(me); }
  async removeView(me: Me, id: string) { await this.ctx(me); await this.repo.removeView(me.tenantId, me.userId, id); return this.views(me); }

  async bulk(me: Me, ids: string[], action: string, value: string | null) {
    const need: Permission = action === 'archive' ? 'client.archive' : 'client.edit';
    const c = await this.ctx(me, need, 'Это действие с клиентами вам не разрешено');
    const visible = (await this.repo.list(me.tenantId, c.scope, { ids, page: 1, view: action === 'restore' ? 'archive' : 'all' })).rows.map((r) => String(r.id));
    if (action === 'owner' && value && !(await this.repo.userInTenant(me.tenantId, value))) throw AppException.validation('Ответственный не найден');
    for (const id of visible) {
      if (action === 'owner') await this.repo.update(me.tenantId, id, { ownerId: value });
      else if (action === 'status') await this.repo.update(me.tenantId, id, { status: value });
      else if (action === 'segment') await this.repo.update(me.tenantId, id, { segment: value });
      else if (action === 'archive') await this.repo.setArchived(me.tenantId, id, true);
      else throw AppException.validation('Неизвестное действие');
      await this.repo.log(me.tenantId, id, me.userId, 'client', `Массово: ${BULK_RU[action]}${value ? ` → ${value}` : ''}`);
    }
    return { updated: visible.length };
  }

  /** CSV для Excel: «;» и BOM. Контакты — по политике маски: выгрузка не обходит защиту. */
  async exportCsv(me: Me, f: ListFilters) {
    const c = await this.ctx(me, 'client.export', 'Выгружать клиентов вам не разрешено');
    const all: any[] = [];
    for (let page = 1; page <= 100; page++) {
      const r = await this.repo.list(me.tenantId, c.scope, { ...f, page });
      all.push(...r.rows);
      if (all.length >= r.total || !r.rows.length) break;
    }
    const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Название', 'Тип', 'Статус', 'Сегмент', 'Источник', 'Ответственный', 'Город', 'Сайт', 'Основной контакт', 'Открытых сделок', 'Сумма сделок', 'Открытых задач', 'Просрочено', 'Последняя активность'];
    const lines = all.map((r) => [r.name, r.type === 'person' ? 'частное лицо' : 'компания', r.status, r.segment, r.source, r.owner_name, r.city, r.website,
      r.primary_contact, r.open_deals, r.deals_amount, r.open_tasks, r.overdue_tasks, r.activity_at ? new Date(r.activity_at).toISOString().slice(0, 10) : ''].map(cell).join(';'));
    await this.security.record({ tenantId: me.tenantId, actorId: me.userId, event: 'client.exported', resourceType: 'client', metadata: { count: all.length, filters: f } });
    return `﻿${[head.map(cell).join(';'), ...lines].join('\r\n')}`;
  }

  // ── объединение дублей (п. 49) ──────────────────────────────────────────────────
  async mergePreview(me: Me, keepId: string, dropId: string) {
    const c = await this.ctx(me, 'client.edit', 'Объединять клиентов вам не разрешено');
    if (keepId === dropId) throw AppException.validation('Выберите двух разных клиентов');
    const [a, b] = await Promise.all([this.client(me, c, keepId), this.client(me, c, dropId)]);
    const count = async (id: string) => this.db.one<any>(
      `SELECT (SELECT count(*) FROM client_contacts WHERE client_id = $1 AND archived_at IS NULL)::int AS contacts,
              (SELECT count(*) FROM deals WHERE client_id = $1 AND archived_at IS NULL)::int AS deals,
              (SELECT count(*) FROM projects WHERE client_id = $1)::int AS projects,
              (SELECT count(*) FROM client_notes WHERE client_id = $1 AND deleted_at IS NULL)::int AS notes,
              (SELECT count(*) FROM client_files WHERE client_id = $1)::int AS files,
              (SELECT count(*) FROM tasks WHERE client_id = $1)::int AS tasks`, [id]);
    const [ca, cb] = await Promise.all([count(keepId), count(dropId)]);
    return {
      keep: { id: keepId, name: a.name, website: a.website, ownerName: a.owner_name, status: a.status, ...ca },
      drop: { id: dropId, name: b.name, website: b.website, ownerName: b.owner_name, status: b.status, ...cb },
    };
  }

  /** Всё со второго переезжает на первого; второй — в архив с пометкой. Журнал обязателен. */
  async merge(me: Me, keepId: string, dropId: string, nameFrom: 'keep' | 'drop') {
    const p = await this.mergePreview(me, keepId, dropId);
    const t = me.tenantId;
    await this.db.withTransaction(async (q) => {
      // основной контакт остаётся у оставляемого клиента
      await q.query(`UPDATE client_contacts SET is_primary = FALSE WHERE client_id = $1 AND EXISTS (SELECT 1 FROM client_contacts WHERE client_id = $2 AND is_primary AND archived_at IS NULL)`, [dropId, keepId]);
      for (const table of ['client_contacts', 'deals', 'projects', 'client_notes', 'client_files', 'client_activity', 'tasks', 'calendar_events', 'meetings', 'chats', 'contact_reveals']) {
        await q.query(`UPDATE ${table} SET client_id = $2 WHERE tenant_id = $3 AND client_id = $1`, [dropId, keepId, t]);
      }
      await q.query(`UPDATE users SET client_id = $2 WHERE tenant_id = $3 AND client_id = $1`, [dropId, keepId, t]);
      await q.query(`UPDATE conversation_links SET entity_id = $2 WHERE entity_type = 'client' AND entity_id = $1`, [dropId, keepId]);
      await q.query(`INSERT INTO client_members (tenant_id, client_id, user_id, role)
                     SELECT tenant_id, $2, user_id, role FROM client_members WHERE client_id = $1 ON CONFLICT DO NOTHING`, [dropId, keepId]);
      if (nameFrom === 'drop') await q.query(`UPDATE clients SET name = $2, normalized_name = $3 WHERE id = $1`, [keepId, p.drop.name, normalizeName(p.drop.name)]);
      await q.query(`UPDATE clients SET archived_at = now(), name = left(name || ' (объединён)', 160) WHERE id = $1`, [dropId]);
    });
    await this.repo.log(t, keepId, me.userId, 'client', `Объединён с «${p.drop.name}»`);
    await this.security.record({ tenantId: t, actorId: me.userId, event: 'client.merged', resourceType: 'client', resourceId: keepId, metadata: { dropId, dropName: p.drop.name } });
    this.emit(me, 'client.updated', keepId);
    return { id: keepId };
  }

  // ── импорт (п. 50–52) ───────────────────────────────────────────────────────────
  async importPreview(me: Me, file: { originalname: string; buffer: Buffer }) {
    await this.ctx(me, 'client.create', 'Заводить клиентов вам не разрешено');
    const { headers, rows } = await this.readFile(file);
    const mapping = guessMapping(headers);
    return {
      headers, mapping, total: rows.length, sample: rows.slice(0, 20),
      fields: CLIENT_FIELDS.map((f) => ({ key: f, title: FIELD_TITLES[f] })),
    };
  }

  private async readFile(file: { originalname: string; buffer: Buffer }) {
    try {
      return splitHeader(await readTable(file.originalname, file.buffer));
    } catch (e) {
      throw AppException.validation(e instanceof Error ? e.message : 'Файл не читается');
    }
  }

  /**
   * Импорт: плохая строка не ломает остальные; похожий на существующего — не
   * создаём, а кладём «на проверку» (объединять сами не объединяем).
   */
  async importRun(me: Me, file: { originalname: string; buffer: Buffer }, mapping: Record<string, ClientField | null>, onDuplicate: 'skip' | 'create') {
    await this.ctx(me, 'client.create', 'Заводить клиентов вам не разрешено');
    const { headers, rows } = await this.readFile(file);
    const users = await this.db.many<{ id: string; full_name: string; email: string }>(`SELECT id, full_name, email FROM users WHERE tenant_id = $1 AND is_active`, [me.tenantId]);
    const findOwner = (hint: string | null) => {
      if (!hint) return null;
      const h = hint.toLowerCase().trim();
      return users.find((u) => u.email?.toLowerCase() === h || u.full_name?.toLowerCase() === h || u.full_name?.toLowerCase().startsWith(h))?.id ?? null;
    };
    const report = { total: rows.length, imported: 0, skipped: 0, review: 0, errors: [] as { row: number; reason: string; name?: string }[] };
    for (let i = 0; i < rows.length; i++) {
      const r = parseRow(rows[i], headers, mapping);
      if (!r.ok) { report.skipped++; report.errors.push({ row: i + 2, reason: r.error ?? 'ошибка' }); continue; }
      const dups = await this.duplicates(me, { name: r.client.name, email: r.contact?.email ?? undefined, phone: r.contact?.phone ?? undefined, website: r.client.website ?? undefined, taxId: r.client.taxId ?? undefined });
      if (dups.length && onDuplicate === 'skip') {
        report.review++;
        report.errors.push({ row: i + 2, reason: `похож на «${dups[0].name}» (${dups[0].matched.join(', ')})`, name: r.client.name });
        continue;
      }
      try {
        const created = await this.repo.create(me.tenantId, me.userId, {
          ...r.client, normalizedName: normalizeName(r.client.name), ownerId: findOwner(r.client.ownerHint) ?? me.userId,
        });
        if (r.contact) await this.repo.addContact(me.tenantId, String(created!.id), { ...r.contact, isPrimary: true });
        await this.repo.log(me.tenantId, String(created!.id), me.userId, 'client', 'Клиент импортирован из файла');
        report.imported++;
      } catch (e) {
        report.skipped++;
        report.errors.push({ row: i + 2, reason: e instanceof Error ? e.message.slice(0, 120) : 'ошибка', name: r.client.name });
      }
    }
    await this.security.record({ tenantId: me.tenantId, actorId: me.userId, event: 'client.imported', resourceType: 'client', metadata: { ...report, errors: report.errors.length } });
    this.realtime.emitToTenant(me.tenantId, 'client.created', {});
    return { ...report, errors: report.errors.slice(0, 200) };
  }

  /** Подсказки: сотрудники и отделы для выбора ответственного и отдела. */
  async options(me: Me) {
    await this.ctx(me);
    const [users, groups, segments] = await Promise.all([
      this.db.many<any>(`SELECT u.id, u.full_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.tenant_id = $1 AND u.is_active AND r.code <> 'client' ORDER BY u.full_name`, [me.tenantId]),
      this.db.many<any>(`SELECT id, name FROM groups WHERE tenant_id = $1 ORDER BY name`, [me.tenantId]).catch(() => []),
      this.db.many<any>(`SELECT DISTINCT segment FROM clients WHERE tenant_id = $1 AND segment IS NOT NULL ORDER BY segment`, [me.tenantId]),
    ]);
    return {
      users: users.map((u) => ({ id: String(u.id), name: u.full_name })),
      departments: groups.map((g) => ({ id: String(g.id), name: g.name })),
      segments: [...new Set(['VIP', 'Key Account', 'Standard', 'Potential', 'Partner', 'Supplier', ...segments.map((s) => s.segment)])],
    };
  }
}

const STAGE_RU: Record<string, string> = { new: 'новая', negotiation: 'переговоры', proposal: 'предложение', approval: 'согласование', won: 'выиграна', lost: 'проиграна' };
const BULK_RU: Record<string, string> = { owner: 'ответственный', status: 'статус', segment: 'сегмент', archive: 'в архив' };

function presentDeal(d: any) {
  return {
    id: String(d.id), title: d.title, stage: d.stage, amount: d.amount != null ? Number(d.amount) : null, currency: d.currency,
    probability: d.probability, ownerId: d.owner_user_id ? String(d.owner_user_id) : null, ownerName: d.owner_name ?? null,
    nextAction: d.next_action, closeDate: d.close_date, lostReason: d.lost_reason, projectId: d.project_id ? String(d.project_id) : null,
    updatedAt: d.updated_at,
  };
}
function presentTask(t: any) {
  return {
    id: String(t.id), title: t.title, projectId: t.project_id ? String(t.project_id) : null, projectName: t.project_name,
    deadlineAt: t.deadline_at, priority: t.priority, closed: !!t.closed_at, assigneeName: t.assignee_name, column: t.column_name,
  };
}
function presentMeeting(m: any) {
  return { kind: m.kind, id: String(m.id), title: m.title, startsAt: m.starts_at, endsAt: m.ends_at, roomId: m.meet_room_id ?? null };
}
function presentNote(n: any) {
  return { id: String(n.id), body: n.body, pinned: n.pinned, isPrivate: n.is_private, authorId: n.author_id ? String(n.author_id) : null, authorName: n.author_name ?? null, createdAt: n.created_at };
}
