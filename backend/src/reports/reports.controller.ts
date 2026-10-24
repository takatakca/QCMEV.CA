import { Controller, Get, Post, Body, UseGuards, Request, HttpCode, HttpStatus } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ReportsService } from './reports.service';

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get()
  async listReports(@Request() req: any) {
    return this.reportsService.listReports(req.user.operatorId);
  }

  @Post('annual')
  @HttpCode(HttpStatus.CREATED)
  async generateAnnual(@Request() req: any, @Body() body: { year: number }) {
    return this.reportsService.generateUserReport(req.user.operatorId, body.year);
  }
}
