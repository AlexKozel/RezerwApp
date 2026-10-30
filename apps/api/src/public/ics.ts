/**
 * Файл календаря (RFC 5545) для «Добавить в календарь» после записи: Apple Календарь, Outlook, Google.
 * Время в UTC (суффикс Z), поэтому пояс телефона клиента не важен; строки через CRLF, длинные строки
 * переносятся по 75 байт (продолжение начинается с пробела), текст экранируется.
 */
export interface CalendarEvent {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  description: string;
  url?: string;
  /** pending: заявка ждёт мастера (TENTATIVE), confirmed: подтверждена. */
  tentative: boolean;
  now?: Date;
}

function stamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Перенос строки длиннее 75 байт UTF-8, не разрывая многобайтовые символы. */
export function fold(line: string): string {
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    const limit = parts.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

export function buildIcs(event: CalendarEvent): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//RezerwApp//PL',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${stamp(event.now ?? new Date())}`,
    `DTSTART:${stamp(event.start)}`,
    `DTEND:${stamp(event.end)}`,
    `SUMMARY:${escapeText(event.summary)}`,
    `DESCRIPTION:${escapeText(event.description)}`,
    ...(event.url ? [`URL:${event.url}`] : []),
    `STATUS:${event.tentative ? 'TENTATIVE' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}
