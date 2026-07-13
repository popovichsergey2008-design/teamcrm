import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { PromptsService } from './prompts.service';
import { PromptOptimizerService } from './prompt-optimizer.service';

class CreateVersionDto {
  @IsString() @MinLength(1) @MaxLength(20000) body!: string;
  @IsOptional() @IsString() @MaxLength(64) model?: string;
  @IsOptional() @IsObject() params?: Record<string, unknown>;
  @IsOptional() variables?: unknown[];
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class AbDto {
  @IsInt() @Min(1) @Max(99) split!: number; // % трафика на B-вариант
}

/** PromptOps: управление версиями промптов ИИ (owner/manager). Системные дефолты клонируются в override арендатора. */
@ApiTags('prompts')
@ApiBearerAuth()
@Controller('prompts')
@Roles('owner', 'manager')
export class PromptsController {
  constructor(
    private readonly prompts: PromptsService,
    private readonly optimizer: PromptOptimizerService,
  ) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.prompts.listTemplates(u.tenantId);
  }

  @Get(':key/versions')
  versions(@CurrentUser() u: AuthUser, @Param('key') key: string) {
    return this.prompts.versions(u.tenantId, key);
  }

  @Post(':key/versions')
  create(@CurrentUser() u: AuthUser, @Param('key') key: string, @Body() dto: CreateVersionDto) {
    return this.prompts.createVersion(u.tenantId, u.userId, key, dto);
  }

  @Post(':key/versions/:v/activate')
  activate(@CurrentUser() u: AuthUser, @Param('key') key: string, @Param('v') v: string) {
    return this.prompts.activate(u.tenantId, key, Number(v));
  }

  @Post(':key/versions/:v/ab')
  ab(@CurrentUser() u: AuthUser, @Param('key') key: string, @Param('v') v: string, @Body() dto: AbDto) {
    return this.prompts.setAbTest(u.tenantId, key, Number(v), dto.split);
  }

  @Post(':key/versions/:v/deprecate')
  deprecate(@CurrentUser() u: AuthUser, @Param('key') key: string, @Param('v') v: string) {
    return this.prompts.deprecate(u.tenantId, key, Number(v));
  }

  @Get(':key/metrics')
  metrics(@CurrentUser() u: AuthUser, @Param('key') key: string, @Query('days') days?: string) {
    const d = Math.min(Math.max(Number(days) || 30, 1), 365);
    return this.prompts.metrics(u.tenantId, key, d);
  }

  /** P4: ИИ предлагает улучшенную версию по метрикам (не применяет — владелец сохраняет вручную). */
  @Post(':key/optimize')
  optimize(@CurrentUser() u: AuthUser, @Param('key') key: string, @Query('days') days?: string) {
    const d = Math.min(Math.max(Number(days) || 30, 1), 365);
    return this.optimizer.optimize(u.tenantId, key, d);
  }
}
