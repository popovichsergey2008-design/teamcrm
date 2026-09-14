import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { SupportService } from './support.service';

export class SupportTicketDto {
  @IsString() @MaxLength(500) title!: string;
  @IsOptional() @IsString() @MaxLength(8000) description?: string;
}

export class SupportProjectDto {
  @IsBoolean() isSupport!: boolean;
}

@ApiTags('support')
@ApiBearerAuth()
@Controller('support')
@Roles('owner', 'manager', 'member') // клиенту в поддержку компании писать незачем — у него портал
export class SupportController {
  constructor(private readonly support: SupportService) {}

  /** Страница «Поддержка»: проект и мои обращения. */
  @Get()
  overview(@CurrentUser() u: AuthUser) {
    return this.support.overview(u.tenantId, u.userId);
  }

  /** Новое обращение — обычная задача в проекте поддержки. */
  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: SupportTicketDto) {
    return this.support.create(u.tenantId, u, dto);
  }

  /** Какой проект принимает обращения — решает руководитель. */
  @Post('project/:id')
  @Roles('owner', 'manager')
  setProject(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SupportProjectDto) {
    return this.support.setProject(u.tenantId, id, dto.isSupport);
  }
}
