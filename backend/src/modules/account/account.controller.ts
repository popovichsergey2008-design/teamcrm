import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CurrentUser } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { AccountService } from './account.service';

class UpdateProfileDto {
  @IsOptional() @IsString() @MaxLength(160) fullName?: string;
  @IsOptional() @IsString() @MaxLength(32) phone?: string | null;
  @IsOptional() @IsString() @MaxLength(48) timezone?: string;
  @IsOptional() @IsString() @MaxLength(8) locale?: string;
  /** Через сколько часов на проверке задача считается зависшей. null — вернуть значение по умолчанию. */
  @IsOptional() @IsInt() @Min(1) @Max(168) radarStuckHours?: number | null;
  /** Не ставить мне встречи на время, где уже что-то стоит. */
  @IsOptional() @IsBoolean() calendarBlockOverlap?: boolean;
}
class PasswordDto {
  @IsString() currentPassword!: string;
  @IsString() @MinLength(8) @MaxLength(128) newPassword!: string;
}
class NotifyDto {
  @IsObject() prefs!: Record<string, unknown>;
}
class AvailabilityDto {
  @IsIn(['vacation', 'sick', 'other']) kind!: string;
  @IsDateString() fromDate!: string;
  @IsDateString() toDate!: string;
}

@ApiTags('account')
@ApiBearerAuth()
@Controller('me')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get()
  me(@CurrentUser() u: AuthUser) {
    return this.account.getMe(u.tenantId, u.userId);
  }

  @Patch()
  update(@CurrentUser() u: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.account.updateProfile(u.tenantId, u.userId, dto);
  }

  @Post('password')
  password(@CurrentUser() u: AuthUser, @Body() dto: PasswordDto) {
    return this.account.changePassword(u.tenantId, u.userId, u.sessionId, dto.currentPassword, dto.newPassword);
  }

  @Post('avatar')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  avatar(@CurrentUser() u: AuthUser, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw AppException.validation('file is required');
    return this.account.setAvatar(u.tenantId, u.userId, file);
  }

  @Put('notifications')
  notifications(@CurrentUser() u: AuthUser, @Body() dto: NotifyDto) {
    return this.account.setNotifyPrefs(u.tenantId, u.userId, dto.prefs);
  }

  /**
   * Личное меню: порядок пунктов и скрытые разделы.
   *
   * Настройка человека, а не браузера: он открывает CRM с другого компьютера и ждёт
   * то же меню, которое себе собрал.
   */
  @Put('ui-prefs')
  uiPrefs(@CurrentUser() u: AuthUser, @Body() dto: NotifyDto) {
    return this.account.setUiPrefs(u.tenantId, u.userId, dto.prefs);
  }

  @Get('availability')
  listAvailability(@CurrentUser() u: AuthUser) {
    return this.account.listAvailability(u.tenantId, u.userId);
  }
  @Post('availability')
  addAvailability(@CurrentUser() u: AuthUser, @Body() dto: AvailabilityDto) {
    return this.account.addAvailability(u.tenantId, u.userId, dto.kind, dto.fromDate, dto.toDate);
  }
  @Delete('availability/:id')
  removeAvailability(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.account.removeAvailability(u.tenantId, u.userId, id);
  }

  @Get('sessions')
  sessions(@CurrentUser() u: AuthUser) {
    return this.account.sessions(u.userId, u.sessionId);
  }
  @Delete('sessions/:id')
  revokeSession(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.account.revokeSession(u.userId, id);
  }
  @Post('sessions/revoke-all')
  revokeAll(@CurrentUser() u: AuthUser) {
    return this.account.revokeOtherSessions(u.userId, u.sessionId);
  }
}
