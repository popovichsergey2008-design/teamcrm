import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsISO8601, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { APPROVAL_KINDS, ApprovalsService } from './approvals.service';

class CreateApprovalDto {
  @IsString() approverId!: string;
  @IsOptional() @IsIn(APPROVAL_KINDS as unknown as string[]) kind?: string;
  @IsString() @MinLength(3) @MaxLength(200) subject!: string;
  @IsOptional() @IsString() @MaxLength(2000) details?: string;
  @IsOptional() @IsString() taskId?: string;
  @IsOptional() @IsISO8601() dueAt?: string;
}

class DecideDto {
  @IsBoolean() approve!: boolean;
  /** При отказе обязателен — проверяется в сервисе, где видно решение целиком. */
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/**
 * Согласования: то, что ждёт ответа человека и не является задачей.
 * Клиент сюда не допускается — это внутренние решения компании.
 */
@ApiTags('approvals')
@ApiBearerAuth()
@Controller('approvals')
@Roles('owner', 'manager', 'member')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  /** Что ждёт решения лично меня — первая колонка «Фокуса дня». */
  @Get()
  inbox(@CurrentUser() u: AuthUser) {
    return this.approvals.inbox(u.tenantId, u.userId);
  }

  /** Что я спросил и чего жду: иначе непонятно, у кого лежит вопрос. */
  @Get('sent')
  sent(@CurrentUser() u: AuthUser, @Query('all') all?: string) {
    return this.approvals.sent(u.tenantId, u.userId, all === '1');
  }

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateApprovalDto) {
    return this.approvals.create(u.tenantId, u.userId, dto);
  }

  @Post(':id/decide')
  decide(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: DecideDto) {
    return this.approvals.decide(u.tenantId, u.userId, id, dto.approve, dto.note);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.approvals.cancel(u.tenantId, u.userId, id);
  }
}
