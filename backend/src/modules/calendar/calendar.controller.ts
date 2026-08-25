import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength,
} from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { CalendarService } from './calendar.service';

class EventDto {
  @IsString() @MinLength(1) @MaxLength(255) title!: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsOptional() @IsString() @MaxLength(255) location?: string;
  @IsDateString() startsAt!: string;
  @IsDateString() endsAt!: string;
  @IsOptional() @IsBoolean() allDay?: boolean;
  @IsOptional() @IsString() @MaxLength(16) color?: string;
  @IsOptional() @IsBoolean() isPrivate?: boolean;
  @IsOptional() @IsIn(['personal', 'company']) scope?: 'personal' | 'company';
  @IsOptional() @IsArray() @ArrayMaxSize(100) participantIds?: string[];
  /** Комната нашего созвона: кнопка «Начать созвон» у события. */
  @IsOptional() @IsString() @MaxLength(64) meetRoomId?: string;
}

class EventPatchDto {
  @IsOptional() @IsString() @MaxLength(255) title?: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsOptional() @IsString() @MaxLength(255) location?: string;
  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @IsDateString() endsAt?: string;
  @IsOptional() @IsBoolean() allDay?: boolean;
  @IsOptional() @IsString() @MaxLength(16) color?: string;
  @IsOptional() @IsBoolean() isPrivate?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(100) participantIds?: string[];
  @IsOptional() @IsString() @MaxLength(64) meetRoomId?: string;
}

class RespondDto {
  @IsIn(['accepted', 'declined']) status!: 'accepted' | 'declined';
}

class WorkDto {
  @Matches(/^\d{2}:\d{2}$/) workStart!: string;
  @Matches(/^\d{2}:\d{2}$/) workEnd!: string;
  @IsArray() @ArrayMaxSize(7) @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) weekendDays!: number[];
  @IsArray() @ArrayMaxSize(200) @IsDateString({}, { each: true }) holidays!: string[];
}

/** Календарь: личные события и события компании. Заказчику (роль client) не показывается. */
@ApiTags('calendar')
@ApiBearerAuth()
@Controller('calendar')
@Roles('owner', 'manager', 'member')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  /** Всё для экрана за один запрос: события, задачи со сроком и рабочее время. */
  @Get()
  range(
    @CurrentUser() user: AuthUser,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('tasks') tasks?: string,
  ) {
    return this.calendar.range(user.tenantId, user, from, to, tasks !== '0');
  }

  @Get('pending')
  pending(@CurrentUser() user: AuthUser) {
    return this.calendar.pending(user.tenantId, user.userId);
  }

  @Get('work')
  work(@CurrentUser() user: AuthUser) {
    return this.calendar.work(user.tenantId);
  }

  @Post('work')
  saveWork(@CurrentUser() user: AuthUser, @Body() dto: WorkDto) {
    return this.calendar.saveWork(user.tenantId, user, dto);
  }

  @Get('events/:id')
  details(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.calendar.details(user.tenantId, user, id);
  }

  @Post('events')
  create(@CurrentUser() user: AuthUser, @Body() dto: EventDto) {
    return this.calendar.create(user.tenantId, user, dto);
  }

  @Patch('events/:id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: EventPatchDto) {
    return this.calendar.update(user.tenantId, user, id, dto);
  }

  @Delete('events/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.calendar.remove(user.tenantId, user, id);
  }

  /** Принять или отклонить приглашение — только за себя. */
  @Post('events/:id/respond')
  respond(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RespondDto) {
    return this.calendar.respond(user.tenantId, user.userId, id, dto.status);
  }
}
