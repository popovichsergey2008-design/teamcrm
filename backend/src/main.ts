import 'reflect-metadata';
import { ValidationPipe, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './common/auth/redis-io.adapter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api');
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
  });

  app.useWebSocketAdapter(new RedisIoAdapter(app));

  const swaggerConfig = new DocumentBuilder()
    .setTitle('TEAMCRM API')
    .setDescription('Этап 1 — каркас: auth/RBAC, projects, tasks, deals, board, realtime')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = Number(config.get('PORT') ?? 3000);
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`TEAMCRM backend on :${port} (docs at /api/docs)`);
}

bootstrap();
