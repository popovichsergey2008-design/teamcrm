import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../../common/auth/decorators';
import { AuthUser } from '../../../common/auth/jwt.types';
import { NotionService } from './notion.service';
import { ConnectNotionDto, ImportNotionDto, MapNotionUserDto } from './notion.dto';

/**
 * Интеграция с Notion (ТЗ-4, слой 3): токен интеграции → базы данных → импорт.
 * Только владелец: токен даёт доступ ко всему, что интеграции открыли.
 */
@ApiTags('integrations/notion')
@ApiBearerAuth()
@Controller('integrations/notion')
@Roles('owner')
export class NotionController {
  constructor(private readonly notion: NotionService) {}

  @Post('connections')
  connect(@CurrentUser() u: AuthUser, @Body() dto: ConnectNotionDto) {
    return this.notion.connect(u.tenantId, u.userId, dto.token.trim(), dto.label);
  }

  @Get('connections')
  list(@CurrentUser() u: AuthUser) {
    return this.notion.listConnections(u.tenantId);
  }

  @Delete('connections/:cid')
  disconnect(@CurrentUser() u: AuthUser, @Param('cid') cid: string) {
    return this.notion.disconnect(u.tenantId, cid);
  }

  @Get('connections/:cid/databases')
  databases(@CurrentUser() u: AuthUser, @Param('cid') cid: string) {
    return this.notion.listDatabases(u.tenantId, cid);
  }

  @Post('connections/:cid/import')
  import(@CurrentUser() u: AuthUser, @Param('cid') cid: string, @Body() dto: ImportNotionDto) {
    return this.notion.startImport(u.tenantId, u.userId, cid, dto.databaseIds ?? []);
  }

  @Get('runs/:runId')
  run(@CurrentUser() u: AuthUser, @Param('runId') runId: string) {
    return this.notion.runStatus(u.tenantId, runId);
  }

  @Get('connections/:cid/unmatched-users')
  unmatched(@CurrentUser() u: AuthUser, @Param('cid') cid: string) {
    return this.notion.unmatchedUsers(u.tenantId, cid);
  }

  @Post('connections/:cid/user-map')
  mapUser(@CurrentUser() u: AuthUser, @Param('cid') cid: string, @Body() dto: MapNotionUserDto) {
    return this.notion.mapUser(u.tenantId, cid, dto.externalUserId, dto.localUserId);
  }
}
