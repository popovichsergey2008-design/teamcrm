import { Body, Controller, Get, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { NlService } from './nl.service';
import { VoiceService } from './voice.service';

class ParseDto {
  @IsString() @MaxLength(2000) text!: string;
  /** Открытая доска: задачу почти всегда ставят в проект, на который человек смотрит. */
  @IsOptional() @IsString() @MaxLength(32) currentProjectId?: string;
}
class ParseEventDto {
  @IsString() @MaxLength(2000) text!: string;
  /** Местное «сейчас» клиента: «завтра в 15» — это его завтра, а не серверное. */
  @IsOptional() @IsString() @MaxLength(32) now?: string;
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
    private readonly voice: VoiceService,
  ) {}

  /** Голосовая команда: запись из браузера (multipart 'audio') → Whisper → текст (дальше обычный /parse). */
  @Post('transcribe')
  @UseInterceptors(FileInterceptor('audio', { limits: { fileSize: 25 * 1024 * 1024 } }))
  async transcribe(@CurrentUser() u: AuthUser, @UploadedFile() file?: Express.Multer.File) {
    if (!file?.buffer?.length) throw AppException.validation('Аудио не получено');
    // словарь компании: без него названия и имена латиницей превращаются в похожие
    // по звучанию русские слова — «ANTHILL» в «Тим Сирей», «Boris» в «Борисом»
    const hint = await this.nl.speechHint(u.tenantId).catch(() => undefined);
    const text = await this.ai.transcribeAudio(u.tenantId, file.buffer, file.originalname || 'audio.webm', hint);
    return { text: (text || '').trim() };
  }

  /**
   * Длинная надиктовка: принимаем запись и разбираем в фоне.
   *
   * Отдельно от `transcribe`, который отвечает текстом сразу: короткую фразу ждать
   * не надо, а пятиминутная запись не должна зависеть от таймаутов по пути.
   */
  @Post('voice')
  @UseInterceptors(FileInterceptor('audio', { limits: { fileSize: 64 * 1024 * 1024 } }))
  voiceStart(
    @CurrentUser() u: AuthUser,
    @UploadedFile() file?: Express.Multer.File,
    @Body('currentProjectId') currentProjectId?: string,
  ) {
    if (!file) throw AppException.validation('Аудио не получено');
    return this.voice.accept(u.tenantId, u.userId, file, currentProjectId ?? null);
  }

  /** Как идут дела с записью: расшифровка, разбор, готово или ошибка с причиной. */
  @Get('voice/:id')
  voiceStatus(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.voice.status(u.tenantId, u.userId, id);
  }

  /** Повторить обработку сохранённой записи — не заставляя диктовать заново. */
  @Post('voice/:id/retry')
  voiceRetry(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body('currentProjectId') currentProjectId?: string,
  ) {
    return this.voice.retry(u.tenantId, u.userId, id, currentProjectId ?? null);
  }

  @Post('parse')
  parse(@CurrentUser() u: AuthUser, @Body() dto: ParseDto) {
    return this.nl.parse(u.tenantId, u.userId, dto.text, dto.currentProjectId ?? null);
  }

  /**
   * Набранная команда с НЕСКОЛЬКИМИ поручениями → список черновиков.
   *
   * То же, что делает длинная надиктовка, только для текста: «Глебу форму, Юре
   * страницу, Алине тексты» из быстрой команды раньше сворачивалось в одну задачу.
   * Одно поручение — один черновик, как и прежде.
   */
  @Post('parse-many')
  parseMany(@CurrentUser() u: AuthUser, @Body() dto: ParseDto) {
    return this.nl.parseMany(u.tenantId, u.userId, dto.text, dto.currentProjectId ?? null);
  }

  /** Надиктованная встреча → заполненный черновик события (ничего не создаёт). */
  @Post('parse-event')
  parseEvent(@CurrentUser() u: AuthUser, @Body() dto: ParseEventDto) {
    return this.nl.parseEvent(u.tenantId, dto.text, dto.now);
  }

  @Post('apply')
  apply(@CurrentUser() u: AuthUser, @Body() dto: ApplyDto) {
    return this.nl.apply(u.tenantId, u.userId, dto);
  }
}
