import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { ChatPlusService } from './chat-plus.service';

class ReplyDto {
  @IsString() @MinLength(1) @MaxLength(4000)
  text!: string;
}

class ListenDto {
  @IsString() @MinLength(1) @MaxLength(4000)
  text!: string;
}

/** «Входящие» чатов (#4902, пп. 5–6): что я пропустил и кто ждёт моего ответа. */
@ApiTags('chat-plus')
@ApiBearerAuth()
@Controller('chat-plus')
@Roles('owner', 'manager', 'member')
export class ChatPlusController {
  constructor(private readonly svc: ChatPlusService) {}

  @Get('missed')
  missed(@CurrentUser() u: AuthUser) { return this.svc.missed(u); }

  @Post('missed/listen')
  listen(@CurrentUser() u: AuthUser, @Body() dto: ListenDto) { return this.svc.listen(u, dto.text); }

  @Get('waiting')
  waiting(@CurrentUser() u: AuthUser) { return this.svc.waiting(u); }

  @Post('waiting/:id/draft')
  draft(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.draft(u, id); }

  @Post('waiting/:id/reply')
  reply(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ReplyDto) { return this.svc.send(u, id, dto.text); }

  @Post('waiting/:id/dismiss')
  dismiss(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.dismiss(u, id); }

  @Post('waiting/:id/remind')
  remind(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.remind(u, id); }
}
