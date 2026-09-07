import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Импорт задач из файла — первый слой «переезда в один клик».
 *
 * Проверяем то, ради чего он и делается: колонки угадываются, люди находятся по
 * почте, срок и приоритет разбираются, повторный прогон того же файла НЕ создаёт
 * дублей. Последнее важнее прочего: импорт, который при второй попытке удваивает
 * доску, хуже отсутствующего.
 */
describe('импорт из файла (e2e)', () => {
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

  const team = async () => {
    const email = `imp_${uniq()}@t.test`;
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Imp', email, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    return { owner, email };
  };

  const upload = (token: string, csv: string, name = 'tasks.csv') =>
    http.post('/api/integrations/file/preview')
      .set(H(token))
      .attach('file', Buffer.from(csv, 'utf8'), name)
      .expect(201);

  it('колонки угадываются, а строки становятся задачами', async () => {
    const { owner, email } = await team();
    const csv = [
      'Задача;Описание;Ответственный;Срок;Приоритет;Статус;Метки;Завершена',
      `Сверстать лендинг;Главная и контакты;${email};15.10.2026;Срочно;В работе;фронт, срочно;нет`,
      'Написать тексты;;неизвестный@нигде.нет;;обычный;;;да',
      ';строка без названия — не задача;;;;;;',
    ].join('\n');

    const preview = (await upload(owner.accessToken, csv)).body.data;
    expect(preview.headers[0]).toBe('Задача');
    expect(preview.mapping.title).toBe(0);
    expect(preview.mapping.assignee).toBe(2);
    expect(preview.mapping.deadline).toBe(3);
    // Строка без названия из предпросмотра НЕ прячется: человек должен видеть, что
    // в файле она есть. Пропущена она будет при импорте — и попадёт в счётчик.
    expect(preview.totalRows).toBe(3);

    const stats = (await http.post('/api/integrations/file/run').set(H(owner.accessToken))
      .send({ token: preview.token, mapping: preview.mapping, newProjectName: `Импорт ${uniq()}` })
      .expect(201)).body.data;
    expect(stats.created).toBe(2);
    expect(stats.skipped).toBe(1); // строка без названия — не задача
    // человека, которого нет в команде, не выдумываем — говорим об этом в отчёте
    expect(stats.warnings.join(' ')).toContain('неизвестный@нигде.нет');

    const projects = (await http.get('/api/projects').set(H(owner.accessToken)).expect(200)).body.data;
    const project = projects.find((p: any) => String(p.name).startsWith('Импорт '));
    const board = (await http.get(`/api/projects/${project.id}/board`).set(H(owner.accessToken)).expect(200)).body.data;
    const tasks = board.columns.flatMap((c: any) => c.tasks);
    expect(tasks).toHaveLength(2);

    const landing = tasks.find((t: any) => t.title === 'Сверстать лендинг');
    expect(String(landing.assignee_id)).toBe(String(owner.user.id)); // нашли по почте
    expect(landing.priority).toBe('urgent');
    expect(String(landing.deadline_at).slice(0, 10)).toBe('2026-10-15'); // 15 октября, а не 10 марта
    expect(landing.labels.map((l: any) => l.name).sort()).toEqual(['срочно', 'фронт']);

    // «Завершена: да» уезжает сразу в финальную колонку — иначе доска врёт
    const texts = tasks.find((t: any) => t.title === 'Написать тексты');
    expect(texts.closed_at).toBeTruthy();
  });

  it('повторный прогон того же файла не плодит дубли', async () => {
    const { owner } = await team();
    const csv = [
      'ID,Название,Статус',
      'A-1,Первая задача,Новые',
      'A-2,Вторая задача,Новые',
    ].join('\n');
    const name = `Повтор ${uniq()}`;

    const first = (await upload(owner.accessToken, csv)).body.data;
    expect(first.mapping.externalId).toBe(0);
    const run1 = (await http.post('/api/integrations/file/run').set(H(owner.accessToken))
      .send({ token: first.token, mapping: first.mapping, newProjectName: name }).expect(201)).body.data;
    expect(run1.created).toBe(2);

    const projects = (await http.get('/api/projects').set(H(owner.accessToken)).expect(200)).body.data;
    const project = projects.find((p: any) => p.name === name);

    // тот же файл во второй раз — в тот же проект
    const second = (await upload(owner.accessToken, csv)).body.data;
    const run2 = (await http.post('/api/integrations/file/run').set(H(owner.accessToken))
      .send({ token: second.token, mapping: second.mapping, projectId: String(project.id) }).expect(201)).body.data;
    expect(run2.created).toBe(0);
    expect(run2.updated).toBe(2);

    const board = (await http.get(`/api/projects/${project.id}/board`).set(H(owner.accessToken)).expect(200)).body.data;
    expect(board.columns.flatMap((c: any) => c.tasks)).toHaveLength(2);
  });

  it('файл без названия задачи и просроченный токен отвергаются понятно', async () => {
    const { owner } = await team();
    const preview = (await upload(owner.accessToken, 'Что-то,Ещё\n1,2')).body.data;
    // название не угадалось — сервер обязан сказать об этом, а не создать пустые задачи
    await http.post('/api/integrations/file/run').set(H(owner.accessToken))
      .send({ token: preview.token, mapping: {}, newProjectName: 'Пустой' }).expect(400);
    // чужой токен — не наш файл
    await http.post('/api/integrations/file/run').set(H(owner.accessToken))
      .send({ token: 'нетакого', mapping: { title: 0 }, newProjectName: 'Пустой' }).expect(404);
  });
});
