/**
 * Staff API for sales (JWT). Every :id route is scoped to the caller's operator.
 * Amounts are integer cents; quantities are decimal strings.
 */
import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser, JwtAuthGuard, MANAGERS, Roles, RolesGuard, STAFF } from '../auth/auth';
import { isValidQuantity, lineTotal, TaxCode } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiptService } from '../receipts/receipt.service';
import { TransactionsService } from './transactions.service';
import { PAYMENT_CODES, PaymentCode, SaleDraft, SaleLine } from './trans-builder';

const TAXES: TaxCode[] = ['FP', 'F', 'P', 'NON'];
const KINDS = { RECEIPT: 'RFER', ADDITION: 'ADDI', ESTIMATE: 'ESTM', QUOTE: 'SOUM' } as const;

interface ItemBody {
  description?: string;
  quantity?: string | number;
  unitPriceCents?: number;
  tax?: string;
  activity?: string;
}

function parseItem(i: ItemBody, path: string): SaleLine {
  const quantity = String(i?.quantity ?? '1');
  if (!i?.description || typeof i.description !== 'string') throw new BadRequestException(`${path}.description is required`);
  if (!isValidQuantity(quantity)) throw new BadRequestException(`${path}.quantity must be a positive decimal (max 3 decimals)`);
  if (!Number.isInteger(i.unitPriceCents) || (i.unitPriceCents as number) < 0) throw new BadRequestException(`${path}.unitPriceCents must be a positive integer (cents)`);
  const tax = (i.tax ?? 'FP') as TaxCode;
  if (!TAXES.includes(tax)) throw new BadRequestException(`${path}.tax must be FP, F, P or NON`);
  const activity = (i.activity ?? 'RES') as SaleLine['activity'];
  if (!['RES', 'BAR', 'NON'].includes(activity)) throw new BadRequestException(`${path}.activity must be RES, BAR or NON`);
  return { description: i.description.trim().slice(0, 100), quantity, unitPriceCents: i.unitPriceCents as number, totalCents: lineTotal(i.unitPriceCents as number, quantity), tax, activity };
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
  async create(@CurrentUser() u: AuthUser, @Body() b: Record<string, unknown>) {
    const items = Array.isArray(b?.items) ? (b.items as ItemBody[]) : [];
    if (!items.length) throw new BadRequestException('items is required');
    const lines = items.map((i, n) => parseItem(i, `items[${n}]`));
    const modPai = String(b.paymentMode ?? '') as PaymentCode;
    if (!PAYMENT_CODES.includes(modPai)) throw new BadRequestException(`paymentMode must be one of ${PAYMENT_CODES.join(', ')}`);
    const kind = String(b.documentKind ?? 'RECEIPT') as keyof typeof KINDS;
    if (!KINDS[kind]) throw new BadRequestException('documentKind must be RECEIPT, ADDITION, ESTIMATE or QUOTE');
    const typServ = b.serviceType ? (String(b.serviceType) as SaleDraft['typServ']) : 'CMP';
    if (!['CMP', 'LVR', 'LVT', 'TBL'].includes(typServ as string)) throw new BadRequestException('serviceType must be CMP, LVR, LVT or TBL');
    const formImpr = String(b.printFormat ?? 'PAP') as SaleDraft['formImpr'];
    if (!['PAP', 'ELE', 'PEL', 'NON'].includes(formImpr)) throw new BadRequestException('printFormat must be PAP, ELE, PEL or NON');
    const tipCents = b.tipCents == null ? null : Number(b.tipCents);
    if (tipCents != null && (!Number.isInteger(tipCents) || tipCents < 0)) throw new BadRequestException('tipCents must be a positive integer');
    const deviceId = String(b.deviceId ?? '');
    const r = await this.txs.issue({
      operatorId: u.operatorId,
      deviceId,
      userId: u.sub,
      externalRef: typeof b.externalRef === 'string' ? b.externalRef.slice(0, 60) : null,
      draft: {
        documentKind: kind,
        typTrans: KINDS[kind],
        modImpr: 'FAC',
        formImpr,
        modTrans: b.training === true ? 'FOR' : 'OPE',
        typServ,
        noTabl: typeof b.tableNumber === 'string' ? b.tableNumber.slice(0, 10) : undefined,
        nbClint: Number.isInteger(b.numberOfCovers) ? (b.numberOfCovers as number) : undefined,
        ecommerce: b.ecommerce === true,
        modPai,
        lines,
        tipCents,
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

  /** Full or partial credit note (RFER, negative amounts, referencing the sale). */
  @Post(':id/credit-note')
  @Roles(...MANAGERS)
  async credit(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { full?: boolean; itemIds?: string[]; reason?: string }) {
    const original = await this.txs.loadOwned(u.operatorId, id);
    const full = b?.full !== false && !b?.itemIds?.length;
    const lines = full ? undefined : this.txs.linesOf({ ...original, items: original.items.filter((i) => b.itemIds!.includes(i.id)) });
    if (!full && !lines?.length) throw new BadRequestException('itemIds matches no item of this transaction');
    const r = await this.txs.creditNote({ operatorId: u.operatorId, originalId: id, userId: u.sub, full, lines, reason: b?.reason });
    return { ...r.transaction, warnings: r.warnings, receipt: await this.receipts.build(r.transaction.id, u.operatorId) };
  }

  /** Same as a full credit note (kept for the dashboard's "Annuler" button). */
  @Post(':id/cancel')
  @HttpCode(200)
  @Roles(...MANAGERS)
  cancel(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { reason?: string }) {
    return this.credit(u, id, { full: true, reason: b?.reason });
  }

  /** RPR (reproduction for the customer) or DUP (merchant copy). Both are transmitted. */
  @Post(':id/reprint')
  async reprint(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { mode?: string }) {
    const mode = (b?.mode ?? 'RPR') as 'RPR' | 'DUP';
    if (!['RPR', 'DUP'].includes(mode)) throw new BadRequestException('mode must be RPR or DUP');
    const r = await this.txs.reprint({ operatorId: u.operatorId, originalId: id, userId: u.sub, mode });
    return { ...r.transaction, warnings: r.warnings, receipt: await this.receipts.build(r.transaction.id, u.operatorId) };
  }

  /** Post-invoice: add an item → new referenced receipt. */
  @Post(':id/items')
  @Roles(...MANAGERS)
  async addItem(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: ItemBody & { reason?: string }) {
    const line = parseItem(b, 'item');
    const r = await this.txs.addItemAfterInvoice(u.operatorId, id, u.sub, { description: line.description, quantity: line.quantity, unitPriceCents: line.unitPriceCents, tax: line.tax }, b?.reason);
    return { ...r.transaction, warnings: r.warnings };
  }

  /** Post-invoice: remove an item → credit note for it. */
  @Post(':id/items/:itemId/remove')
  @HttpCode(200)
  @Roles(...MANAGERS)
  async removeItem(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('itemId') itemId: string, @Body() b: { reason?: string }) {
    const r = await this.txs.removeItemAfterInvoice(u.operatorId, id, itemId, u.sub, b?.reason);
    return { ...r.transaction, warnings: r.warnings };
  }

  /** Post-invoice: change a price → credit note for the old line + new receipt at the new price. */
  @Post(':id/items/:itemId/price')
  @HttpCode(200)
  @Roles(...MANAGERS)
  modifyPrice(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('itemId') itemId: string, @Body() b: { newUnitPriceCents?: number; reason?: string }) {
    return this.txs.modifyPriceAfterInvoice(u.operatorId, id, itemId, u.sub, Number(b?.newUnitPriceCents), b?.reason);
  }

  @Get(':id/modifications')
  modifications(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.prisma.transactionModification.findMany({ where: { transactionId: id, transaction: { operatorId: u.operatorId } }, orderBy: { performedAt: 'asc' } });
  }
}
