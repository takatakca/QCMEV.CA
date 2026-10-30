/** Preview in integer cents, with the same line and tax rounding as the backend. */
export function salePreview(items: Array<{ quantity: number; unitPrice: number; taxCode: string }>, tip = 0) {
  let subtotal = 0;
  let tpsBase = 0;
  let tvqBase = 0;
  for (const item of items) {
    const unitCents = Math.round(Number(item.unitPrice) * 100);
    const thousandths = Math.round(Number(item.quantity) * 1000);
    if (!Number.isSafeInteger(unitCents) || !Number.isSafeInteger(thousandths) || unitCents < 0 || thousandths < 0) continue;
    const cents = Math.floor((unitCents * thousandths + 500) / 1000);
    subtotal += cents;
    if (item.taxCode === 'FP' || item.taxCode === 'F') tpsBase += cents;
    if (item.taxCode === 'FP' || item.taxCode === 'P') tvqBase += cents;
  }
  const tps = Math.floor((tpsBase * 5 + 50) / 100);
  const tvq = Math.floor((tvqBase * 9975 + 50000) / 100000);
  const tips = Number.isFinite(tip) ? Math.round(tip * 100) : 0;
  return { subtotalCents: subtotal, tpsCents: tps, tvqCents: tvq, totalCents: subtotal + tps + tvq + tips };
}
