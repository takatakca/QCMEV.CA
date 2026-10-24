/**
 * Civil date and time in America/Montreal (PROVEN: datTrans AAAAMMJJhhmmss in local time, plus the utc offset).
 * A sale at 23:30 local time belongs to that local day even though it is already the next day in UTC.
 */

export const TIME_ZONE = 'America/Montreal';

export interface CivilTime {
  /** AAAAMMJJ */
  civilDate: string;
  /** AAAAMMJJhhmmss */
  datTrans: string;
  /** -04:00 (EDT) or -05:00 (EST) */
  utc: string;
  /** ISO-8601 with offset, e.g. 2026-10-24T23:30:00-04:00 */
  iso: string;
}

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function civilTime(at: Date = new Date()): CivilTime {
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(at)) parts[p.type] = p.value;
  const { year, month, day, hour, minute, second } = parts;
  const wallAsUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  const offsetMin = Math.round((wallAsUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  const utc = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  const civilDate = `${year}${month}${day}`;
  return {
    civilDate,
    datTrans: `${civilDate}${hour}${minute}${second}`,
    utc,
    iso: `${year}-${month}-${day}T${hour}:${minute}:${second}${utc}`,
  };
}

/** "2026-10-24 23:30:00" from AAAAMMJJhhmmss */
export function displayDatTrans(datTrans: string): string {
  const d = datTrans;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${d.slice(8, 10)}:${d.slice(10, 12)}:${d.slice(12, 14)}`;
}
