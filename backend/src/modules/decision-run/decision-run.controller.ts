import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { DecisionQueueService } from '../decision-queue/decision-queue.service';
import { DecisionRunService } from './decision-run.service';

class DecideDto {
  @IsString() @MaxLength(40) key!: string;
  @IsIn(['accept', 'return', 'ask', 'close']) action!: 'accept' | 'return' | 'ask' | 'close';
  @IsOptional() @IsString() @MaxLength(1000) note?: string | null;
  @IsOptional() @IsString() @MaxLength(40) runId?: string | null;
}
class SummaryDto {
  @IsString() @MaxLength(40) runId!: string;
  @IsOptional() @IsString() @MaxLength(40) startedAt?: string | null;
}

/**
 * «Ждут вашего решения» и разбор по одной карточке (#4890, пп. 3–6, 13). Для каждого
 * сотрудника: очередь — своя (проверяющий / постановщик / тот, у кого спросили согласие).
 */
@ApiTags('decisions')
@ApiBearerAuth()
@Roles('owner', 'manager', 'member')
@Controller('decisions')
export class DecisionRunController {
  constructor(private readonly queue: DecisionQueueService, private readonly run: DecisionRunService) {}

  private v(u: AuthUser) { return { tenantId: u.tenantId, userId: u.userId, role: u.role }; }

  /** Одно число на все экраны. */
  @Get('count')
  async count(@CurrentUser() u: AuthUser) {
    return { count: await this.queue.count(this.v(u)), updatedAt: new Date().toISOString() };
  }

  /** Паспорт числа (п. 3). */
  @Get('passport')
  passport(@CurrentUser() u: AuthUser) { return this.queue.passport(this.v(u)); }

  /** «Открыть список»: те же строки, из которых считается число. */
  @Get('list')
  async list(@CurrentUser() u: AuthUser) {
    const w = await this.queue.waiting(this.v(u));
    const now = Date.now();
    return {
      count: w.count, overdue: w.overdue, updatedAt: w.updatedAt.toISOString(),
      items: w.items.map((i) => ({
        key: i.key, kind: i.kind, taskId: i.taskId, approvalId: i.approvalId, title: i.title, projectId: i.projectId, projectName: i.projectName,
        assigneeName: i.assigneeName, submittedAt: i.since.toISOString(), deadlineAt: i.deadlineAt?.toISOString() ?? null,
        waitingDays: Math.max(0, Math.floor((now - i.since.getTime()) / 86_400_000)),
      })),
    };
  }

  /** Пачка разбора: exclude — ключи решённых и пропущенных в этом разборе через запятую. */
  @Get('batch')
  batch(@CurrentUser() u: AuthUser, @Query('exclude') exclude?: string, @Query('size') size?: string) {
    const ex = String(exclude ?? '').split(',').map((s) => s.trim()).filter((s) => /^(review|approval):\d+$/.test(s)).slice(0, 500);
    return this.run.batch(this.v(u), ex, Number(size) || undefined);
  }

  @Get('recap/:taskId')
  recap(@CurrentUser() u: AuthUser, @Param('taskId') taskId: string) { return this.run.recap(this.v(u), taskId); }

  @Post('decide')
  decide(@CurrentUser() u: AuthUser, @Body() dto: DecideDto) { return this.run.decide(this.v(u), dto); }

  @Post('actions/:id/undo')
  undo(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.run.undo(this.v(u), id); }

  @Post('summary')
  summary(@CurrentUser() u: AuthUser, @Body() dto: SummaryDto) { return this.run.summary(this.v(u), dto.runId, dto.startedAt); }
}
