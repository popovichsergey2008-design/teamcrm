import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { SecurityRepository } from './security.repository';
import {
  can, capGrants, effectivePermissions, isPermission, isScope, maskContact, mergePolicy,
  Permission, PermissionMap, SecurityPolicy,
} from './permissions';

/**
 * Централизованная безопасность (ТЗ «Central Security System»).
 *
 * Слой отвечает на один вопрос: «можно ли этому человеку сделать это прямо сейчас» —
 * и сам же записывает, что было сделано. Проверка живёт на сервере намеренно и
 * подчёркнуто: скрытая кнопка и замазанное поле в интерфейсе защитой не являются,
 * их обходит любой, кто открыл вкладку «сеть» в браузере.
 *
 * Права складываются тремя слоями (базовая роль → своя роль компании → личная
 * поправка), правила сложения живут в `permissions.ts` и проверяются тестами.
 */
@Injectable()
export class SecurityService {
  private readonly log = new Logger('Security');

  constructor(private readonly repo: SecurityRepository) {}

  /** Итоговые права человека. Нет такого сотрудника — прав нет вовсе. */
  async permissionsOf(tenantId: string, userId: string): Promise<PermissionMap> {
    const member = await this.repo.member(tenantId, userId);
    if (!member) return {};
    const overrides = await this.repo.overrides(tenantId, userId);
    return effectivePermissions(member.base_role, member.role_permissions, overrides);
  }

  async policyOf(tenantId: string): Promise<SecurityPolicy> {
    return mergePolicy(await this.repo.policy(tenantId));
  }

  /**
   * Проверка права. Отказ — 403 с человеческим объяснением: «нет доступа» без
   * указания, какого именно, заставляет людей гадать и писать в поддержку.
   */
  async require(tenantId: string, userId: string, permission: Permission, what?: string): Promise<PermissionMap> {
    const perms = await this.permissionsOf(tenantId, userId);
    if (!can(perms, permission)) {
      throw AppException.forbidden(what ?? `Нет права «${permission}» — его выдаёт владелец организации`);
    }
    return perms;
  }

  /** Всё, что нужно интерфейсу: права и политика одним ответом (ТЗ, п. 69). */
  async me(tenantId: string, userId: string) {
    const [permissions, policy] = await Promise.all([
      this.permissionsOf(tenantId, userId),
      this.policyOf(tenantId),
    ]);
    return { permissions, policy };
  }

  // ── роли ──

  async roles(tenantId: string, user: { userId: string; role: string }) {
    await this.require(tenantId, user.userId, 'security.manage');
    return { items: await this.repo.roles(tenantId), members: await this.repo.members(tenantId) };
  }

  async saveRole(
    tenantId: string, user: { userId: string; role: string },
    body: { id?: string; code?: string; name: string; permissions: Record<string, unknown> },
  ) {
    const actorPerms = await this.require(tenantId, user.userId, 'security.manage');
    const wanted = this.cleanPermissions(body.permissions);
    /*
      Потолок: нельзя выдать роли право, которого нет у самого раздающего. Иначе
      ограничение администратора обходится в два нажатия — создал роль с нужным
      правом и выдал её себе.
    */
    const { allowed, refused } = capGrants(user.role, actorPerms, wanted);
    if (refused.length) {
      throw AppException.forbidden(`Нельзя выдать права, которых нет у вас: ${refused.join(', ')}`);
    }
    const role = body.id
      ? await this.repo.updateRole(tenantId, body.id, { name: body.name, permissions: allowed })
      : await this.repo.createRole({
        tenantId, code: this.codeOf(body.code ?? body.name), name: body.name,
        permissions: allowed, createdBy: user.userId,
      });
    if (!role) throw AppException.notFound('Роль не найдена');
    await this.repo.audit({
      tenantId, actorId: user.userId, event: body.id ? 'role.updated' : 'role.created',
      resourceType: 'role', resourceId: String(role.id), metadata: { name: role.name },
    });
    return role;
  }

  async deleteRole(tenantId: string, user: { userId: string; role: string }, id: string) {
    await this.require(tenantId, user.userId, 'security.manage');
    const role = await this.repo.roleById(tenantId, id);
    if (!role) throw AppException.notFound('Роль не найдена');
    if (role.is_base) throw AppException.validation('Базовую роль удалить нельзя — на ней держится вход');
    await this.repo.deleteRole(tenantId, id);
    await this.repo.audit({
      tenantId, actorId: user.userId, event: 'role.deleted', resourceType: 'role', resourceId: id,
      metadata: { name: role.name },
    });
    return { ok: true };
  }

  /** Назначить человеку роль компании (или снять её, вернув базовую). */
  async assignRole(tenantId: string, user: { userId: string; role: string }, targetId: string, roleId: string | null) {
    await this.require(tenantId, user.userId, 'security.manage');
    if (roleId && !(await this.repo.roleById(tenantId, roleId))) throw AppException.notFound('Роль не найдена');
    await this.repo.setSecurityRole(tenantId, targetId, roleId);
    await this.repo.audit({
      tenantId, actorId: user.userId, event: 'role.assigned', targetUserId: targetId,
      resourceType: 'role', resourceId: roleId, metadata: {},
    });
    return { ok: true };
  }

  /**
   * Личные поправки — то, ради чего слой затевался: «этот администратор делает всё,
   * кроме контактов и интеграций».
   */
  async setOverrides(
    tenantId: string, user: { userId: string; role: string }, targetId: string,
    body: Record<string, unknown>,
  ) {
    const actorPerms = await this.require(tenantId, user.userId, 'security.manage');
    if (String(targetId) === String(user.userId) && user.role !== 'owner') {
      // Себе права не правят: иначе ограничение снимается тем, кого ограничивали.
      throw AppException.forbidden('Свои права меняет владелец организации');
    }
    const target = await this.repo.member(tenantId, targetId);
    if (!target) throw AppException.notFound('Сотрудник не найден');
    if (target.base_role === 'owner' && user.role !== 'owner') {
      throw AppException.forbidden('Права владельца может менять только он сам');
    }

    const wanted = this.cleanPermissions(body);
    const { allowed, refused } = capGrants(user.role, actorPerms, wanted);
    if (refused.length) {
      throw AppException.forbidden(`Нельзя выдать права, которых нет у вас: ${refused.join(', ')}`);
    }
    for (const [permission, grant] of Object.entries(allowed)) {
      if (!grant) continue;
      await this.repo.setOverride({
        tenantId, userId: targetId, permission, allowed: grant.allowed,
        scope: grant.scope ?? null, actorId: user.userId,
      });
    }
    await this.repo.audit({
      tenantId, actorId: user.userId, event: 'permission.changed', targetUserId: targetId,
      metadata: { permissions: Object.keys(allowed) },
    });
    return { permissions: await this.permissionsOf(tenantId, targetId) };
  }

  async clearOverride(tenantId: string, user: { userId: string; role: string }, targetId: string, permission: string) {
    await this.require(tenantId, user.userId, 'security.manage');
    if (!isPermission(permission)) throw AppException.validation('Неизвестное право');
    await this.repo.clearOverride(tenantId, targetId, permission);
    await this.repo.audit({
      tenantId, actorId: user.userId, event: 'permission.changed', targetUserId: targetId,
      metadata: { cleared: permission },
    });
    return { ok: true };
  }

  // ── политика ──

  async savePolicy(tenantId: string, user: { userId: string; role: string }, patch: Record<string, unknown>) {
    if (user.role !== 'owner') throw AppException.forbidden('Политику безопасности меняет владелец организации');
    const current = await this.policyOf(tenantId);
    const next = mergePolicy({ ...current, ...patch });
    await this.repo.savePolicy(tenantId, next, user.userId);
    await this.repo.audit({
      tenantId, actorId: user.userId, event: 'security.policy.changed', metadata: { changed: Object.keys(patch) },
    });
    return next;
  }

  async auditList(tenantId: string, user: { userId: string; role: string }, f: { event?: string; userId?: string }) {
    await this.require(tenantId, user.userId, 'audit.view', 'Журнал безопасности открыт руководителям');
    return { items: await this.repo.auditList(tenantId, { event: f.event ?? null, userId: f.userId ?? null, limit: 200 }) };
  }

  async revealReport(tenantId: string, user: { userId: string; role: string }) {
    await this.require(tenantId, user.userId, 'audit.view', 'Отчёт о просмотрах контактов открыт руководителям');
    return { items: await this.repo.reveals(tenantId, 200) };
  }

  // ── контакты ──

  /**
   * Контакты клиента так, как их можно показать этому человеку.
   *
   * Замаскированное значение считается на СЕРВЕРЕ и полным наружу не уходит: размыть
   * его на экране означало бы отдать телефон любому, кто откроет вкладку «сеть».
   */
  async clientContacts(tenantId: string, user: { userId: string; role: string }, clientId: string) {
    const perms = await this.require(tenantId, user.userId, 'contact.view', 'Контакты клиентов вам не открыты');
    const client = await this.repo.client(tenantId, clientId);
    if (!client) throw AppException.notFound('Клиент не найден');
    const policy = await this.policyOf(tenantId);
    const masked = policy.contacts.defaultAccess === 'masked';

    const fields = [
      { key: 'phone', kind: 'phone' as const, value: client.phone },
      { key: 'email', kind: 'email' as const, value: client.email },
      { key: 'telegram', kind: 'text' as const, value: client.telegram },
      { key: 'contact', kind: 'text' as const, value: client.contact },
    ];
    const out: Record<string, { value: string | null; masked: boolean }> = {};
    for (const f of fields) {
      if (!f.value) { out[f.key] = { value: null, masked: false }; continue; }
      // Недавно раскрытое остаётся открытым, пока не истёк срок (ТЗ, п. 19).
      const recently = masked && await this.repo.revealedRecently(
        tenantId, user.userId, clientId, f.key, policy.contacts.revealTtlSeconds,
      );
      const hide = masked && !recently;
      out[f.key] = { value: hide ? maskContact(f.value, f.kind) : f.value, masked: hide };
    }
    return {
      id: String(client.id),
      name: client.name,
      fields: out,
      canReveal: can(perms, 'contact.reveal'),
      requireReason: policy.contacts.requireReason,
    };
  }

  /** Раскрыть одно поле: проверка права, причина по политике и обязательная запись. */
  async revealContact(
    tenantId: string, user: { userId: string; role: string }, clientId: string,
    field: string, reason: string | null, meta: { ip?: string | null; deviceId?: string | null },
  ) {
    await this.require(tenantId, user.userId, 'contact.reveal', 'Раскрывать контакты вам не разрешено');
    const policy = await this.policyOf(tenantId);
    if (policy.contacts.requireReason && !String(reason ?? '').trim()) {
      throw AppException.validation('Укажите, зачем нужен контакт — этого требует политика компании');
    }
    const client = await this.repo.client(tenantId, clientId);
    if (!client) throw AppException.notFound('Клиент не найден');
    const value = ({
      phone: client.phone, email: client.email, telegram: client.telegram, contact: client.contact,
    } as Record<string, string | null>)[field];
    if (value === undefined) throw AppException.validation('Неизвестное поле контакта');

    await this.repo.logReveal({
      tenantId, userId: user.userId, clientId, field, reason: reason ?? null,
      ip: meta.ip ?? null, deviceId: meta.deviceId ?? null,
    });
    await this.repo.audit({
      tenantId, actorId: user.userId, event: 'contact.revealed', resourceType: 'client', resourceId: clientId,
      ip: meta.ip ?? null, deviceId: meta.deviceId ?? null, metadata: { field, reason: reason ?? null },
    });
    return { field, value: value ?? null, ttlSeconds: policy.contacts.revealTtlSeconds };
  }

  /** Короткая запись в журнал — ею пользуются другие модули. */
  record(o: Parameters<SecurityRepository['audit']>[0]) {
    return this.repo.audit(o);
  }

  private codeOf(name: string): string {
    const base = String(name).trim().toLowerCase().replace(/[^a-zа-я0-9]+/gi, '_').slice(0, 32);
    return base || `role_${Date.now().toString(36)}`;
  }

  /** Оставляем только известные права и области: чужое молча выбрасываем. */
  private cleanPermissions(input: Record<string, unknown>): PermissionMap {
    const out: PermissionMap = {};
    for (const [key, raw] of Object.entries(input ?? {})) {
      if (!isPermission(key) || !raw || typeof raw !== 'object') continue;
      const grant = raw as { allowed?: unknown; scope?: unknown };
      out[key] = {
        allowed: grant.allowed === true,
        ...(isScope(grant.scope) ? { scope: grant.scope } : {}),
      };
    }
    return out;
  }
}
