import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { CHANGE_REASONS, FocusDayService } from './focus-day.service';

class AddItemDto {
  /** ключ кандидата из «остальных»: task:15 · review:15 · approval:4 */
  @IsString() @MaxLength(40) key!: string;
  /** на какое место (1–3); занятое — заменяется */
  @IsOptional() @IsInt() @Min(1) @Max(3) rank?: number;
  /** почему заменили то, что было на этом месте (волна 9) */
  @IsOptional() @IsIn(CHANGE_REASONS as unknown as string[]) reason?: string;
}

class RemoveItemDto {
  @IsOptional() @IsIn(CHANGE_REASONS as unknown as string[]) reason?: string;
}

class PinDto {
  @IsBoolean() pinned!: boolean;
}

class ReorderDto {
  @IsArray() @ArrayMaxSize(3) @IsString({ each: true }) ids!: string[];
}

class DismissDto {
  @IsString() @MaxLength(40) key!: string;
}

class FeedbackDto {
  @IsIn([1, -1]) value!: 1 | -1;
}

/**
 * «Фокус дня» — дневной план человека (ТЗ-16, п. 94–95). Всё только про себя:
 * чужой план не читается и не меняется ни одной ручкой.
 */
@ApiTags('focus')
@ApiBearerAuth()
@Controller('focus/today')
@Roles('owner', 'manager', 'member')
export class FocusDayController {
  constructor(private readonly day: FocusDayService) {}

  private v(u: AuthUser) {
    return { tenantId: u.tenantId, userId: u.userId, role: u.role };
  }

  /** Экран целиком: план, тройка, сколько ещё, ждут решения, предложение замены. */
  @Get()
  today(@CurrentUser() u: AuthUser) {
    return this.day.today(this.v(u));
  }

  @Get('backlog')
  backlog(@CurrentUser() u: AuthUser) {
    return this.day.backlog(this.v(u));
  }

  @Post('accept')
  accept(@CurrentUser() u: AuthUser) {
    return this.day.accept(this.v(u));
  }

  @Post('recalculate')
  recalculate(@CurrentUser() u: AuthUser) {
    return this.day.recalculate(this.v(u));
  }

  @Post('items')
  add(@CurrentUser() u: AuthUser, @Body() dto: AddItemDto) {
    return this.day.add(this.v(u), dto);
  }

  @Post('items/reorder')
  reorder(@CurrentUser() u: AuthUser, @Body() dto: ReorderDto) {
    return this.day.reorder(this.v(u), dto.ids);
  }

  @Delete('items/:itemId')
  remove(@CurrentUser() u: AuthUser, @Param('itemId') itemId: string, @Body() dto: RemoveItemDto) {
    return this.day.remove(this.v(u), itemId, dto?.reason);
  }

  @Patch('items/:itemId/pin')
  pin(@CurrentUser() u: AuthUser, @Param('itemId') itemId: string, @Body() dto: PinDto) {
    return this.day.pin(this.v(u), itemId, dto.pinned);
  }

  @Post('dismiss')
  dismiss(@CurrentUser() u: AuthUser, @Body() dto: DismissDto) {
    return this.day.dismiss(this.v(u), dto.key);
  }

  @Post('feedback')
  feedback(@CurrentUser() u: AuthUser, @Body() dto: FeedbackDto) {
    return this.day.feedback(this.v(u), dto.value);
  }
}
