import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Текущий фокус сотрудника и журнал «AI Секретаря» (ТЗ-2, этап 1, Ш5).
 *
 * Главное, что проверяем: фокус ставится и снимается, автофокус от таймера не
 * затирает написанное человеком руками, а виджет секретаря показывает ровно
 * записанное в журнал, а не выдуманное число.
 */
describe('ТЗ-2 — фокус и AI Секретарь (e2e)', () => {
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

  const register = async () => {
    const r = (await http.post('/api/auth/register')
      .send({ tenantName: 'Focus', email: `f_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' })
      .expect(201)).body.data;
    return r.accessToken as string;
  };

  it('фокус ставится, живёт своё время и снимается', async () => {
    const tok = await register();

    // пусто — это нормальное состояние «свободен», а не ошибка
    expect((await http.get('/api/focus/me').set(H(tok)).expect(200)).body.data).toBeNull();

    const set = (await http.put('/api/focus/me').set(H(tok))
      .send({ kind: 'deep', note: 'Работаю над макетом', minutes: 60 }).expect(200)).body.data;
    expect(set.kind).toBe('deep');
    expect(new Date(set.until).getTime()).toBeGreaterThan(Date.now());

    const mine = (await http.get('/api/focus/me').set(H(tok)).expect(200)).body.data;
    expect(mine.note).toBe('Работаю над макетом');

    // в списке организации человек виден с тем же фокусом
    const team = (await http.get('/api/focus/team').set(H(tok)).expect(200)).body.data;
    expect(team).toHaveLength(1);
    expect(team[0].note).toBe('Работаю над макетом');

    await http.delete('/api/focus/me').set(H(tok)).expect(200);
    expect((await http.get('/api/focus/me').set(H(tok)).expect(200)).body.data).toBeNull();
  });

  it('фокус без срока живёт до отмены', async () => {
    const tok = await register();
    // minutes: 0 — «пока не сниму сам»; срок при этом не выставляется
    await http.put('/api/focus/me').set(H(tok)).send({ kind: 'break', minutes: 0 }).expect(200);
    const open = (await http.get('/api/focus/me').set(H(tok)).expect(200)).body.data;
    expect(open.until).toBeNull();
    // Истечение срока проверяется условием в SQL (until > now()) и здесь не воспроизводится:
    // ждать минуту вживую в тесте — плохой размен, а лезть в базу мимо API незачем.
  });

  it('неизвестный вид фокуса отклоняется', async () => {
    const tok = await register();
    await http.put('/api/focus/me').set(H(tok)).send({ kind: 'sleeping' }).expect(400);
  });

  it('таймер по задаче ставит фокус сам, но не затирает написанное руками', async () => {
    const tok = await register();
    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'Фокус' }).expect(201)).body.data;
    const task = (await http.post('/api/tasks').set(H(tok))
      .send({ projectId: proj.id, title: 'Вёрстка каталога' }).expect(201)).body.data;

    await http.post(`/api/tasks/${task.id}/timer/start`).set(H(tok)).expect(201);
    const auto = (await http.get('/api/focus/me').set(H(tok)).expect(200)).body.data;
    expect(auto.kind).toBe('task');
    expect(auto.note).toBe('Вёрстка каталога');

    // работу остановили — автоматический статус снимается сам, а не висит сутками
    await http.post(`/api/tasks/${task.id}/timer/stop`).set(H(tok)).expect(201);
    expect((await http.get('/api/focus/me').set(H(tok)).expect(200)).body.data).toBeNull();
    await http.post(`/api/tasks/${task.id}/timer/start`).set(H(tok)).expect(201);

    // человек сказал, чем занят, — второй старт таймера не должен это переписывать
    await http.put('/api/focus/me').set(H(tok))
      .send({ kind: 'deep', note: 'Готовлю отчёт совету директоров', minutes: 60 }).expect(200);
    await http.post(`/api/tasks/${task.id}/timer/stop`).set(H(tok)).expect(201);
    await http.post(`/api/tasks/${task.id}/timer/start`).set(H(tok)).expect(201);

    const kept = (await http.get('/api/focus/me').set(H(tok)).expect(200)).body.data;
    expect(kept.note).toBe('Готовлю отчёт совету директоров');
  });

  it('журнал секретаря пуст, пока ассистент ничего не сделал', async () => {
    const tok = await register();
    expect((await http.get('/api/secretary/summary').set(H(tok)).expect(200)).body.data)
      .toEqual({ actions: 0, savedMinutes: 0 });
    expect((await http.get('/api/secretary/log').set(H(tok)).expect(200)).body.data).toEqual([]);
  });
});
