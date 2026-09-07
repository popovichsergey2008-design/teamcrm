import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../../common/auth/decorators';
import { AuthUser } from '../../../common/auth/jwt.types';
import { TrelloService } from './trello.service';
import { ConnectTrelloDto, ImportTrelloDto, MapTrelloUserDto } from './trello.dto';

/**
 * Интеграция с Trello (ТЗ-4, слой 2): подключение по ключу и токену, выбор досок,
 * импорт. Только владелец — как и остальные подключения: ключ даёт доступ ко всем
 * доскам человека, и раздавать это право по компании нельзя.
 */
@ApiTags('integrations/trello')
@ApiBearerAuth()
@Controller('integrations/trello')
@Roles('owner')
export class TrelloController {
  constructor(private readonly trello: TrelloService) {}

  @Post('connections')
  connect(@CurrentUser() u: AuthUser, @Body() dto: ConnectTrelloDto) {
    return this.trello.connect(u.tenantId, u.userId, dto.apiKey.trim(), dto.token.trim(), dto.label);
  }

  @Get('connections')
  list(@CurrentUser() u: AuthUser) {
    return this.trello.listConnections(u.tenantId);
  }

  @Delete('connections/:cid')
  disconnect(@CurrentUser() u: AuthUser, @Param('cid') cid: string) {
    return this.trello.disconnect(u.tenantId, cid);
  }

  @Get('connections/:cid/boards')
  boards(@CurrentUser() u: AuthUser, @Param('cid') cid: string) {
    return this.trello.listBoards(u.tenantId, cid);
  }

  @Post('connections/:cid/import')
  import(@CurrentUser() u: AuthUser, @Param('cid') cid: string, @Body() dto: ImportTrelloDto) {
    return this.trello.startImport(u.tenantId, u.userId, cid, dto.boardIds ?? []);
  }

  @Get('runs/:runId')
  run(@CurrentUser() u: AuthUser, @Param('runId') runId: string) {
    return this.trello.runStatus(u.tenantId, runId);
  }

  @Get('connections/:cid/unmatched-users')
  unmatched(@CurrentUser() u: AuthUser, @Param('cid') cid: string) {
    return this.trello.unmatchedUsers(u.tenantId, cid);
  }

  @Post('connections/:cid/user-map')
  mapUser(@CurrentUser() u: AuthUser, @Param('cid') cid: string, @Body() dto: MapTrelloUserDto) {
    return this.trello.mapUser(u.tenantId, cid, dto.externalUserId, dto.localUserId);
  }
}
