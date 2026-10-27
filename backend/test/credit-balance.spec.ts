import { DocumentKind, MevStatus, TransactionStatus } from '@prisma/client';
import { TransactionsService, TxWithItems } from '../src/transactions/transactions.service';
import { SaleRuleError } from '../src/transactions/trans-builder';

/* eslint-disable @typescript-eslint/no-explicit-any */
function harness(aggregate: Record<string, number | null>, row: Record<string, number>) {
  const svc = new TransactionsService({} as never, {} as never, {} as never, {} as never, { log: jest.fn() } as never);
  const original = {
    id: 'original', deviceId: 'd', operatorId: 'op', documentKind: DocumentKind.RECEIPT, printMode: 'FAC',
    mevStatus: MevStatus.ACCEPTED, noTrans: '1', subtotalCents: 1000, tpsCents: 50, tvqCents: 100, totalCents: 1150,
    items: [{ quantity: '1', unitPriceCents: 1000, totalCents: 1000, description: 'Sale', tax: 'FP', activity: 'RES' }],
  } as TxWithItems;
  jest.spyOn(svc, 'loadReferenceable').mockResolvedValue(original);
  jest.spyOn(svc, 'creditedSoFar').mockResolvedValue(0); // stale pre-transaction balance
  const tx = { $queryRaw: jest.fn().mockResolvedValue([]), transaction: { aggregate: jest.fn().mockResolvedValue({ _sum: aggregate }), update: jest.fn().mockResolvedValue({}) } };
  jest.spyOn(svc, 'issue').mockImplementation(async (req) => {
    const transaction = { id: 'new-credit', ...row } as any;
    await req.inTx!(tx as never, transaction);
    return { transaction, totals: {} as never, warnings: [] };
  });
  return { svc, tx };
}
const partial = { operatorId: 'op', originalId: 'original', userId: 'u', full: false, lines: [{ description: 'Partial', quantity: '1', unitPriceCents: 800, totalCents: 800, tax: 'FP' as const, activity: 'RES' as const }] };

describe('credit limits rechecked within issuance transaction', () => {
  it('refuses a second full credit despite a stale zero precheck', async () => {
    const h = harness({ subtotalCents: -1000 }, { subtotalCents: -1000, tpsCents: -50, tvqCents: -100, totalCents: -1150 });
    await expect(h.svc.creditNote({ ...partial, full: true })).rejects.toMatchObject({ status: 400 });
    expect(h.tx.$queryRaw).toHaveBeenCalled();
    expect(h.tx.transaction.update).not.toHaveBeenCalled();
  });

  it('refuses an overlapping partial credit before changing the original status', async () => {
    const h = harness({ subtotalCents: -800 }, { subtotalCents: -800, tpsCents: -40, tvqCents: -80, totalCents: -920 });
    await expect(h.svc.creditNote(partial)).rejects.toBeInstanceOf(SaleRuleError);
    expect(h.tx.transaction.update).not.toHaveBeenCalled();
  });

  it.each(['tpsCents', 'tvqCents', 'totalCents'] as const)('refuses over-refunding %s even if the subtotal still fits', async (field) => {
    const h = harness({ subtotalCents: 0, [field]: -10_000 }, { subtotalCents: -800, tpsCents: -40, tvqCents: -80, totalCents: -920 });
    await expect(h.svc.creditNote(partial)).rejects.toMatchObject({ field });
    expect(h.tx.transaction.update).not.toHaveBeenCalled();
  });

  it('updates status and the integration record inside the same transaction', async () => {
    const h = harness({ subtotalCents: -200, tpsCents: -10, tvqCents: -20, totalCents: -230 }, { subtotalCents: -800, tpsCents: -40, tvqCents: -80, totalCents: -920 });
    const inTx = jest.fn();
    await h.svc.creditNote({ ...partial, inTx });
    expect(h.tx.transaction.update).toHaveBeenCalledWith({ where: { id: 'original' }, data: { status: TransactionStatus.CREDITED } });
    expect(inTx).toHaveBeenCalledWith(h.tx, expect.objectContaining({ id: 'new-credit' }));
  });
});
