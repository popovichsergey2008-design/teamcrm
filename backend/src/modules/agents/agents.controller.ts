import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AiSettingsService } from '../ai/ai-settings.service';
import { AgentsService, AgentPromptOpts } from './agents.service';
import { AgentPromptsService } from './agent-prompts.service';

class AcceptRunDto {
  @IsOptional() @IsBoolean() toChecklist?: boolean;
}
class ReworkRunDto {
  @IsString() @MinLength(2) @MaxLength(2000) feedback!: string;
}

/** Выбор промпта для запуска: пресет из библиотеки, свой ad-hoc текст и/или модель. */
class RunPromptDto {
  @IsOptional() @IsString() presetId?: string;
  @IsOptional() @IsString() @MaxLength(4000) instruction?: string;
  @IsOptional() @IsString() @MaxLength(80) model?: string;
}
class AssignAgentDto extends RunPromptDto {
  @IsOptional() @IsBoolean() autoRun?: boolean;
}

class CreatePromptDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsString() @MinLength(1) @MaxLength(4000) instruction!: string;
  @IsOptional() @IsString() @MaxLength(80) model?: string;
  @IsOptional() @IsBoolean() isShared?: boolean;
}
class UpdatePromptDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(4000) instruction?: string;
  @IsOptional() @IsString() @MaxLength(80) model?: string;
  @IsOptional() @IsBoolean() isShared?: boolean;
}

const promptOpts = (dto: RunPromptDto): AgentPromptOpts | undefined =>
  dto.presetId || dto.instruction || dto.model ? { presetId: dto.presetId, instruction: dto.instruction, model: dto.model } : undefined;

/** Оркестрация ИИ-агентов + библиотека промптов. Внутренние роли (owner/manager/member); client — нет. */
@ApiTags('agents')
@ApiBearerAuth()
@Controller('agents')
@Roles('owner', 'manager', 'member')
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly prompts: AgentPromptsService,
    private readonly aiSettings: AiSettingsService,
  ) {}

  // ── запуск агента ──
  @Post('tasks/:taskId/run')
  run(@CurrentUser() u: AuthUser, @Param('taskId') taskId: string) {
    return this.agents.runTaskDraft(u.tenantId, u.userId, taskId);
  }

  /** Автономное выполнение: агент выполняет задачу (опц. по выбранному промпту/модели) → «На тестировании». */
  @Post('tasks/:taskId/execute')
  execute(@CurrentUser() u: AuthUser, @Param('taskId') taskId: string, @Body() dto: RunPromptDto) {
    return this.agents.executeTask(u.tenantId, u.userId, taskId, promptOpts(dto));
  }

  @Get('tasks/:taskId/runs')
  runs(@CurrentUser() u: AuthUser, @Param('taskId') taskId: string) {
    return this.agents.listForTask(u.tenantId, taskId);
  }

  /** Передать задачу ИИ-агенту (виртуальный исполнитель); autoRun по умолчанию — сразу выполнить. */
  @Post('tasks/:taskId/assign')
  assign(@CurrentUser() u: AuthUser, @Param('taskId') taskId: string, @Body() dto: AssignAgentDto) {
    return this.agents.assignAgent(u.tenantId, u.userId, taskId, dto.autoRun ?? true, promptOpts(dto));
  }

  @Post('tasks/:taskId/unassign')
  unassign(@CurrentUser() u: AuthUser, @Param('taskId') taskId: string) {
    return this.agents.unassignAgent(u.tenantId, taskId);
  }

  @Post('runs/:id/accept')
  accept(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AcceptRunDto) {
    return this.agents.acceptRun(u.tenantId, u.userId, id, dto.toChecklist ?? false);
  }

  @Post('runs/:id/reject')
  reject(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.agents.rejectRun(u.tenantId, u.userId, u.role, id);
  }

  @Post('runs/:id/rework')
  rework(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ReworkRunDto) {
    return this.agents.reworkRun(u.tenantId, u.userId, id, dto.feedback);
  }

  // ── библиотека промптов ──
  /** Доступные модели ИИ (для селектора в промптах) — доступно всем внутренним ролям. */
  @Get('models')
  models(@CurrentUser() u: AuthUser) {
    return this.aiSettings.listModels(u.tenantId);
  }

  @Get('prompts')
  listPrompts(@CurrentUser() u: AuthUser) {
    return this.prompts.list(u.tenantId, u.userId);
  }

  @Post('prompts')
  createPrompt(@CurrentUser() u: AuthUser, @Body() dto: CreatePromptDto) {
    return this.prompts.create(u.tenantId, u.userId, dto);
  }

  @Patch('prompts/:id')
  updatePrompt(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdatePromptDto) {
    return this.prompts.update(u.tenantId, u.userId, u.role, id, dto);
  }

  @Delete('prompts/:id')
  deletePrompt(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.prompts.remove(u.tenantId, u.userId, u.role, id);
  }
}
