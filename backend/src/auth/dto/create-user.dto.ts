import { IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { NOM_UTIL, USERNAME } from '../../operators/dto/register-operator.dto';

/** POST /api/operators/users: a new SEV user, then a UTL request (AJO) on every certified device. */
export class CreateUserDto {
  @Matches(USERNAME, { message: 'username: 3–60 letters, digits, . _ @ -' })
  username!: string;

  @IsString() @MinLength(12, { message: 'password must be at least 12 characters' }) @MaxLength(200)
  password!: string;

  @IsString() @IsNotEmpty() @MaxLength(100)
  firstName!: string;

  @IsOptional() @IsString() @MaxLength(100)
  lastName?: string;

  /** SYSTEM users are created by the integrations only. */
  @IsOptional() @IsIn(['ADMIN', 'MANAGER', 'CASHIER'], { message: 'role must be ADMIN, MANAGER or CASHIER' })
  role?: 'ADMIN' | 'MANAGER' | 'CASHIER';

  /** nomUtil registered with MEV-WEB. Default: "<first name> <last name>", else the username. */
  @IsOptional() @Matches(NOM_UTIL, { message: 'mevUserName: 2–50 characters' })
  mevUserName?: string;
}

/** POST /api/operators/users/:id/register */
export class UtlDto {
  @IsOptional() @IsIn(['AJO', 'SUP', 'VAL'], { message: 'modif must be AJO, SUP or VAL' })
  modif?: 'AJO' | 'SUP' | 'VAL';
}
