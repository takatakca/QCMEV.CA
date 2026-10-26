import { classifyErrors } from '../src/mev-web/mev-web.types';
import { assertSaleRules, SaleDraft, SaleLine, SaleRuleError, saleTotals } from '../src/transactions/trans-builder';

const burger: SaleLine = { description: 'Burger', quantity: '1', unitPriceCents: 1500, totalCents: 1500, tax: 'FP', activity: 'RES' };
const base = (o: Partial<SaleDraft> = {}): SaleDraft => ({
  documentKind: 'RECEIPT', typTrans: 'RFER', modImpr: 'FAC', formImpr: 'PAP', modTrans: 'OPE', typServ: 'CMP', ecommerce: false, modPai: 'CRE',
  lines: [burger],
  ...o,
});
const check = (d: SaleDraft) => assertSaleRules(d, saleTotals(d));

describe('sale rules (public Revenu Québec rules + contract)', () => {
  it('accepts a normal sale', () => expect(() => check(base())).not.toThrow());

  it('refuses cash or cheque for e-commerce (commerElectr O)', () => {
    expect(() => check(base({ ecommerce: true, modPai: 'ARG' }))).toThrow(SaleRuleError);
    expect(() => check(base({ ecommerce: true, modPai: 'CHQ' }))).toThrow(SaleRuleError);
    expect(() => check(base({ ecommerce: true, modPai: 'CRE' }))).not.toThrow();
  });

  it('a $0 receipt must use AUC', () => {
    const zero: SaleLine[] = [{ ...burger, description: 'Café offert', unitPriceCents: 0, totalCents: 0 }];
    expect(() => check(base({ lines: zero, modPai: 'ARG' }))).toThrow(SaleRuleError);
    expect(() => check(base({ lines: zero, modPai: 'AUC' }))).not.toThrow();
  });

  it('INC only with a bar item', () => {
    expect(() => check(base({ modPai: 'INC' }))).toThrow(SaleRuleError);
    expect(() => check(base({ modPai: 'INC', lines: [{ ...burger, description: 'Bière', activity: 'BAR' }] }))).not.toThrow();
  });

  it('a credit note must be negative; a receipt cannot be', () => {
    const neg: SaleLine[] = [{ ...burger, unitPriceCents: -1500, totalCents: -1500 }];
    expect(() => check(base({ documentKind: 'CREDIT_NOTE' }))).toThrow(SaleRuleError);
    expect(() => check(base({ documentKind: 'CREDIT_NOTE', lines: neg }))).not.toThrow();
    expect(() => check(base({ lines: neg }))).toThrow(SaleRuleError);
  });

  it('a platform courier tip is never transmitted (LVT)', () => {
    expect(() => check(base({ typServ: 'LVT', tipCents: 300 }))).toThrow(SaleRuleError);
    expect(() => check(base({ typServ: 'CMP', tipCents: 300 }))).not.toThrow();
  });

  it('the tip stays outside apresTax', () => {
    expect(saleTotals(base({ tipCents: 300 })).totalCents).toBe(1500 + 75 + 150);
  });

  it('taxGap when the charged taxes differ from the computed ones by more than 1 cent', () => {
    expect(saleTotals(base({ taxOverride: { tpsCents: 76, tvqCents: 149 } })).taxGap).toBe(false);
    expect(saleTotals(base({ taxOverride: { tpsCents: 0, tvqCents: 0 } })).taxGap).toBe(true);
  });
});

describe('MEV error classes (codRetour)', () => {
  it('no error → accepted', () => expect(classifyErrors([])).toBe('accepted'));
  it('codRetour ending in 0, 1 or 5 → resend in a batch', () => {
    expect(classifyErrors([{ id: 'a', mess: 'x', codRetour: '95' }])).toBe('retry_batch');
    expect(classifyErrors([{ id: 'a', mess: 'x', codRetour: '90' }, { id: 'b', mess: 'y', codRetour: '91' }])).toBe('retry_batch');
  });
  it('any other code → rejected', () => {
    expect(classifyErrors([{ id: 'a', mess: 'x', codRetour: '92' }])).toBe('rejected');
    expect(classifyErrors([{ id: 'a', mess: 'x', codRetour: '95' }, { id: 'b', mess: 'y', codRetour: '93' }])).toBe('rejected');
  });
});
