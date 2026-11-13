import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { MeetingRecapService } from './meeting-recap.service';

class TakeDto {
  /** «срок»: ISO-дата; без поля — просто «✓ беру». */
  @IsOptional() @IsString() @MaxLength(40) deadlineAt?: string;
}

/**
 * #4902, п. 10–11: карточки встречи в чатах. Отдельный префикс, а не /meetings/...:
 * там `GET :id` перехватил бы маршруты карточек.
 */
@ApiTags('meetings')
@ApiBearerAuth()
@Controller('meeting-cards')
@Roles('owner', 'manager', 'member')
export class MeetingRecapController {
  constructor(private readonly recap: MeetingRecapService) {}

  /** Живые данные карточки по номеру сообщения чата. */
  @Get(':messageId')
  view(@CurrentUser() u: AuthUser, @Param('messageId') messageId: string) {
    return this.recap.view(u.tenantId, messageId, { userId: u.userId, role: u.role });
  }

  @Post(':messageId/confirm-all')
  confirmAll(@CurrentUser() u: AuthUser, @Param('messageId') messageId: string) {
    return this.recap.confirmAll(u.tenantId, messageId, { userId: u.userId, role: u.role });
  }

  @Post(':messageId/retry')
  retry(@CurrentUser() u: AuthUser, @Param('messageId') messageId: string) {
    return this.recap.retry(u.tenantId, messageId, { userId: u.userId, role: u.role });
  }

  @Post(':messageId/retell')
  retell(@CurrentUser() u: AuthUser, @Param('messageId') messageId: string) {
    return this.recap.retell(u.tenantId, messageId, { userId: u.userId, role: u.role });
  }

  /** «✓ беру» / «срок» по своей задаче. */
  @Post('drafts/:draftId/take')
  take(@CurrentUser() u: AuthUser, @Param('draftId') draftId: string, @Body() dto: TakeDto) {
    return this.recap.take(u.tenantId, { userId: u.userId, role: u.role }, draftId, dto.deadlineAt);
  }

  /** «Не моё»: хозяин встречи получит уведомление и переназначит. */
  @Post('drafts/:draftId/decline')
  decline(@CurrentUser() u: AuthUser, @Param('draftId') draftId: string) {
    return this.recap.decline(u.tenantId, { userId: u.userId, role: u.role }, draftId);
  }
}
