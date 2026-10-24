import { Controller, Get, Post, Put, Body, Param, UseGuards, Request, HttpCode, HttpStatus } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OperatorsService } from './operators.service';
import { AuthService } from '../auth/auth.service';

@Controller('operators')
@UseGuards(JwtAuthGuard)
export class OperatorsController {
  constructor(
    private readonly operatorsService: OperatorsService,
    private readonly authService: AuthService,
  ) {}

  /** Get current operator details */
  @Get('me')
  async getMe(@Request() req: any) {
    return this.operatorsService.findById(req.user.operatorId);
  }

  /** Get MEV system status for this operator */
  @Get('mev-status')
  async getMevStatus(@Request() req: any) {
    return this.operatorsService.getMevStatus(req.user.operatorId);
  }

  /** Update operator settings */
  @Put('me')
  async update(@Request() req: any, @Body() dto: any) {
    return this.operatorsService.update(req.user.operatorId, dto);
  }

  /** Create a new SEV user for this operator */
  @Post('users')
  @HttpCode(HttpStatus.CREATED)
  async createUser(@Request() req: any, @Body() dto: any) {
    return this.authService.createUser(req.user.operatorId, dto);
  }

  /** Register a new operator (public — used during initial setup) */
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dto: any) {
    const operator = await this.operatorsService.create(dto);
    // Create the first admin user
    await this.authService.createUser(operator.id, {
      username: dto.adminUsername,
      password: dto.adminPassword,
      firstName: dto.adminFirstName ?? 'Admin',
      lastName:  dto.adminLastName  ?? '',
      role:      'ADMIN',
    });
    return { operatorId: operator.id, message: 'Operator registered. Please request a MEV certificate.' };
  }
}
