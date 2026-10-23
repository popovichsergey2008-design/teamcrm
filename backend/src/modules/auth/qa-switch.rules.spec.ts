import { backRefusal, switchRefusal } from './qa-switch.rules';

const qa = { id: '50', tenant_id: '2', is_active: true };
const me = { id: '7', tenant_id: '2', is_active: true };

describe('#1562 правила переключения на тестового сотрудника', () => {
  const base = { tenantId: '2', callerId: '7', targetId: '50', hasAccess: true, target: qa };

  it('есть строка, цель активна и в той же организации — можно', () => {
    expect(switchRefusal(base)).toBeNull();
  });
  it('без строки в таблице — нельзя никому', () => {
    expect(switchRefusal({ ...base, hasAccess: false })).toBe('no_access');
  });
  it('цель из другой организации или её нет — нельзя', () => {
    expect(switchRefusal({ ...base, target: { ...qa, tenant_id: '3' } })).toBe('target_missing');
    expect(switchRefusal({ ...base, target: null })).toBe('target_missing');
  });
  it('отключённая цель — нельзя', () => {
    expect(switchRefusal({ ...base, target: { ...qa, is_active: false } })).toBe('target_inactive');
  });
  it('цепочек нет: из сессии тестового дальше не переключиться', () => {
    expect(switchRefusal({ ...base, actingFor: '7' })).toBe('chain');
  });
  it('сам в себя — нельзя', () => {
    expect(switchRefusal({ ...base, targetId: '7', target: me })).toBe('self');
  });

  const back = { tenantId: '2', currentId: '50', actorId: '7', hasAccess: true, actor: me };
  it('возврат: связь ещё есть, исходный активен — можно', () => {
    expect(backRefusal(back)).toBeNull();
  });
  it('возврат из обычной сессии — нет', () => {
    expect(backRefusal({ ...back, actorId: undefined })).toBe('not_acting');
  });
  it('строку убрали — возврат и обновление сессии тестового запрещены', () => {
    expect(backRefusal({ ...back, hasAccess: false })).toBe('no_access');
  });
  it('исходный отключён или в другой организации — нет', () => {
    expect(backRefusal({ ...back, actor: { ...me, is_active: false } })).toBe('actor_missing');
    expect(backRefusal({ ...back, actor: { ...me, tenant_id: '9' } })).toBe('actor_missing');
    expect(backRefusal({ ...back, actor: null })).toBe('actor_missing');
  });
});
