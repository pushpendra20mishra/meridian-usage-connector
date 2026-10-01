export class InvalidPeriod extends Error {}

export interface DateRange {
  start: string;
  endExclusive: string;
  partial: boolean;
}

const DAY = 86_400_000;
const WEEK = /^(\d{4})-W(\d{2})$/;
const MONTH = /^(\d{4})-(\d{2})$/;

const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => fromMs(toMs(d) + n * DAY);

function isoWeekMonday(year: number, week: number): string {
  const jan4 = toMs(`${year}-01-04`);
  const dow = new Date(jan4).getUTCDay() || 7;
  return fromMs(jan4 - (dow - 1) * DAY + (week - 1) * 7 * DAY);
}

export function isoWeekLabel(date: string): string {
  const ms = toMs(date);
  const dow = new Date(ms).getUTCDay() || 7;
  const thursday = new Date(ms + (4 - dow) * DAY); // iso year follows the thursday
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - toMs(`${year}-01-01`)) / DAY / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function weekStart(label: string): string {
  const m = WEEK.exec(label);
  if (!m) throw new InvalidPeriod(`invalid ISO week ${JSON.stringify(label)}`);
  return isoWeekMonday(Number(m[1]), Number(m[2]));
}

function bounds(period: string, dataEnd: string): [string, string] {
  if (period === "last_7_days" || period === "last_30_days") {
    return [addDays(dataEnd, period === "last_7_days" ? -7 : -30), dataEnd];
  }
  let m = WEEK.exec(period);
  if (m) {
    const start = isoWeekMonday(Number(m[1]), Number(m[2]));
    // W53 only exists in some years
    if (isoWeekLabel(start) !== period) throw new InvalidPeriod(`invalid ISO week ${JSON.stringify(period)}`);
    return [start, addDays(start, 7)];
  }
  m = MONTH.exec(period);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) throw new InvalidPeriod(`invalid month ${JSON.stringify(period)}`);
    const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
    return [`${year}-${String(month).padStart(2, "0")}-01`, next];
  }
  throw new InvalidPeriod(
    `unrecognised period ${JSON.stringify(period)}: use last_7_days, last_30_days, an ISO week (2026-W36) or a month (2026-09)`,
  );
}

// last_N_days counts back from the end of the data, not from today
export function parsePeriod(period: string, dataEndExclusive: string): DateRange {
  const [start, endExclusive] = bounds(period, dataEndExclusive);
  return { start, endExclusive, partial: endExclusive > dataEndExclusive };
}
