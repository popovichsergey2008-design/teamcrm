import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { DbService } from '../src/database/db.service';
import { AiService } from '../src/modules/ai/ai.service';

/**
 * Отчёт «было/стало» (#4657).
 *
 * Границы: пункты из списка описания, снимок постановщика — «было», снимок
 * исполнителя с «п. 1» — «стало» первого пункта; без ключа ИИ отчёт всё равно
 * строится («проверьте глазами»), второй пункт без результата — «результат не
 * приложен»; повтор без изменений версию не плодит; сдача запускает проверку сама
 * и пишет итог в обсуждение; чужая задача — 404.
 */
describe('Было/стало (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  let db: DbService;
  let ai: AiService;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
  const prevDelay = process.env.BEFORE_AFTER_AUTO_DELAY_MS;

  beforeAll(async () => {
    process.env.BEFORE_AFTER_AUTO_DELAY_MS = '50';
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.listen(0, '0.0.0.0');
    http$ = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
    db = app.get(DbService);
    ai = app.get(AiService);
  });
  afterAll(async () => {
    process.env.BEFORE_AFTER_AUTO_DELAY_MS = prevDelay;
    await app?.close();
  });

  /** Ждём, пока фоновая проверка допишет отчёт. */
  const settle = async (taskId: string, auth: Record<string, string>, want: (o: any) => boolean) => {
    for (let i = 0; i < 60; i++) {
      const o = (await http$.get(`/api/tasks/${taskId}/before-after`).set(auth).expect(200)).body.data;
      if (want(o)) return o;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('отчёт «было/стало» не дописался');
  };

  it('отчёт по пунктам, без ключа — глазами, повтор без изменений, автозапуск после сдачи, 404 чужим', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Было-стало', email: `ba_${uniq()}@t.test`, password: 'Test-pass-2026', fullName: 'Постановщик Пётр' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const mk = async (name: string) => {
      const email = `bam_${uniq()}@t.test`;
      const u = (await http$.post('/api/users').set(O).send({ email, fullName: name, password: 'Test-pass-2026', role: 'member' }).expect(201)).body.data;
      const tok = (await http$.post('/api/auth/login').send({ email, password: 'Test-pass-2026' }).expect(201)).body.data.accessToken;
      return { id: String(u.id), H: H(tok) };
    };
    const doer = await mk('Исполнитель Иван');
    const stranger = await mk('Посторонний');
    await http$.put('/api/handoff-gate').set(O).send({ checklist: false, comment: false, attachment: false }).expect(200);

    const project = (await http$.post('/api/projects').set(O).send({ name: 'Сайт' }).expect(201)).body.data;
    const board = (await http$.get(`/api/projects/${project.id}/board`).set(O).expect(200)).body.data;
    const done = board.columns.find((c: any) => c.name === 'Готово').id;
    const task = (await http$.post('/api/tasks').set(O).send({
      projectId: project.id, assigneeId: doer.id, title: 'Правки на сайте',
      description: '<ol><li>Подзаголовок: заменить «помощник внутри переписки» на «помощник внутри приложения»</li><li>Иконка карточки «Задача из сообщения»</li></ol>',
    }).expect(201)).body.data;

    // «было»: снимок постановщика; «стало»: снимок исполнителя с подписью «п. 1»
    await http$.post(`/api/tasks/${task.id}/attachments`).set(O)
      .attach('file', png, { filename: 'было-подзаголовок.png', contentType: 'image/png' }).expect(201);
    await http$.post(`/api/tasks/${task.id}/comments/file`).set(doer.H)
      .field('body', 'п. 1 — поправил подзаголовок')
      .attach('files', png, { filename: 'стало.png', contentType: 'image/png' }).expect(201);

    const started = (await http$.post(`/api/tasks/${task.id}/before-after`).set(O).expect(201)).body.data;
    expect(started.unchanged).toBe(false);
    expect(started.report.version).toBe(1);

    const o = await settle(task.id, O, (x) => x.current?.status === 'ready');
    const r = o.current;
    expect(r.trigger).toBe('manual');
    expect(r.items).toHaveLength(2);
    expect(r.items[0].change).toEqual({ from: 'помощник внутри переписки', to: 'помощник внутри приложения' });
    expect(r.items[0].before).toHaveLength(1);
    expect(r.items[0].after.map((s: any) => s.name)).toEqual(['стало.png']);
    // второй пункт: снимка «стало» нет, но есть сообщение исполнителя — решать глазами, а не «не приложен»
    if (!(await ai.hasModel(owner.user.tenantId))) {
      expect(r.mode).toBe('eyes');
      expect(r.items.every((i: any) => i.verdict === 'eyes')).toBe(true);
      expect(r.summary.message).toMatch(/сравните снимки глазами/);
    }
    expect(o.changed).toBe(false);

    // ничего не изменилось — новой версии нет
    const again = (await http$.post(`/api/tasks/${task.id}/before-after`).set(O).expect(201)).body.data;
    expect(again.unchanged).toBe(true);
    expect(again.report.id).toBe(r.id);

    // посторонний в закрытом проекте — как несуществующая
    await db.query(`UPDATE projects SET visibility = 'members' WHERE id = $1`, [project.id]);
    await http$.get(`/api/tasks/${task.id}/before-after`).set(stranger.H).expect(404);
    await http$.post(`/api/tasks/${task.id}/before-after`).set(stranger.H).expect(404);
    await http$.get(`/api/tasks/${task.id}/before-after/${r.id}`).set(stranger.H).expect(404);
    // исполнитель свою задачу видит и в закрытом проекте
    await http$.get(`/api/tasks/${task.id}/before-after/${r.id}`).set(doer.H).expect(200);

    // новый снимок и сдача — проверка сама, итог в обсуждении
    await http$.post(`/api/tasks/${task.id}/comments/file`).set(doer.H)
      .field('body', 'п. 2 иконка')
      .attach('files', png, { filename: 'иконка.png', contentType: 'image/png' }).expect(201);
    await http$.post(`/api/tasks/${task.id}/move`).set(doer.H).send({ columnId: done, position: 0 }).expect(201);
    const auto = await settle(task.id, O, (x) => x.current?.version === 2 && x.current?.status === 'ready');
    expect(auto.current.trigger).toBe('auto');
    expect(auto.current.items[1].after.map((s: any) => s.name)).toEqual(['иконка.png']);
    expect(auto.versions).toHaveLength(2);
    const comments = (await http$.get(`/api/tasks/${task.id}/comments`).set(O).expect(200)).body.data;
    expect(comments.some((c: any) => c.is_ai && /было\/стало/.test(String(c.body)))).toBe(true);

    // задача другой компании — 404
    const alien = (await http$.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Чужие', email: `baa_${uniq()}@t.test`, password: 'Test-pass-2026', fullName: 'Чужой' }).expect(201)).body.data;
    await http$.get(`/api/tasks/${task.id}/before-after`).set(H(alien.accessToken)).expect(404);
  });

  /**
   * Случай #4657: постановщик приложил ОБРАЗЕЦ желаемого результата, а пункты — критерии
   * приёмки функции. Образец не «было», итог — не «нашли ошибки»; сдача без результата
   * отчёт сама не собирает; роль снимка можно поправить руками, а «Попросить результат»
   * пишет исполнителю один раз.
   */
  it('образец постановщика и чек-лист приёмки: без «ошибок», роль руками, «Попросить результат» один раз', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Образец', email: `bae_${uniq()}@t.test`, password: 'Test-pass-2026', fullName: 'Постановщик Константин' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const email = `baed_${uniq()}@t.test`;
    const doerUser = (await http$.post('/api/users').set(O).send({ email, fullName: 'Исполнитель', password: 'Test-pass-2026', role: 'member' }).expect(201)).body.data;
    const D = H((await http$.post('/api/auth/login').send({ email, password: 'Test-pass-2026' }).expect(201)).body.data.accessToken);
    await http$.put('/api/handoff-gate').set(O).send({ checklist: false, comment: false, attachment: false }).expect(200);
    const project = (await http$.post('/api/projects').set(O).send({ name: 'Функции' }).expect(201)).body.data;
    const board = (await http$.get(`/api/projects/${project.id}/board`).set(O).expect(200)).body.data;
    const done = board.columns.find((c: any) => c.name === 'Готово').id;
    const task = (await http$.post('/api/tasks').set(O).send({
      projectId: project.id, assigneeId: String(doerUser.id), title: 'Отчёт «было/стало»',
      description: '<p>Нужен отчёт по задаче. Образец отчёта — на скринах во вложении.</p>',
    }).expect(201)).body.data;
    for (const text of [
      'Открыть завершённую задачу и запустить проверку',
      'Убедиться, что формируется отчёт с блоками «Было» и «Стало»',
      'Проверить итог',
      'Принять или отклонить работу',
    ]) await http$.post(`/api/tasks/${task.id}/checklist`).set(O).send({ text }).expect(201);
    const file = (await http$.post(`/api/tasks/${task.id}/attachments`).set(O)
      .attach('file', png, { filename: '4657_1226.png', contentType: 'image/png' }).expect(201)).body.data;
    const fileId = String(file.file_id ?? file.fileId ?? file.id);

    // сдача без результата — сама не проверяет: образец «стало» не считается.
    // Чек-лист здесь — критерии приёмки, их отмечает постановщик: сдаче он не мешает
    await http$.patch(`/api/tasks/${task.id}/checklist-required`).set(O).send({ required: false }).expect(200);
    await http$.post(`/api/tasks/${task.id}/move`).set(D).send({ columnId: done, position: 0, confirmGate: true }).expect(201);
    await new Promise((r) => setTimeout(r, 600));
    expect((await http$.get(`/api/tasks/${task.id}/before-after`).set(O).expect(200)).body.data.versions).toHaveLength(0);

    await http$.post(`/api/tasks/${task.id}/before-after`).set(O).expect(201);
    const o = await settle(task.id, O, (x) => x.current?.status === 'ready');
    const r = o.current;
    expect(r.items).toHaveLength(4);
    expect(r.summary.message).not.toMatch(/ошибк/);
    expect(o.task.canSetRoles).toBe(true);
    if (!(await ai.hasModel(owner.user.tenantId))) {
      // правила: описание называет вложение образцом — оно отдельно, а не в «Было»
      expect(r.summary.examples.map((s: any) => s.fileId)).toEqual([fileId]);
      expect(r.items.every((i: any) => !i.before.length && i.verdict === 'no_result')).toBe(true);
      expect(r.summary.kind).toBe('functional');
      expect(r.summary.message).toBe('Исполнитель пока не приложил результат — проверять нечего.');
    }

    // роль руками: «Было» — отпечаток другой, отчёт предлагает пересобрать
    await http$.put(`/api/tasks/${task.id}/before-after/shots/${fileId}`).set(O).send({ role: 'before' }).expect(200);
    await http$.put(`/api/tasks/${task.id}/before-after/shots/${fileId}`).set(O).send({ role: 'чепуха' }).expect(400);
    const o2 = (await http$.get(`/api/tasks/${task.id}/before-after`).set(O).expect(200)).body.data;
    expect(o2.roles).toEqual({ [fileId]: 'before' });
    expect(o2.changed).toBe(true);
    await http$.post(`/api/tasks/${task.id}/before-after`).set(O).expect(201);
    const o3 = await settle(task.id, O, (x) => x.current?.version === 2 && x.current?.status === 'ready');
    const shots = [...o3.current.items.flatMap((i: any) => i.before), ...(o3.current.summary.loose?.before ?? [])];
    expect(shots.map((s: any) => [s.fileId, s.roleBy])).toEqual([[fileId, 'manual']]);
    expect(o3.current.summary.examples ?? []).toHaveLength(0);
    // чужой файл — как несуществующий
    await http$.put(`/api/tasks/${task.id}/before-after/shots/999999999`).set(O).send({ role: 'none' }).expect(404);

    // «Попросить результат» — один раз
    const first = (await http$.post(`/api/tasks/${task.id}/before-after/${o3.current.id}/ask-result`).set(O).expect(201)).body.data;
    const second = (await http$.post(`/api/tasks/${task.id}/before-after/${o3.current.id}/ask-result`).set(O).expect(201)).body.data;
    expect([first.sent, second.sent]).toEqual([true, false]);
    const comments = (await http$.get(`/api/tasks/${task.id}/comments`).set(O).expect(200)).body.data;
    expect(comments.filter((c: any) => /Приложите, пожалуйста, как стало/.test(String(c.body)))).toHaveLength(1);

    // «Проверено» у пункта — постановщик ставит, исполнитель нет
    const checked = (await http$.put(`/api/tasks/${task.id}/before-after/${o3.current.id}/checked`).set(O).send({ n: 2, checked: true }).expect(200)).body.data;
    expect(Object.keys(checked.summary.checked)).toEqual(['2']);
    await http$.put(`/api/tasks/${task.id}/before-after/${o3.current.id}/checked`).set(D).send({ n: 2, checked: false }).expect(403);
    const unchecked = (await http$.put(`/api/tasks/${task.id}/before-after/${o3.current.id}/checked`).set(O).send({ n: 2, checked: false }).expect(200)).body.data;
    expect(unchecked.summary.checked).toEqual({});
  });
});
