/**
 * Staff API for sales (JWT). Every :id route is scoped to the caller's operator: another operator's transaction,
 * item or receipt answers 404. Bodies are validated by the DTOs in ./dto (400), then by the sale rules (422).
 * Amounts are integer cents; quantities are decimal strings.
 */
import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser, JwtAuthGuard, MANAGERS, Roles, RolesGuard, STAFF } from '../auth/auth';
import { lineTotal, TaxCode } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiptService } from '../receipts/receipt.service';
import { AddItemAfterInvoiceDto, CreateTransactionDto, CreditNoteDto, ModifyPriceDto, ReasonDto, ReprintDto, TransactionItemDto } from './dto/transaction.dto';
import { TransactionsService } from './transactions.service';
import { PaymentCode, SaleLine } from './trans-builder';

const KINDS = { RECEIPT: 'RFER', ADDITION: 'ADDI', ESTIMATE: 'ESTM', QUOTE: 'SOUM' } as const;

function toLine(i: TransactionItemDto): SaleLine {
  const quantity = i.quantity ?? '1';
  return {
    description: i.description.trim().slice(0, 100),
    quantity,
    unitPriceCents: i.unitPriceCents,
    totalCents: lineTotal(i.unitPriceCents, quantity),
    tax: (i.tax ?? 'FP') as TaxCode,
    activity: i.activity ?? 'RES',
  };
}

@Controller('transactions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...STAFF)
export class TransactionsController {
  constructor(
    private readonly txs: TransactionsService,
    private readonly receipts: ReceiptService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Query('take') take?: string) {
    return this.txs.list(u.operatorId, Number(take ?? 50) || 50);
  }

  @Get('daily-summary')
  daily(@CurrentUser() u: AuthUser, @Query('date') date?: string) {
    return this.txs.dailySummary(u.operatorId, date);
  }

  @Post()
  async create(@CurrentUser() u: AuthUser, @Body() b: CreateTransactionDto) {
    const kind = b.documentKind ?? 'RECEIPT';
    if (b.relatedTransactionId && kind !== 'RECEIPT') throw new BadRequestException('relatedTransactionId is only allowed on a RECEIPT (facture corrigée)');
    const r = await this.txs.issue({
      operatorId: u.operatorId,
      deviceId: b.deviceId,
      userId: u.sub,
      externalRef: b.externalRef?.slice(0, 60) ?? null,
      relatedTransactionId: b.relatedTransactionId ? await this.txs.assertCorrectable(u.operatorId, b.relatedTransactionId) : null,
      draft: {
        documentKind: kind,
        typTrans: KINDS[kind],
        modImpr: 'FAC',
        formImpr: b.printFormat ?? 'PAP',
        modTrans: b.training === true ? 'FOR' : 'OPE',
        typServ: b.serviceType ?? 'CMP',
        noTabl: b.tableNumber?.slice(0, 10),
        nbClint: b.numberOfCovers,
        ecommerce: b.ecommerce === true,
        modPai: b.paymentMode as PaymentCode,
        lines: b.items.map(toLine),
        tipCents: b.tipCents ?? null,
      },
    });
    return { ...r.transaction, warnings: r.warnings, receipt: await this.receipts.build(r.transaction.id, u.operatorId) };
  }

  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.txs.loadOwned(u.operatorId, id);
  }

  @Get(':id/receipt')
  receipt(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.receipts.build(id, u.operatorId);
  }

  /** The 80 mm text of the receipt, ready for a thermal printer. */
  @Get(':id/receipt/text')
  async receiptText(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const r = await this.receipts.build(id, u.operatorId);
    return { text: r.text80mm.join('\n') };
  }

  /** Full or partial credit note (RFER, negative amounts, referencing the sale). */
  @Post(':id/credit-note')
  @Roles(...MANAGERS)
  async credit(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: CreditNoteDto) {
    const original = await this.txs.loadOwned(u.operatorId, id);
    const full = b?.full !== false && !b?.itemIds?.length;
    const lines = full ? undefined : this.txs.linesOf({ ...original, items: original.items.filter((i) => b.itemIds!.includes(i.id)) });
    if (!full && !lines?.length) throw new BadRequestException('itemIds matches no item of this transaction');
    const r = await this.txs.creditNote({ operatorId: u.operatorId, originalId: id, userId: u.sub, full, lines, reason: b?.reason });
    return { ...r.transaction, warnings: r.warnings, receipt: await this.receipts.build(r.transaction.id, u.operatorId) };
  }

  /** Same as a full credit note (the dashboard's "Annuler" button; the official layer has no separate cancellation). */
  @Post(':id/cancel')
  @HttpCode(200)
  @Roles(...MANAGERS)
  cancel(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: ReasonDto) {
    return this.credit(u, id, { full: true, reason: b?.reason });
  }

  /** RPR (reproduction for the customer) or DUP (merchant copy). Both are transmitted. */
  @Post(':id/reprint')
  async reprint(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: ReprintDto) {
    const r = await this.txs.reprint({ operatorId: u.operatorId, originalId: id, userId: u.sub, mode: b?.mode ?? 'RPR' });
    return { ...r.transaction, warnings: r.warnings, receipt: await this.receipts.build(r.transaction.id, u.operatorId) };
  }

  /** Post-invoice: add an item → new referenced receipt. */
  @Post(':id/items')
  @Roles(...MANAGERS)
  async addItem(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: AddItemAfterInvoiceDto) {
    const line = toLine(b);
    const r = await this.txs.addItemAfterInvoice(u.operatorId, id, u.sub, { description: line.description, quantity: line.quantity, unitPriceCents: line.unitPriceCents, tax: line.tax }, b?.reason);
    return { ...r.transaction, warnings: r.warnings };
  }

  /** Post-invoice: remove an item → credit note for it. The item must belong to this transaction. */
  @Post(':id/items/:itemId/remove')
  @HttpCode(200)
  @Roles(...MANAGERS)
  async removeItem(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('itemId') itemId: string, @Body() b: ReasonDto) {
    const r = await this.txs.removeItemAfterInvoice(u.operatorId, id, itemId, u.sub, b?.reason);
    return { ...r.transaction, warnings: r.warnings };
  }

  /** Post-invoice: change a price → credit note for the old line + new receipt at the new price. */
  @Post(':id/items/:itemId/price')
  @HttpCode(200)
  @Roles(...MANAGERS)
  modifyPrice(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('itemId') itemId: string, @Body() b: ModifyPriceDto) {
    return this.txs.modifyPriceAfterInvoice(u.operatorId, id, itemId, u.sub, b.newUnitPriceCents, b?.reason);
  }

  @Get(':id/modifications')
  modifications(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.prisma.transactionModification.findMany({ where: { transactionId: id, transaction: { operatorId: u.operatorId } }, orderBy: { performedAt: 'asc' } });
  }
}
