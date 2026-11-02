import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module';
import { AppInstallsController } from './app-installs.controller';
import { AppInstallsService } from './app-installs.service';

/** Скачивания APK и запуски приложения/PWA — для консоли владельца (§5.3). */
@Global()
@Module({
  imports: [JwtModule.register({}), AuthModule],
  controllers: [AppInstallsController],
  providers: [AppInstallsService],
  exports: [AppInstallsService],
})
export class AppInstallsModule {}
