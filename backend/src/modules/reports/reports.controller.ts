import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';
import type { Response } from 'express';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { ReportsService } from './reports.service';

class TaskReportDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) from!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) to!: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() userId?: string;
}

/**
 * Отчёты из личного кабинета.
 *
 * Клиенту (внешнему заказчику) раздел закрыт: отчёт показывает работу всей команды,
 * включая чужие проекты и людей.
 */
@ApiTags('reports')
@Controller('reports')
@Roles('owner', 'manager', 'member')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('tasks/summary')
  summary(@CurrentUser() u: AuthUser, @Query() q: TaskReportDto) {
    return this.reports.summary(u, q);
  }

  /** Сам PDF — мимо общего конверта {ok,data}: это файл, а не JSON. */
  @Get('tasks/pdf')
  async pdf(@CurrentUser() u: AuthUser, @Query() q: TaskReportDto, @Res() res: Response) {
    const { buffer, fileName, asciiName } = await this.reports.pdfFile(u, q);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  }
}
