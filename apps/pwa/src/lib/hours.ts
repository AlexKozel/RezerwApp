/** Интервал графика в формате API: weekday 0 = воскресенье … 6 = суббота, время HH:MM. */
export interface ApiInterval {
  weekday: number;
  start: string;
  end: string;
}

/** Строка редактора недели. Неделя в интерфейсе начинается с понедельника, как принято в Польше. */
export interface DayRow {
  weekday: number;
  open: boolean;
  start: string;
  end: string;
  /** У дня в API несколько интервалов (например, перерыв): простой редактор покажет их одним, сохранит как один. */
  merged: boolean;
}

export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const DEFAULT_START = '09:00';
const DEFAULT_END = '18:00';

export function toRows(intervals: ApiInterval[]): DayRow[] {
  return WEEK_ORDER.map((weekday) => {
    const day = intervals.filter((i) => i.weekday === weekday).sort((a, b) => a.start.localeCompare(b.start));
    if (day.length === 0) return { weekday, open: false, start: DEFAULT_START, end: DEFAULT_END, merged: false };
    return { weekday, open: true, start: day[0]!.start, end: day[day.length - 1]!.end, merged: day.length > 1 };
  });
}

export function toIntervals(rows: DayRow[]): ApiInterval[] {
  return rows.filter((r) => r.open).map((r) => ({ weekday: r.weekday, start: r.start, end: r.end }));
}

/** Ошибки редактора: конец не позже начала. */
export function invalidRows(rows: DayRow[]): number[] {
  return rows.filter((r) => r.open && !(r.start < r.end)).map((r) => r.weekday);
}
