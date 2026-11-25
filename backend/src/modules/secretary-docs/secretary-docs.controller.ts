import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Response } from 'express';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { DOC_KINDS, RECEIPT_CATEGORIES } from './secretary-docs.rules';
import { SecretaryDocsService } from './secretary-docs.service';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

class DocDto {
  @IsOptional() @IsIn(DOC_KINDS as unknown as string[]) kind?: string;
  @IsOptional() @IsString() @MaxLength(160) title?: string;
  @IsOptional() @Matches(DATE) expiresOn?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(6) @IsInt({ each: true }) @Min(1, { each: true }) @Max(365, { each: true }) remindDays?: number[];
  @IsOptional() @IsString() @MaxLength(500) note?: string | null;
  @IsOptional() @IsBoolean() renewed?: boolean;
}
class ReceiptAddDto {
  @IsOptional() @IsString() @MaxLength(20) fileId?: string | null;
}
class ReceiptDto {
  @IsOptional() @IsString() @MaxLength(10) spentOn?: string | null;
  @IsOptional() @IsString() @MaxLength(200) seller?: string | null;
  @IsOptional() @IsString() @MaxLength(16) sellerInn?: string | null;
  @IsOptional() total?: number | string | null;
  @IsOptional() vat?: number | string | null;
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
  @IsOptional() @IsIn(RECEIPT_CATEGORIES as unknown as string[]) category?: string;
  @IsOptional() @IsString() @MaxLength(300) purpose?: string | null;
}

const period = (v?: string) => (v && DATE.test(v) ? v : null);

/** Функции секретаря #1476: сроки документов, проверка договора, чеки. Поздравления — в «Клиентах» (/clients/:id/dates). */
@ApiTags('secretary-docs')
@ApiBearerAuth()
@Roles('owner', 'manager', 'member')
@Controller()
export class SecretaryDocsController {
  constructor(private readonly svc: SecretaryDocsService) {}

  // ── сроки документов (личные: видит только сам человек) ──
  @Get('doc-deadlines') docs(@CurrentUser() u: AuthUser) { return this.svc.docs(u); }
  @Post('doc-deadlines') addDoc(@CurrentUser() u: AuthUser, @Body() dto: DocDto) { return this.svc.addDoc(u, dto); }
  @Patch('doc-deadlines/:id') updateDoc(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: DocDto) { return this.svc.updateDoc(u, id, dto); }
  @Delete('doc-deadlines/:id') removeDoc(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.removeDoc(u, id); }

  // ── проверка договора (права — как у скачивания файла) ──
  @Get('contract-review/:fileId') saved(@CurrentUser() u: AuthUser, @Param('fileId') fileId: string) { return this.svc.contractReview(u, fileId, false); }
  @Post('contract-review/:fileId') review(@CurrentUser() u: AuthUser, @Param('fileId') fileId: string, @Query('force') force?: string) {
    return this.svc.contractReview(u, fileId, force === '1' || force === 'true');
  }

  // ── чеки и авансовый отчёт (личные) ──
  @Get('receipts') receipts(@CurrentUser() u: AuthUser, @Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.receipts(u, period(from), period(to));
  }
  @Get('receipts/export') async export(@CurrentUser() u: AuthUser, @Res() res: Response, @Query('from') from?: string, @Query('to') to?: string) {
    const { buffer, fileName } = await this.svc.exportReceipts(u, period(from), period(to));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.send(buffer);
  }
  @Post('receipts') addReceipt(@CurrentUser() u: AuthUser, @Body() dto: ReceiptAddDto) { return this.svc.addReceipt(u, dto.fileId ? String(dto.fileId) : null); }
  @Post('receipts/:id/recognize') recognize(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.recognize(u, id); }
  @Patch('receipts/:id') updateReceipt(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ReceiptDto) { return this.svc.updateReceipt(u, id, dto); }
  @Delete('receipts/:id') removeReceipt(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.removeReceipt(u, id); }
}
