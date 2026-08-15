import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { MediaService } from './media.service';

/** Диагностика медиа-слоя: поднялись ли воркеры и какие созвоны идут прямо сейчас. */
@ApiTags('media')
@ApiBearerAuth()
@Controller('media')
@Roles('owner', 'manager', 'member')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  /** Почему «Позвонить» не работает — ответ здесь, а не в логах контейнера. */
  @Get('health')
  health() {
    return this.media.health();
  }

  @Get('rooms')
  rooms(@CurrentUser() u: AuthUser) {
    return this.media.activeRooms(u.tenantId);
  }
}
