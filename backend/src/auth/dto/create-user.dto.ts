import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { UserRole } from '@prisma/client';

/** POST /api/operators/users — new SEV user (+ UTL request to MEV-WEB) */
export class CreateUserDto {
  @IsString() @MinLength(3) @MaxLength(50)
  username!: string;

  @IsString() @MinLength(8, { message: 'password must be at least 8 characters' }) @MaxLength(200)
  password!: string;

  @IsString() @IsNotEmpty() @MaxLength(100)
  firstName!: string;

  @IsOptional() @IsString() @MaxLength(100)
  lastName?: string;

  @IsEnum(UserRole, { message: `role must be one of: ${Object.values(UserRole).join(', ')}` })
  role!: UserRole;
}
