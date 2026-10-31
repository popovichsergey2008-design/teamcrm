import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module';
import { AppErrorsController } from './app-errors.controller';
import { AppErrorsService } from './app-errors.service';

/** Ошибки приложения для консоли разработчика: сервер пишет через фильтр, сайт — через /telemetry/error. */
@Global()
@Module({
  imports: [JwtModule.register({}), AuthModule],
  controllers: [AppErrorsController],
  providers: [AppErrorsService],
  exports: [AppErrorsService],
})
export class AppErrorsModule {}
