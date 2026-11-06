import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsDateString, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CalendarCardService } from './calendar-card.service';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { CalendarBlocksService } from './calendar-blocks.service';

class BlockDto {
  @IsIn(['task', 'focus']) kind!: 'task' | 'focus';
  @IsOptional() @IsString() taskId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) taskIds?: string[];
  @IsOptional() @IsString() @MaxLength(300) title?: string;
  @IsDateString() startsAt!: string;
  @IsDateString() endsAt!: string;
}

class PlanItemDto {
  @IsString() taskId!: string;
  @IsOptional() @IsInt() @Min(5) @Max(480) minutes?: number;
}
class PlanDayDto {
  @IsOptional() @IsString() date?: string;
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => PlanItemDto) items!: PlanItemDto[];
}
class ApplyItemDto {
  @IsString() taskId!: string;
  @IsDateString() startsAt!: string;
  @IsDateString() endsAt!: string;
}
class ApplyPlanDto {
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => ApplyItemDto) plan!: ApplyItemDto[];
}
class GoalDto {
  @IsOptional() @IsString() @MaxLength(500) goal?: string | null;
}
class LinkDto {
  @IsString() taskId!: string;
}

class BlockMoveDto {
  @IsDateString() startsAt!: string;
  @IsDateString() endsAt!: string;
}

/** #4787: время на задачи и запланированный фокус — блоки своего расписания. */
@ApiTags('calendar')
@ApiBearerAuth()
@Controller('calendar')
@Roles('owner', 'manager', 'member')
export class CalendarBlocksController {
  constructor(private readonly blocks: CalendarBlocksService, private readonly card: CalendarCardService) {}

  @Post('blocks')
  create(@CurrentUser() u: AuthUser, @Body() dto: BlockDto) {
    return this.blocks.create(u.tenantId, u.userId, dto);
  }

  @Patch('blocks/:id')
  move(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: BlockMoveDto) {
    return this.blocks.move(u.tenantId, u.userId, id, dto);
  }

  @Delete('blocks/:id')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.blocks.remove(u.tenantId, u.userId, id);
  }

  /** Когда человек собирается делать задачу — для карточки задачи. */
  @Get('blocks/task/:taskId')
  ofTask(@CurrentUser() u: AuthUser, @Param('taskId') taskId: string) {
    return this.blocks.ofTask(u.tenantId, u.userId, taskId);
  }

  /** «Помоги спланировать день» (п. 14): предложение, ничего не создаёт. */
  @Post('plan-day')
  planDay(@CurrentUser() u: AuthUser, @Body() dto: PlanDayDto) {
    return this.blocks.planDay(u.tenantId, u.userId, dto);
  }

  @Post('plan-day/apply')
  applyPlan(@CurrentUser() u: AuthUser, @Body() dto: ApplyPlanDto) {
    return this.blocks.applyPlan(u.tenantId, u.userId, dto.plan);
  }

  /** Карточка встречи до и после (п. 10–11). */
  @Get('events/:id/card')
  eventCard(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.card.card(u.tenantId, u, id);
  }

  @Patch('events/:id/goal')
  eventGoal(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: GoalDto) {
    return this.card.setGoal(u.tenantId, u, id, dto.goal ?? null);
  }

  @Post('events/:id/tasks')
  linkTask(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: LinkDto) {
    return this.card.link(u.tenantId, u, id, dto.taskId);
  }

  @Delete('events/:id/tasks/:taskId')
  unlinkTask(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('taskId') taskId: string) {
    return this.card.unlink(u.tenantId, u, id, taskId);
  }

  /** Панель «Задачи для планирования». */
  @Get('plan-tasks')
  toPlan(@CurrentUser() u: AuthUser) {
    return this.blocks.toPlan(u.tenantId, u.userId);
  }

  /** «Найти время»: варианты, ничего не создаёт. */
  @Get('find-time')
  findTime(
    @CurrentUser() u: AuthUser,
    @Query('taskId') taskId?: string,
    @Query('minutes') minutes?: string,
    @Query('before') before?: string,
    @Query('exceptBlockId') exceptBlockId?: string,
  ) {
    return this.blocks.findTime(u.tenantId, u.userId, { taskId, minutes: minutes ? Number(minutes) : undefined, before, exceptBlockId });
  }
}
