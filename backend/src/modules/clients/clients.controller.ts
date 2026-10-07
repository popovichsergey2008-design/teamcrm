import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min,
} from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { ClientsService } from './clients.service';
import { CLIENT_SOURCES, CLIENT_STATUSES, CLIENT_TYPES, DEAL_STAGES, FILE_CATEGORIES, MEMBER_ROLES } from './client-rules';

const bool = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1';

class ListQuery {
  @IsOptional() @IsString() @MaxLength(120) q?: string;
  @IsOptional() @IsIn(['all', 'mine', 'attention', 'no_owner', 'archive']) view?: string;
  @IsOptional() @IsIn(CLIENT_STATUSES as unknown as string[]) status?: string;
  @IsOptional() @IsIn(CLIENT_TYPES as unknown as string[]) type?: string;
  @IsOptional() @IsString() @MaxLength(48) segment?: string;
  @IsOptional() @IsIn(CLIENT_SOURCES as unknown as string[]) source?: string;
  @IsOptional() @IsString() @MaxLength(32) ownerId?: string;
  @IsOptional() @Transform(bool) @IsBoolean() hasDeals?: boolean;
  @IsOptional() @Transform(bool) @IsBoolean() hasOverdue?: boolean;
  @IsOptional() @Transform(bool) @IsBoolean() hasOpenTasks?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3650) inactiveDays?: number;
  @IsOptional() @IsDateString() createdFrom?: string;
  @IsOptional() @IsDateString() createdTo?: string;
  @IsOptional() @IsIn(['activity', 'name', 'created', 'status', 'owner', 'deals']) sort?: string;
  @IsOptional() @IsIn(['asc', 'desc']) dir?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
}

class ClientFields {
  @IsOptional() @IsString() @MaxLength(160) name?: string;
  @IsOptional() @IsIn(CLIENT_TYPES as unknown as string[]) type?: string;
  @IsOptional() @IsString() @MaxLength(255) legalName?: string;
  @IsOptional() @IsIn(CLIENT_STATUSES as unknown as string[]) status?: string;
  @IsOptional() @IsString() @MaxLength(48) segment?: string;
  @IsOptional() @IsIn(CLIENT_SOURCES as unknown as string[]) source?: string;
  @IsOptional() @IsString() ownerId?: string | null;
  @IsOptional() @IsString() departmentId?: string | null;
  @IsOptional() @IsString() @MaxLength(255) website?: string;
  @IsOptional() @IsString() @MaxLength(80) country?: string;
  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @IsString() @MaxLength(400) address?: string;
  @IsOptional() @IsString() @MaxLength(32) taxId?: string;
  @IsOptional() @IsString() @MaxLength(48) registrationNumber?: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsString() @MaxLength(255) nextAction?: string;
  @IsOptional() @IsDateString() nextActionAt?: string | null;
}

class CreateClientDto extends ClientFields {
  @IsString() @MaxLength(160) declare name: string;
  @IsOptional() @IsString() @MaxLength(64) phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(64) telegram?: string;
  @IsOptional() @IsString() @MaxLength(160) contactName?: string;
  /** «Создать всё равно» — похожий клиент уже есть */
  @IsOptional() @IsBoolean() force?: boolean;
}

class DupQuery {
  @IsOptional() @IsString() @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(160) email?: string;
  @IsOptional() @IsString() @MaxLength(64) phone?: string;
  @IsOptional() @IsString() @MaxLength(255) website?: string;
  @IsOptional() @IsString() @MaxLength(32) taxId?: string;
  @IsOptional() @IsString() excludeId?: string;
}

class ContactDto {
  @IsOptional() @IsString() @MaxLength(120) firstName?: string;
  @IsOptional() @IsString() @MaxLength(120) lastName?: string;
  @IsOptional() @IsString() @MaxLength(160) position?: string;
  @IsOptional() @IsString() @MaxLength(64) phone?: string;
  @IsOptional() @IsString() @MaxLength(160) email?: string;
  @IsOptional() @IsString() @MaxLength(64) telegram?: string;
  @IsOptional() @IsString() @MaxLength(64) whatsapp?: string;
  @IsOptional() @IsIn(['phone', 'email', 'telegram', 'whatsapp']) preferredChannel?: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}

class RevealDto {
  @IsIn(['phone', 'email', 'telegram', 'whatsapp']) field!: string;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

class MemberDto {
  @IsString() userId!: string;
  @IsOptional() @IsIn(MEMBER_ROLES as unknown as string[]) role?: string;
}

class NoteDto {
  @IsOptional() @IsString() @MaxLength(10000) body?: string;
  @IsOptional() @IsBoolean() pinned?: boolean;
  @IsOptional() @IsBoolean() isPrivate?: boolean;
}

class DealDto {
  @IsOptional() @IsString() @MaxLength(255) title?: string;
  @IsOptional() @IsIn(DEAL_STAGES as unknown as string[]) stage?: string;
  @IsOptional() @IsNumber() @Min(0) amount?: number | null;
  @IsOptional() @IsIn(['RUB', 'EUR', 'USD', 'KZT', 'BYN', 'UAH', 'GBP', 'CNY']) currency?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100) probability?: number | null;
  @IsOptional() @IsString() ownerId?: string | null;
  @IsOptional() @IsString() @MaxLength(255) nextAction?: string;
  @IsOptional() @IsDateString() closeDate?: string | null;
  @IsOptional() @IsString() @MaxLength(300) lostReason?: string;
}

class FileDto {
  @IsString() fileId!: string;
  @IsOptional() @IsIn(FILE_CATEGORIES as unknown as string[]) category?: string;
}

class ViewDto {
  @IsString() @MaxLength(80) name!: string;
  @IsOptional() @IsObject() filter?: Record<string, unknown>;
  @IsOptional() @IsObject() sort?: Record<string, unknown>;
}

class BulkDto {
  @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) ids!: string[];
  @IsIn(['owner', 'status', 'segment', 'archive']) action!: string;
  @IsOptional() @IsString() @MaxLength(48) value?: string | null;
}

class MergeDto {
  @IsString() keepId!: string;
  @IsString() dropId!: string;
  @IsOptional() @IsIn(['keep', 'drop']) nameFrom?: 'keep' | 'drop';
}

/**
 * Раздел «Клиенты» (ТЗ-17, п. 66–71). Права проверяет сервис на каждом действии;
 * роль `client` (внешний пользователь портала) сюда не пускается вовсе.
 */
@ApiTags('clients')
@ApiBearerAuth()
@Controller()
@Roles('owner', 'manager', 'member')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  private me(u: AuthUser) {
    return { tenantId: u.tenantId, userId: u.userId, role: u.role };
  }

  @Get('clients')
  list(@CurrentUser() u: AuthUser, @Query() q: ListQuery) {
    return this.clients.list(this.me(u), q);
  }

  @Get('clients/options')
  options(@CurrentUser() u: AuthUser) {
    return this.clients.options(this.me(u));
  }

  @Get('clients/duplicates')
  duplicates(@CurrentUser() u: AuthUser, @Query() q: DupQuery) {
    return this.clients.duplicates(this.me(u), q);
  }

  @Get('clients/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="clients.csv"')
  exportCsv(@CurrentUser() u: AuthUser, @Query() q: ListQuery) {
    return this.clients.exportCsv(this.me(u), q);
  }

  @Get('clients/views')
  views(@CurrentUser() u: AuthUser) {
    return this.clients.views(this.me(u));
  }

  @Post('clients/views')
  addView(@CurrentUser() u: AuthUser, @Body() dto: ViewDto) {
    return this.clients.addView(this.me(u), dto.name, dto.filter, dto.sort);
  }

  @Delete('clients/views/:id')
  removeView(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.clients.removeView(this.me(u), id);
  }

  @Post('clients/bulk')
  bulk(@CurrentUser() u: AuthUser, @Body() dto: BulkDto) {
    return this.clients.bulk(this.me(u), dto.ids, dto.action, dto.value ?? null);
  }

  @Post('clients/merge-preview')
  mergePreview(@CurrentUser() u: AuthUser, @Body() dto: MergeDto) {
    return this.clients.mergePreview(this.me(u), dto.keepId, dto.dropId);
  }

  @Post('clients/merge')
  merge(@CurrentUser() u: AuthUser, @Body() dto: MergeDto) {
    return this.clients.merge(this.me(u), dto.keepId, dto.dropId, dto.nameFrom ?? 'keep');
  }

  @Post('clients/import/preview')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  importPreview(@CurrentUser() u: AuthUser, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw AppException.validation('Приложите файл CSV или XLSX');
    return this.clients.importPreview(this.me(u), file);
  }

  @Post('clients/import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  importRun(@CurrentUser() u: AuthUser, @UploadedFile() file: Express.Multer.File, @Body() body: { mapping?: string; onDuplicate?: string }) {
    if (!file) throw AppException.validation('Приложите файл CSV или XLSX');
    let mapping: Record<string, any> = {};
    try { mapping = JSON.parse(body?.mapping ?? '{}'); } catch { throw AppException.validation('Сопоставление колонок не читается'); }
    return this.clients.importRun(this.me(u), file, mapping, body?.onDuplicate === 'create' ? 'create' : 'skip');
  }

  @Post('clients')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateClientDto) {
    return this.clients.create(this.me(u), dto);
  }

  @Get('clients/:id')
  card(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.clients.card(this.me(u), id);
  }

  /** Коротко — для поля «Клиент» в карточке задачи (п. 33). */
  @Get('clients/:id/brief')
  brief(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.clients.brief(this.me(u), id);
  }

  @Patch('clients/:id')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ClientFields) {
    return this.clients.update(this.me(u), id, dto);
  }

  /** Обычное «удалить» — в архив (п. 66). */
  @Delete('clients/:id')
  archive(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.clients.archive(this.me(u), id, true);
  }

  @Post('clients/:id/restore')
  restore(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.clients.archive(this.me(u), id, false);
  }

  @Delete('clients/:id/permanent')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.clients.remove(this.me(u), id);
  }

  // контакты
  @Get('clients/:id/contacts')
  contacts(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.clients.contacts(this.me(u), id);
  }

  @Post('clients/:id/contacts')
  addContact(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ContactDto) {
    return this.clients.addContact(this.me(u), id, dto);
  }

  @Patch('client-contacts/:id')
  updateContact(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ContactDto) {
    return this.clients.updateContact(this.me(u), id, dto);
  }

  @Delete('client-contacts/:id')
  removeContact(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.clients.removeContact(this.me(u), id);
  }

  @Post('client-contacts/:id/reveal')
  reveal(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: RevealDto, @Req() req: { ip?: string; headers?: Record<string, unknown> }) {
    const device = String(req?.headers?.['x-device-id'] ?? '') || null;
    return this.clients.reveal(this.me(u), id, dto.field, dto.reason ?? null, { ip: req?.ip ?? null, deviceId: device });
  }

  // команда
  @Post('clients/:id/members')
  setMember(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: MemberDto) {
    return this.clients.setMember(this.me(u), id, dto.userId, dto.role ?? 'watcher');
  }

  @Delete('clients/:id/members/:userId')
  removeMember(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('userId') userId: string) {
    return this.clients.removeMember(this.me(u), id, userId);
  }

  // заметки
  @Get('clients/:id/notes')
  notes(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.clients.notes(this.me(u), id);
  }

  @Post('clients/:id/notes')
  addNote(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: NoteDto) {
    return this.clients.addNote(this.me(u), id, { body: dto.body ?? '', pinned: dto.pinned, isPrivate: dto.isPrivate });
  }

  @Patch('client-notes/:id')
  updateNote(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: NoteDto) {
    return this.clients.updateNote(this.me(u), id, dto);
  }

  @Delete('client-notes/:id')
  deleteNote(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.clients.deleteNote(this.me(u), id);
  }

  // сделки
  @Get('clients/:id/deals')
  deals(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.clients.deals(this.me(u), id);
  }

  @Post('clients/:id/deals')
  addDeal(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: DealDto) {
    return this.clients.addDeal(this.me(u), id, dto);
  }

  @Patch('client-deals/:id')
  updateDeal(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: DealDto) {
    return this.clients.updateDeal(this.me(u), id, dto);
  }

  @Delete('client-deals/:id')
  removeDeal(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.clients.removeDeal(this.me(u), id);
  }

  // связи
  @Get('clients/:id/projects')
  projects(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.clients.projects(this.me(u), id);
  }

  @Post('clients/:id/projects/:projectId')
  linkProject(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('projectId') projectId: string) {
    return this.clients.linkProject(this.me(u), id, projectId);
  }

  @Delete('clients/:id/projects/:projectId')
  unlinkProject(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('projectId') projectId: string) {
    return this.clients.linkProject(this.me(u), id, projectId, true);
  }

  @Get('clients/:id/tasks')
  tasks(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('filter') filter?: string) {
    return this.clients.tasks(this.me(u), id, ['open', 'overdue', 'approval', 'all'].includes(filter ?? '') ? filter! : 'open');
  }

  @Get('clients/:id/meetings')
  meetings(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.clients.meetings(this.me(u), id);
  }

  @Get('clients/:id/chats')
  chats(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.clients.chats(this.me(u), id);
  }

  @Get('clients/:id/files')
  files(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.clients.files(this.me(u), id);
  }

  @Post('clients/:id/files')
  addFile(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: FileDto) {
    return this.clients.addFile(this.me(u), id, dto.fileId, dto.category ?? 'other');
  }

  @Delete('clients/:id/files/:fid')
  removeFile(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('fid') fid: string) {
    return this.clients.removeFile(this.me(u), id, fid);
  }

  @Get('clients/:id/activity')
  activity(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('kind') kind?: string) {
    return this.clients.activity(this.me(u), id, kind ?? null);
  }
}
