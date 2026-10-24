import { Controller, Get, Post, Put, Body, Param, UseGuards, Request, HttpCode, HttpStatus } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DevicesService } from './devices.service';
import { OfflineQueueService } from '../offline/offline-queue.service';

@Controller('devices')
@UseGuards(JwtAuthGuard)
export class DevicesController {
  constructor(
    private readonly devicesService: DevicesService,
    private readonly offlineQueueService: OfflineQueueService,
  ) {}

  /** List all devices for the operator */
  @Get()
  async findAll(@Request() req: any) {
    return this.devicesService.findAllForOperator(req.user.operatorId);
  }

  /** Register a new device */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async register(@Request() req: any, @Body() dto: any) {
    return this.devicesService.register(req.user.operatorId, dto);
  }

  /** Get device by ID */
  @Get(':id')
  async findOne(@Request() req: any, @Param('id') id: string) {
    await this.devicesService.assertOwned(req.user.operatorId, id);
    return this.devicesService.findById(id);
  }

  /** Update device info */
  @Put(':id')
  async update(@Request() req: any, @Param('id') id: string, @Body() dto: any) {
    await this.devicesService.assertOwned(req.user.operatorId, id);
    return this.devicesService.update(id, dto);
  }

  /** Get offline/queue status for a device */
  @Get(':id/offline-status')
  async offlineStatus(@Request() req: any, @Param('id') id: string) {
    await this.devicesService.assertOwned(req.user.operatorId, id);
    return this.devicesService.getOfflineStatus(id);
  }

  /** Manually trigger an offline queue flush */
  @Post(':id/flush-queue')
  @HttpCode(HttpStatus.OK)
  async flushQueue(@Request() req: any, @Param('id') id: string) {
    await this.devicesService.assertOwned(req.user.operatorId, id);
    return this.offlineQueueService.flushDeviceQueue(id);
  }
}
