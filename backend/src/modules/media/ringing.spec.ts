import { Ringing } from './ringing';

describe('Ringing — учёт идущих вызовов', () => {
  it('гасит звонок у всех, кого звали, когда комната закрылась', () => {
    const r = new Ringing();
    r.add('10', '2');
    r.add('10', '3');
    expect(r.clear('10').sort()).toEqual(['2', '3']);
  });

  it('ответивший и отклонивший из списка выбывают', () => {
    const r = new Ringing();
    r.add('10', '2');
    r.add('10', '3');
    r.stop('10', '2');
    expect(r.clear('10')).toEqual(['3']);
  });

  it('повторное приглашение не задваивает человека', () => {
    const r = new Ringing();
    r.add('10', '2');
    r.add('10', '2');
    expect(r.waiting('10')).toEqual(['2']);
  });

  it('комнаты не путаются между собой', () => {
    const r = new Ringing();
    r.add('10', '2');
    r.add('11', '3');
    expect(r.clear('10')).toEqual(['2']);
    expect(r.waiting('11')).toEqual(['3']);
  });

  it('закрытая комната больше ничего не помнит — второй раз гасить некого', () => {
    const r = new Ringing();
    r.add('10', '2');
    r.clear('10');
    expect(r.clear('10')).toEqual([]);
  });
});
