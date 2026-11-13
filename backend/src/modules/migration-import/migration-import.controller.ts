import {
  Body, Controller, Get, Param, Post, Query, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { randomUUID } from 'crypto';
import { unlink } from 'fs/promises';
import { diskStorage } from 'multer';
import { tmpdir } from 'os';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { decodeUploadName } from '../files/files.validation';
import { ImportSource } from './import-types';
import { MigrationImportService } from './migration-import.service';

/**
 * Предел архива. Экспорт Slack — это текст без файлов и весит мегабайты даже за годы;
 * объём дают выгрузки Telegram с фото и документами. Пишем на диск, а не в память:
 * полгигабайта в памяти процесса API на каждую загрузку — путь к падению под нагрузкой.
 */
const MAX_BYTES = 500 * 1024 * 1024;

class StartDto {
  @IsOptional() @IsArray() @ArrayMaxSize(5000) @IsString({ each: true }) @MaxLength(255, { each: true })
  chatKeys?: string[];

  @IsOptional() @IsBoolean()
  invite?: boolean;

  @IsOptional() @IsBoolean()
  projects?: boolean;
}

/**
 * Переезд из Slack и Telegram (#4902, п. 4).
 *
 * Только владелец и руководитель: перенос заводит чаты и проекты на всю компанию
 * и рассылает приглашения от её имени.
 */
@ApiTags('migration-import')
@ApiBearerAuth()
@Controller('migration-import')
@Roles('owner', 'manager')
export class MigrationImportController {
  constructor(private readonly svc: MigrationImportService) {}

  /** Загрузить архив (multipart, поле file). ?source=slack|telegram */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: MAX_BYTES, files: 1 },
    storage: diskStorage({
      destination: tmpdir(),
      filename: (_req, _file, cb) => cb(null, `qevo-import-${randomUUID()}`),
    }),
  }))
  upload(
    @CurrentUser() user: AuthUser,
    @Query('source') source: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw AppException.validation('Файл не получен');
    if (source !== 'slack' && source !== 'telegram') {
      void unlink(file.path).catch(() => undefined); // отказ — и чужой архив не остаётся на диске
      throw AppException.validation('Укажите источник: slack или telegram');
    }
    return this.svc.upload(user.tenantId, user.userId, source as ImportSource, {
      path: file.path,
      // имя из multipart приходит побайтово как latin1 — чиним, как и для вложений
      originalname: decodeUploadName(file.originalname || 'архив'),
      size: file.size,
    });
  }

  @Get('jobs')
  list(@CurrentUser() user: AuthUser) {
    return this.svc.list(user.tenantId);
  }

  @Get('jobs/:id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    if (!/^\d{1,18}$/.test(id)) throw AppException.notFound('Загрузка не найдена');
    return this.svc.get(user.tenantId, id);
  }

  /** Перенести выбранное. Повторный запуск того же архива не создаёт дублей. */
  @Post('jobs/:id/start')
  start(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: StartDto) {
    if (!/^\d{1,18}$/.test(id)) throw AppException.notFound('Загрузка не найдена');
    return this.svc.start(user.tenantId, user.userId, id, dto);
  }
}
