import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { ProjectsService } from './projects.service';
import { ColumnDto, CreateProjectDto, MoveColumnDto } from './projects.dto';

@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.projects.list(user.tenantId, user.role);
  }

  @Post()
  @Roles('owner', 'manager')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProjectDto) {
    return this.projects.create(user.tenantId, dto);
  }

  @Delete(':id')
  @Roles('owner', 'manager')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.projects.remove(user.tenantId, id);
  }

  // ───── колонки доски ─────
  @Post(':id/columns')
  @Roles('owner', 'manager')
  addColumn(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ColumnDto) {
    return this.projects.addColumn(user.tenantId, id, dto.name);
  }

  @Patch(':id/columns/:colId')
  @Roles('owner', 'manager')
  renameColumn(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('colId') colId: string,
    @Body() dto: ColumnDto,
  ) {
    return this.projects.renameColumn(user.tenantId, id, colId, dto.name);
  }

  @Post(':id/columns/:colId/move')
  @Roles('owner', 'manager')
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
