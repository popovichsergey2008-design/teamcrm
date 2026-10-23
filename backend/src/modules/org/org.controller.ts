import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { Skill, SKILLS } from '../team/skills';
import { OrgService } from './org.service';

class DirectionLeadDto {
  @IsIn(SKILLS.filter((s) => s !== 'other') as unknown as string[]) skill!: string;
  @IsString() userId!: string;
}

/** Структура компании: оргсхема и «кто отвечает за направление» (#4615, доработка 23.10). */
@ApiTags('org')
@ApiBearerAuth()
@Controller('org')
@Roles('owner', 'manager', 'member')
export class OrgController {
  constructor(private readonly org: OrgService) {}

  @Get('structure')
  structure(@CurrentUser() user: AuthUser) {
    return this.org.structure(user.tenantId);
  }

  /** Назначить руководителя направления: создаёт или правит отдел. Структуру меняют владелец и руководитель. */
  @Post('direction-lead')
  @Roles('owner', 'manager')
  directionLead(@CurrentUser() user: AuthUser, @Body() dto: DirectionLeadDto) {
    return this.org.setDirectionLead(user.tenantId, dto.skill as Skill, String(dto.userId));
  }
}
