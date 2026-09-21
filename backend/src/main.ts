import 'reflect-metadata';
import { ValidationPipe, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './common/auth/redis-io.adapter';
import { REQUEST_ID_HEADER, requestId } from './common/http/request-id.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const config = app.get(ConfigService);
  /*
    API стоит за edge-nginx: без доверия к первому прокси @Ip() отдаёт адрес контейнера
    (172.18.x.x), и в списке устройств у всех сессий один и тот же «IP». Один прокси —
    один уровень доверия; заголовок X-Forwarded-For nginx выставляет сам.
  */
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  // Номер каждого запроса — в ответ и в журнал: нитка между экраном человека и логом.
  app.use(requestId);

  /*
    Всё приложение живёт под `/api`, кроме метрик.

    Наружный nginx проксирует в приложение только `/api/`, `/socket.io/` и `/ws/meet`.
    Оставив метрики под общим префиксом, мы бы выставили наружу длину очереди поддержки
    и состояние модели. Вне префикса они доступны только изнутри docker-сети, где и
    стоит Prometheus, — это дешевле и надёжнее ещё одного секрета.
  */
  app.setGlobalPrefix('api', { exclude: ['metrics'] });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const corsList = config
    .getOrThrow<string>('CORS_ORIGIN')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsList.length > 1 ? corsList : corsList[0],
    credentials: true,
    // Иначе браузер спрячет заголовок от скрипта, и клиент номер не увидит.
    exposedHeaders: [REQUEST_ID_HEADER],
  });

  app.useWebSocketAdapter(new RedisIoAdapter(app));

  const swaggerConfig = new DocumentBuilder()
    .setTitle('ANTHILL API')
    .setDescription('Этап 1 — каркас: auth/RBAC, projects, tasks, deals, board, realtime')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = Number(config.get('PORT') ?? 3000);
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`ANTHILL backend on :${port} (docs at /api/docs)`);
}

bootstrap();
