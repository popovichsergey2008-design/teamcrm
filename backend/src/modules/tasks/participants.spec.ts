import { MAX_PARTICIPANTS, participantIdsIn, pickParticipants } from './participants';

describe('#4661 соисполнители и наблюдатели из первого окна', () => {
  const active = new Set(['1', '2', '3', '4', '5']);

  it('вход: только числовые id, без повторов и мусора', () => {
    expect(participantIdsIn(['2', 3, ' 4 ', '2', 'abc', null, {}, '', '1;DROP'])).toEqual(['2', '3', '4']);
    expect(participantIdsIn(undefined)).toEqual([]);
    expect(participantIdsIn('2')).toEqual([]);
  });

  it('чужие и уволенные — не участники', () => {
    const r = pickParticipants({ coAssigneeIds: ['2', '99'], watcherIds: ['77', '3'] }, active, null);
    expect(r).toEqual({ coAssigneeIds: ['2'], watcherIds: ['3'] });
  });

  it('исполнитель не соисполнитель и не наблюдатель', () => {
    const r = pickParticipants({ coAssigneeIds: ['1', '2'], watcherIds: ['1', '3'] }, active, '1');
    expect(r).toEqual({ coAssigneeIds: ['2'], watcherIds: ['3'] });
  });

  it('соисполнитель наблюдателем не дублируется', () => {
    const r = pickParticipants({ coAssigneeIds: ['2'], watcherIds: ['2', '4'] }, active, null);
    expect(r).toEqual({ coAssigneeIds: ['2'], watcherIds: ['4'] });
  });

  it('потолок на роль', () => {
    const many = Array.from({ length: 30 }, (_, i) => String(i + 1));
    const r = pickParticipants({ coAssigneeIds: many }, new Set(many), null);
    expect(r.coAssigneeIds).toHaveLength(MAX_PARTICIPANTS);
    expect(r.watcherIds).toEqual([]);
  });

  it('ничего не прислали — пусто, без ошибок', () => {
    expect(pickParticipants({}, active, '1')).toEqual({ coAssigneeIds: [], watcherIds: [] });
  });
});
