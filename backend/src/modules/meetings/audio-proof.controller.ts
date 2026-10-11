import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsNumber, IsOptional, Max, Min } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AudioProofService } from './audio-proof.service';

class AdjustDto {
  /** сдвиг начала, с: −5 — на пять секунд раньше */
  @IsOptional() @IsNumber() @Min(-60) @Max(60) startDelta?: number;
  @IsOptional() @IsNumber() @Min(-60) @Max(60) endDelta?: number;
}

/**
 * Аудио-доказательство задачи (ТЗ-25, §47): «Послушать контекст · 15 сек».
 * Права — задачи: кто её видит, тот слышит фрагмент (решение 11.10).
 */
@ApiTags('tasks')
@ApiBearerAuth()
@Controller('tasks/:taskId/audio-proof')
@Roles('owner', 'manager', 'member')
export class AudioProofController {
  constructor(private readonly proofs: AudioProofService) {}

  @Get()
  get(@CurrentUser() u: AuthUser, @Param('taskId') taskId: string) {
    return this.proofs.view(u.tenantId, { userId: u.userId, role: u.role }, taskId);
  }

  @Patch()
  adjust(@CurrentUser() u: AuthUser, @Param('taskId') taskId: string, @Body() dto: AdjustDto) {
    return this.proofs.adjust(u.tenantId, { userId: u.userId, role: u.role }, taskId, dto);
  }

  @Post('reprocess')
  reprocess(@CurrentUser() u: AuthUser, @Param('taskId') taskId: string) {
    return this.proofs.reprocess(u.tenantId, { userId: u.userId, role: u.role }, taskId);
  }

  @Delete()
  revoke(@CurrentUser() u: AuthUser, @Param('taskId') taskId: string) {
    return this.proofs.revoke(u.tenantId, { userId: u.userId, role: u.role }, taskId);
  }
}
