import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { TasksService } from './tasks.service';
import { TaskMergeService } from './task-merge.service';
import {
  ApprovalRequiredDto, CreateTaskDto, FocusDateDto, MergeTasksDto, MoveTaskDto, ParticipantDto,
  ReturnTaskDto, TaskRecurrenceDto, TaskRegistryQueryDto, UpdateTaskDto,
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
  constructor(
    private readonly tasks: TasksService,
    private readonly merge: TaskMergeService,
  ) {}

  /**
   * Объединение похожих задач.
   *
   * Маршруты стоят первыми и длиннее одного сегмента — `:id/merge/...` не спутать
   * ни с `:id`, ни с `registry`. Тем же местом мы уже обожглись на реестре.
   */
  @Get(':id/merge/candidates')
  mergeCandidates(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('q') q?: string) {
    return this.merge.candidates(u.tenantId, id, q);
  }

  /** Что получится при объединении — вместе с предложением ИИ. Ничего не меняет. */
  @Get(':id/merge/preview')
  mergePreview(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('with') withId: string) {
    return this.merge.preview(u.tenantId, id, withId);
  }

  @Post(':id/merge')
  mergeTasks(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: MergeTasksDto) {
    return this.merge.merge(u.tenantId, u.userId, {
      primaryId: dto.primaryId,
      secondaryId: dto.secondaryId,
      title: dto.title ?? null,
      description: dto.description ?? null,
      checklist: dto.checklist ?? null,
    });
  }

  /**
   * Повтор задачи: прочитать, задать, снять.
   *
   * Расписание живёт при задаче-образце, а не отдельным разделом: «повторять
   * еженедельно» — свойство этой задачи, и искать его человек будет в ней.
   */
  @Get(':id/recurrence')
  recurrence(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tasks.getRecurrence(user.tenantId, id);
  }

  @Put(':id/recurrence')
  setRecurrence(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: TaskRecurrenceDto) {
    return this.tasks.setRecurrence(user.tenantId, id, dto, user.userId);
  }

  @Delete(':id/recurrence')
  clearRecurrence(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tasks.clearRecurrence(user.tenantId, id, user.userId);
  }

  /** Карточку открыли — изменения по ней больше не новые. */
  @Post(':id/read')
  async read(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.tasks.markRead(user.tenantId, id, user.userId);
    return { read: true };
  }

  /**
   * Реестр: все задачи по всем проектам с отбором и постраничностью.
   *
   * Маршрут объявлен ВЫШЕ `:id`-маршрутов намеренно: иначе «registry» попадёт в
   * параметр идентификатора и вернёт 404. На этом мы уже спотыкались в чатах.
   *
   * `dayEnd` присылает клиент: «сегодня» у человека и на сервере — разные сутки, и без
   * этого «просрочено» считалось бы по часовому поясу сервера.
   */
  @Get('registry')
  registry(@CurrentUser() user: AuthUser, @Query() query: TaskRegistryQueryDto) {
    return this.tasks.registry(user.tenantId, user.userId, {
      ...query,
      closed: query.closed === '1' || query.closed === 'true',
      dayEnd: query.dayEnd ?? new Date().toISOString(),
    });
  }

  /** Исполнители для фильтра реестра. */
  @Get('registry/assignees')
  registryAssignees(@CurrentUser() user: AuthUser) {
    return this.tasks.registryAssignees(user.tenantId);
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
  /**
   * Удаление задачи. Доступно любому сотруднику — решение заказчика.
   *
   * Подтверждение при учтённом времени осталось: это не ограничение прав, а вопрос
   * «вы уверены» — часы и их стоимость остаются в себестоимости проекта, но задача
   * с доски исчезает навсегда, и знать об этом человек должен ДО нажатия.
   */
  @Delete(':id')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('confirmTimeLoss') confirmTimeLoss?: string,
  ) {
    return this.tasks.remove(user.tenantId, id, user.userId, {
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
