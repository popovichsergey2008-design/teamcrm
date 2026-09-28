import { Body, Controller, Delete, Get, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes } from '@nestjs/swagger';
import { AppException } from '../../common/http/app-exception';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { OnboardingService } from './onboarding.service';
import { StepKey } from './onboarding-steps';

class CompanyDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(48) timezone?: string;
  @IsOptional() @IsString() @MaxLength(48) industry?: string;
  @IsOptional() @IsString() @MaxLength(32) logoFileId?: string;
}

class DepartmentsDto {
  @IsArray() @IsString({ each: true }) names!: string[];
}

class SkipDto {
  @IsIn(['company', 'departments', 'team']) step!: StepKey;
}

class DismissDto {
  @IsBoolean() dismissed!: boolean;
}

/**
 * Путь владельца (ТЗ-11).
 *
 * Только для тех, кто вправе настраивать компанию: путь про заведение отделов,
 * приглашений и первого проекта. Сотруднику эта подсказка не нужна и не показывается.
 */
@ApiTags('onboarding')
@ApiBearerAuth()
@Controller('onboarding')
@Roles('owner', 'manager')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  view(@CurrentUser() user: AuthUser) {
    return this.onboarding.view(user.tenantId, user.userId);
  }

  @Get('industries')
  industries() {
    return this.onboarding.industries();
  }

  /** Что предложить отметить: отрасль передаётся, потому что её ещё могли не сохранить. */
  @Get('departments/suggest')
  suggest(@CurrentUser() user: AuthUser, @Query('industry') industry?: string) {
    return this.onboarding.departmentSuggestion(user.tenantId, industry ?? null);
  }

  @Post('departments')
  createDepartments(@CurrentUser() user: AuthUser, @Body() dto: DepartmentsDto) {
    return this.onboarding.createDepartments(user.tenantId, dto.names ?? []);
  }

  @Post('company')
  async saveCompany(@CurrentUser() user: AuthUser, @Body() dto: CompanyDto) {
    await this.onboarding.saveCompany(user.tenantId, user.userId, {
      name: dto.name,
      timezone: dto.timezone,
      industry: dto.industry ?? null,
      logoFileId: dto.logoFileId ?? null,
    });
    return this.onboarding.view(user.tenantId, user.userId);
  }

  /**
   * Логотип компании.
   *
   * Отдельной ручкой, а не полем в настройках: это файл, и он идёт тем же путём, что
   * аватар человека и вложения задач.
   */
  @Post('logo')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  logo(@CurrentUser() user: AuthUser, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw AppException.validation('Файл не выбран');
    return this.onboarding.setLogo(user.tenantId, user.userId, file);
  }

  @Delete('logo')
  async clearLogo(@CurrentUser() user: AuthUser) {
    await this.onboarding.clearLogo(user.tenantId);
    return { cleared: true };
  }

  @Post('skip')
  async skip(@CurrentUser() user: AuthUser, @Body() dto: SkipDto) {
    await this.onboarding.skip(user.tenantId, user.userId, dto.step);
    return this.onboarding.view(user.tenantId, user.userId);
  }

  /** Свернуть подсказку совсем или открыть её заново из настроек. */
  @Post('dismiss')
  async dismiss(@CurrentUser() user: AuthUser, @Body() dto: DismissDto) {
    await this.onboarding.setDismissed(user.tenantId, user.userId, dto.dismissed);
    return this.onboarding.view(user.tenantId, user.userId);
  }
}
