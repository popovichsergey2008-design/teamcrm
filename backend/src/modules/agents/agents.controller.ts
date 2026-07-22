import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AgentsService } from './agents.service';

class AcceptRunDto {
  @IsOptional() @IsBoolean() toChecklist?: boolean;
}

class ReworkRunDto {
  @IsString() @MinLength(2) @MaxLength(2000) feedback!: string;
}

class AssignAgentDto {
  @IsOptional() @IsBoolean() autoRun?: boolean;
}

/** Оркестрация ИИ-агентов: запуск агента по задаче + история запусков. Внутренние роли (owner/manager). */
@ApiTags('agents')
@ApiBearerAuth()
@Controller('agents')
@Roles('owner', 'manager')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Post('tasks/:taskId/run')
  run(@CurrentUser() u: AuthUser, @Param('taskId') taskId: string) {
    return this.agents.runTaskDraft(u.tenantId, u.userId, taskId);
  }

  /** v1 автономного выполнения: агент выполняет задачу → результат в задачу + перенос в «На тестировании». */
  @Post('tasks/:taskId/execute')
  execute(@CurrentUser() u: AuthUser, @Param('taskId') taskId: string) {
    return this.agents.executeTask(u.tenantId, u.userId, taskId);
  }

  @Get('tasks/:taskId/runs')
  runs(@CurrentUser() u: AuthUser, @Param('taskId') taskId: string) {
    return this.agents.listForTask(u.tenantId, taskId);
  }

  /** v3.2: передать задачу ИИ-агенту (виртуальный исполнитель); autoRun по умолчанию — сразу выполнить. */
  @Post('tasks/:taskId/assign')
  assign(@CurrentUser() u: AuthUser, @Param('taskId') taskId: string, @Body() dto: AssignAgentDto) {
    return this.agents.assignAgent(u.tenantId, u.userId, taskId, dto.autoRun ?? true);
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

  /** v2: доработать результат агента по замечаниям ревьюера. */
  @Post('runs/:id/rework')
  rework(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ReworkRunDto) {
    return this.agents.reworkRun(u.tenantId, u.userId, id, dto.feedback);
  }
}
