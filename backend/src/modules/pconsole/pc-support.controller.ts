import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { Public } from '../../common/auth/decorators';
import { CurrentPc, PcAuth, PcGuard, PcNeed } from './pc.guard';
import { PcRepository } from './pc.repository';
import { PcSupportService } from './pc-support.service';
import { SupportDeskService } from '../support/support-desk.service';
import { SupportConciergeService } from '../support/support-concierge.service';
import { MANUAL_STATUSES, ManualStatus } from '../support/support-concierge';

class TextDto { @IsString() @MaxLength(8000) text!: string }
class OptTextDto { @IsOptional() @IsString() @MaxLength(8000) text?: string }
class NoteDto { @IsString() @MaxLength(4000) text!: string }
class BugDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsIn(['bug', 'feedback']) kind?: 'bug' | 'feedback';
}
class BeatDto { @IsOptional() @IsIn(MANUAL_STATUSES as unknown as string[]) status?: ManualStatus }

/**
 * Консоль поддержки (support.qevo.one, §6). Те же действия службы заботы, что и в
 * прежней консоли, но от служебного профиля оператора: свой вход, 2FA, без чатов CRM.
 * Кто какую организацию видит — решает служба заботы (deskTenant), как и раньше.
 * Аудит — действия, меняющие обращение (§10): взял, решено, статус, баг.
 */
@Public()
@UseGuards(PcGuard)
@PcNeed('support.view')
@Controller('pc/support')
export class PcSupportController {
  constructor(
    private readonly sup: PcSupportService,
    private readonly desk: SupportDeskService,
    private readonly concierge: SupportConciergeService,
    private readonly repo: PcRepository,
  ) {}

  private async scope(pc: PcAuth, id: string) {
    const op = await this.sup.operator(pc);
    return { op, t: await this.desk.deskTenant(op, id) };
  }

  private audit(pc: PcAuth, req: Request, action: string, id: string, meta: Record<string, unknown> = {}) {
    return this.repo.audit({ accountId: pc.accountId, app: pc.app, action, target: `conversation:${id}`, meta, ip: req.ip });
  }

  /** «Я на месте» раз в 30 с; статус — «свободен / занят / отошёл», как у дежурных. */
  @Post('presence') @HttpCode(200)
  async presence(@CurrentPc() pc: PcAuth, @Body() dto: BeatDto) {
    const op = await this.sup.operator(pc);
    this.sup.beat(op, false);
    if (dto.status) await this.concierge.setMyStatus(op, dto.status);
    return this.concierge.availability();
  }

  @Get('availability')
  async availability(@CurrentPc() pc: PcAuth) {
    await this.sup.operator(pc);
    return this.concierge.availability();
  }

  @Get('queue')
  async queue(@CurrentPc() pc: PcAuth, @Query('assigned') assigned?: string) {
    const op = await this.sup.operator(pc);
    return this.desk.queue(op.tenantId, op, {
      assignedTo: assigned === 'me' ? 'me' : null,
      onlyFree: assigned === 'none' ? true : null,
    });
  }

  @Get('dashboard')
  async dashboard(@CurrentPc() pc: PcAuth) {
    const op = await this.sup.operator(pc);
    const [summary, sla] = await Promise.all([this.desk.dashboard(op.tenantId, op), this.desk.sla(op.tenantId, op)]);
    return { summary, sla };
  }

  @Get(':id')
  async conversation(@CurrentPc() pc: PcAuth, @Param('id') id: string) {
    const { op, t } = await this.scope(pc, id);
    const conv = await this.desk.conversation(t, op, id);
    return { ...conv, me: op.userId, client: await this.sup.client(t) };
  }

  @Post(':id/join') @HttpCode(200)
  async join(@CurrentPc() pc: PcAuth, @Param('id') id: string, @Req() req: Request) {
    const { op, t } = await this.scope(pc, id);
    const r = await this.desk.join(t, op, id);
    await this.audit(pc, req, 'support.join', id, { tenant: t });
    return r;
  }

  @Post(':id/reply') @HttpCode(200)
  async reply(@CurrentPc() pc: PcAuth, @Param('id') id: string, @Body() dto: TextDto) {
    const { op, t } = await this.scope(pc, id);
    return this.desk.reply(t, op, id, dto.text);
  }

  @Post(':id/resolve') @HttpCode(200)
  async resolve(@CurrentPc() pc: PcAuth, @Param('id') id: string, @Body() dto: OptTextDto, @Req() req: Request) {
    const { op, t } = await this.scope(pc, id);
    const r = await this.desk.resolve(t, op, id, dto.text);
    await this.audit(pc, req, 'support.resolve', id, { tenant: t });
    return r;
  }

  @Post(':id/unassign') @HttpCode(200)
  async unassign(@CurrentPc() pc: PcAuth, @Param('id') id: string, @Req() req: Request) {
    const { op, t } = await this.scope(pc, id);
    const r = await this.desk.unassign(t, op, id);
    await this.audit(pc, req, 'support.unassign', id, { tenant: t });
    return r;
  }

  @Post(':id/ai/return') @HttpCode(200)
  async returnAi(@CurrentPc() pc: PcAuth, @Param('id') id: string) {
    const { op, t } = await this.scope(pc, id);
    return this.desk.returnAi(t, op, id);
  }

  @Get(':id/notes')
  async notes(@CurrentPc() pc: PcAuth, @Param('id') id: string) {
    const { op, t } = await this.scope(pc, id);
    return this.desk.notes(t, op, id);
  }

  @Post(':id/notes') @HttpCode(200)
  async addNote(@CurrentPc() pc: PcAuth, @Param('id') id: string, @Body() dto: NoteDto) {
    const { op, t } = await this.scope(pc, id);
    return this.desk.addNote(t, op, id, dto.text);
  }

  @Get(':id/diagnostics')
  async diagnostics(@CurrentPc() pc: PcAuth, @Param('id') id: string) {
    const { op, t } = await this.scope(pc, id);
    return this.desk.diagnostics(t, op, id);
  }

  @Post(':id/copilot') @HttpCode(200)
  async copilot(@CurrentPc() pc: PcAuth, @Param('id') id: string) {
    const { op, t } = await this.scope(pc, id);
    return this.desk.copilot(t, op, id);
  }

  @Post(':id/bug') @HttpCode(200)
  async bug(@CurrentPc() pc: PcAuth, @Param('id') id: string, @Body() dto: BugDto, @Req() req: Request) {
    const { op, t } = await this.scope(pc, id);
    const r = await this.desk.createBug(t, op, id, dto.title, dto.kind === 'feedback' ? 'feedback' : 'bug');
    await this.audit(pc, req, 'support.bug', id, { tenant: t, kind: dto.kind ?? 'bug' });
    return r;
  }

  /** Файл из разговора (снимок экрана): право даёт разговор, как и в прежней консоли. */
  @Get(':id/files/:fileId')
  async file(@CurrentPc() pc: PcAuth, @Param('id') id: string, @Param('fileId') fileId: string, @Res() res: Response) {
    const op = await this.sup.operator(pc);
    const { file, stream } = await this.desk.fileOf(op, id, fileId);
    const inline = file.content_type.startsWith('image/') || file.content_type === 'application/pdf';
    res.setHeader('Content-Type', file.content_type);
    res.setHeader('Content-Length', file.size_bytes);
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(file.file_name)}"`);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }
}
