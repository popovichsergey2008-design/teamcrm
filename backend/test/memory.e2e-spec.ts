import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { DbService } from '../src/database/db.service';
import { KnowledgeService } from '../src/modules/knowledge/knowledge.service';

/**
 * «Вторая память» (ТЗ-21, этап 4): личная переписка находится только участникам —
 * руководителю тоже нет; изменённое решение помнит замену; запись отдаётся кусками (Range).
 */
describe('Вторая память (e2e)', () => {
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
  afterAll(async () => { await app?.close(); });

  it('личка — только участникам; решение изменили; запись кусками', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Память', email: `mem_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const tenantId = String(owner.user.tenantId);
    const mk = async (name: string) => {
      const email = `memm_${uniq()}@t.test`;
      const u = (await http$.post('/api/users').set(O).send({ email, fullName: name, password: 'password123', role: 'member' }).expect(201)).body.data;
      const tok = (await http$.post('/api/auth/login').send({ email, password: 'password123' }).expect(201)).body.data.accessToken;
      return { id: String(u.id), H: H(tok) };
    };
    const gleb = await mk('Глеб');
    const anna = await mk('Анна');

    const chat = (await http$.post('/api/chats/dm').set(gleb.H).send({ userId: anna.id }).expect(201)).body.data;
    const msg = (await http$.post(`/api/chats/${chat.id}/messages`).set(gleb.H).send({ body: 'Смету для Восточного банка согласовали на 450 тысяч' }).expect(201)).body.data;
    const ks = app.get(KnowledgeService);
    await ks.indexSource({ tenantId, sourceType: 'chat', sourceId: String(msg.id) });

    const find = async (h: any) => (await http$.get('/api/knowledge/memory').query({ q: 'смета Восточного банка' }).set(h).expect(200)).body.data;
    const forAnna = await find(anna.H);
    expect(forAnna[0].sourceType).toBe('chat');
    expect(forAnna[0].link).toBe(`/chat/${chat.id}?m=${msg.id}`);
    expect(forAnna[0].private).toBe(true);
    expect((await find(O)).filter((h: any) => h.sourceType === 'chat')).toHaveLength(0);

    // решение со встречи → изменили → журнал и память помнят
    const [m] = await db.many<{ id: string }>(
      `INSERT INTO meetings (tenant_id, title, source, created_by, status) VALUES ($1, 'Планёрка', 'upload', $2, 'done') RETURNING id`,
      [tenantId, owner.user.id],
    );
    const [d] = await db.many<{ id: string }>(
      `INSERT INTO decisions (tenant_id, meeting_id, text, created_by) VALUES ($1, $2, 'Форма заявки — три поля', $3) RETURNING id::text`,
      [tenantId, m.id, owner.user.id],
    );
    await http$.post(`/api/chat-analysis/decisions/${d.id}/supersede`).set(gleb.H).send({ text: 'Форма — два поля' }).expect(403);
    const r = (await http$.post(`/api/chat-analysis/decisions/${d.id}/supersede`).set(O).send({ text: 'Форма заявки — два поля' }).expect(201)).body.data;
    const list = (await http$.get('/api/chat-analysis/decisions').set(O).expect(200)).body.data;
    const old = list.find((x: any) => x.id === d.id);
    expect(old.superseded_by).toBe(r.decisionId);
    expect(old.superseded_text).toBe('Форма заявки — два поля');
    await ks.indexSource({ tenantId, sourceType: 'decision', sourceId: d.id });
    const mem = (await http$.get('/api/knowledge/memory').query({ q: 'форма заявки', types: 'decision' }).set(O).expect(200)).body.data;
    expect(mem.some((h: any) => String(h.title).startsWith('Решение (изменено)'))).toBe(true);

    // запись встречи кусками: проигрыватель перематывает без скачивания целиком
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
    const fileId = String((await http$.post('/api/files').set(O)
      .attach('file', png, { filename: 'pic.png', contentType: 'image/png' }).expect(201)).body.data.id);
    const part = await http$.get(`/api/files/${fileId}`).set(O).set('Range', 'bytes=2-5')
      .buffer(true)
      .parse((res: any, cb: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(206);
    expect(part.headers['content-range']).toBe('bytes 2-5/16');
    expect(Buffer.compare(part.body as Buffer, png.subarray(2, 6))).toBe(0);
    await http$.get(`/api/files/${fileId}`).set(O).set('Range', 'bytes=50-').expect(416);
  });
});
