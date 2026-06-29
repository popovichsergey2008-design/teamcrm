import { IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateProjectDto {
  @IsString()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  clientId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  budget?: number;
}
