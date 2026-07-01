import { ArrayNotEmpty, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class ConnectBitrixDto {
  @IsString()
  @MaxLength(500)
  webhookUrl!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

export class ImportBitrixDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'Выберите хотя бы один проект' })
  @IsString({ each: true })
  projectExternalIds!: string[];
}

export class MapUserDto {
  @IsString()
  externalUserId!: string;

  @IsString()
  localUserId!: string;
}
