import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { TagsService } from './tags.service';
import { TagCreatePolicy } from './tag-rules';

class CreateTagDto {
  @IsString() @MinLength(2) @MaxLength(48) name!: string;
  @IsOptional() @IsString() @MaxLength(16) color?: string;
  @IsOptional() @IsString() @MaxLength(400) aiDescription?: string;
  /** «Всё равно создать новый» — осознанный второй похожий тег. */
  @IsOptional() @IsBoolean() force?: boolean;
}

class UpdateTagDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(48) name?: string;
  @IsOptional() @IsString() @MaxLength(16) color?: string;
  @IsOptional() @IsString() @MaxLength(400) aiDescription?: string;
}

class TagSettingsDto {
  @IsOptional() @IsBoolean() aiTagging?: boolean;
  @IsOptional() @IsBoolean() requireConfirmation?: boolean;
  @IsOptional() @IsIn(['all', 'managers', 'admins']) whoCanCreate?: TagCreatePolicy;
}

class SuggestDto {
  @IsString() @MinLength(2) @MaxLength(300) title!: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsOptional() @IsArray() checklist?: string[];
  @IsOptional() @IsString() @MaxLength(160) projectName?: string;
}

class TaskTagsDto {
  @IsArray() tagIds!: string[];
  /** Какие из них предложил ИИ: по ним считается, что человек поправил. */
  @IsOptional() @IsArray() suggestedTagIds?: string[];
}

/**
 * Теги задач (ТЗ «Теги задач + автоматическая AI-разметка»).
 *
 * Клиенту (роль client) теги команды не показываем: это внутренняя классификация
 * работы, и в портале заказчика ей делать нечего.
 */
@ApiTags('tags')
@ApiBearerAuth()
@Controller('tags')
@Roles('owner', 'manager', 'member')
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Query('archived') archived?: string) {
    return this.tags.list(u.tenantId, archived === '1' || archived === 'true');
  }

  @Get('settings')
  settings(@CurrentUser() u: AuthUser) {
    return this.tags.settings(u.tenantId);
  }

  @Post('settings')
  saveSettings(@CurrentUser() u: AuthUser, @Body() dto: TagSettingsDto) {
    return this.tags.saveSettings(u.tenantId, u, dto);
  }

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateTagDto) {
    return this.tags.create(u.tenantId, u, dto);
  }

  /** Подсказки ИИ по тексту задачи. Ничего не сохраняет — решает человек. */
  @Post('suggest')
  suggest(@CurrentUser() u: AuthUser, @Body() dto: SuggestDto) {
    return this.tags.suggest(u.tenantId, dto);
  }

  @Patch(':id')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateTagDto) {
    return this.tags.update(u.tenantId, u, id, dto);
  }

  @Post(':id/archive')
  archive(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.tags.archive(u.tenantId, u, id, true);
  }

  @Post(':id/restore')
  restore(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.tags.archive(u.tenantId, u, id, false);
  }
}

/** Теги конкретной задачи — рядом с самой задачей, а не в общем словаре. */
@ApiTags('tags')
@ApiBearerAuth()
@Controller('tasks')
@Roles('owner', 'manager', 'member')
export class TaskTagsController {
  constructor(private readonly tags: TagsService) {}

  @Get(':id/tags')
  ofTask(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.tags.tagsOfTask(u.tenantId, id);
  }

  /**
   * Набор тегов задачи целиком.
   *
   * Именно набор, а не «добавить один»: «снял один, добавил два» — это одно решение
   * человека, и при обрыве связи посередине задача не должна остаться размеченной
   * наполовину.
   */
  @Post(':id/tags')
  setForTask(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: TaskTagsDto) {
    return this.tags.setTaskTags(u.tenantId, u, id, dto.tagIds ?? [], dto.suggestedTagIds ?? []);
  }
}
