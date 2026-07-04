import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { BoardService } from './board.service';

@ApiTags('board')
@ApiBearerAuth()
@Controller('projects')
@Roles('owner', 'manager', 'member') // client — только через /api/portal
export class BoardController {
  constructor(private readonly board: BoardService) {}

  @Get(':id/board')
  getBoard(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.board.getBoard(user.tenantId, id, user.role);
  }
}
