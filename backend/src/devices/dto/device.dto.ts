import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { DeviceType } from '@prisma/client';

/** POST /api/devices */
export class RegisterDeviceDto {
  @IsString() @IsNotEmpty() @MaxLength(100)
  name!: string;

  @IsString() @IsNotEmpty() @MaxLength(100)
  serialNumber!: string;

  @IsEnum(DeviceType, { message: `deviceType must be one of: ${Object.values(DeviceType).join(', ')}` })
  deviceType!: DeviceType;

  @IsOptional() @IsString() @MaxLength(100) model?: string;
  @IsOptional() @IsString() @MaxLength(50) firmwareVersion?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}

/** PUT /api/devices/:id — only these fields are editable */
export class UpdateDeviceDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(100) model?: string;
  @IsOptional() @IsString() @MaxLength(50) firmwareVersion?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
