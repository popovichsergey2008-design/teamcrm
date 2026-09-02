import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { TasksService } from './tasks.service';
import {
  ApprovalRequiredDto, CreateTaskDto, FocusDateDto, MoveTaskDto, ParticipantDto,
  ReturnTaskDto, UpdateTaskDto,
} from './tasks.dto';

/** Пустую или кривую дату не подставляем молча: считаем, что клиент имел в виду сегодня. */
function isoDate(value?: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') ? (value as string) : new Date().toISOString().slice(0, 10);
}

@ApiTags('tasks')
@ApiBearerAuth()
@Controller('tasks')
@Roles('owner', 'manager', 'member') // клиенты не мутируют задачи
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  /** Карточку открыли — изменения по ней больше не новые. */
  @Post(':id/read')
  async read(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.tasks.markRead(user.tenantId, id, user.userId);
    return { read: true };
  }

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

  /**
   * План на день: дата или null, чтобы снять. Дату присылает клиент — «сегодня»
   * у человека и на сервере это разные дни.
   */
  @Patch(':id/focus-date')
  setFocusDate(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: FocusDateDto,
  ) {
    return this.tasks.setFocusDate(user.tenantId, id, user.userId, dto.date ?? null);
  }

  /** Незакрытое со вчера и раньше — для разбора хвостов при первом входе за день. */
  @Get('my/leftovers')
  leftovers(@CurrentUser() user: AuthUser, @Query('today') today?: string) {
    return this.tasks.leftovers(user.tenantId, user.userId, isoDate(today));
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

  /**
   * Удаление задачи целиком. Рядовому сотруднику недоступно: чистка доски — дело ведущего.
   * Задачу с учтённым временем удаляет только владелец и только с подтверждением.
   */
  @Delete(':id')
  @Roles('owner', 'manager')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('confirmTimeLoss') confirmTimeLoss?: string,
  ) {
    return this.tasks.remove(user.tenantId, id, user.userId, {
      role: user.role,
      confirmTimeLoss: confirmTimeLoss === '1' || confirmTimeLoss === 'true',
    });
  }

  @Post(':id/move')
  move(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: MoveTaskDto,
  ) {
    return this.tasks.move(user.tenantId, id, dto, user.userId);
  }

  /** Кто ещё в задаче: соисполнители и наблюдатели. */
  @Get(':id/participants')
  participants(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.tasks.listParticipants(u.tenantId, id);
  }

  @Post(':id/participants')
  addParticipant(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ParticipantDto) {
    return this.tasks.addParticipant(u.tenantId, id, u.userId, dto.userId, dto.role);
  }

  @Delete(':id/participants')
  removeParticipant(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ParticipantDto) {
    return this.tasks.removeParticipant(u.tenantId, id, u.userId, dto.userId, dto.role);
  }

  /**
   * Постановщик принял работу — задача завершена по-настоящему.
   *
   * Отдельной ручкой, а не переносом в «Готово»: перенос делает исполнитель,
   * а это решение принимает другой человек, и путать их нельзя.
   */
  @Post(':id/approve')
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tasks.approve(user.tenantId, id, user);
  }

  /** Вернуть в работу с объяснением: «переделай» без причины бесполезно. */
  @Post(':id/return')
  returnTask(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReturnTaskDto) {
    return this.tasks.returnForRework(user.tenantId, id, user, dto.reason);
  }

  /** Включить или снять согласование по этой задаче. */
  @Post(':id/approval-required')
  setApproval(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ApprovalRequiredDto) {
    return this.tasks.setApprovalRequired(user.tenantId, id, user, dto.enabled);
  }
}
