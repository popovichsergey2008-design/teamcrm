import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { BoardService } from './board.service';

@ApiTags('board')
@ApiBearerAuth()
@Controller('projects')
export class BoardController {
  constructor(private readonly board: BoardService) {}

  @Get(':id/board')
  getBoard(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.board.getBoard(user.tenantId, id, user.role);
  }
}
