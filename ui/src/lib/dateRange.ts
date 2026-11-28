export interface DateRange {
  startDate?: string;
  endDate?: string;
}

function getLocalDayBoundary(date: string, endOfDay: boolean): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;

  const [, year, month, day] = match;
  const value = new Date(Number(year), Number(month) - 1, Number(day));
  if (
    value.getFullYear() !== Number(year) ||
    value.getMonth() !== Number(month) - 1 ||
    value.getDate() !== Number(day)
  ) {
    return null;
  }

  if (endOfDay) value.setHours(23, 59, 59, 999);
  return value.getTime();
}

export function isTimestampInDateRange(
  timestamp: string | number,
  { startDate = '', endDate = '' }: DateRange,
): boolean {
  const timestampValue =
    typeof timestamp === 'number'
      ? timestamp
      : Date.parse(timestamp.trim().replace(' ', 'T'));
  if (!Number.isFinite(timestampValue)) return false;

  const start = startDate ? getLocalDayBoundary(startDate, false) : null;
  const end = endDate ? getLocalDayBoundary(endDate, true) : null;
  if ((startDate && start === null) || (endDate && end === null)) return false;
  if (start !== null && end !== null && start > end) return false;

  return (start === null || timestampValue >= start) &&
    (end === null || timestampValue <= end);
}
