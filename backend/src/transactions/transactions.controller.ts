/**
 * Transactions Controller
 *
 * REST endpoints for transaction management.
 * All routes require JWT authentication (JwtAuthGuard).
 */

import {
  Controller, Post, Get, Param, Body, UseGuards, Request,
  HttpCode, HttpStatus, Query,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TransactionsService } from './transactions.service';
import { ReceiptService } from '../documents/receipt.service';

@Controller('transactions')
@UseGuards(JwtAuthGuard)
export class TransactionsController {
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly receiptService: ReceiptService,
  ) {}

  /** Create a new transaction (ADD) */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Request() req: any, @Body() dto: any) {
    return this.transactionsService.createTransaction(req.user.operatorId, req.user.sub, dto);
  }

  /** Cancel an existing transaction (ANN) */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(@Request() req: any, @Param('id') id: string, @Body() dto: any) {
    return this.transactionsService.cancelTransaction(id, req.user.sub, dto?.reason);
  }

  /** Get daily transaction summary */
  @Get('daily-summary')
  async dailySummary(
    @Request() req: any,
    @Query('deviceId') deviceId: string,
    @Query('date') date?: string,
  ) {
    return this.transactionsService.getDailySummary(req.user.operatorId, deviceId, date);
  }

  /** Get receipt data for a transaction */
  @Get(':id/receipt')
  async receipt(@Param('id') id: string) {
    return this.receiptService.generateReceiptData(id);
  }

  /** Get receipt as plain text (for thermal printer) */
  @Get(':id/receipt/text')
  async receiptText(@Param('id') id: string) {
    const text = await this.receiptService.formatReceiptText(id);
    return { text };
  }

  /** Add item after invoice (SW-76 §4.6) */
  @Post(':id/items')
  @HttpCode(HttpStatus.OK)
  async addItem(@Request() req: any, @Param('id') id: string, @Body() item: any) {
    return this.transactionsService.addItemAfterInvoice(id, req.user.sub, item);
  }

  /** Remove item after invoice (SW-76 §4.6) */
  @Post(':id/items/:itemId/remove')
  @HttpCode(HttpStatus.OK)
  async removeItem(
    @Request() req: any,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: any,
  ) {
    return this.transactionsService.removeItemAfterInvoice(id, itemId, req.user.sub, body?.reason);
  }

  /** Modify item price after invoice (SW-76 §4.6) */
  @Post(':id/items/:itemId/price')
  @HttpCode(HttpStatus.OK)
  async modifyPrice(
    @Request() req: any,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: any,
  ) {
    return this.transactionsService.modifyPriceAfterInvoice(id, itemId, req.user.sub, body.newUnitPrice, body?.reason);
  }
}
