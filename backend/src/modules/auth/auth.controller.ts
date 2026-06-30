import { Body, Controller, Headers, Ip, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/auth/decorators';
import { AuthService, SessionMeta } from './auth.service';
import { LoginDto, LogoutDto, RefreshDto, RegisterDto } from './auth.dto';

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
}
