import { Body, Controller, Get, Headers, Ip, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Public } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AuthService, SessionMeta } from './auth.service';
import { LoginDto, LogoutDto, RefreshDto, RegisterDto } from './auth.dto';

class SwitchOrgDto {
  @IsString() tenantId!: string;
}
class CreateOrgDto {
  @IsString() @MinLength(2) @MaxLength(160) name!: string;
}

@ApiTags('auth')
@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('auth/register')
  register(@Body() dto: RegisterDto, @Headers('user-agent') ua: string, @Ip() ip: string) {
    return this.auth.register(dto, this.meta(ua, ip));
  }

  @Public()
  @Post('auth/login')
  login(@Body() dto: LoginDto, @Headers('user-agent') ua: string, @Ip() ip: string) {
    return this.auth.login(dto, this.meta(ua, ip));
  }

  @Public()
  @Post('auth/refresh')
  refresh(@Body() dto: RefreshDto, @Headers('user-agent') ua: string, @Ip() ip: string) {
    return this.auth.refresh(dto.refreshToken, this.meta(ua, ip));
  }

  private meta(ua?: string, ip?: string): SessionMeta {
    return { userAgent: ua?.slice(0, 250), ip };
  }

  @Public()
  @Post('auth/logout')
  async logout(@Body() dto: LogoutDto) {
    await this.auth.logout(dto.refreshToken);
    return { loggedOut: true };
  }

  @ApiBearerAuth()
  @Get('auth/organizations')
  organizations(@CurrentUser() user: AuthUser) {
    return this.auth.organizations(user.tenantId, user.userId);
  }

  @ApiBearerAuth()
  @Post('auth/switch-org')
  switchOrg(@CurrentUser() user: AuthUser, @Body() dto: SwitchOrgDto, @Headers('user-agent') ua: string, @Ip() ip: string) {
    return this.auth.switchOrg(user.tenantId, user.userId, dto.tenantId, this.meta(ua, ip));
  }

  @ApiBearerAuth()
  @Post('auth/organizations')
  createOrg(@CurrentUser() user: AuthUser, @Body() dto: CreateOrgDto, @Headers('user-agent') ua: string, @Ip() ip: string) {
    return this.auth.createOrg(user.tenantId, user.userId, dto.name, this.meta(ua, ip));
  }
}
