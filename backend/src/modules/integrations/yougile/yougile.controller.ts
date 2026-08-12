import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../../common/auth/decorators';
import { AuthUser } from '../../../common/auth/jwt.types';
import { YougileService } from './yougile.service';
import { ConnectYougileDto, ImportYougileDto, MapUserDto, PushYougileDto } from './yougile.dto';

/** Интеграция с YouGile (E1): подключение по ключу + импорт досок/колонок/задач. Только владелец. */
@ApiTags('integrations/yougile')
@ApiBearerAuth()
@Controller('integrations/yougile')
@Roles('owner')
export class YougileController {
  constructor(private readonly yougile: YougileService) {}

  @Post('connections')
  connect(@CurrentUser() u: AuthUser, @Body() dto: ConnectYougileDto) {
    return this.yougile.connect(u.tenantId, u.userId, dto.apiKey, dto.label);
  }

  @Get('connections')
  list(@CurrentUser() u: AuthUser) {
    return this.yougile.listConnections(u.tenantId);
  }

  @Delete('connections/:cid')
  disconnect(@CurrentUser() u: AuthUser, @Param('cid') cid: string) {
    return this.yougile.disconnect(u.tenantId, cid);
  }

  @Get('connections/:cid/boards')
  boards(@CurrentUser() u: AuthUser, @Param('cid') cid: string) {
    return this.yougile.listBoards(u.tenantId, cid);
  }

  @Post('connections/:cid/import')
  import(@CurrentUser() u: AuthUser, @Param('cid') cid: string, @Body() dto: ImportYougileDto) {
    return this.yougile.startImport(u.tenantId, u.userId, cid, dto.boardExternalIds ?? []);
  }

  @Get('connections/:cid/unmatched-users')
  unmatched(@CurrentUser() u: AuthUser, @Param('cid') cid: string) {
    return this.yougile.unmatchedUsers(u.tenantId, cid);
  }

  @Post('connections/:cid/user-map')
  mapUser(@CurrentUser() u: AuthUser, @Param('cid') cid: string, @Body() dto: MapUserDto) {
    return this.yougile.mapUser(u.tenantId, cid, dto.externalUserId, dto.localUserId);
  }

  /** E3: включить живую синхронизацию — зарегистрировать вебхуки YouGile на наш URL. */
  @Post('connections/:cid/enable-live')
  enableLive(@CurrentUser() u: AuthUser, @Param('cid') cid: string) {
    return this.yougile.enableLive(u.tenantId, cid);
  }

  /** E4: включить/выключить выгрузку изменений CRM → YouGile. */
  @Post('connections/:cid/push')
  push(@CurrentUser() u: AuthUser, @Param('cid') cid: string, @Body() dto: PushYougileDto) {
    return this.yougile.setPush(u.tenantId, cid, dto.enabled);
  }

  @Get('connections/:cid/push')
  pushStatus(@CurrentUser() u: AuthUser, @Param('cid') cid: string) {
    return this.yougile.pushStatus(u.tenantId, cid);
  }

  /** E4: отправить очередь немедленно (обычно её разбирает фоновый воркер). */
  @Post('connections/:cid/push/flush')
  pushFlush(@CurrentUser() u: AuthUser, @Param('cid') cid: string) {
    return this.yougile.flushPush(u.tenantId, cid);
  }

  @Get('runs/:id')
  run(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.yougile.getRun(u.tenantId, id);
  }
}
