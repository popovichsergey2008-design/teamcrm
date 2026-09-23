import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/** NL-команда / Zero-UI. Под mock LLM интент может быть none, поэтому apply тестируем на явном черновике. */
describe('NL-команда (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useWebSocketAdapter(new RedisIoAdapter(app));
    await app.listen(0, '0.0.0.0');
    http$ = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
  });

  afterAll(async () => { await app?.close(); });

  it('parse отдаёт контекст; apply создаёт задачу; без проекта — 400', async () => {
    const email = `nl_${uniq()}@t.test`;
    const reg = (await http$.post('/api/auth/register').send({ tenantName: 'NL', email, password: 'password123', fullName: 'Босс' }).expect(201)).body.data;
    const tok = reg.accessToken;
    const proj = (await http$.post('/api/projects').set(H(tok)).send({ name: 'Маркетинг' }).expect(201)).body.data;

    // parse: структура + контекст (интент под mock LLM не гарантирован)
    const parsed = (await http$.post('/api/nl/parse').set(H(tok)).send({ text: 'Создай задачу обновить баннер в проекте Маркетинг' }).expect(201)).body.data;
    expect(['create_task', 'create_deal', 'none']).toContain(parsed.intent);
    expect(parsed.context.projects.some((p: any) => p.name === 'Маркетинг')).toBe(true);
    expect(parsed.context.users.some((u: any) => u.name === 'Босс')).toBe(true);

    // Проект из обстановки: человек стоит на доске и диктует задачу, не называя проект.
    // Раньше здесь оставался пустой обязательный выбор — команда голосом упиралась в него.
    const fromBoard = (await http$.post('/api/nl/parse').set(H(tok))
      .send({ text: 'обновить баннер на главной', currentProjectId: String(proj.id) }).expect(201)).body.data;
    expect(fromBoard.intent).toBe('create_task');
    expect(String(fromBoard.task.projectId)).toBe(String(proj.id));
    expect(fromBoard.task.projectHint).toBeTruthy(); // видно, откуда взялся проект

    // Названный вслух проект сильнее открытой доски: сказанное человеком важнее обстановки.
    const other = (await http$.post('/api/projects').set(H(tok)).send({ name: 'Сайт клиента' }).expect(201)).body.data;
    const spoken = (await http$.post('/api/nl/parse').set(H(tok))
      .send({ text: 'поправить форму по сайту клиента срочно', currentProjectId: String(proj.id) }).expect(201)).body.data;
    expect(String(spoken.task.projectId)).toBe(String(other.id));
    expect(spoken.task.priority).toBe('urgent'); // «срочно» слышно и без модели

    // Длинная надиктовка: запись принимается отдельно от разбора и переживает ошибки.
    // Проверяем сам конвейер приёма — распознавание на CI мокнуто и текста не даёт.
    const started = (await http$.post('/api/nl/voice').set(H(tok))
      .attach('audio', Buffer.from('fake-audio-bytes'), { filename: 'voice.webm', contentType: 'audio/webm' })
      .expect(201)).body.data;
    expect(started.id).toBeTruthy();
    expect(['queued', 'transcribing', 'parsing', 'ready', 'error']).toContain(started.status);

    // статус доступен по id — интерфейс на него и опирается, пока идёт обработка
    const state = (await http$.get(`/api/nl/voice/${started.id}`).set(H(tok)).expect(200)).body.data;
    expect(String(state.id)).toBe(String(started.id));

    // повторный запуск возможен: исходное аудио сохранено, диктовать заново не нужно
    await http$.post(`/api/nl/voice/${started.id}/retry`).set(H(tok)).expect(201);

    // чужую запись не отдаём: надиктовка — это чужой разговор
    const stranger = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Чужие', email: `nl2_${uniq()}@t.test`, password: 'password123', fullName: 'Сосед' })
      .expect(201)).body.data;
    await http$.get(`/api/nl/voice/${started.id}`).set(H(stranger.accessToken)).expect(404);

    // apply: создать задачу из подтверждённого черновика (+ срок уходит в описание, приоритет применяется)
    const applied = (await http$.post('/api/nl/apply').set(H(tok))
      .send({ intent: 'create_task', task: { projectId: proj.id, title: 'Обновить баннер', description: 'детали', priority: 'high', deadline: '2026-08-01' } }).expect(201)).body.data;
    expect(applied.type).toBe('task');
    expect(applied.task.title).toBe('Обновить баннер');

    const board = (await http$.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    const task = board.columns.flatMap((c: any) => c.tasks).find((x: any) => x.title === 'Обновить баннер');
    expect(task).toBeTruthy();
    expect(task.priority).toBe('high');

    // apply задачи без проекта → 400
    await http$.post('/api/nl/apply').set(H(tok)).send({ intent: 'create_task', task: { title: 'Без проекта' } }).expect(400);

    // apply сделки
    const deal = (await http$.post('/api/nl/apply').set(H(tok)).send({ intent: 'create_deal', deal: { title: 'Продажа Иванову', amount: 5000 } }).expect(201)).body.data;
    expect(deal.type).toBe('deal');
    expect(deal.deal.title).toBe('Продажа Иванову');
  });

  it('transcribe: multipart аудио принимается (mock → пустой текст); без файла — 400', async () => {
    const email = `nlv_${uniq()}@t.test`;
    const reg = (await http$.post('/api/auth/register').send({ tenantName: 'NLV', email, password: 'password123', fullName: 'Босс' }).expect(201)).body.data;
    const tok = reg.accessToken;

    // multipart с аудио-полем → 200, ответ содержит строковое поле text (под mock Whisper — пусто)
    const res = (await http$.post('/api/nl/transcribe').set(H(tok))
      .attach('audio', Buffer.from('fake audio bytes'), 'command.webm').expect(201)).body.data;
    expect(typeof res.text).toBe('string');

    // без файла → 400 (валидация)
    await http$.post('/api/nl/transcribe').set(H(tok)).expect(400);
  });

  it('надиктованная встреча превращается в заполненный черновик', async () => {
    const email = `nle_${uniq()}@t.test`;
    const reg = (await http$.post('/api/auth/register')
      .send({ tenantName: 'NLE', email, password: 'password123', fullName: 'Ольга Ким' }).expect(201)).body.data;
    const tok = reg.accessToken;
    const mateEmail = `nle_m_${uniq()}@t.test`;
    const mate = (await http$.post('/api/users').set(H(tok))
      .send({ email: mateEmail, fullName: 'Пётр Иванов', password: 'password123', role: 'member' }).expect(201)).body.data;

    // «сейчас» присылает клиент: разбор идёт в ЕГО местном времени, а не серверном
    const draft = (await http$.post('/api/nl/parse-event').set(H(tok)).send({
      text: 'созвон с Петром завтра в 15 на час в переговорной',
      now: '2026-08-26T11:00',
    }).expect(201)).body.data;

    expect(draft.startsAt).toBe('2026-08-27T15:00');
    expect(draft.endsAt).toBe('2026-08-27T16:00');
    expect(draft.allDay).toBe(false);
    expect(draft.location).toContain('переговорной');
    expect(draft.participantIds).toContain(String(mate.id));
    // название очищено от времени, но осталось словами человека
    expect(draft.title).toContain('созвон');
    expect(draft.title).not.toContain('завтра');

    // без единого признака времени даты не выдумываются, а человека предупреждают
    const vague = (await http$.post('/api/nl/parse-event').set(H(tok))
      .send({ text: 'обсудить смету с подрядчиком', now: '2026-08-26T11:00' }).expect(201)).body.data;
    expect(vague.startsAt).toBeNull();
    expect(vague.warnings.length).toBeGreaterThan(0);

    // распознанная фраза возвращается: человек должен видеть, что услышала система
    expect(draft.source).toContain('Петром');

    // время словами — так его и пишет распознавание речи
    const spoken = (await http$.post('/api/nl/parse-event').set(H(tok)).send({
      text: 'созвон с Петром завтра в десять часов',
      now: '2026-08-26T11:00',
    }).expect(201)).body.data;
    expect(spoken.startsAt).toBe('2026-08-27T10:00');

    // слишком короткая команда — отказ, а не пустой черновик
    await http$.post('/api/nl/parse-event').set(H(tok)).send({ text: 'ок' }).expect(400);
  });

  /*
    Пакет задач (ТЗ-10, этап 2). Обещание продукта: одна операция — один результат,
    который можно открыть снова; повтор не плодит дубли; упавшая задача не отменяет
    остальные и её можно повторить отдельно.
  */
  it('пакет: результат живёт по номеру, повтор не плодит дубли, упавшую можно повторить', async () => {
    const email = `batch_${uniq()}@t.test`;
    const reg = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Пакет', email, password: 'password123', fullName: 'Ольга' }).expect(201)).body.data;
    const tok = reg.accessToken;
    const proj = (await http$.post('/api/projects').set(H(tok)).send({ name: 'Сайт' }).expect(201)).body.data;
    const requestId = `qc-${uniq()}`;

    const drafts = [
      { intent: 'create_task', task: { projectId: String(proj.id), title: 'Исправить форму регистрации' } },
      { intent: 'create_task', task: { projectId: String(proj.id), title: 'Написать текст для лендинга' } },
      // третья без проекта — сервер её не создаст, но и остальные не отменит
      { intent: 'create_task', task: { title: 'Обновить документацию' } },
    ];
    const batch = (await http$.post('/api/nl/batches').set(H(tok))
      .send({ drafts, sourceType: 'text', sourceText: 'три поручения', clientRequestId: requestId })
      .expect(201)).body.data;

    expect(batch.requested).toBe(3);
    expect(batch.created).toBe(2);
    expect(batch.failedCount).toBe(1);
    expect(batch.status).toBe('partial');
    expect(batch.tasks).toHaveLength(2);
    expect(batch.tasks[0].projectName).toBe('Сайт');
    expect(batch.failed[0].title).toBe('Обновить документацию');
    expect(batch.failed[0].error).toContain('проект');

    // результат открывается по номеру — это и есть адрес страницы результата
    const again = (await http$.get(`/api/nl/batches/${batch.batchId}`).set(H(tok)).expect(200)).body.data;
    expect(again.batchId).toBe(batch.batchId);
    expect(again.tasks).toHaveLength(2);

    // повтор с тем же ключом — ТОТ ЖЕ пакет, новых задач нет
    const repeat = (await http$.post('/api/nl/batches').set(H(tok))
      .send({ drafts, sourceType: 'text', clientRequestId: requestId }).expect(201)).body.data;
    expect(repeat.batchId).toBe(batch.batchId);
    expect(repeat.created).toBe(2);

    // упавшую повторяем отдельно, с исправленным черновиком — успешные не трогаются
    const fixed = (await http$.post(`/api/nl/batches/${batch.batchId}/items/${batch.failed[0].itemId}/retry`)
      .set(H(tok))
      .send({ task: { projectId: String(proj.id), title: 'Обновить документацию' } })
      .expect(201)).body.data;
    expect(fixed.created).toBe(3);
    expect(fixed.failedCount).toBe(0);
    expect(fixed.status).toBe('completed');
    expect(new Set(fixed.tasks.map((t: any) => t.taskId)).size).toBe(3);

    // задачи помечены пакетом: видно, откуда они взялись
    const board = (await http$.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    const titles = board.columns.flatMap((c: any) => c.tasks).map((t: any) => t.title);
    expect(titles).toContain('Исправить форму регистрации');
    expect(titles.filter((t: string) => t === 'Обновить документацию')).toHaveLength(1);

    // чужой пакет не показываем
    const other = `other_${uniq()}@t.test`;
    const reg2 = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Чужие', email: other, password: 'password123', fullName: 'Пётр' }).expect(201)).body.data;
    await http$.get(`/api/nl/batches/${batch.batchId}`).set(H(reg2.accessToken)).expect(404);
  });
});
