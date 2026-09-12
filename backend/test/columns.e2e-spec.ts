import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/** Управление колонками доски: add/rename/move/delete + перенос задач, инварианты. */
describe('Enhancements v1 — Board columns (e2e)', () => {
  let app: INestApplication;
  let http: any;
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
    http = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
  });
  afterAll(async () => app?.close());

  const names = (board: any) => board.columns.map((c: any) => c.name);

  it('add / rename / move / delete колонок с переносом задач', async () => {
    const reg = (await http.post('/api/auth/register').send({ tenantName: 'Cols', email: `c_${uniq()}@t.test`, password: 'password123', fullName: 'К' }).expect(201)).body.data;
    const tok = reg.accessToken;
    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'Доска' }).expect(201)).body.data;

    let board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(names(board)).toEqual(['Новые', 'В работе', 'На тестировании', 'Готово']);

    // добавить колонку
    await http.post(`/api/projects/${proj.id}/columns`).set(H(tok)).send({ name: 'Ревью' }).expect(201);
    board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(names(board)).toEqual(['Новые', 'В работе', 'На тестировании', 'Готово', 'Ревью']);

    // переименовать первую
    const first = board.columns[0].id;
    await http.patch(`/api/projects/${proj.id}/columns/${first}`).set(H(tok)).send({ name: 'Бэклог' }).expect(200);

    // переместить последнюю (Ревью, индекс 4) влево
    const revue = board.columns[4].id;
    await http.post(`/api/projects/${proj.id}/columns/${revue}/move`).set(H(tok)).send({ direction: 'left' }).expect(201);
    board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(names(board)).toEqual(['Бэклог', 'В работе', 'На тестировании', 'Ревью', 'Готово']);

    // задача во второй колонке → удаляем эту колонку → задача переезжает (не теряется)
    const col2 = board.columns[1].id;
    const task = (await http.post('/api/tasks').set(H(tok)).send({ projectId: proj.id, columnId: col2, title: 'Перенос' }).expect(201)).body.data;
    await http.delete(`/api/projects/${proj.id}/columns/${col2}`).set(H(tok)).expect(200);
    board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(names(board)).toEqual(['Бэклог', 'На тестировании', 'Ревью', 'Готово']);
    const allTasks = board.columns.flatMap((c: any) => c.tasks.map((t: any) => String(t.id)));
    expect(allTasks).toContain(String(task.id)); // задача сохранилась
  });

  it('reorder произвольным порядком (drag-and-drop); кривой набор → 400', async () => {
    const reg = (await http.post('/api/auth/register').send({ tenantName: 'Reord', email: `r_${uniq()}@t.test`, password: 'password123', fullName: 'Р' }).expect(201)).body.data;
    const tok = reg.accessToken;
    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'Доска' }).expect(201)).body.data;
    let board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    const [a, b, c, d] = board.columns.map((x: any) => x.id); // Новые, В работе, На тестировании, Готово

    // переставляем в обратном порядке (полный набор)
    await http.post(`/api/projects/${proj.id}/columns/reorder`).set(H(tok)).send({ orderedIds: [d, c, b, a] }).expect(201);
    board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(names(board)).toEqual(['Готово', 'На тестировании', 'В работе', 'Новые']);

    // неполный/чужой набор — ошибка валидации
    await http.post(`/api/projects/${proj.id}/columns/reorder`).set(H(tok)).send({ orderedIds: [c, a] }).expect(400);
    await http.post(`/api/projects/${proj.id}/columns/reorder`).set(H(tok)).send({ orderedIds: [d, c, b, a, '999999'] }).expect(400);
  });

  it('нельзя удалить последнюю колонку; остальным доска доступна сотруднику целиком', async () => {
    const reg = (await http.post('/api/auth/register').send({ tenantName: 'Cols2', email: `c_${uniq()}@t.test`, password: 'password123', fullName: 'Б' }).expect(201)).body.data;
    const tok = reg.accessToken;
    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'Доска2' }).expect(201)).body.data;
    let board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;

    // удаляем до одной (дефолтных теперь 4)
    await http.delete(`/api/projects/${proj.id}/columns/${board.columns[3].id}`).set(H(tok)).expect(200);
    await http.delete(`/api/projects/${proj.id}/columns/${board.columns[2].id}`).set(H(tok)).expect(200);
    await http.delete(`/api/projects/${proj.id}/columns/${board.columns[1].id}`).set(H(tok)).expect(200);
    board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(board.columns.length).toBe(1);
    // последняя — нельзя (409)
    await http.delete(`/api/projects/${proj.id}/columns/${board.columns[0].id}`).set(H(tok)).expect(409);

    // Правило изменилось по живому замечанию: сотрудник не видел ни стрелок переноса
    // колонок, ни архивации проекта — и не мог понять, почему у коллеги они есть.
    // Доской теперь управляют все, кто по ней работает, удаление колонки в том числе:
    // держать её запертой рядом с кнопкой удаления всего проекта было бы защитой от ничего.
    const mEmail = `m_${uniq()}@t.test`;
    const inv = (await http.post('/api/invites').set(H(tok)).send({ email: mEmail, role: 'member' }).expect(201)).body.data;
    await http.post('/api/invites/accept').send({ token: inv.token, fullName: 'Петя', password: 'memberpass1' }).expect(201);
    const mLogin = (await http.post('/api/auth/login').send({ email: mEmail, password: 'memberpass1' }).expect(201)).body.data;
    const mine = (await http.post(`/api/projects/${proj.id}/columns`).set(H(mLogin.accessToken))
      .send({ name: 'X' }).expect(201)).body.data;
    await http.delete(`/api/projects/${proj.id}/columns/${mine.id}`).set(H(mLogin.accessToken)).expect(200);
    // а вот запрет на удаление ПОСЛЕДНЕЙ колонки — не про права, он держится для всех
    const left = (await http.get(`/api/projects/${proj.id}/board`).set(H(mLogin.accessToken)).expect(200)).body.data;
    expect(left.columns.length).toBe(1);
    await http.delete(`/api/projects/${proj.id}/columns/${left.columns[0].id}`).set(H(mLogin.accessToken)).expect(409);
  });

  /*
    Доски по умолчанию в начало.

    Проект из импорта живёт с чужими колонками, и работа по нему идёт не по тем
    правилам, что по остальным. Кнопка добавляет недостающие ПЕРЕД созданными
    вручную и ничего не трогает у существующих — иначе она стоила бы потерянных
    задач, а не сэкономленной минуты.
  */
  it('доски по умолчанию встают в начало, своё остаётся целым, повтор не плодит близнецов', async () => {
    const reg = (await http.post('/api/auth/register').send({ tenantName: 'Cols3', email: `c_${uniq()}@t.test`, password: 'password123', fullName: 'К' }).expect(201)).body.data;
    const tok = reg.accessToken;
    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'Импортированная' }).expect(201)).body.data;
    let board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;

    // Превращаем доску в «пришедшую из чужой системы»: одна колонка с чужим именем.
    await http.patch(`/api/projects/${proj.id}/columns/${board.columns[0].id}`).set(H(tok)).send({ name: 'Импортировано' }).expect(200);
    await http.delete(`/api/projects/${proj.id}/columns/${board.columns[3].id}`).set(H(tok)).expect(200);
    await http.delete(`/api/projects/${proj.id}/columns/${board.columns[2].id}`).set(H(tok)).expect(200);
    await http.delete(`/api/projects/${proj.id}/columns/${board.columns[1].id}`).set(H(tok)).expect(200);
    await http.post(`/api/projects/${proj.id}/columns`).set(H(tok)).send({ name: 'Согласование' }).expect(201);

    board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(names(board)).toEqual(['Импортировано', 'Согласование']);

    // Задача в своей колонке: перестановка не должна её никуда деть.
    const own = board.columns[1].id;
    const task = (await http.post('/api/tasks').set(H(tok)).send({ projectId: proj.id, columnId: own, title: 'Своя' }).expect(201)).body.data;

    const res = (await http.post(`/api/projects/${proj.id}/columns/default`).set(H(tok)).expect(201)).body.data;
    expect(res.added).toEqual(['Новые', 'В работе', 'На тестировании', 'Готово']);

    board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(names(board)).toEqual(['Новые', 'В работе', 'На тестировании', 'Готово', 'Импортировано', 'Согласование']);
    const kept = board.columns.find((c: any) => String(c.id) === String(own));
    expect(kept.tasks.map((t: any) => String(t.id))).toContain(String(task.id));

    // Повтор ничего не добавляет: иначе с каждым нажатием доска обрастала бы близнецами.
    const again = (await http.post(`/api/projects/${proj.id}/columns/default`).set(H(tok)).expect(201)).body.data;
    expect(again.added).toEqual([]);
    board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(board.columns.length).toBe(6);

    // Регистр и пробелы не создают вторую такую же колонку.
    const proj2 = (await http.post('/api/projects').set(H(tok)).send({ name: 'Регистр' }).expect(201)).body.data;
    const b2 = (await http.get(`/api/projects/${proj2.id}/board`).set(H(tok)).expect(200)).body.data;
    await http.patch(`/api/projects/${proj2.id}/columns/${b2.columns[0].id}`).set(H(tok)).send({ name: '  новые ' }).expect(200);
    const r2 = (await http.post(`/api/projects/${proj2.id}/columns/default`).set(H(tok)).expect(201)).body.data;
    expect(r2.added).toEqual([]);
    expect(r2.columns.length).toBe(4);
  });
});
