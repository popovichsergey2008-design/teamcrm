import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { TemplatesService } from './templates.service';

class SaveTemplateDto {
  /** Как шаблон будет называться в списке. */
  @IsString() @MinLength(2) @MaxLength(80) name!: string;
  /** «Через сколько дней срок» — необязательно; не передали, считаем по задаче. */
  @IsOptional() @IsInt() @Min(0) @Max(365) deadlineDays?: number;
}

/**
 * Шаблоны задач (просьба заказчика: кнопка «сохранить как шаблон»).
 *
 * Доступ тот же, что к задачам: кто может поставить задачу, тот может и закрепить
 * способ, каким её ставят. Заказчику (роль client) чужая кухня не нужна. Удаление — уже
 * с отдельной проверкой, см. сервис.
 */
@ApiTags('task-templates')
@ApiBearerAuth()
@Controller('task-templates')
@Roles('owner', 'manager', 'member')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.templates.list(user.tenantId);
  }

  @Post('from-task/:taskId')
  saveFromTask(
    @CurrentUser() user: AuthUser,
    @Param('taskId') taskId: string,
    @Body() dto: SaveTemplateDto,
  ) {
    return this.templates.saveFromTask(
      user.tenantId, taskId, dto.name, { userId: user.userId, role: user.role },
      dto.deadlineDays === undefined ? undefined : dto.deadlineDays,
    );
  }

  @Post(':id/used')
  markUsed(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.templates.markUsed(user.tenantId, id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.templates.remove(user.tenantId, id, { userId: user.userId, role: user.role })
      .then(() => ({ removed: true }));
  }
}
