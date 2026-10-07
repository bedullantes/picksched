/* Date and money helpers. Dates are 'YYYY-MM-DD' strings in the facility's time zone. */

export const DEFAULT_TIMEZONE = 'Asia/Manila';

export function todayIn(timeZone: string, now = new Date()): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

export function formatTimeRange(start: string, end: string, timeZone: string): string {
  return `${formatTime(start, timeZone)} – ${formatTime(end, timeZone)}`;
}

/** 24h "HH:MM" key for lining slots up in rows. */
export function timeKey(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(iso));
}

export function formatDate(date: string, style: 'long' | 'short' = 'long'): string {
  const d = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-US', style === 'long'
    ? { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }
    : { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(d);
}

export function formatMoney(centavos: number, currency = 'PHP'): string {
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency, maximumFractionDigits: centavos % 100 ? 2 : 0 })
    .format(centavos / 100);
}

export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hour${h > 1 ? 's' : ''}`;
}
