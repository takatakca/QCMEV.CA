import { Controller, Get, Post, Put, Body, UseGuards, Request, HttpCode, HttpStatus } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OperatorsService } from './operators.service';
import { AuthService } from '../auth/auth.service';
import { RegisterOperatorDto, UpdateOperatorDto } from './dto/register-operator.dto';

/**
 * NOTE: guards are per-route on purpose. `register` MUST stay public — a
 * class-level JwtAuthGuard made it unreachable (nobody has a token before
 * the first operator exists).
 */
@Controller('operators')
export class OperatorsController {
  constructor(
    private readonly operatorsService: OperatorsService,
    private readonly authService: AuthService,
  ) {}

  /**
   * Register a new operator + first ADMIN user (PUBLIC — initial setup).
   * Next steps for the operator: log in → register a device → request a
   * certificate (POST /api/certificates/request). The admin's UTL request is
   * sent automatically as soon as the certificate is stored.
   */
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dto: RegisterOperatorDto) {
    const { operator, admin } = await this.operatorsService.register(dto);
    return {
      operatorId:  operator.id,
      adminUserId: admin.id,
      environment: operator.environment,
      message:     'Opérateur enregistré. Connectez-vous, ajoutez un appareil, puis demandez un certificat MEV.',
      nextSteps:   [
        'POST /api/auth/login',
        'POST /api/devices',
        'POST /api/certificates/request { deviceId }',
      ],
    };
  }

  /** Get current operator details */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMe(@Request() req: any) {
    return this.operatorsService.findById(req.user.operatorId);
  }

  /** Get MEV system status for this operator */
  @Get('mev-status')
  @UseGuards(JwtAuthGuard)
  async getMevStatus(@Request() req: any) {
    return this.operatorsService.getMevStatus(req.user.operatorId);
  }

  /** Update operator settings (whitelisted fields only) */
  @Put('me')
  @UseGuards(JwtAuthGuard)
  async update(@Request() req: any, @Body() dto: UpdateOperatorDto) {
    return this.operatorsService.update(req.user.operatorId, dto);
  }

  /** Create a new SEV user for this operator (+ UTL request to MEV-WEB) */
  @Post('users')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async createUser(@Request() req: any, @Body() dto: any) {
    return this.authService.createUser(req.user.operatorId, dto);
  }

  /** (Re)send UTL for every user of this operator still missing a MEV user id */
  @Post('users/sync-mev')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async syncMevUsers(@Request() req: any) {
    return this.authService.syncMevUsers(req.user.operatorId);
  }
}
