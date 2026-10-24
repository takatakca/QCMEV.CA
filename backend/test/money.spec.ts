import { computeTaxes, lineTotal, mevAmount, receiptAmount, tpsOf, tvqOf } from '../src/common/money';

describe('money: TPS / TVQ rounded half-up, each on its own', () => {
  it.each([
    [1000, 50, 100], // 10.00 → 0.50 / 0.9975 → 1.00
    [2598, 130, 259], // 25.98 → 1.299 → 1.30 / 2.591505 → 2.59
    [2449, 122, 244], // 24.49 → 1.2245 → 1.22 / 2.4428775 → 2.44
    [10, 1, 1], // 0.10 → 0.005 → 0.01 (half-up) / 0.009975 → 0.01
    [30, 2, 3], // 0.30 → 0.015 → 0.02 / 0.029925 → 0.03
    [2000, 100, 200], // 20.00 → 1.00 / 1.995 → 2.00 (half-up)
    [0, 0, 0],
  ])('base %i ¢ → TPS %i ¢, TVQ %i ¢', (base, tps, tvq) => {
    expect(tpsOf(base)).toBe(tps);
    expect(tvqOf(base)).toBe(tvq);
  });

  it('credit notes round half away from zero (exact negatives of the sale)', () => {
    expect(tpsOf(-2598)).toBe(-130);
    expect(tvqOf(-2598)).toBe(-259);
    expect(tvqOf(-2000)).toBe(-200);
  });

  it('apresTax = avantTax + TPS + TVQ exactly, per tax code', () => {
    const r = computeTaxes([
      { totalCents: 1000, tax: 'FP' },
      { totalCents: 500, tax: 'F' },
      { totalCents: 300, tax: 'P' },
      { totalCents: 200, tax: 'NON' },
    ]);
    expect(r.subtotalCents).toBe(2000);
    expect(r.tpsBaseCents).toBe(1500);
    expect(r.tvqBaseCents).toBe(1300);
    expect(r.tpsCents).toBe(75);
    expect(r.tvqCents).toBe(130); // 1.296750 → 1.30
    expect(r.totalCents).toBe(r.subtotalCents + r.tpsCents + r.tvqCents);
  });

  it('line totals with decimal quantities', () => {
    expect(lineTotal(1299, '2')).toBe(2598);
    expect(lineTotal(999, '0.5')).toBe(500); // 4.995 → 5.00
    expect(lineTotal(1000, '1.333')).toBe(1333);
    expect(() => lineTotal(100, '0')).toThrow();
    expect(() => lineTotal(100, '1.2345')).toThrow();
  });

  it('formats amounts for MEV-WEB and for the receipt', () => {
    expect(mevAmount(123456)).toBe('1234.56');
    expect(mevAmount(-5)).toBe('-0.05');
    expect(mevAmount(0)).toBe('0.00');
    expect(receiptAmount(2815)).toBe('28,15 $');
  });

  it('refuses non-integer cents', () => {
    expect(() => tpsOf(10.5)).toThrow(RangeError);
  });
});
