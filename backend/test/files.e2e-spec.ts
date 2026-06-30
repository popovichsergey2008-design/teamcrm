import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/** Этап A (файлы) e2e. Требует живой MinIO + PG/Redis/RabbitMQ. */
describe('Enhancements v1 — Files (e2e)', () => {
  let app: INestApplication;
  let http: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

  // валидный минимальный PNG (сигнатура + немного данных)
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

  async function reg(): Promise<string> {
    const r = await http
      .post('/api/auth/register')
      .send({ tenantName: 'Files', email: `f_${uniq()}@t.test`, password: 'password123', fullName: 'U' })
      .expect(201);
    return r.body.data.accessToken;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useWebSocketAdapter(new RedisIoAdapter(app));
    void app.get(ConfigService);
    await app.listen(0, '0.0.0.0');
    http = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('загрузка → скачивание (байты совпадают)', async () => {
    const token = await reg();
    const up = await http
      .post('/api/files')
      .set({ Authorization: `Bearer ${token}` })
      .attach('file', png, { filename: 'pic.png', contentType: 'image/png' })
      .expect(201);
    expect(up.body.ok).toBe(true);
    const id = up.body.data.id;
    expect(up.body.data.sizeBytes).toBe(png.length);

    const dl = await http
      .get(`/api/files/${id}`)
      .set({ Authorization: `Bearer ${token}` })
      .buffer(true)
      .parse((res: any, cb: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.compare(dl.body as Buffer, png)).toBe(0);
  }, 30000);

  it('отклоняет неразрешённый тип', async () => {
    const token = await reg();
    const res = await http
      .post('/api/files')
      .set({ Authorization: `Bearer ${token}` })
      .attach('file', Buffer.from('MZ...'), { filename: 'evil.exe', contentType: 'application/x-msdownload' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  }, 30000);

  it('tenant-изоляция: чужой файл недоступен (404)', async () => {
    const tokenA = await reg();
    const up = await http
      .post('/api/files')
      .set({ Authorization: `Bearer ${tokenA}` })
      .attach('file', png, { filename: 'a.png', contentType: 'image/png' })
      .expect(201);
    const id = up.body.data.id;

    const tokenB = await reg();
    await http.get(`/api/files/${id}`).set({ Authorization: `Bearer ${tokenB}` }).expect(404);
    await http.delete(`/api/files/${id}`).set({ Authorization: `Bearer ${tokenB}` }).expect(404);
  }, 30000);

  it('удаление автором → файл недоступен', async () => {
    const token = await reg();
    const up = await http
      .post('/api/files')
      .set({ Authorization: `Bearer ${token}` })
      .attach('file', png, { filename: 'del.png', contentType: 'image/png' })
      .expect(201);
    const id = up.body.data.id;
    await http.delete(`/api/files/${id}`).set({ Authorization: `Bearer ${token}` }).expect(200);
    await http.get(`/api/files/${id}`).set({ Authorization: `Bearer ${token}` }).expect(404);
  }, 30000);
});
