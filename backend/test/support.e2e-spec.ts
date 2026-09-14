import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Кнопка «Поддержка».
 *
 * Обращение — обычная задача в проекте поддержки: постановщик — кто обратился,
 * исполнитель — владелец. Проект заводится сам, пока руководитель не выбрал свой.
 */
describe('Поддержка (e2e)', () => {
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
  afterAll(async () => app?.close());

  it('обращение сотрудника становится задачей владельцу в проекте поддержки', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'SUP', email: `sup_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' }).expect(201)).body.data;
    const mateEmail = `supm_${uniq()}@t.test`;
    const mate = (await http$.post('/api/users').set(H(owner.accessToken))
      .send({ email: mateEmail, fullName: 'Сотрудник', password: 'password123', role: 'member' }).expect(201)).body.data;
    const M = H((await http$.post('/api/auth/login').send({ email: mateEmail, password: 'password123' }).expect(201)).body.data.accessToken);
    const O = H(owner.accessToken);

    // до первого обращения проекта поддержки нет — и это не ошибка
    const empty = (await http$.get('/api/support').set(M).expect(200)).body.data;
    expect(empty.project).toBeNull();
    expect(empty.tickets).toEqual([]);

    // первое обращение заводит проект само: человек с проблемой не упирается в «настройте»
    const ticket = (await http$.post('/api/support').set(M)
      .send({ title: 'Не открывается карточка задачи', description: 'Нажимаю — пусто' }).expect(201)).body.data;
    const projects = (await http$.get('/api/projects').set(M).expect(200)).body.data;
    const support = projects.find((p: any) => String(p.id) === String(ticket.projectId));
    expect(support.name).toBe('Поддержка');
    expect(support.is_support).toBe(true);

    // задача: исполнитель — владелец, постановщик — кто обратился
    const onBoard = async (projectId: string, taskId: string, who: any) => {
      const board = (await http$.get(`/api/projects/${projectId}/board`).set(who).expect(200)).body.data;
      return board.columns.flatMap((c: any) => c.tasks).find((t: any) => String(t.id) === String(taskId));
    };
    const task = await onBoard(ticket.projectId, ticket.id, M);
    expect(String(task.assignee_id)).toBe(String(owner.user.id));
    expect(String(task.created_by)).toBe(String(mate.id));
    expect(task.description).toBe('Нажимаю — пусто');

    // в моих обращениях — с текущим статусом
    const mine = (await http$.get('/api/support').set(M).expect(200)).body.data;
    expect(mine.tickets.map((t: any) => t.id)).toEqual([String(ticket.id)]);
    expect(mine.tickets[0].status).toBe('Новые');
    expect(mine.tickets[0].closed).toBe(false);
    // чужих обращений в списке нет
    expect((await http$.get('/api/support').set(O).expect(200)).body.data.tickets).toEqual([]);

    // пустое обращение не принимается
    await http$.post('/api/support').set(M).send({ title: '   ' }).expect(400);

    // руководитель переназначает проект поддержки — сотрудник этого сделать не может
    const other = (await http$.post('/api/projects').set(O).send({ name: 'Разработка' }).expect(201)).body.data;
    await http$.post(`/api/support/project/${other.id}`).set(M).send({ isSupport: true }).expect(403);
    await http$.post(`/api/support/project/${other.id}`).set(O).send({ isSupport: true }).expect(201);
    const next = (await http$.post('/api/support').set(M).send({ title: 'Второе' }).expect(201)).body.data;
    expect(String(next.projectId)).toBe(String(other.id));
    // прежний проект пометку потерял: поддержка одна на компанию
    const after = (await http$.get('/api/projects').set(O).expect(200)).body.data;
    expect(after.find((p: any) => String(p.id) === String(support.id)).is_support).toBe(false);

    // владелец пишет в поддержку сам — задача без исполнителя, а не «себе от себя»
    const own = (await http$.post('/api/support').set(O).send({ title: 'Идея' }).expect(201)).body.data;
    const ownTask = await onBoard(own.projectId, own.id, O);
    expect(ownTask.assignee_id).toBeNull();
  });
});
