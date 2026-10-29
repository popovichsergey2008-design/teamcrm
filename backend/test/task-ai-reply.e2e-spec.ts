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
 * «Предложить ответ» / «Обновление статуса» / «Спасибо» в задаче (#4639, #4641, #4642).
 *
 * Границы: черновик не пишется в ленту, чужая задача — 404, без ключа ИИ — понятный
 * текст, «Спасибо» работает правилами и без ключа.
 */
describe('Ответ ИИ в обсуждении задачи (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  let db: DbService;
  let ai: AiService;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
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
  afterAll(async () => { await app?.close(); });

  it('спасибо правилами, без ключа — понятный текст, чужая задача — 404', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'ИИ-ответ', email: `air_${uniq()}@t.test`, password: 'Test-pass-2026', fullName: 'Постановщик Пётр' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const mk = async (name: string) => {
      const email = `airm_${uniq()}@t.test`;
      const u = (await http$.post('/api/users').set(O).send({ email, fullName: name, password: 'Test-pass-2026', role: 'member' }).expect(201)).body.data;
      const tok = (await http$.post('/api/auth/login').send({ email, password: 'Test-pass-2026' }).expect(201)).body.data.accessToken;
      return { id: String(u.id), H: H(tok) };
    };
    const nikita = await mk('Никита Адаменко');
    const stranger = await mk('Посторонний');

    const project = (await http$.post('/api/projects').set(O).send({ name: 'Вёрстка' }).expect(201)).body.data;
    const task = (await http$.post('/api/tasks').set(O)
      .send({ projectId: project.id, title: 'Поправить мобильную вёрстку', assigneeId: nikita.id }).expect(201)).body.data;
    await http$.post(`/api/tasks/${task.id}/comments`).set(O)
      .send({ body: '@Никита Адаменко, получится поправить до конца дня?' }).expect(201);

    // «Спасибо» — без модели: адресат последнего сообщения, текст в поле, не в ленту
    const before = (await http$.get(`/api/tasks/${task.id}/comments`).set(nikita.H).expect(200)).body.data.length;
    const thanks = (await http$.post(`/api/tasks/${task.id}/ai-reply`).set(nikita.H).send({ kind: 'thanks' }).expect(201)).body.data;
    expect(thanks.text).toBe('@Постановщик Пётр, спасибо!');
    expect(thanks.ai).toBe(false);
    expect(thanks.replyTo.reason).toBe('addressed');
    const other = (await http$.post(`/api/tasks/${task.id}/ai-reply`).set(nikita.H).send({ kind: 'thanks', variant: 1 }).expect(201)).body.data;
    expect(other.text).not.toBe(thanks.text);
    expect((await http$.get(`/api/tasks/${task.id}/comments`).set(nikita.H).expect(200)).body.data.length).toBe(before);

    // без ключа ИИ — понятный ответ, а не выдуманный заглушкой текст
    if (!(await ai.hasModel(owner.user.tenantId))) {
      const r = await http$.post(`/api/tasks/${task.id}/ai-reply`).set(nikita.H).send({ kind: 'reply' }).expect(409);
      expect(r.body.error?.message ?? r.body.message).toMatch(/Подключите ИИ/);
    }

    // неизвестный вид — 400
    await http$.post(`/api/tasks/${task.id}/ai-reply`).set(nikita.H).send({ kind: 'poem' }).expect(400);

    // задача закрытого проекта, где человек не участник, — как несуществующая
    await db.query(`UPDATE projects SET visibility = 'members' WHERE id = $1`, [project.id]);
    await http$.post(`/api/tasks/${task.id}/ai-reply`).set(stranger.H).send({ kind: 'thanks' }).expect(404);
    // исполнитель свою задачу видит и в закрытом проекте
    await http$.post(`/api/tasks/${task.id}/ai-reply`).set(nikita.H).send({ kind: 'thanks' }).expect(201);

    // задача другой компании — 404
    const alien = (await http$.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Чужие', email: `aira_${uniq()}@t.test`, password: 'Test-pass-2026', fullName: 'Чужой' }).expect(201)).body.data;
    await http$.post(`/api/tasks/${task.id}/ai-reply`).set(H(alien.accessToken)).send({ kind: 'thanks' }).expect(404);
  });
});
