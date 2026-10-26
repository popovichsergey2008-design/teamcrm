import { VoiceService } from './voice.service';

/*
  #4666: короткая запись — готовые черновики прямо в ответе на загрузку (без опроса),
  разбор сразу с автозаполнением (второго разбора из окна нет), тайминги — в журнал.
*/
describe('#4666 VoiceService: короткая запись', () => {
  const make = (text: string, parseMany = jest.fn(async () => [{ intent: 'create_task', task: { title: 'Поправить вход', auto: true } }])) => {
    const row: any = { id: '7', tenant_id: 't', user_id: 'u', file_id: 'f', status: 'queued', transcript: null, drafts: [], error: null, duration_sec: null };
    const repo = {
      create: jest.fn(async () => ({ ...row })),
      find: jest.fn(async () => ({ ...row })),
      setStatus: jest.fn(async (_id: string, status: string, error?: string | null) => { row.status = status; row.error = error ?? null; }),
      setTranscript: jest.fn(async (_id: string, t: string) => { row.transcript = t; }),
      setDrafts: jest.fn(async (_id: string, d: unknown[]) => { row.drafts = d; row.status = 'ready'; }),
    };
    const files = { upload: jest.fn(async () => ({ id: 'f' })) };
    const ai = { transcribeAudioWithModel: jest.fn(async () => ({ text, model: 'gpt-4o-mini-transcribe' })) };
    const nl = { parseMany, speechHint: jest.fn(async () => 'словарь') };
    const diag = { write: jest.fn() };
    const svc = new VoiceService(repo as any, files as any, ai as any, nl as any, diag as any);
    return { svc, nl, ai, diag };
  };
  const file = { buffer: Buffer.alloc(20_000), originalname: 'voice.webm', mimetype: 'audio/webm' };

  it('ответ на загрузку уже с черновиком; разбор — с авто и быстрым путём', async () => {
    const { svc, nl, ai, diag } = make('Сергею поправить вход');
    const view = await svc.accept('t', 'u', file, '10', { auto: true });
    expect(view.status).toBe('ready');
    expect(view.tasks).toHaveLength(1);
    expect((ai.transcribeAudioWithModel.mock.calls[0] as any[])[4]).toEqual({ fast: true });
    expect((nl.parseMany.mock.calls[0] as any[])[4]).toMatchObject({ auto: true, fast: true });
    const ev = diag.write.mock.calls[0][0];
    expect(ev).toMatchObject({ scope: 'app', refId: 'voice:7', event: 'voice.timing' });
    expect(ev.data).toMatchObject({ bytes: 20_000, sttModel: 'gpt-4o-mini-transcribe', words: 3, result: 'ready', auto: true });
    expect(typeof ev.data.sttMs).toBe('number');
  });

  it('«Продолжение следует…» на тишине — не задача, а просьба повторить', async () => {
    const { svc, nl } = make('Продолжение следует...');
    const view = await svc.accept('t', 'u', file, null, { auto: true });
    expect(view.status).toBe('error');
    expect(view.error).toMatch(/скажите ещё раз/);
    expect(nl.parseMany).not.toHaveBeenCalled();
  });

  it('разбор не уложился в ожидание — ответ сразу, дальше окно спрашивает статус', async () => {
    const slow = jest.fn(() => new Promise<any[]>(() => undefined));
    const { svc } = make('Сергею поправить вход', slow as any);
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const p = svc.accept('t', 'u', file, null, { auto: true });
    await jest.advanceTimersByTimeAsync(20_000);
    const view = await p;
    jest.useRealTimers();
    expect(view.status).toBe('queued');
  });
});
