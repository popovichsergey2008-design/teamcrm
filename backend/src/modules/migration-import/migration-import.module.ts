import { Module } from '@nestjs/common';
import { S3Service } from '../files/s3.client';
import { ProjectsModule } from '../projects/projects.module';
import { InvitesModule } from '../team/invites.module';
import { MigrationImportController } from './migration-import.controller';
import { MigrationImportRepository } from './migration-import.repository';
import { MigrationImportService } from './migration-import.service';

/**
 * Переезд из Slack и Telegram за вечер (#4902, п. 4).
 *
 * S3Service подключаем своим экземпляром: модуль файлов отдаёт наружу только
 * FilesService, а архиву переезда нужен прямой доступ к хранилищу (положить,
 * забрать, стереть) — это не вложение и в таблицу files он не идёт.
 */
@Module({
  imports: [ProjectsModule, InvitesModule],
  controllers: [MigrationImportController],
  providers: [MigrationImportService, MigrationImportRepository, S3Service],
})
export class MigrationImportModule {}
