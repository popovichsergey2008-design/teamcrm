import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { DbService } from '../src/database/db.service';

/**
 * Личная почта (ТЗ-18). Настоящего почтового сервера в CI нет, поэтому проверяем то,
 * что не зависит от него: почтовики, защиту «своего сервера» от внутренней сети,
 * личность ящика (чужие письма не видны никому, даже владельцу организации).
 */
describe('Почта секретаря (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  let db: DbService;
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
  });
  afterAll(async () => app?.close());

  it('почтовики, защита своего сервера, письма видит только владелец ящика', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Mail', email: `ml_${uniq()}@t.test`, password: 'password123', fullName: 'Сергей' }).expect(201)).body.data;
    const O = H(owner.accessToken);

    const providers = (await http$.get('/api/mailbox/providers').set(O).expect(200)).body.data;
    expect(providers.map((p: any) => p.id)).toEqual(expect.arrayContaining(['gmail', 'yandex', 'mailru', 'outlook']));
    expect((await http$.get('/api/mailbox/accounts').set(O).expect(200)).body.data).toEqual([]);

    // «свой сервер» не может вести во внутреннюю сеть и на чужие порты
    const internal = await http$.post('/api/mailbox/accounts').set(O).send({
      provider: 'custom', email: 'me@example.com', password: 'x', imapHost: '127.0.0.1', imapPort: 993, smtpHost: 'smtp.example.com', smtpPort: 465,
    }).expect(400);
    expect(JSON.stringify(internal.body)).toContain('внутреннюю сеть');
    await http$.post('/api/mailbox/accounts').set(O).send({
      provider: 'custom', email: 'me@example.com', password: 'x', imapHost: 'imap.example.com', imapPort: 5432, smtpHost: 'smtp.example.com', smtpPort: 465,
    }).expect(400);
    await http$.post('/api/mailbox/accounts').set(O).send({ provider: 'gmail', email: 'не адрес', password: 'x' }).expect(400);

    // письмо сотрудника, положенное как будто его забрал планировщик
    const mateEmail = `mlm_${uniq()}@t.test`;
    const mate = (await http$.post('/api/users').set(O).send({ email: mateEmail, fullName: 'Глеб', password: 'password123', role: 'member' }).expect(201)).body.data;
    const M = H((await http$.post('/api/auth/login').send({ email: mateEmail, password: 'password123' }).expect(201)).body.data.accessToken);
    const acc = await db.one<{ id: string }>(
      `INSERT INTO mail_accounts (tenant_id, user_id, provider, email, username, imap_host, imap_port, smtp_host, smtp_port, secret_enc)
       VALUES ($1,$2,'gmail',$3,$3,'imap.gmail.com',993,'smtp.gmail.com',465,'x') RETURNING id`,
      [owner.user.tenantId, mate.id, mateEmail],
    );
    const msg = await db.one<{ id: string }>(
      `INSERT INTO mail_messages (tenant_id, user_id, account_id, uid, from_email, from_name, subject, sent_at, body_text, category, reason)
       VALUES ($1,$2,$3,1,'boss@acme.ru','Иван','Срочно: договор',now(),'Подпишите сегодня','critical','срочные слова в письме') RETURNING id`,
      [owner.user.tenantId, mate.id, acc!.id],
    );
    const mine = (await http$.get('/api/mailbox/messages').set(M).expect(200)).body.data;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ subject: 'Срочно: договор', category: 'critical', from: 'Иван' });
    expect((await http$.get(`/api/mailbox/messages/${msg!.id}`).set(M).expect(200)).body.data.body).toBe('Подпишите сегодня');
    // владелец организации чужую почту не видит
    expect((await http$.get('/api/mailbox/messages').set(O).expect(200)).body.data).toEqual([]);
    await http$.get(`/api/mailbox/messages/${msg!.id}`).set(O).expect(404);
    await http$.delete(`/api/mailbox/accounts/${acc!.id}`).set(O).expect(404);
    // утренняя сводка сотрудника видит важное письмо
    const brief = (await http$.get('/api/anthill/secretary/brief/morning').set(M).expect(200)).body.data;
    expect(brief.text).toContain('Почта (непрочитанное): важных 1');
    await http$.delete(`/api/mailbox/accounts/${acc!.id}`).set(M).expect(200);
    expect((await http$.get('/api/mailbox/messages').set(M).expect(200)).body.data).toEqual([]);
  });
});
