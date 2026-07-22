import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AgentsService } from './agents.service';

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

  @Get('tasks/:taskId/runs')
  runs(@CurrentUser() u: AuthUser, @Param('taskId') taskId: string) {
    return this.agents.listForTask(u.tenantId, taskId);
  }
}
