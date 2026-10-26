import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { loadConfig } from '../src/config/app-config';
import { FoodHubSaleV1, payloadHashOf } from '../src/integrations/foodhub/foodhub.contract';
import type { SignedRequestInfo } from '../src/integrations/foodhub/foodhub.guard';
import { FoodHubService } from '../src/integrations/foodhub/foodhub.service';
import * as crypto from 'crypto';

const cfg = loadConfig({ JWT_SECRET: crypto.randomBytes(32).toString('hex'), PRIVATE_KEY_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') });

const body: FoodHubSaleV1 = {
  schema: 'foodhub.sale.v1', tenantId: 'takatak', locationId: 'E2E_A', saleKey: 'fh:takatak:stored:uber_eats:ORDER-9', occurredAt: '2026-10-24T12:00:00-04:00',
  source: { model: 'stored', channel: 'uber_eats', orderId: 'ORDER-9' }, serviceType: 'LVT', ecommerce: false,
  lines: [{ description: 'Poutine', quantity: '1', unitPriceCents: 1000, totalCents: 1000, taxCode: 'FP', activity: 'RES' }],
  amounts: { subtotalCents: 1000, gstCents: 50, qstCents: 100, totalCents: 1150 }, payment: { mode: 'AUT', collectedBy: 'platform' },
};
const info = (bodyHash: string, eventId = 'evt_a'): SignedRequestInfo => ({ tenantId: 'takatak', eventId, integrationId: 'foodhub', idempotencyKey: eventId, rawBody: '', bodyHash });

function harness(existing: Record<string, unknown> | null, seenEvent: Record<string, unknown> | null = null) {
  const issued: unknown[] = [];
  const prisma = {
    integrationEvent: { findUnique: jest.fn().mockResolvedValue(seenEvent), create: jest.fn().mockResolvedValue({}) },
    externalSale: { findUnique: jest.fn().mockResolvedValue(existing), update: jest.fn().mockResolvedValue({}) },
    transaction: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'tx1', mevStatus: 'ACCEPTED', mevErrors: null, subtotalCents: 1000, tpsCents: 50, tvqCents: 100, totalCents: 1150, tipCents: null }) },
  };
  const receipts = { build: jest.fn().mockResolvedValue({ noTrans: '1', renderHash: 'h' }) };
  const txs = { issue: jest.fn((r: unknown) => { issued.push(r); return Promise.resolve({}); }) };
  const audit = { log: jest.fn() };
  const svc = new FoodHubService(cfg, prisma as never, txs as never, receipts as never, {} as never, {} as never, {} as never, audit as never);
  return { svc, prisma, txs, issued };
}

describe('Food Hub idempotency', () => {
  const hash = payloadHashOf(body as unknown as Record<string, unknown>);

  it('same key + same payload → the stored answer is replayed (200), nothing new is issued', async () => {
    const h = harness({ id: 'e1', key: body.saleKey, saleKey: body.saleKey, kind: 'SALE', payloadHash: hash, transactionId: 'tx1', status: 'DONE', httpStatus: 200, responseJson: { warnings: [] } });
    const a = await h.svc.sale(info('b1'), body);
    expect(a.httpStatus).toBe(200);
    expect(a.body.status).toBe('accepted');
    expect(h.txs.issue).not.toHaveBeenCalled();
  });

  it('same key + different payload → 409 idempotency_conflict', async () => {
    const h = harness({ id: 'e1', key: body.saleKey, saleKey: body.saleKey, kind: 'SALE', payloadHash: 'other', transactionId: 'tx1', status: 'DONE', httpStatus: 200 });
    await expect(h.svc.sale(info('b1'), body)).rejects.toBeInstanceOf(ConflictException);
    expect(h.txs.issue).not.toHaveBeenCalled();
  });

  it('a reused event id with another body → 409 replay_conflict', async () => {
    const h = harness(null, { eventId: 'evt_a', tenantId: 'takatak', key: body.saleKey, bodyHash: 'another-body' });
    await expect(h.svc.sale(info('b1'), body)).rejects.toMatchObject({ response: { error: 'replay_conflict' } });
  });

  it.each([
    { bodyHash: 'another-body', tenantId: 'takatak', key: body.saleKey },
    { bodyHash: 'b1', tenantId: 'another-tenant', key: body.saleKey },
    { bodyHash: 'b1', tenantId: 'takatak', key: 'another-sale' },
    null,
  ])('rejects a conflicting event that wins a concurrent insert (%j)', async (winner) => {
    const h = harness(null);
    h.prisma.integrationEvent.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    h.prisma.integrationEvent.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '5.22.0' }));
    await expect(h.svc.sale(info('b1'), body)).rejects.toMatchObject({ response: { error: 'replay_conflict' } });
    expect(h.txs.issue).not.toHaveBeenCalled();
  });

  it('replays an identical event that wins a concurrent insert', async () => {
    const hash = payloadHashOf(body as unknown as Record<string, unknown>);
    const h = harness({ id: 'e1', key: body.saleKey, kind: 'SALE', payloadHash: hash, transactionId: 'tx1', status: 'DONE', httpStatus: 200 });
    h.prisma.integrationEvent.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ bodyHash: 'b1', tenantId: 'takatak', key: body.saleKey });
    h.prisma.integrationEvent.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '5.22.0' }));
    await expect(h.svc.sale(info('b1'), body)).resolves.toMatchObject({ httpStatus: 200, body: { status: 'accepted' } });
    expect(h.txs.issue).not.toHaveBeenCalled();
  });

  it('a payloadHash that does not match the body → 422 (ContractError)', async () => {
    const h = harness(null);
    await expect(h.svc.sale(info('b1'), { ...body, payloadHash: 'f'.repeat(64) })).rejects.toMatchObject({ errors: [{ field: 'payloadHash' }] });
  });
});
