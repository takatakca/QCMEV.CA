/**
 * Québec local date/time helpers for MEV-WEB.
 *
 * The civil date (dateCivile) and start time (heureDebut) are LOCAL Québec
 * values. Never use toISOString() (UTC) or toTimeString() (container TZ,
 * usually UTC in Docker): a sale at 21:00 EDT would get tomorrow's date.
 */

export const MEV_TIMEZONE = 'America/Toronto'; // Québec (Montréal) local time, DST-aware

function parts(date: Date): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: MEV_TIMEZONE,
    year:     'numeric',
    month:    '2-digit',
    day:      '2-digit',
    hour:     '2-digit',
    minute:   '2-digit',
    second:   '2-digit',
    hourCycle: 'h23',
  });
  return Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
}

/** YYYYMMDD in Québec local time */
export function quebecCivilDate(date: Date = new Date()): string {
  const p = parts(date);
  return `${p.year}${p.month}${p.day}`;
}

/** HHMMSS (24h) in Québec local time */
export function quebecTime(date: Date = new Date()): string {
  const p = parts(date);
  return `${p.hour}${p.minute}${p.second}`;
}

/** Calendar year in Québec local time (for annual reports) */
export function quebecYear(date: Date = new Date()): number {
  return Number(parts(date).year);
}
