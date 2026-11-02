import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { Public } from '../../common/auth/decorators';
import { CurrentPc, PcAuth, PcGuard, PcNeed, PcStepUp } from './pc.guard';
import { PcRepository } from './pc.repository';
import { PcSupportService } from './pc-support.service';
import { SupportDeskService } from '../support/support-desk.service';
import { SupportConciergeService } from '../support/support-concierge.service';
import { MANUAL_STATUSES, ManualStatus } from '../support/support-concierge';
import { GuestLinksService } from '../media/guest-links.service';

class TextDto { @IsString() @MaxLength(8000) text!: string }
class OptTextDto { @IsOptional() @IsString() @MaxLength(8000) text?: string }
class NoteDto { @IsString() @MaxLength(4000) text!: string }
class BugDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsIn(['bug', 'feedback']) kind?: 'bug' | 'feedback';
}
class BeatDto { @IsOptional() @IsIn(MANUAL_STATUSES as unknown as string[]) status?: ManualStatus }
class ReasonDto { @IsOptional() @IsString() @MaxLength(300) reason?: string }
class KnownDto {
  @IsString() @MaxLength(20) taskId!: string;
  @IsString() @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(300) pattern?: string;
}
class ActiveDto { @IsBoolean() active!: boolean }
class IncidentDto {
  @IsString() @MaxLength(200) title!: string;
  @IsString() @MaxLength(1000) message!: string;
}

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
    private readonly guests: GuestLinksService,
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

  // ── известные проблемы и массовый сбой (руководитель службы) ──
  @Get('known')
  async known(@CurrentPc() pc: PcAuth) {
    const op = await this.sup.operator(pc);
    return this.desk.knownIssues(op.tenantId, op);
  }

  @Post('known') @HttpCode(200)
  async addKnown(@CurrentPc() pc: PcAuth, @Body() dto: KnownDto, @Req() req: Request) {
    const op = await this.sup.operator(pc);
    const r = await this.desk.addKnownIssue(op.tenantId, op, dto.taskId.replace(/\D/g, ''), dto.title.trim(), (dto.pattern ?? dto.title).trim());
    await this.repo.audit({ accountId: pc.accountId, app: pc.app, action: 'support.known.add', target: `task:${r.taskId}`, meta: { title: dto.title }, ip: req.ip });
    return r;
  }

  @Post('known/:knownId') @HttpCode(200)
  async setKnown(@CurrentPc() pc: PcAuth, @Param('knownId') knownId: string, @Body() dto: ActiveDto) {
    const op = await this.sup.operator(pc);
    return this.desk.setKnownIssueActive(op.tenantId, op, knownId, dto.active);
  }

  @Get('incident')
  async incident(@CurrentPc() pc: PcAuth) {
    const op = await this.sup.operator(pc);
    return { incident: await this.desk.currentIncident(op.tenantId, op) };
  }

  @Post('incident') @PcStepUp() @HttpCode(200)
  async declare(@CurrentPc() pc: PcAuth, @Body() dto: IncidentDto, @Req() req: Request) {
    const op = await this.sup.operator(pc);
    const r = await this.desk.declareIncident(op.tenantId, op, dto.title.trim(), dto.message.trim());
    await this.repo.audit({ accountId: pc.accountId, app: pc.app, action: 'support.incident.declare', target: r?.id ? `incident:${r.id}` : null, meta: { title: dto.title }, ip: req.ip });
    return r;
  }

  @Post('incident/:incidentId/resolve') @PcStepUp() @HttpCode(200)
  async resolveIncident(@CurrentPc() pc: PcAuth, @Param('incidentId') incidentId: string, @Req() req: Request) {
    const op = await this.sup.operator(pc);
    const r = await this.desk.resolveIncident(op.tenantId, op, incidentId);
    await this.repo.audit({ accountId: pc.accountId, app: pc.app, action: 'support.incident.resolve', target: `incident:${incidentId}`, meta: {}, ip: req.ip });
    return r;
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

  // ── созвон с клиентом (Support Huddle) ──

  /** Предложить созвон: клиент соглашается у себя, комнату и ссылку поднимает он. */
  @Post(':id/call/request') @HttpCode(200)
  async requestCall(@CurrentPc() pc: PcAuth, @Param('id') id: string) {
    const { op, t } = await this.scope(pc, id);
    return this.desk.requestCall(t, op, id);
  }

  /**
   * Принять просьбу клиента о созвоне: комната и гостевая ссылка — у платформы, ссылка
   * уходит клиенту в разговор, оператору — пропуск хозяина этой комнаты.
   */
  @Post(':id/call/accept') @HttpCode(200)
  async acceptCall(@CurrentPc() pc: PcAuth, @Param('id') id: string, @Req() req: Request) {
    const { op, t } = await this.scope(pc, id);
    const conv = await this.desk.conversation(t, op, id);
    const link = await this.guests.create(op.tenantId, op.userId, { label: `Служба заботы · ${conv.subject ?? 'созвон'}`.slice(0, 80), ttlHours: 4 });
    const view = await this.desk.acceptCall(t, op, id, { roomId: link.roomId, joinUrl: link.url });
    await this.audit(pc, req, 'support.call', id, { tenant: t, room: link.roomId });
    return { conversation: view, pass: await this.guests.operatorPass(op.tenantId, link.roomId, op.userId, pc.name) };
  }

  @Post(':id/call/decline') @HttpCode(200)
  async declineCall(@CurrentPc() pc: PcAuth, @Param('id') id: string) {
    const { op, t } = await this.scope(pc, id);
    return this.desk.declineCall(t, op, id);
  }

  /** Вернуться в свой идущий созвон (закрыл вкладку) — новый пропуск в ту же комнату. */
  @Post(':id/call/pass') @HttpCode(200)
  async callPass(@CurrentPc() pc: PcAuth, @Param('id') id: string) {
    const { op, t } = await this.scope(pc, id);
    await this.desk.conversation(t, op, id);
    const room = await this.desk.myLiveHuddleRoom(id, op.userId);
    if (!room) return { pass: null };
    return { pass: await this.guests.operatorPass(op.tenantId, room, op.userId, pc.name) };
  }

  // ── временный доступ к настройкам проекта клиента (ТЗ-29): только по разрешению клиента ──
  @Get(':id/access')
  async accessList(@CurrentPc() pc: PcAuth, @Param('id') id: string) {
    const { op, t } = await this.scope(pc, id);
    return this.concierge.accessList(t, op, id);
  }

  @Post(':id/access') @HttpCode(200)
  async requestAccess(@CurrentPc() pc: PcAuth, @Param('id') id: string, @Body() dto: ReasonDto, @Req() req: Request) {
    const { op, t } = await this.scope(pc, id);
    const r = await this.concierge.requestAccess(t, op, id, dto.reason ?? null);
    await this.audit(pc, req, 'support.access.request', id, { tenant: t });
    return r;
  }

  @Get(':id/access/:grantId')
  async accessView(@CurrentPc() pc: PcAuth, @Param('id') id: string, @Param('grantId') grantId: string, @Req() req: Request) {
    const { op, t } = await this.scope(pc, id);
    const r = await this.concierge.accessView(t, op, id, grantId);
    await this.audit(pc, req, 'support.access.view', id, { tenant: t, grant: grantId });
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
