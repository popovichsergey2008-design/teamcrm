import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Теги задач и разметка через ИИ (ТЗ «Теги задач + автоматическая AI-разметка»).
 *
 * Проверяем то, что ломается молча: базовый набор у новой организации, защиту от
 * дублей вроде «SEO»/«seo», архив вместо удаления и главное — что задача не создаётся,
 * пока постановщик не подтвердил теги. Последнее проверяем именно на сервере: правило
 * компании нельзя обходить старым клиентом или чужим скриптом.
 */
describe('теги задач (e2e)', () => {
  let app: INestApplication;
  let http: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (token: string) => ({ Authorization: `Bearer ${token}` });

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
  afterAll(async () => { await app?.close(); });

  it('базовый набор, дубли, архив и обязательное подтверждение перед созданием', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Теги', email: `tg_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга' })
      .expect(201)).body.data;
    const O = H(owner.accessToken);

    // Пять базовых тегов заводятся при регистрации — фильтр по тегам не должен быть пустым с первого дня.
    const list = (await http.get('/api/tags').set(O).expect(200)).body.data;
    expect(list.items.length).toBeGreaterThanOrEqual(5);
    expect(list.items.map((t: any) => t.name)).toEqual(
      expect.arrayContaining(['Контентная задача', 'Программная задача', 'Дизайнерская задача', 'Клиент-менеджер', 'Отложенная задача']),
    );
    // По умолчанию разметка включена и требует подтверждения (требование ТЗ).
    expect(list.settings.aiTagging).toBe(true);
    expect(list.settings.requireConfirmation).toBe(true);

    // Свой тег компании.
    const seo = (await http.post('/api/tags').set(O).send({ name: 'SEO' }).expect(201)).body.data;
    expect(seo.id).toBeTruthy();

    // Похожий по написанию — предупреждение, а не молчаливый дубль.
    const dup = await http.post('/api/tags').set(O).send({ name: 'seo' }).expect(409);
    expect(String(dup.body.error.message)).toContain('Похожий тег');
    expect(dup.body.error.details.similar.name).toBe('SEO');
    // Настоять на своём можно осознанно — это право руководителя.
    await http.post('/api/tags').set(O).send({ name: 'seo', force: true }).expect(201);

    const project = (await http.post('/api/projects').set(O).send({ name: 'Сайт' }).expect(201)).body.data;

    /*
      Главное правило: клиент, который знает о тегах, без подтверждения задачу не
      создаст — и это проверяет сервер, а не только окно. Иначе правило компании
      обходится любым изменённым фронтендом.
    */
    const denied = await http.post('/api/tasks').set(O)
      .send({ projectId: String(project.id), title: 'Задача без подтверждения тегов', tagsConfirmed: false })
      .expect(400);
    expect(String(denied.body.error.message)).toContain('Подтвердите теги');

    /*
      А клиент, который о тегах не знает (уже установленное приложение на телефоне,
      импорт, интеграция), работает как раньше: правило появилось сегодня, и отнимать
      у него постановку задач нельзя.
    */
    await http.post('/api/tasks').set(O)
      .send({ projectId: String(project.id), title: 'Задача из старого клиента' }).expect(201);

    // Подтвердили набор — создаётся.
    const withTag = (await http.post('/api/tasks').set(O).send({
      projectId: String(project.id), title: 'Исправить API импорта',
      labelIds: [String(seo.id)], suggestedTagIds: [String(seo.id)], tagsConfirmed: true,
    }).expect(201)).body.data;
    const tags = (await http.get(`/api/tasks/${withTag.id}/tags`).set(O).expect(200)).body.data;
    expect(tags.map((t: any) => t.name)).toEqual(['SEO']);
    // Источник тега сохранён: через месяц видно, что его предложил ИИ, а человек согласился.
    expect(tags[0].source).toBe('ai');

    // Сознательное «без тегов» — отдельное решение, и оно проходит.
    const noTags = (await http.post('/api/tasks').set(O).send({
      projectId: String(project.id), title: 'Задача без тегов', confirmedWithoutTags: true,
    }).expect(201)).body.data;
    expect((await http.get(`/api/tasks/${noTags.id}/tags`).set(O).expect(200)).body.data).toEqual([]);

    // Отбор по тегу считает сервер: в выборке только помеченная задача.
    const dayEnd = new Date().toISOString();
    const filtered = (await http
      .get(`/api/tasks/registry?scope=all&tagIds=${seo.id}&dayEnd=${dayEnd}`)
      .set(O).expect(200)).body.data;
    expect(filtered.items.map((t: any) => String(t.id))).toEqual([String(withTag.id)]);
    expect(filtered.items[0].tags.map((t: any) => t.name)).toEqual(['SEO']);

    // Архив вместо удаления: тег остаётся у задачи, но исчезает из выбора новых.
    await http.post(`/api/tags/${seo.id}/archive`).set(O).expect(201);
    const active = (await http.get('/api/tags').set(O).expect(200)).body.data;
    expect(active.items.some((t: any) => String(t.id) === String(seo.id))).toBe(false);
    const still = (await http.get(`/api/tasks/${withTag.id}/tags`).set(O).expect(200)).body.data;
    expect(still.map((t: any) => t.name)).toEqual(['SEO']);
    await http.post(`/api/tags/${seo.id}/restore`).set(O).expect(201);

    /*
      Компания вправе отказаться от разметки целиком — тогда ворот нет вовсе.
      Проверяем именно так, как это увидит человек: выключил настройку и создал задачу.
    */
    await http.post('/api/tags/settings').set(O).send({ aiTagging: false }).expect(201);
    await http.post('/api/tasks').set(O)
      .send({ projectId: String(project.id), title: 'Без разметки теги не спрашивают' }).expect(201);
  }, 90000);
});
