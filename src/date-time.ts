/** Calendar operations stay in local time; UTC is only used at the export boundary. */
export const twoDigits = (value: number) => String(value).padStart(2, '0');

export function calendarDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
}

export function parseCalendarDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(12, 0, 0, 0);
  return calendarDate(date) === value ? date : null;
}

export function moveCalendarDate(value: string, days: number): string {
  const date = parseCalendarDate(value)!;
  date.setDate(date.getDate() + days);
  return calendarDate(date);
}

export function moveCalendarMonth(value: string, months: number): string {
  const date = parseCalendarDate(value)!;
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, last));
  return calendarDate(date);
}

export function calendarDays(month: string): string[] {
  const first = `${month.slice(0, 7)}-01`;
  const weekday = (parseCalendarDate(first)!.getDay() + 6) % 7;
  return Array.from({length: 42}, (_, index) => moveCalendarDate(first, index - weekday));
}

export function localDateTime(date: string, time: string): Date | null {
  if (!parseCalendarDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const result = parseCalendarDate(date)!;
  const [hours, minutes] = time.split(':').map(Number);
  result.setHours(hours, minutes, 0, 0);
  // Reject nonexistent local times instead of silently shifting a user's range.
  return calendarDate(result) === date && result.getHours() === hours && result.getMinutes() === minutes ? result : null;
}
