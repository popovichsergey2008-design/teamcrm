import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { HubLibrarianService } from './hub-librarian.service';
import { AskDto, CreateItemDto, DecisionsQuery, MemberDto, PassportDto, UpdateItemDto } from './project-hub.dto';
import { ProjectHubService } from './project-hub.service';

/**
 * Инфоцентр проекта (#4659). Проект, которого человек не видит, — «не найден» (404),
 * клиенту Инфоцентр закрыт (403 на уровне ролей).
 */
@ApiTags('project-hub')
@ApiBearerAuth()
@Controller('projects/:id/hub')
@Roles('owner', 'manager', 'member')
export class ProjectHubController {
  constructor(private readonly hub: ProjectHubService, private readonly librarian: HubLibrarianService) {}

  @Get()
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.hub.get(u, id);
  }

  @Patch('passport')
  passport(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: PassportDto) {
    return this.hub.patchPassport(u, id, dto);
  }

  @Post('items')
  createItem(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: CreateItemDto) {
    return this.hub.createItem(u, id, dto);
  }

  @Patch('items/:itemId')
  updateItem(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('itemId') itemId: string, @Body() dto: UpdateItemDto) {
    return this.hub.updateItem(u, id, itemId, dto);
  }

  @Delete('items/:itemId')
  removeItem(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('itemId') itemId: string) {
    return this.hub.removeItem(u, id, itemId);
  }

  @Patch('members/:userId')
  member(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('userId') userId: string, @Body() dto: MemberDto) {
    return this.hub.setMember(u, id, userId, dto);
  }

  @Get('decisions')
  decisions(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query() q: DecisionsQuery) {
    return this.hub.decisions(u, id, q);
  }

  @Get('runs/:runId')
  run(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('runId') runId: string) {
    return this.hub.runDetail(u, id, runId);
  }

  @Post('runs/:runId/seen')
  seen(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('runId') runId: string) {
    return this.hub.seen(u, id, runId);
  }

  /** «Собрать сейчас»: руководство и ответственный за проект. */
  @Post('librarian/run')
  runLibrarian(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.librarian.runNow(u, id);
  }

  @Post('ask')
  ask(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AskDto) {
    return this.hub.ask(u, id, dto.q);
  }
}
