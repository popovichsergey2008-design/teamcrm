import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { ProjectsService } from './projects.service';
import { ColumnDto, CreateProjectDto, MoveColumnDto, ReorderColumnsDto } from './projects.dto';

@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
@Roles('owner', 'manager', 'member') // client — только через /api/portal
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  /** ?archived=1 — вернуть вместе с архивными (переключатель «Показать архив»). */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('archived') archived?: string) {
    return this.projects.list(user.tenantId, user.role, archived === '1' || archived === 'true', user.userId);
  }

  /**
   * Убрать проект в архив / вернуть из архива. Данные сохраняются.
   *
   * Доступно и сотруднику: архив — действие ОБРАТИМОЕ, проект возвращается одной
   * кнопкой и ничего не теряет. Держать за руководителем стоит то, что не отменишь,
   * а не то, что убирает законченный проект с глаз. Удаление проекта — ниже, и оно
   * по-прежнему только для владельца и руководителя.
   */
  @Post(':id/archive')
  archive(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.projects.setArchived(user.tenantId, id, true);
  }

  @Post(':id/unarchive')
  unarchive(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.projects.setArchived(user.tenantId, id, false);
  }

  /**
   * Создание проекта — тоже обратимое действие: лишний проект убирается в архив,
   * а удалить его может руководитель. Держать его за ролью значило бы показывать
   * сотруднику поле ввода, на которое сервер отвечает «недостаточно прав».
   */
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProjectDto) {
    return this.projects.create(user.tenantId, dto);
  }

  @Delete(':id')
  @Roles('owner', 'manager')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.projects.remove(user.tenantId, id);
  }

  /*
    ───── колонки доски ─────

    Порядок колонок, их названия и добавление новой — работа тех, кто по этой доске
    работает, а не привилегия. Сотрудник видел кнопки… точнее, НЕ видел: они просто
    не рисовались, и на вопрос «почему у меня нет стрелок» ответа в интерфейсе не было.

    Удаление колонки осталось за руководителем: колонку с задачами не вернёшь.
  */
  @Post(':id/columns')
  addColumn(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ColumnDto) {
    return this.projects.addColumn(user.tenantId, id, dto.name);
  }

  @Patch(':id/columns/:colId')
  renameColumn(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('colId') colId: string,
    @Body() dto: ColumnDto,
  ) {
    return this.projects.renameColumn(user.tenantId, id, colId, dto.name);
  }

  @Post(':id/columns/reorder')
  reorderColumns(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReorderColumnsDto) {
    return this.projects.reorderColumns(user.tenantId, id, dto.orderedIds);
  }

  @Post(':id/columns/:colId/move')
  moveColumn(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('colId') colId: string,
    @Body() dto: MoveColumnDto,
  ) {
    return this.projects.moveColumn(user.tenantId, id, colId, dto.direction);
  }

  @Delete(':id/columns/:colId')
  @Roles('owner', 'manager')
  deleteColumn(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('colId') colId: string) {
    return this.projects.deleteColumn(user.tenantId, id, colId);
  }
}
