import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AssistantService } from './assistant.service';

class ModeDto {
  @IsString() @IsIn(['off', 'copilot', 'autopilot']) mode!: string;
}

/**
 * Смарт-пинги ассистента.
 *
 * Режим читают все — человек вправе знать, сам ассистент ему пишет или с чьего-то
 * ведома. Меняет владелец: это решение о том, как компания разговаривает с людьми.
 */
@ApiTags('assistant')
@ApiBearerAuth()
@Controller('assistant')
@Roles('owner', 'manager', 'member')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Get('mode')
  mode(@CurrentUser() u: AuthUser) {
    return this.assistant.mode(u.tenantId);
  }

  @Put('mode')
  setMode(@CurrentUser() u: AuthUser, @Body() dto: ModeDto) {
    return this.assistant.setMode(u.tenantId, u.role, dto.mode);
  }

  /** Что ассистент напомнил лично мне. */
  @Get('pings')
  pings(@CurrentUser() u: AuthUser) {
    return this.assistant.listForUser(u.tenantId, u.userId);
  }

  /** Что он предлагает разослать по моим задачам (режим «копилот»). */
  @Get('pings/proposed')
  proposed(@CurrentUser() u: AuthUser) {
    return this.assistant.listProposed(u.tenantId, u.userId);
  }

  @Post('pings/:id/send')
  send(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.assistant.send(u.tenantId, u.userId, id);
  }

  @Post('pings/:id/dismiss')
  dismiss(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.assistant.dismiss(u.tenantId, u.userId, id);
  }
}
