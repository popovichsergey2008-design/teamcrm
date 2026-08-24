import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { SearchService } from './search.service';

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

  @Get()
  all(@CurrentUser() user: AuthUser, @Query('q') q?: string) {
    return this.search.all(user.tenantId, user.userId, user.role, q ?? '');
  }
}
