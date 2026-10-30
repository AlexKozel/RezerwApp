import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildIcs, escapeText, fold } from '../src/public/ics';

describe('файл календаря (.ics)', () => {
  test('экранирование текста и перенос длинных строк по 75 байт без разрыва символов', () => {
    // Вход: a;b,c\d<перевод строки>e. Выход: каждый спецсимвол с обратной косой чертой, перевод строки как \n.
    assert.equal(escapeText('a;b,c\\d\ne'), 'a\\;b\\,c\\\\d\\ne');
    const long = `SUMMARY:${'ż'.repeat(60)}`;
    const folded = fold(long);
    for (const line of folded.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
    assert.equal(folded.split('\r\n').map((l, i) => (i === 0 ? l : l.slice(1))).join(''), long, 'склейка возвращает исходную строку');
  });

  test('событие в UTC, CRLF, статус по заявке', () => {
    const ics = buildIcs({
      uid: 'b1@rezerwapp',
      start: new Date('2030-07-02T08:00:00Z'),
      end: new Date('2030-07-02T09:30:00Z'),
      summary: 'Manicure · Anna',
      description: 'https://example.pl/b/x',
      url: 'https://example.pl/b/x',
      tentative: true,
      now: new Date('2030-07-01T10:00:00.123Z'),
    });
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
    for (const line of ['DTSTART:20300702T080000Z', 'DTEND:20300702T093000Z', 'DTSTAMP:20300701T100000Z', 'SUMMARY:Manicure · Anna', 'STATUS:TENTATIVE']) {
      assert.ok(ics.includes(`\r\n${line}\r\n`), line);
    }
  });
});
