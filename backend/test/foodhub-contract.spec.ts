import { ContractError, FoodHubSaleV1, mapSale, payloadHashOf, validateCredit, validatePrint, validateSale } from '../src/integrations/foodhub/foodhub.contract';
import { tpsOf, tvqOf } from '../src/common/money';
import { saleTotals } from '../src/transactions/trans-builder';

type Over = Partial<FoodHubSaleV1> & { lines?: FoodHubSaleV1['lines'] };

function sale(channel: FoodHubSaleV1['source']['channel'], serviceType: FoodHubSaleV1['serviceType'], o: Over & { delivery?: number; serviceFee?: number; discount?: number; tip?: number } = {}): FoodHubSaleV1 {
  const lines = o.lines ?? [{ description: 'Poutine', quantity: '1', unitPriceCents: 1299, totalCents: 1299, taxCode: 'FP', activity: 'RES' }];
  const sum = lines.reduce((s, l) => s + l.totalCents + (l.modifiers ?? []).reduce((m, x) => m + x.totalCents, 0), 0);
  const subtotal = sum + (serviceType === 'LVR' ? o.delivery ?? 0 : 0) + (o.serviceFee ?? 0) - (o.discount ?? 0);
  const model = channel === 'clover_pos' ? 'pos' : ['website', 'phone', 'storefront'].includes(channel) ? 'direct' : 'stored';
  return {
    schema: 'foodhub.sale.v1',
    tenantId: 'takatak',
    locationId: 'E2E_A',
    saleKey: `fh:takatak:${model}:${channel}:ORDER-1`,
    occurredAt: '2026-10-24T23:30:00-04:00',
    source: { model, channel, orderId: 'ORDER-1', displayId: 'A1B2', brand: 'Démo' },
    serviceType,
    ecommerce: false,
    lines,
    fees: { deliveryCents: o.delivery ?? 0, serviceFeeCents: o.serviceFee ?? 0 },
    discountCents: o.discount ?? 0,
    amounts: { subtotalCents: subtotal, gstCents: tpsOf(subtotal), qstCents: tvqOf(subtotal), totalCents: subtotal + tpsOf(subtotal) + tvqOf(subtotal), tipCents: o.tip ?? 0 },
    payment: { mode: 'AUT', collectedBy: 'platform' },
    ...o,
  } as FoodHubSaleV1;
}

describe('foodhub.sale.v1 → SEV transaction (mapper fixtures per channel)', () => {
  it('Clover register sale (model pos, clover_pos): counter, Clover tender, tip as pourb', () => {
    const s = sale('clover_pos', 'CMP', { tip: 200, payment: { mode: 'DEB', collectedBy: 'clover_tender' } });
    validateSale(s, 'takatak');
    const m = mapSale(s);
    expect(m.draft.typServ).toBe('CMP');
    expect(m.draft.modPai).toBe('DEB');
    expect(m.draft.tipCents).toBe(200);
  });

  it('clover_pos only with model pos, and model pos only with clover_pos', () => {
    const wrongModel = sale('clover_pos', 'CMP');
    wrongModel.source = { ...wrongModel.source, model: 'direct' };
    expect(() => validateSale(wrongModel, 'takatak')).toThrow(ContractError);
    const wrongChannel = sale('phone', 'CMP');
    wrongChannel.source = { ...wrongChannel.source, model: 'pos' };
    expect(() => validateSale(wrongChannel, 'takatak')).toThrow(ContractError);
  });

  it('Uber Eats delivery: LVT, courier tip and platform delivery fee excluded', () => {
    const s = sale('uber_eats', 'LVT', { tip: 300, delivery: 399 });
    validateSale(s, 'takatak');
    const m = mapSale(s);
    expect(m.draft.typServ).toBe('LVT');
    expect(m.draft.tipCents).toBeNull();
    expect(m.warnings).toEqual(expect.arrayContaining(['tipExcluded', 'deliveryFeeExcluded']));
    expect(m.draft.lines.some((l) => /livraison/i.test(l.description))).toBe(false);
    expect(m.draft.modPai).toBe('AUT');
    expect(m.draft.ecommerce).toBe(false);
    expect(m.externalRef).toBe('Démo #A1B2');
  });

  it('DoorDash pickup with a restaurant promo: negative discount line inside avantTax', () => {
    const s = sale('doordash', 'LVT', { discount: 300, lines: [{ description: 'Poutine', quantity: '1', unitPriceCents: 1299, totalCents: 1299, taxCode: 'FP', activity: 'RES' }, { description: 'Burger', quantity: '1', unitPriceCents: 1599, totalCents: 1599, taxCode: 'FP', activity: 'RES' }] });
    validateSale(s, 'takatak');
    const m = mapSale(s);
    const t = saleTotals(m.draft);
    expect(t.subtotalCents).toBe(2598);
    expect(m.draft.lines.at(-1)).toMatchObject({ description: 'Rabais', totalCents: -300 });
    expect(t.taxGap).toBe(false);
  });

  it('Skip (failed order recovered): taxes as computed by Food Hub, no gap', () => {
    const s = sale('skip', 'LVT');
    validateSale(s, 'takatak');
    expect(saleTotals(mapSale(s).draft).taxGap).toBe(false);
  });

  it('Skip with tax left at 0 on a taxable order → taxGap flagged', () => {
    const s = sale('skip', 'LVT');
    s.amounts = { ...s.amounts, gstCents: 0, qstCents: 0, totalCents: s.amounts.subtotalCents };
    validateSale(s, 'takatak');
    expect(saleTotals(mapSale(s).draft).taxGap).toBe(true);
  });

  it('Too Good To Go bag sold through the platform: LVT', () => {
    const s = sale('tgtg', 'LVT', { lines: [{ description: 'Panier surprise', quantity: '1', unitPriceCents: 599, totalCents: 599, taxCode: 'FP', activity: 'RES' }] });
    validateSale(s, 'takatak');
    expect(mapSale(s).draft.typServ).toBe('LVT');
  });

  it('phone pickup paid cash at the counter: CMP, ARG, pourb kept', () => {
    const s = sale('phone', 'CMP', { tip: 200, payment: { mode: 'ARG', collectedBy: 'cash' } });
    validateSale(s, 'takatak');
    const m = mapSale(s);
    expect(m.draft).toMatchObject({ typServ: 'CMP', modPai: 'ARG', tipCents: 200, ecommerce: false });
  });

  it('website own delivery paid online: LVR, delivery fee line, commerElectr O, CRE', () => {
    const s = sale('website', 'LVR', { delivery: 499, ecommerce: true, payment: { mode: 'CRE', collectedBy: 'paylink' } });
    validateSale(s, 'takatak');
    const m = mapSale(s);
    expect(m.draft).toMatchObject({ typServ: 'LVR', ecommerce: true, modPai: 'CRE' });
    expect(m.draft.lines.at(-1)).toMatchObject({ description: 'Frais de livraison', totalCents: 499, tax: 'FP' });
  });

  it('storefront $0 order: payment forced to AUC', () => {
    const s = sale('storefront', 'CMP', { lines: [{ description: 'Café offert', quantity: '1', unitPriceCents: 0, totalCents: 0, taxCode: 'FP', activity: 'RES' }], payment: { mode: 'CRE', collectedBy: 'clover_tender' } });
    validateSale(s, 'takatak');
    const m = mapSale(s);
    expect(m.draft.modPai).toBe('AUC');
    expect(m.warnings).toContain('paymentModeAUC');
  });

  it('modifiers become their own lines with the parent tax code', () => {
    const s = sale('uber_eats', 'LVT', { lines: [{ description: 'Trio', quantity: '1', unitPriceCents: 1899, totalCents: 1899, taxCode: 'FP', activity: 'RES', modifiers: [{ description: 'Sauce', quantity: '1', unitPriceCents: 50, totalCents: 50 }] }] });
    validateSale(s, 'takatak');
    expect(mapSale(s).draft.lines[1]).toMatchObject({ description: 'Sauce', isModifier: true, tax: 'FP', totalCents: 50 });
  });

  it('testMode → modTrans FOR', () => {
    const s = sale('phone', 'CMP', { testMode: true, payment: { mode: 'DEB', collectedBy: 'clover_tender' } });
    validateSale(s, 'takatak');
    expect(mapSale(s).draft.modTrans).toBe('FOR');
  });
});

describe('contract validation', () => {
  it('lists every invalid field', () => {
    try {
      validateSale({ schema: 'foodhub.sale.v1', tenantId: 'takatak', lines: [] } as unknown as FoodHubSaleV1, 'takatak');
      throw new Error('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ContractError);
      const fields = (e as ContractError).errors.map((x) => x.field);
      expect(fields).toEqual(expect.arrayContaining(['locationId', 'saleKey', 'occurredAt', 'serviceType', 'lines', 'payment.mode']));
    }
  });

  it('total must equal subtotal + taxes exactly (tip excluded)', () => {
    const s = sale('phone', 'CMP', { tip: 200, payment: { mode: 'ARG', collectedBy: 'cash' } });
    s.amounts.totalCents += 200;
    expect(() => validateSale(s, 'takatak')).toThrow(ContractError);
  });

  it('subtotal must match lines + restaurant fees − discount', () => {
    const s = sale('website', 'LVR', { delivery: 499, ecommerce: true, payment: { mode: 'CRE', collectedBy: 'paylink' } });
    s.amounts.subtotalCents -= 499;
    s.amounts.totalCents = s.amounts.subtotalCents + s.amounts.gstCents + s.amounts.qstCents;
    validateSale(s, 'takatak');
    expect(() => mapSale(s)).toThrow(ContractError);
  });

  it('tenant must match the signed header; keys must extend the saleKey', () => {
    expect(() => validateSale(sale('phone', 'CMP'), 'other-tenant')).toThrow(ContractError);
    const key = 'fh:takatak:stored:uber_eats:ORDER-1';
    expect(() => validateCredit({ schema: 'foodhub.credit.v1', tenantId: 'takatak', creditKey: 'other:cn:1', reason: 'refund', full: true }, 'takatak', key)).toThrow(ContractError);
    expect(() => validateCredit({ schema: 'foodhub.credit.v1', tenantId: 'takatak', creditKey: `${key}:cn:1`, reason: 'refund', full: true }, 'takatak', key)).not.toThrow();
    expect(() => validatePrint({ schema: 'foodhub.print.v1', tenantId: 'takatak', printKey: `${key}:pr:1`, mode: 'DUP' }, 'takatak', key)).not.toThrow();
  });

  it('payloadHash ignores key order and the payloadHash field itself', () => {
    const a = { b: 1, a: { y: 2, x: [1, { d: 4, c: 3 }] } };
    const b = { a: { x: [1, { c: 3, d: 4 }], y: 2 }, b: 1, payloadHash: 'whatever' };
    expect(payloadHashOf(a)).toBe(payloadHashOf(b));
    expect(payloadHashOf(a)).not.toBe(payloadHashOf({ ...a, b: 2 }));
  });
});
