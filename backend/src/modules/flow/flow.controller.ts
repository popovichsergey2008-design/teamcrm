import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min,
} from 'class-validator';
import { Request } from 'express';
import { CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { BLOCKER_REASONS, RULE_ACTIONS, RULE_TRIGGERS } from './flow-rules';
import { FlowService } from './flow.service';

const ID = /^\d{1,18}$/;

class BlockerDto {
  @IsIn(BLOCKER_REASONS as unknown as string[]) reason!: string;
  @IsString() @MaxLength(500) need!: string;
  @IsOptional() @Matches(ID) helperId?: string | null;
  @IsOptional() @IsString() @MaxLength(500) nextStep?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) dueOn?: string | null;
}
class NoteDto {
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}
class LinkDto {
  @Matches(/^#?\d{1,18}$/) dependsOn!: string;
}
class SubmitDto {
  @IsOptional() @IsString() @MaxLength(2000) done?: string;
  @IsOptional() @IsString() @MaxLength(1000) where?: string;
  @IsOptional() @IsString() @MaxLength(1000) limits?: string;
  @IsOptional() @Matches(ID) reviewerId?: string | null;
  @Matches(ID) columnId!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) position?: number;
  @IsOptional() @IsBoolean() confirmGate?: boolean;
  @IsOptional() @IsString() @MaxLength(500) noAfterReason?: string;
}
class DecisionDto {
  @IsIn(['accept', 'return', 'ask']) action!: 'accept' | 'return' | 'ask';
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) handoffVersion?: number;
}
class ViewDto {
  @IsString() @MaxLength(120) name!: string;
  @IsObject() query!: Record<string, unknown>;
  @IsOptional() @IsBoolean() shared?: boolean;
}
class ViewPatchDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsObject() query?: Record<string, unknown>;
  @IsOptional() @IsBoolean() shared?: boolean;
}
class WipDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number | null;
}
class RuleDto {
  @IsIn(RULE_TRIGGERS as unknown as string[]) trigger!: string;
  @IsIn(RULE_ACTIONS as unknown as string[]) action!: string;
}
class RuleToggleDto {
  @IsBoolean() enabled!: boolean;
}
class ShareDto {
  @IsOptional() @IsString() @MaxLength(1000) summary?: string;
  @IsString() @MaxLength(4000) result!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @Matches(ID, { each: true }) fileIds?: string[];
}
class GuestDecisionDto {
  @IsIn(['approved', 'changes']) decision!: 'approved' | 'changes';
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
}

/**
 * Поток работы на доске (#4798 / #4799). Клиент сюда не ходит: у него свой портал.
 */
@ApiTags('flow')
@ApiBearerAuth()
@Controller()
@Roles('owner', 'manager', 'member')
export class FlowController {
  constructor(private readonly flow: FlowService) {}

  // препятствие
  @Get('tasks/:id/blocker')
  blocker(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.flow.getBlocker(u, id); }
  @Put('tasks/:id/blocker')
  setBlocker(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: BlockerDto) { return this.flow.setBlocker(u, id, dto); }
  @Delete('tasks/:id/blocker')
  resolve(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: NoteDto) { return this.flow.resolveBlocker(u, id, dto?.note); }

  // связи
  @Get('tasks/:id/links')
  links(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.flow.links(u, id); }
  @Post('tasks/:id/links')
  addLink(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: LinkDto) { return this.flow.addLink(u, id, dto.dependsOn); }
  @Delete('tasks/:id/links/:dep')
  removeLink(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('dep') dep: string) { return this.flow.removeLink(u, id, dep); }

  // сдача и решение
  @Post('tasks/:id/handoff')
  submit(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SubmitDto) { return this.flow.submit(u, id, dto); }
  @Get('tasks/:id/handoffs')
  handoffs(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.flow.handoffs(u, id); }
  @Get('review/queue')
  queue(@CurrentUser() u: AuthUser) { return this.flow.queue(u); }
  @Get('review/:id')
  item(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.flow.reviewItem(u, id); }
  @Post('review/:id/decision')
  decide(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: DecisionDto) { return this.flow.decide(u, id, dto); }
  @Post('tasks/:id/request-update')
  requestUpdate(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.flow.requestUpdate(u, id); }

  // виды доски
  @Get('projects/:id/views')
  views(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.flow.views(u, id); }
  @Post('projects/:id/views')
  createView(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ViewDto) { return this.flow.createView(u, id, dto); }
  @Patch('board-views/:id')
  updateView(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ViewPatchDto) { return this.flow.updateView(u, id, dto); }
  @Delete('board-views/:id')
  deleteView(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.flow.deleteView(u, id); }

  @Put('projects/:id/wip')
  wip(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: WipDto) { return this.flow.setWip(u, id, dto.limit ?? null); }

  // правила
  @Get('projects/:id/rules')
  rules(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.flow.rules(u, id); }
  @Post('projects/:id/rules')
  addRule(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: RuleDto) { return this.flow.addRule(u, id, dto.trigger, dto.action); }
  @Post('projects/:id/rules/preview')
  preview(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: RuleDto) { return this.flow.previewRule(u, id, dto.trigger, dto.action); }
  @Patch('projects/:id/rules/:rule')
  toggleRule(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('rule') rule: string, @Body() dto: RuleToggleDto) {
    return this.flow.toggleRule(u, id, rule, dto.enabled);
  }
  @Delete('projects/:id/rules/:rule')
  deleteRule(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('rule') rule: string) { return this.flow.deleteRule(u, id, rule); }

  // ссылка для клиента
  @Get('tasks/:id/shares')
  shares(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.flow.shares(u, id); }
  @Post('tasks/:id/shares')
  createShare(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ShareDto) { return this.flow.createShare(u, id, dto); }
  @Delete('tasks/:id/shares/:share')
  revokeShare(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('share') share: string) { return this.flow.revokeShare(u, id, share); }
}

/** Предохранитель от перебора с одного адреса: ссылка гостя публична. */
const hits = new Map<string, { n: number; until: number }>();
function limit(req: Request, bucket: string, max: number) {
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.until < now) { hits.set(key, { n: 1, until: now + 60_000 }); return; }
  if (++h.n > max) throw AppException.conflict('Слишком много запросов — попробуйте через минуту');
  if (hits.size > 50_000) hits.clear();
}

/** Клиент смотрит результат и решает — без учётной записи, только по ссылке. */
@ApiTags('flow')
@Controller('share')
@Public()
export class ShareController {
  constructor(private readonly flow: FlowService) {}

  @Get(':token')
  view(@Req() req: Request, @Param('token') token: string) { limit(req, 'view', 60); return this.flow.guestView(token); }
  @Post(':token/files/:fileId')
  file(@Req() req: Request, @Param('token') token: string, @Param('fileId') fileId: string) {
    limit(req, 'file', 30);
    return this.flow.guestFile(token, fileId);
  }
  @Post(':token/decision')
  decide(@Req() req: Request, @Param('token') token: string, @Body() dto: GuestDecisionDto) {
    limit(req, 'decide', 10);
    return this.flow.guestDecide(token, dto);
  }
}
