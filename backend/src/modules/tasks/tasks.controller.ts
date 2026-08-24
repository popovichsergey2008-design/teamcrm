import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { TasksService } from './tasks.service';
import { CreateTaskDto, MoveTaskDto, UpdateTaskDto } from './tasks.dto';

@ApiTags('tasks')
@ApiBearerAuth()
@Controller('tasks')
@Roles('owner', 'manager', 'member') // клиенты не мутируют задачи
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  /**
   * Мои задачи (scope=mine), порученные другим (scope=delegated) и сданные мне
   * на проверку (scope=review) — сквозной срез по всем проектам.
   * ?closed=1 — показать и завершённые.
   */
  @Get('my')
  my(@CurrentUser() user: AuthUser, @Query('scope') scope?: string, @Query('closed') closed?: string) {
    return this.tasks.listForUser(
      user.tenantId,
      user.userId,
      scope === 'delegated' ? 'delegated' : scope === 'review' ? 'review' : 'mine',
      closed === '1' || closed === 'true',
    );
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTaskDto) {
    return this.tasks.create(user.tenantId, dto, user.userId);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.tasks.update(user.tenantId, id, dto, user.userId);
  }

  /** Удаление задачи целиком. Рядовому сотруднику недоступно: чистка доски — дело ведущего. */
  @Delete(':id')
  @Roles('owner', 'manager')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tasks.remove(user.tenantId, id, user.userId);
  }

  @Post(':id/move')
  move(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: MoveTaskDto,
  ) {
    return this.tasks.move(user.tenantId, id, dto, user.userId);
  }
}
