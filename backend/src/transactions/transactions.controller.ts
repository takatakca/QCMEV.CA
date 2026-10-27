/**
 * Transactions Controller
 *
 * REST endpoints for transaction management.
 * All routes require JWT authentication (JwtAuthGuard) and are scoped to the
 * caller's operator — another operator's transaction id answers 404.
 */

import {
  Controller, Post, Get, Param, Body, UseGuards, Request,
  HttpCode, HttpStatus, Query,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TransactionsService } from './transactions.service';
import { ReceiptService } from '../documents/receipt.service';
import {
  AddItemAfterInvoiceDto,
  CancelTransactionDto,
  CreateTransactionBodyDto,
  ModifyPriceAfterInvoiceDto,
  RemoveItemAfterInvoiceDto,
} from './dto/transaction.dto';

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
  async create(@Request() req: any, @Body() body: CreateTransactionBodyDto) {
    return this.transactionsService.createTransaction({
      operatorId:    req.user.operatorId,
      deviceId:      body.deviceId,
      userId:        req.user.sub,
      transactionType: body.transactionType ?? 'ADDITION',
      items:         body.items,
      paymentMode:   body.paymentMode ?? 'CASH',
      printMode:     body.printMode,
      tableNumber:   body.tableNumber,
      numberOfCovers: body.numberOfCovers,
      tipsAmount:    body.tipsAmount,
      relatedTransactionId: body.originalTransactionId ?? body.relatedTransactionId,
      isTraining:    body.isTraining ?? false,
    });
  }

  /** Cancel an existing transaction (ANN) */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(@Request() req: any, @Param('id') id: string, @Body() dto: CancelTransactionDto) {
    return this.transactionsService.cancelTransaction(req.user.operatorId, id, req.user.sub, dto.reason ?? 'Non spécifié');
  }

  /** Get daily transaction summary */
  @Get('daily-summary')
  async dailySummary(
    @Request() req: any,
    @Query('date') date?: string,
  ) {
    return this.transactionsService.getDailySummary(req.user.operatorId, date);
  }

  /** Get receipt data for a transaction */
  @Get(':id/receipt')
  async receipt(@Request() req: any, @Param('id') id: string) {
    await this.transactionsService.assertOwned(req.user.operatorId, id);
    return this.receiptService.generateReceiptData(id);
  }

  /** Get receipt as plain text (for thermal printer) */
  @Get(':id/receipt/text')
  async receiptText(@Request() req: any, @Param('id') id: string) {
    await this.transactionsService.assertOwned(req.user.operatorId, id);
    const text = await this.receiptService.formatReceiptText(id);
    return { text };
  }

  /** Add item after invoice (SW-76 §4.6) */
  @Post(':id/items')
  @HttpCode(HttpStatus.OK)
  async addItem(@Request() req: any, @Param('id') id: string, @Body() body: AddItemAfterInvoiceDto) {
    const { reason, ...item } = body;
    return this.transactionsService.addItemAfterInvoice(req.user.operatorId, id, req.user.sub, item, reason ?? 'Non spécifié');
  }

  /** Remove item after invoice (SW-76 §4.6) */
  @Post(':id/items/:itemId/remove')
  @HttpCode(HttpStatus.OK)
  async removeItem(
    @Request() req: any,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: RemoveItemAfterInvoiceDto,
  ) {
    return this.transactionsService.removeItemAfterInvoice(req.user.operatorId, id, req.user.sub, itemId, body.reason ?? 'Non spécifié');
  }

  /** Modify item price after invoice (SW-76 §4.6) */
  @Post(':id/items/:itemId/price')
  @HttpCode(HttpStatus.OK)
  async modifyPrice(
    @Request() req: any,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: ModifyPriceAfterInvoiceDto,
  ) {
    return this.transactionsService.modifyPriceAfterInvoice(req.user.operatorId, id, req.user.sub, itemId, body.newUnitPrice, body.reason ?? 'Non spécifié');
  }
}
