import { civilTime, displayDatTrans } from '../src/common/time';

describe('civil date and time in America/Montreal', () => {
  it('23:30 local in summer (EDT) is still the local day, utc -04:00', () => {
    const t = civilTime(new Date('2026-10-25T03:30:00Z'));
    expect(t.civilDate).toBe('20261024');
    expect(t.datTrans).toBe('20261024233000');
    expect(t.utc).toBe('-04:00');
    expect(t.iso).toBe('2026-10-24T23:30:00-04:00');
  });

  it('23:30 local in winter (EST) → utc -05:00', () => {
    const t = civilTime(new Date('2026-01-15T04:30:00Z'));
    expect(t.civilDate).toBe('20260114');
    expect(t.datTrans).toBe('20260114233000');
    expect(t.utc).toBe('-05:00');
  });

  it('just after midnight local is the new day even though UTC is the same day', () => {
    const t = civilTime(new Date('2026-07-01T04:05:06Z'));
    expect(t.datTrans).toBe('20260701000506');
  });

  it('switches offset at the DST change (2026-11-01 02:00 EDT → 01:00 EST)', () => {
    expect(civilTime(new Date('2026-11-01T05:59:59Z')).utc).toBe('-04:00');
    expect(civilTime(new Date('2026-11-01T06:00:00Z')).utc).toBe('-05:00');
  });

  it('displays datTrans', () => {
    expect(displayDatTrans('20261024233000')).toBe('2026-10-24 23:30:00');
  });
});
