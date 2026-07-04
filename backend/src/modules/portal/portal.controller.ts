import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { PortalService } from './portal.service';

class CreateClientDto {
  @IsString() @MaxLength(160) name!: string;
  @IsOptional() @IsString() @MaxLength(255) contact?: string;
}
class InviteClientDto {
  @IsEmail() email!: string;
}
class AssignDto {
  @IsOptional() @IsString() clientId?: string | null;
}

@ApiTags('portal')
@ApiBearerAuth()
@Controller('portal')
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  // ── управление клиентами (owner/manager) ──
  @Post('clients')
  @Roles('owner', 'manager')
  createClient(@CurrentUser() u: AuthUser, @Body() dto: CreateClientDto) {
    return this.portal.createClient(u.tenantId, dto.name, dto.contact);
  }

  @Get('clients')
  @Roles('owner', 'manager')
  listClients(@CurrentUser() u: AuthUser) {
    return this.portal.listClients(u.tenantId);
  }

  @Post('clients/:cid/invite')
  @Roles('owner', 'manager')
  invite(@CurrentUser() u: AuthUser, @Param('cid') cid: string, @Body() dto: InviteClientDto) {
    return this.portal.inviteClientUser(u.tenantId, u.userId, cid, dto.email);
  }

  @Post('projects/:id/assign')
  @Roles('owner', 'manager')
  assign(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AssignDto) {
    return this.portal.assignProject(u.tenantId, id, dto.clientId ?? null);
  }

  // ── клиентский портал (role client) ──
  @Get('projects')
  @Roles('client')
  myProjects(@CurrentUser() u: AuthUser) {
    return this.portal.myProjects(u.tenantId, u.userId);
  }

  @Get('projects/:id/board')
  @Roles('client')
  myBoard(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.portal.myBoard(u.tenantId, u.userId, id);
  }
}
