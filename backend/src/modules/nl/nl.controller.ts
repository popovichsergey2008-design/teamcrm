import { Body, Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { NlService } from './nl.service';

class ParseDto {
  @IsString() @MaxLength(2000) text!: string;
}
class ApplyDto {
  @IsIn(['create_task', 'create_deal', 'none']) intent!: 'create_task' | 'create_deal' | 'none';
  @IsOptional() @IsObject() task?: Record<string, unknown>;
  @IsOptional() @IsObject() deal?: Record<string, unknown>;
}

/** NL-команда / Zero-UI: текст → черновик → подтверждение → создание. Внутренние роли (не client). */
@ApiTags('nl')
@ApiBearerAuth()
@Controller('nl')
@Roles('owner', 'manager', 'member')
export class NlController {
  constructor(
    private readonly nl: NlService,
    private readonly ai: AiService,
  ) {}

  /** Голосовая команда: запись из браузера (multipart 'audio') → Whisper → текст (дальше обычный /parse). */
  @Post('transcribe')
  @UseInterceptors(FileInterceptor('audio', { limits: { fileSize: 25 * 1024 * 1024 } }))
  async transcribe(@CurrentUser() u: AuthUser, @UploadedFile() file?: Express.Multer.File) {
    if (!file?.buffer?.length) throw AppException.validation('Аудио не получено');
    const text = await this.ai.transcribeAudio(u.tenantId, file.buffer, file.originalname || 'audio.webm');
    return { text: (text || '').trim() };
  }

  @Post('parse')
  parse(@CurrentUser() u: AuthUser, @Body() dto: ParseDto) {
    return this.nl.parse(u.tenantId, u.userId, dto.text);
  }

  @Post('apply')
  apply(@CurrentUser() u: AuthUser, @Body() dto: ApplyDto) {
    return this.nl.apply(u.tenantId, u.userId, dto);
  }
}
