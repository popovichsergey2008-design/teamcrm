import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';

/** ТЗ-31: задачи без проекта не бывает — одна проверка на все пути, понятные коды. */
describe('Обязательный проект (e2e)', () => {
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
    await app.listen(0, '0.0.0.0');
    http$ = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
  });
  afterAll(async () => { await app?.close(); });

  it('без проекта — 422 PROJECT_REQUIRED; архив — 422; чужой закрытый — 403; с проектом — создаётся', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'RP', email: `rp_${uniq()}@t.test`, password: 'password123', fullName: 'Анна Владелец' })
      .expect(201)).body.data;
    const O = H(owner.accessToken);
    const email = `rp_m_${uniq()}@t.test`;
    await http$.post('/api/users').set(O).send({ email, fullName: 'Борис Сотрудник', password: 'password123', role: 'member' }).expect(201);
    const M = H((await http$.post('/api/auth/login').send({ email, password: 'password123' }).expect(201)).body.data.accessToken);

    const open = (await http$.post('/api/projects').set(O).send({ name: 'Открытый' }).expect(201)).body.data;
    const closed = (await http$.post('/api/projects').set(O).send({ name: 'Закрытый' }).expect(201)).body.data;
    await http$.patch(`/api/projects/${closed.id}`).set(O).send({ visibility: 'members' }).expect(200);
    const old = (await http$.post('/api/projects').set(O).send({ name: 'Старый' }).expect(201)).body.data;
    await http$.post(`/api/projects/${old.id}/archive`).set(O).expect(201);

    const none = (await http$.post('/api/tasks').set(O).send({ title: 'Без проекта' }).expect(422)).body;
    expect(none.error.details).toMatchObject({ code: 'PROJECT_REQUIRED', field: 'project_id' });
    expect(none.error.message).toContain('Выберите проект');

    const arch = (await http$.post('/api/tasks').set(O).send({ projectId: old.id, title: 'В архив' }).expect(422)).body;
    expect(arch.error.details.code).toBe('PROJECT_ARCHIVED');

    const missing = (await http$.post('/api/tasks').set(O).send({ projectId: '999999999', title: 'Нет такого' }).expect(404)).body;
    expect(missing.error.details.code).toBe('PROJECT_NOT_FOUND');

    const hidden = (await http$.post('/api/tasks').set(M).send({ projectId: closed.id, title: 'Чужой' }).expect(403)).body;
    expect(hidden.error.details.code).toBe('PROJECT_FORBIDDEN');

    // быстрая команда / голос — та же проверка
    const nl = (await http$.post('/api/nl/apply').set(M).send({ intent: 'create_task', task: { projectId: closed.id, title: 'Чужой' } }).expect(403)).body;
    expect(nl.error.details.code).toBe('PROJECT_FORBIDDEN');

    await http$.post('/api/tasks').set(M).send({ projectId: open.id, title: 'Нормальная' }).expect(201);
  });
});
