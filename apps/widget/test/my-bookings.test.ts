import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_SAVED, bookAgainUrl, googleCalendarUrl, masters, split, upsert, type SavedBooking } from '../lib/my-bookings';

const entry = (token: string, slug: string, startsAt: string, status = 'confirmed'): SavedBooking => ({
  token,
  slug,
  staffName: slug,
  serviceId: `s-${slug}`,
  variantId: `v-${slug}`,
  service: { pl: 'Manicure' },
  variant: {},
  startsAt,
  endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
  status,
  timeZone: 'Europe/Warsaw',
});

describe('«Мои записи» на телефоне (D-069)', () => {
  test('обновление по токену, замена перенесённой записи, ограничение размера', () => {
    let list = upsert([], entry('a', 'ola', '2030-07-01T08:00:00.000Z'));
    list = upsert(list, entry('a', 'ola', '2030-07-01T08:00:00.000Z', 'cancelled_by_client'));
    assert.deepEqual(list.map((b) => [b.token, b.status]), [['a', 'cancelled_by_client']]);
    list = upsert(list, entry('b', 'ola', '2030-07-03T08:00:00.000Z'), 'a');
    assert.deepEqual(list.map((b) => b.token), ['b'], 'перенос: старая ссылка заменена новой');
    for (let i = 0; i < MAX_SAVED + 5; i += 1) list = upsert(list, entry(`t${i}`, 'ewa', new Date(Date.UTC(2031, 0, 1 + i)).toISOString()));
    assert.equal(list.length, MAX_SAVED);
  });

  test('ближайшие и прошлые, мастера по одному с последней записью', () => {
    const now = new Date('2030-07-02T12:00:00Z');
    const list = [
      entry('past', 'ola', '2030-06-01T08:00:00.000Z', 'completed'),
      entry('soon', 'ola', '2030-07-05T08:00:00.000Z'),
      entry('sooner', 'ewa', '2030-07-03T08:00:00.000Z', 'pending'),
      entry('cancelled', 'ewa', '2030-07-10T08:00:00.000Z', 'cancelled_by_client'),
    ];
    const { upcoming, past } = split(list, now);
    assert.deepEqual(upcoming.map((b) => b.token), ['sooner', 'soon']);
    assert.deepEqual(past.map((b) => b.token), ['cancelled', 'past']);
    assert.deepEqual(masters(list).map((b) => [b.slug, b.token]), [['ewa', 'cancelled'], ['ola', 'soon']]);
  });

  test('ссылки: записаться снова и Google Календарь в UTC', () => {
    assert.equal(bookAgainUrl({ slug: 'ola', serviceId: 's1', variantId: 'v1' }, 'uk'), '/ola?service=s1&variant=v1&lang=uk');
    const url = new URL(googleCalendarUrl('Manicure · Ola', '2030-07-02T08:00:00.000Z', '2030-07-02T09:30:00.000Z', 'https://x/b/t'));
    assert.equal(url.hostname, 'calendar.google.com');
    assert.equal(url.searchParams.get('dates'), '20300702T080000Z/20300702T093000Z');
    assert.equal(url.searchParams.get('text'), 'Manicure · Ola');
  });
});
