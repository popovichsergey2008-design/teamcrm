import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { SEARCH_TYPES, SearchService, SearchType } from './search.service';

/**
 * Поиск для командной строки (Ctrl+K).
 *
 * Одна ручка на все источники: палитра шлёт один запрос на набранную строку,
 * а не шесть параллельных, которые придут вразнобой и будут прыгать в списке.
 */
@ApiTags('search')
@ApiBearerAuth()
@Controller('search')
@Roles('owner', 'manager', 'member', 'client')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  /** #4922: `type` — один раздел, `offset` — «Показать ещё», `page=1` — страница поиска. */
  @Get()
  all(@CurrentUser() user: AuthUser, @Query('q') q?: string, @Query('type') type?: string,
    @Query('offset') offset?: string, @Query('page') page?: string) {
    const t = (SEARCH_TYPES as readonly string[]).includes(type ?? '') ? (type as SearchType) : null;
    return this.search.all(user.tenantId, user.userId, user.role, q ?? '', {
      type: t, offset: Number(offset) || 0, page: page === '1',
    });
  }
}
