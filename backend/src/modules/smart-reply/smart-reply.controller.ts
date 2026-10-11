import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { SmartReplyService } from './smart-reply.service';

class OutcomeDto {
  @IsString() lastMessageId!: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(2) variant!: number;
  @IsIn(['accepted', 'edited', 'dismissed']) outcome!: 'accepted' | 'edited' | 'dismissed';
}

/** Готовый ответ (ТЗ-21, этап 5): черновик для поля ввода; сам ничего не отправляет. */
@ApiTags('secretary')
@ApiBearerAuth()
@Controller('chats/:id/smart-reply')
@Roles('owner', 'manager', 'member')
export class SmartReplyController {
  constructor(private readonly svc: SmartReplyService) {}

  @Get()
  suggest(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('variant') variant?: string) {
    const v = Math.min(Math.max(Number(variant) || 0, 0), 2);
    return this.svc.suggest({ tenantId: u.tenantId, userId: u.userId }, id, v);
  }

  @Post('outcome')
  outcome(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: OutcomeDto) {
    return this.svc.outcome({ tenantId: u.tenantId, userId: u.userId }, id, dto.lastMessageId, dto.variant, dto.outcome);
  }
}
