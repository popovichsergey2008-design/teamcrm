import {
  Body, Controller, Get, Post, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser, Roles } from '../../../common/auth/decorators';
import { AuthUser } from '../../../common/auth/jwt.types';
import { AppException } from '../../../common/http/app-exception';
import { FileImportService, Mapping } from './file-import.service';
import { IMPORT_FIELDS, ImportField } from './import-map';

/** Больше десяти мегабайт — это уже не переезд, а выгрузка базы. */
const MAX_BYTES = 10 * 1024 * 1024;

class RunImportDto {
  @IsString()
  @MaxLength(64)
  token!: string;

  /** Поле задачи → номер колонки файла. Проверяем содержимое руками: ключи динамические. */
  @IsObject()
  mapping!: Record<string, number>;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  projectId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  newProjectName?: string;
}

/**
 * Импорт задач из файла (CSV/Excel).
 *
 * Два шага и оба обязательны: сначала предпросмотр (что в файле, куда поедут колонки,
 * кого из людей не нашли), потом запись. Импорт «сразу и молча» — это работа на день
 * по разгребанию, если колонка угадана неверно.
 */
@ApiTags('integrations')
@ApiBearerAuth()
@Controller('integrations/file')
@Roles('owner', 'manager', 'member')
export class FileImportController {
  constructor(private readonly svc: FileImportService) {}

  /** Поля, в которые можно раскладывать колонки, — списком для интерфейса. */
  @Get('fields')
  fields() {
    return IMPORT_FIELDS;
  }

  @Post('preview')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES } }))
  preview(@CurrentUser() user: AuthUser, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw AppException.validation('Файл не получен');
    return this.svc.preview(user.tenantId, file.originalname || 'файл.csv', file.buffer);
  }

  @Post('run')
  run(@CurrentUser() user: AuthUser, @Body() dto: RunImportDto) {
    const known = new Set(IMPORT_FIELDS.map((f) => f.key as string));
    const mapping: Mapping = {};
    for (const [key, value] of Object.entries(dto.mapping ?? {})) {
      // чужие ключи и «не выбрано» просто игнорируем: это не ошибка, а обычное состояние формы
      if (!known.has(key) || value === null || value === undefined) continue;
      const index = Number(value);
      if (Number.isInteger(index) && index >= 0) mapping[key as ImportField] = index;
    }
    return this.svc.run(user.tenantId, user.userId, { ...dto, mapping });
  }
}
