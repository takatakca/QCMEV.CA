/**
 * Device bodies. The mandatory-billing file number (noDossFO) and the authorization code (CODAUTORI) are write-only:
 * the code is AES-256-GCM encrypted at once, neither is ever returned or logged, and both are frozen once the device
 * holds a certificate (they are inside its CSR).
 */
import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { DeviceType } from '@prisma/client';

const AUTH_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const FILE_NUMBER = /^[A-Za-z0-9-]{2,30}$/;

/** POST /api/devices */
export class RegisterDeviceDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100)
  name?: string;

  @IsString() @IsNotEmpty() @MaxLength(100)
  serialNumber!: string;

  /** Default SERVER (QCMEV signs for the establishment). */
  @IsOptional() @IsEnum(DeviceType, { message: `deviceType must be one of: ${Object.values(DeviceType).join(', ')}` })
  deviceType?: DeviceType;

  @IsOptional() @IsString() @MaxLength(100) model?: string;
  @IsOptional() @IsString() @MaxLength(50) firmwareVersion?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;

  /** noDossFO of the establishment (SPEC format). */
  @IsOptional() @Matches(FILE_NUMBER, { message: 'fileNumber: 2–30 letters, digits or -' })
  fileNumber?: string;

  /** Authorization code given by Revenu Québec, like XXXX-XXXX (S1 format). */
  @IsOptional() @Matches(AUTH_CODE, { message: 'authorizationCode must look like XXXX-XXXX' })
  authorizationCode?: string;
}

/** PUT /api/devices/:id: the only editable fields. */
export class UpdateDeviceDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(100) model?: string;
  @IsOptional() @IsString() @MaxLength(50) firmwareVersion?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsEnum(DeviceType, { message: `deviceType must be one of: ${Object.values(DeviceType).join(', ')}` }) deviceType?: DeviceType;
  @IsOptional() @Matches(FILE_NUMBER, { message: 'fileNumber: 2–30 letters, digits or -' }) fileNumber?: string;
  @IsOptional() @Matches(AUTH_CODE, { message: 'authorizationCode must look like XXXX-XXXX' }) authorizationCode?: string;
}
