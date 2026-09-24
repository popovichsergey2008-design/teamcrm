import {
  can, capGrants, effectivePermissions, inScope, maskContact, mergePolicy, scopeOf,
} from './permissions';

describe('права: слои, потолок, области и маскировка контактов', () => {
  it('личная поправка сильнее роли — ради неё слой и затевался', () => {
    // «Руководитель, которому закрыли контакты»: роль разрешает, поправка запрещает.
    const perms = effectivePermissions('manager', null, { 'contact.reveal': { allowed: false } });
    expect(can(perms, 'contact.reveal')).toBe(false);
    expect(can(perms, 'task.delete')).toBe(true); // остальное роли осталось
  });

  it('своя роль компании перекрывает базовую, а поправка — и её', () => {
    const custom = { 'task.delete': { allowed: false as const } };
    const withRole = effectivePermissions('member', custom, null);
    expect(can(withRole, 'task.delete')).toBe(false);
    const withOverride = effectivePermissions('member', custom, { 'task.delete': { allowed: true } });
    expect(can(withOverride, 'task.delete')).toBe(true);
  });

  it('незнакомое право — запрет, а не «разрешено по умолчанию»', () => {
    const perms = effectivePermissions('member', { 'выдуманное.право': { allowed: true } } as never, null);
    expect(Object.keys(perms)).not.toContain('выдуманное.право');
    // И область «нигде» равна запрету, даже если стоит allowed.
    expect(can({ 'task.delete': { allowed: true, scope: 'none' } }, 'task.delete')).toBe(false);
  });

  it('владелец может всё, клиент — только в своих проектах', () => {
    const owner = effectivePermissions('owner', null, null);
    expect(can(owner, 'security.manage')).toBe(true);
    expect(can(owner, 'task.delete_permanently')).toBe(true);
    const client = effectivePermissions('client', null, null);
    expect(can(client, 'task.view')).toBe(true);
    expect(scopeOf(client, 'task.view')).toBe('project');
    expect(can(client, 'contact.reveal')).toBe(false);
    expect(can(client, 'task.delete')).toBe(false);
  });

  it('удаление насовсем по умолчанию только у владельца — восстановить стёртое нельзя', () => {
    expect(can(effectivePermissions('manager', null, null), 'task.delete_permanently')).toBe(false);
    expect(can(effectivePermissions('member', null, null), 'task.delete_permanently')).toBe(false);
    expect(can(effectivePermissions('owner', null, null), 'task.delete_permanently')).toBe(true);
  });

  it('потолок: нельзя выдать право, которого нет у самого выдающего', () => {
    const admin = effectivePermissions('manager', null, { 'integration.manage': { allowed: false } });
    const res = capGrants('manager', admin, {
      'integration.manage': { allowed: true },   // себе или другому — нельзя
      'task.delete': { allowed: true },          // это у него есть — можно
      'contact.export': { allowed: false },      // отнимать можно всегда
    });
    expect(res.refused).toEqual(['integration.manage']);
    expect(res.allowed['task.delete']).toEqual({ allowed: true });
    expect(res.allowed['contact.export']).toEqual({ allowed: false });
    // Владелец — исключение: выше него в организации никого нет.
    expect(capGrants('owner', {}, { 'security.manage': { allowed: true } }).refused).toEqual([]);
  });

  it('область действия проверяется по самой вещи', () => {
    expect(inScope('all', {})).toBe(true);
    expect(inScope('created_by_me', { isCreator: true })).toBe(true);
    expect(inScope('created_by_me', { isAssignee: true })).toBe(false);
    // «Своя работа» — это и то, что на человеке, и то, что он сам завёл.
    expect(inScope('assigned', { isAssignee: true })).toBe(true);
    expect(inScope('assigned', { isCreator: true })).toBe(true);
    expect(inScope('project', { inProject: false })).toBe(false);
    expect(inScope('none', { isCreator: true })).toBe(false);
  });

  it('маска контакта оставляет узнаваемое, но не отдаёт середину', () => {
    const phone = maskContact('+380671234545', 'phone');
    expect(phone).toContain('•');
    expect(phone).not.toContain('123');   // середина не должна утечь даже в маске
    expect(phone?.endsWith('45')).toBe(true);
    const email = maskContact('sergey@company.com', 'email');
    expect(email).toBe('s•••@company.com');
    expect(maskContact('', 'phone')).toBeNull();
  });

  it('политика: в базе лежит только изменённое, остальное — умолчания', () => {
    const p = mergePolicy({ contacts: { requireReason: true } });
    expect(p.contacts.requireReason).toBe(true);
    expect(p.contacts.revealTtlSeconds).toBe(300);      // умолчание не потерялось
    expect(p.twoFactor).toBe('optional');
    expect(mergePolicy(null).integrations.mode).toBe('all');
  });
});
