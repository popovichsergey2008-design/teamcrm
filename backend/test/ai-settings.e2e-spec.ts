import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/** BYOK: ключи ИИ на арендатора (шифрованные), выбор модели, статус без раскрытия ключа. */
describe('AI settings BYOK (e2e)', () => {
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

  it('владелец задаёт ключ+модель; статус без раскрытия; изоляция по tenant', async () => {
    const a = (await http.post('/api/auth/register').send({ tenantName: 'AI-A', email: `a_${uniq()}@t.test`, password: 'password123', fullName: 'Анна' }).expect(201)).body.data;
    const tok = a.accessToken;

    let st = (await http.get('/api/ai/settings').set(H(tok)).expect(200)).body.data;
    expect(st.openaiKeySet).toBe(false);

    const saved = (await http.put('/api/ai/settings').set(H(tok)).send({ openaiKey: 'sk-test-secret-123', brainModel: 'gpt-4o-mini' }).expect(200)).body.data;
    expect(saved.openaiKeySet).toBe(true);
    expect(saved.brainModel).toBe('gpt-4o-mini');
    // ключ НЕ возвращается ни в статусе, ни где-либо
    expect(JSON.stringify(saved)).not.toContain('sk-test-secret-123');

    st = (await http.get('/api/ai/settings').set(H(tok)).expect(200)).body.data;
    expect(st.openaiKeySet).toBe(true);
    expect(JSON.stringify(st)).not.toContain('sk-test-secret-123');

    // удаление ключа → возврат к общему
    const cleared = (await http.put('/api/ai/settings').set(H(tok)).send({ openaiKey: '' }).expect(200)).body.data;
    expect(cleared.openaiKeySet).toBe(false);

    // другой арендатор не видит настроек первого
    const b = (await http.post('/api/auth/register').send({ tenantName: 'AI-B', email: `b_${uniq()}@t.test`, password: 'password123', fullName: 'Б' }).expect(201)).body.data;
    const stB = (await http.get('/api/ai/settings').set(H(b.accessToken)).expect(200)).body.data;
    expect(stB.openaiKeySet).toBe(false);

    // не-владелец (member) не имеет доступа к ИИ-настройкам
    const mEmail = `m_${uniq()}@t.test`;
    const inv = (await http.post('/api/invites').set(H(tok)).send({ email: mEmail, role: 'member' }).expect(201)).body.data;
    await http.post('/api/invites/accept').send({ token: inv.token, fullName: 'Петя', password: 'memberpass1' }).expect(201);
    const m = (await http.post('/api/auth/login').send({ email: mEmail, password: 'memberpass1' }).expect(201)).body.data;
    await http.get('/api/ai/settings').set(H(m.accessToken)).expect(403);
  });

  it('список моделей доступен (fallback без ключа)', async () => {
    const a = (await http.post('/api/auth/register').send({ tenantName: 'AI-M', email: `m_${uniq()}@t.test`, password: 'password123', fullName: 'М' }).expect(201)).body.data;
    const models = (await http.get('/api/ai/settings/models').set(H(a.accessToken)).expect(200)).body.data;
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
  });
  it('расход ИИ показывает и то, что запускалось, и то, что не запускалось ни разу', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'AI-Usage', email: `u_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' })
      .expect(201)).body.data;
    const usage = (await http.get('/api/ai/usage?days=30').set(H(owner.accessToken)).expect(200)).body.data;

    // Итоги — в токенах и деньгах: «сколько ушло» без цифры денег не ответ.
    expect(typeof usage.totalTokens).toBe('number');
    expect(typeof usage.totalCost).toBe('number');
    expect(Array.isArray(usage.byDay)).toBe(true);

    // Каталог возможностей приходит целиком, включая незапускавшиеся: ноль напротив
    // строки — ровно тот ответ, ради которого экран и делался.
    const keys = usage.byFeature.map((f: any) => f.feature);
    expect(keys).toContain('nl_command');
    expect(keys).toContain('meeting_analyze');
    const idle = usage.byFeature.find((f: any) => f.calls === 0);
    expect(idle.title.length).toBeGreaterThan(3); // человеческое название, а не ключ
    expect(idle.where.length).toBeGreaterThan(0); // и место, где это запускается
  });
});
