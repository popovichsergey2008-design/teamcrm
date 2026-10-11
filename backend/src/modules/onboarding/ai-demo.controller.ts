import { Body, Controller, Get, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AiDemoService } from './ai-demo.service';

class StartDto {
  @IsOptional() @IsString() @MaxLength(24) entryPoint?: string;
}

class FinishDto {
  /** «Ввести текстом» или распознанное браузером (режим правил). */
  @IsOptional() @IsString() @MaxLength(2000) text?: string;
}

class CreateItemDto {
  @IsString() draftId!: string;
  @IsOptional() @IsString() @MaxLength(255) title?: string;
  /** ISO или '' — без срока */
  @IsOptional() @IsString() deadlineAt?: string;
  /** true — на себя, false — без исполнителя, нет — как услышал ИИ */
  @IsOptional() @IsBoolean() assignToMe?: boolean;
}

class CreateDto {
  @IsArray() @ArrayMaxSize(5) @ValidateNested({ each: true }) @Type(() => CreateItemDto) items!: CreateItemDto[];
}

class ConvertDto {
  @IsOptional() @IsString() @MaxLength(255) name?: string;
}

/** «Протестировать магию ИИ-созвона за 30 секунд» (ТЗ-24). Заказчику (client) недоступно. */
@ApiTags('onboarding')
@ApiBearerAuth()
@Controller('onboarding/ai-call')
@Roles('owner', 'manager', 'member')
export class AiDemoController {
  constructor(private readonly demo: AiDemoService) {}

  @Get()
  state(@CurrentUser() u: AuthUser) {
    return this.demo.state(this.a(u));
  }

  @Post('start')
  start(@CurrentUser() u: AuthUser, @Body() dto: StartDto) {
    return this.demo.start(this.a(u), dto.entryPoint ?? 'welcome');
  }

  @Post('skip')
  skip(@CurrentUser() u: AuthUser, @Body() dto: StartDto) {
    return this.demo.skip(this.a(u), dto.entryPoint ?? 'welcome');
  }

  /** «Сделать проект рабочим» — с новым именем или прежним. */
  @Post('projects/:projectId/convert')
  convert(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Body() dto: ConvertDto) {
    return this.demo.convert(this.a(u), projectId, dto.name ?? null);
  }

  @Get(':demoId')
  get(@CurrentUser() u: AuthUser, @Param('demoId') demoId: string) {
    return this.demo.get(this.a(u), demoId);
  }

  /** Конец «звонка»: запись голоса (поле audio) или текст. Звук не хранится. */
  @Post(':demoId/finish')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('audio', { limits: { fileSize: 8 * 1024 * 1024 } }))
  finish(@CurrentUser() u: AuthUser, @Param('demoId') demoId: string, @Body() dto: FinishDto, @UploadedFile() file?: Express.Multer.File) {
    return this.demo.finish(this.a(u), demoId, {
      audio: file ? { buffer: file.buffer, name: file.originalname || 'demo.webm' } : null,
      text: dto.text ?? null,
    });
  }

  @Post(':demoId/create-tasks')
  createTasks(@CurrentUser() u: AuthUser, @Param('demoId') demoId: string, @Body() dto: CreateDto) {
    return this.demo.createTasks(this.a(u), demoId, dto.items);
  }

  @Post(':demoId/complete')
  complete(@CurrentUser() u: AuthUser, @Param('demoId') demoId: string) {
    return this.demo.complete(this.a(u), demoId);
  }

  private a(u: AuthUser) {
    return { tenantId: u.tenantId, userId: u.userId };
  }
}
