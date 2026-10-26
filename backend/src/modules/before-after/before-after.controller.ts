import { Body, Controller, Get, Param, Post, Put, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, Max, Min, ValidateIf } from 'class-validator';
import type { Response } from 'express';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { MANUAL_ROLES } from './before-after.rules';
import { BeforeAfterService } from './before-after.service';

class ShotRoleDto {
  /** Было / Образец / Стало / Не относится; null — «как решит система». */
  @ValidateIf((_, v) => v !== null)
  @IsIn(MANUAL_ROLES as unknown as string[])
  role!: string | null;
}

class CheckedDto {
  @IsInt() @Min(1) @Max(100) n!: number;
  @IsBoolean() checked!: boolean;
}

/**
 * Отчёт «было/стало» по задаче (#4657).
 *
 * Видит тот, кто видит задачу; чужая — 404. Запускать может любой сотрудник,
 * которому задача видна: постановщик, исполнитель, руководитель.
 */
@ApiTags('task-card')
@ApiBearerAuth()
@Controller('tasks')
@Roles('owner', 'manager', 'member')
export class BeforeAfterController {
  constructor(private readonly svc: BeforeAfterService) {}

  /** Вкладка целиком: версии, текущий отчёт, можно ли принять или вернуть. */
  @Get(':id/before-after')
  overview(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.overview(u.tenantId, id, { userId: u.userId, role: u.role });
  }

  /** «Проверить было/стало»: отвечает сразу, проверка идёт фоном. */
  @Post(':id/before-after')
  run(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.run(u.tenantId, id, { userId: u.userId, role: u.role });
  }

  /** Роль снимка руками — главнее модели и правил при следующей пересборке. */
  @Put(':id/before-after/shots/:fileId')
  setShotRole(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('fileId') fileId: string, @Body() dto: ShotRoleDto) {
    return this.svc.setShotRole(u.tenantId, id, fileId, dto.role ?? null, { userId: u.userId, role: u.role });
  }

  /** «Попросить результат»: одно сообщение исполнителю в обсуждение задачи. */
  @Post(':id/before-after/:rid/ask-result')
  askResult(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('rid') rid: string) {
    return this.svc.askResult(u.tenantId, id, rid, { userId: u.userId, role: u.role });
  }

  /** «Проверено» у пункта чек-листа приёмки. */
  @Put(':id/before-after/:rid/checked')
  setChecked(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('rid') rid: string, @Body() dto: CheckedDto) {
    return this.svc.setChecked(u.tenantId, id, rid, dto.n, dto.checked, { userId: u.userId, role: u.role });
  }

  @Get(':id/before-after/:rid')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('rid') rid: string) {
    return this.svc.get(u.tenantId, id, rid, { userId: u.userId, role: u.role });
  }

  /** PDF — мимо общего конверта {ok,data}: это файл, а не JSON. */
  @Get(':id/before-after/:rid/pdf')
  async pdf(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('rid') rid: string, @Res() res: Response) {
    const { buffer, fileName, asciiName } = await this.svc.pdf(u.tenantId, id, rid, { userId: u.userId, role: u.role });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  }
}
