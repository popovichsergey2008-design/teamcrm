import { isAssignableTeamRole, removesLastActiveOwner } from './team-invariants';

describe('removesLastActiveOwner', () => {
  it('понижение последнего owner — запрещено', () => {
    expect(removesLastActiveOwner({ targetIsActiveOwner: true, newRole: 'manager', activeOwnerCount: 1 })).toBe(true);
  });
  it('деактивация последнего owner — запрещено', () => {
    expect(removesLastActiveOwner({ targetIsActiveOwner: true, newActive: false, activeOwnerCount: 1 })).toBe(true);
  });
  it('понижение при наличии второго owner — ок', () => {
    expect(removesLastActiveOwner({ targetIsActiveOwner: true, newRole: 'manager', activeOwnerCount: 2 })).toBe(false);
  });
  it('изменение не-owner — не затрагивает инвариант', () => {
    expect(removesLastActiveOwner({ targetIsActiveOwner: false, newActive: false, activeOwnerCount: 1 })).toBe(false);
  });
  it('owner остаётся owner и активен — ок', () => {
    expect(removesLastActiveOwner({ targetIsActiveOwner: true, newRole: 'owner', activeOwnerCount: 1 })).toBe(false);
  });
});

describe('isAssignableTeamRole', () => {
  it('owner/manager/member — назначаемы', () => {
    expect(isAssignableTeamRole('owner')).toBe(true);
    expect(isAssignableTeamRole('member')).toBe(true);
  });
  it('client — НЕ назначается через команду', () => {
    expect(isAssignableTeamRole('client')).toBe(false);
  });
});
