import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { BrainService } from './brain.service';

class AskDto {
  @IsString() @MinLength(2) question!: string;
  @IsOptional() @IsString() projectId?: string;
}

@ApiTags('brain')
@ApiBearerAuth()
@Controller('brain')
@Roles('owner', 'manager', 'member') // корпоративный разум — внутренний, client не имеет доступа
export class BrainController {
  constructor(private readonly brain: BrainService) {}

  @Post('conversations')
  start(@CurrentUser() u: AuthUser) {
    return this.brain.start(u.tenantId, u.userId);
  }

  @Get('conversations')
  list(@CurrentUser() u: AuthUser) {
    return this.brain.list(u.tenantId, u.userId);
  }

  @Get('conversations/:id/messages')
  messages(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.brain.messages(u.tenantId, u.userId, id);
  }

  @Post('conversations/:id/ask')
  ask(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AskDto) {
    return this.brain.ask(u.tenantId, u.userId, id, dto.question, dto.projectId || undefined);
  }
}
