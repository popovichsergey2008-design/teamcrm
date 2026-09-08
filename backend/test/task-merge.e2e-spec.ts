import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Объединение дублирующихся задач.
 *
 * Проверяем ровно то, ради чего это делалось: ничего не пропало и ничего не
 * случилось само. Переписка и файлы переехали в основную задачу, вторая осталась
 * с пометкой и ссылкой, история есть у обеих, а название и описание меняются
 * только тогда, когда человек их прислал.
 */
describe('Объединение задач (e2e)', () => {
  let app: INestApplication;
  let http: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });

  let tok: string;
  let projectId: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useWebSocketAdapter(new RedisIoAdapter(app));
    await app.listen(0, '0.0.0.0');
    http = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);

    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Дубли', email: `mg_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' })
      .expect(201)).body.data;
    tok = owner.accessToken;
    projectId = (await http.post('/api/projects').set(H(tok)).send({ name: 'Дубли' }).expect(201)).body.data.id;
  });
  afterAll(async () => app?.close());

  const newTask = async (title: string, description?: string) =>
    (await http.post('/api/tasks').set(H(tok)).send({ projectId, title, description }).expect(201)).body.data;

  it('похожая задача находится, а сама задача в списке не показывается', async () => {
    const base = await newTask('Добавить чат в карточку задачи', 'Нужно обсуждение прямо в задаче');
    await newTask('Добавить обсуждение в карточку задачи', 'Чат внутри задачи');
    await newTask('Оплатить хостинг за сентябрь');

    const r = (await http.get(`/api/tasks/${base.id}/merge/candidates`).set(H(tok)).expect(200)).body.data;
    expect(r.items.some((x: any) => String(x.id) === String(base.id))).toBe(false);
    expect(r.items[0].title).toBe('Добавить обсуждение в карточку задачи');
    expect(r.items[0].match).toBeGreaterThan(30);
    // причина обязана быть: процент без объяснения человек читает как гадание
    expect(String(r.items[0].reason).length).toBeGreaterThan(3);
  });

  it('проверка дублей до создания: предупреждает о похожем и молчит о постороннем', async () => {
    await newTask('Настроить выгрузку отчётов в Excel', 'Раз в неделю выгружать отчёты');

    const near = (await http.get('/api/tasks/duplicates')
      .query({ title: 'Настроить выгрузку отчётов в Эксель' }).set(H(tok)).expect(200)).body.data;
    expect(near.items[0].title).toBe('Настроить выгрузку отчётов в Excel');
    expect(near.items[0].match).toBeGreaterThan(45);

    // постороннее название не должно поднимать тревогу: порог здесь высокий намеренно
    const far = (await http.get('/api/tasks/duplicates')
      .query({ title: 'Купить новый чайник в кухню' }).set(H(tok)).expect(200)).body.data;
    expect(far.items).toEqual([]);

    // два слова — не повод предупреждать, по ним похоже всё подряд
    const short = (await http.get('/api/tasks/duplicates')
      .query({ title: 'Отчёт' }).set(H(tok)).expect(200)).body.data;
    expect(short.items).toEqual([]);
  });

  it('ручной поиск находит по номеру и по названию', async () => {
    const base = await newTask('Своя задача для поиска');
    const other = await newTask('Совершенно посторонняя формулировка');

    const byId = (await http.get(`/api/tasks/${base.id}/merge/candidates?q=${other.id}`)
      .set(H(tok)).expect(200)).body.data;
    expect(byId.searched).toBe(true);
    expect(byId.items.map((x: any) => String(x.id))).toContain(String(other.id));

    const byWord = (await http.get(`/api/tasks/${base.id}/merge/candidates?q=посторонняя`)
      .set(H(tok)).expect(200)).body.data;
    expect(byWord.items.map((x: any) => String(x.id))).toContain(String(other.id));
  });

  it('объединение переносит переписку и людей, вторая задача помечается и ссылается', async () => {
    const primary = await newTask('Основная задача', 'Первое описание');
    const secondary = await newTask('Вторая задача', 'Второе описание');

    await http.post(`/api/tasks/${secondary.id}/comments`).set(H(tok))
      .send({ body: 'Замечание из второй задачи' }).expect(201);
    await http.post(`/api/tasks/${secondary.id}/checklist`).set(H(tok)).send({ text: 'Шаг из второй' }).expect(201);
    await http.post(`/api/tasks/${primary.id}/checklist`).set(H(tok)).send({ text: 'Шаг из первой' }).expect(201);

    const preview = (await http.get(`/api/tasks/${primary.id}/merge/preview?with=${secondary.id}`)
      .set(H(tok)).expect(200)).body.data;
    expect(preview.moves.comments).toBe(1);
    expect(preview.moves.checklist).toBe(1);
    expect(preview.differentProjects).toBe(false);
    // склейка чек-листа: свои пункты первыми, чужие следом
    expect(preview.suggestion.checklist).toEqual(['Шаг из первой', 'Шаг из второй']);

    const res = (await http.post(`/api/tasks/${primary.id}/merge`).set(H(tok)).send({
      primaryId: String(primary.id),
      secondaryId: String(secondary.id),
      checklist: preview.suggestion.checklist,
    }).expect(201)).body.data;
    expect(String(res.taskId)).toBe(String(primary.id));

    // переписка переехала целиком
    const comments = (await http.get(`/api/tasks/${primary.id}/comments`).set(H(tok)).expect(200)).body.data;
    expect(comments.some((c: any) => c.body === 'Замечание из второй задачи')).toBe(true);
    const left = (await http.get(`/api/tasks/${secondary.id}/comments`).set(H(tok)).expect(200)).body.data;
    expect(left).toHaveLength(0);

    // чек-лист собран без повторов
    const list = (await http.get(`/api/tasks/${primary.id}/checklist`).set(H(tok)).expect(200)).body.data;
    expect(list.map((i: any) => i.text)).toEqual(['Шаг из первой', 'Шаг из второй']);

    // вторая задача осталась — с пометкой и ссылкой, а не исчезла
    // доска отдаёт задачи внутри колонок — собираем в один список
    const board = (await http.get(`/api/projects/${projectId}/board`).set(H(tok)).expect(200)).body.data;
    const all = board.columns.flatMap((c: any) => c.tasks);
    const stub = all.find((t: any) => String(t.id) === String(secondary.id));
    expect(String(stub.merged_into_id)).toBe(String(primary.id));
    expect(stub.closed_at).not.toBeNull();

    // название и описание НЕ трогали: их не присылали
    const still = all.find((t: any) => String(t.id) === String(primary.id));
    expect(still.title).toBe('Основная задача');
    expect(still.description).toBe('Первое описание');

    // история есть у обеих: по каждой видно, что с ней случилось
    const histA = (await http.get(`/api/tasks/${primary.id}/activity`).set(H(tok)).expect(200)).body.data;
    const histB = (await http.get(`/api/tasks/${secondary.id}/activity`).set(H(tok)).expect(200)).body.data;
    expect(histA.some((a: any) => a.kind === 'merged_in')).toBe(true);
    expect(histB.some((a: any) => a.kind === 'merged_into')).toBe(true);
  });

  it('название и описание меняются только по просьбе человека', async () => {
    const primary = await newTask('Старое название', 'Старое описание');
    const secondary = await newTask('Дубль названия', 'Дубль описания');

    await http.post(`/api/tasks/${primary.id}/merge`).set(H(tok)).send({
      primaryId: String(primary.id),
      secondaryId: String(secondary.id),
      title: 'Общее название после объединения',
      description: 'Общее описание',
    }).expect(201);

    const board = (await http.get(`/api/projects/${projectId}/board`).set(H(tok)).expect(200)).body.data;
    const main = board.columns.flatMap((c: any) => c.tasks)
      .find((t: any) => String(t.id) === String(primary.id));
    expect(main.title).toBe('Общее название после объединения');
    expect(main.description).toBe('Общее описание');
  });

  it('саму с собой и повторно объединить нельзя', async () => {
    const a = await newTask('Задача А для запретов');
    const b = await newTask('Задача Б для запретов');

    await http.post(`/api/tasks/${a.id}/merge`).set(H(tok))
      .send({ primaryId: String(a.id), secondaryId: String(a.id) }).expect(400);

    await http.post(`/api/tasks/${a.id}/merge`).set(H(tok))
      .send({ primaryId: String(a.id), secondaryId: String(b.id) }).expect(201);

    // b уже объединена — второй раз нельзя, и предпросмотр честно об этом говорит
    const again = await http.post(`/api/tasks/${a.id}/merge`).set(H(tok))
      .send({ primaryId: String(a.id), secondaryId: String(b.id) });
    expect(again.status).toBe(409);

    const preview = await http.get(`/api/tasks/${a.id}/merge/preview?with=${b.id}`).set(H(tok));
    expect(preview.status).toBe(409);

    // объединённая задача больше не предлагается в кандидатах
    const c = await newTask('Задача В для запретов');
    const cand = (await http.get(`/api/tasks/${c.id}/merge/candidates?q=запретов`).set(H(tok)).expect(200)).body.data;
    expect(cand.items.map((x: any) => String(x.id))).not.toContain(String(b.id));
  });
});
