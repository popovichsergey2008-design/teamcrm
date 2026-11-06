import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsDateString, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
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
  constructor(private readonly blocks: CalendarBlocksService) {}

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
