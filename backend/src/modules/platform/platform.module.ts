import { Global, Module } from '@nestjs/common';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';

/**
 * Платформа — организация разработчика продукта и её техотдел.
 *
 * Глобальный: «кто здесь вендор» спрашивают и служба заботы, и личный кабинет, и
 * консоль. Заводить ради одного сервиса импорты в трёх модулях — лишний шум.
 */
@Global()
@Module({
  controllers: [PlatformController],
  providers: [PlatformService],
  exports: [PlatformService],
})
export class PlatformModule {}
