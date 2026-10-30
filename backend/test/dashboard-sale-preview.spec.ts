import { computeTaxes, lineTotal, TaxCode } from '../src/common/money';

// Exercise the actual frontend helper without adding a frontend test runner or moving production code across roots.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { salePreview } = require('../../frontend/src/lib/sale-preview') as {
  salePreview: (items: Array<{ quantity: number; unitPrice: number; taxCode: string }>, tip?: number) => {
    subtotalCents: number; tpsCents: number; tvqCents: number; totalCents: number;
  };
};

describe('dashboard preview agrees with the amount the backend will invoice', () => {
  it.each([
    [{ quantity: 1, unitPrice: 0.1, taxCode: 'FP' }],
    [{ quantity: 0.5, unitPrice: 0.03, taxCode: 'FP' }, { quantity: 1.333, unitPrice: 12.99, taxCode: 'F' }],
    [{ quantity: 3, unitPrice: 1.01, taxCode: 'P' }, { quantity: 2.5, unitPrice: 8.99, taxCode: 'NON' }],
  ])('rounds line amounts and tax bases the same way (%j)', (...items) => {
    const lines = items.map((i) => ({ totalCents: lineTotal(Math.round(i.unitPrice * 100), String(i.quantity)), tax: i.taxCode as TaxCode }));
    const result = computeTaxes(lines);
    expect(salePreview(items)).toEqual({ subtotalCents: result.subtotalCents, tpsCents: result.tpsCents, tvqCents: result.tvqCents, totalCents: result.totalCents });
    expect(salePreview(items, 2).totalCents).toBe(result.totalCents + 200);
  });
});
