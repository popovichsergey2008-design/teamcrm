import { Global, Module } from '@nestjs/common';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { FilesRepository } from './files.repository';
import { S3Service } from './s3.client';

/** Global: FilesService доступен модулям аватаров (кабинет) и вложений (карточка). */
@Global()
@Module({
  controllers: [FilesController],
  providers: [S3Service, FilesRepository, FilesService],
  exports: [FilesService],
})
export class FilesModule {}
