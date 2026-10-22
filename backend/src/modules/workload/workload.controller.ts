import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { TasksService } from '../tasks/tasks.service';
import { WorkloadGuardService } from './workload.service';

class CheckDto {
  @IsString() @MaxLength(32) assigneeId!: string;
  @IsString() @MaxLength(32) projectId!: string;
  @IsOptional() @IsIn(['low', 'normal', 'high', 'urgent']) priority?: string;
  /** Срок со временем (окно задачи). */
  @IsOptional() @IsString() @MaxLength(40) deadlineAt?: string | null;
  /** Срок днём без времени (быстрая команда): как при создании — конец рабочего дня. */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) deadline?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) directions?: string[];
}

/**
 * Ранняя проверка нагрузки (#1525): подсказка появляется, как только в форме известны
 * исполнитель и срок, — до «Создать». Ничего не пишет; проект — с проверкой прав,
 * как при создании задачи, иначе через ручку можно было бы мерить чужие закрытые проекты.
 */
@ApiTags('workload')
@ApiBearerAuth()
@Controller('workload')
@Roles('owner', 'manager', 'member')
export class WorkloadController {
  constructor(private readonly guard: WorkloadGuardService, private readonly tasks: TasksService) {}

  @Post('check')
  @HttpCode(200)
  async check(@CurrentUser() u: AuthUser, @Body() dto: CheckDto) {
    await this.tasks.assertProject(u.tenantId, dto.projectId, { userId: u.userId, role: u.role });
    const at = dto.deadlineAt && !Number.isNaN(Date.parse(dto.deadlineAt)) ? new Date(dto.deadlineAt).toISOString()
      : dto.deadline ? await this.guard.deadlineOfDate(u.tenantId, dto.deadline) : null;
    return this.guard.check(u.tenantId, {
      assigneeId: dto.assigneeId, projectId: dto.projectId, priority: dto.priority ?? null,
      deadlineAt: at, directions: dto.directions ?? [],
    });
  }
}
