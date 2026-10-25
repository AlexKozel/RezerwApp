import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { serverGet, type ManagedBooking } from '../../../lib/api';
import { pickLocale } from '../../../lib/locale';
import { LanguageSwitch } from '../../LanguageSwitch';
import { ManageBooking } from './ManageBooking';

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Страница управления записью по ссылке из подтверждения и напоминаний (D-051). */
export default async function ManagePage({ params, searchParams }: Props) {
  const { token } = await params;
  const h = await headers();
  const locale = pickLocale((await searchParams).lang, h.get('accept-language'));
  if (!/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) notFound();
  // IP клиента передаётся API для лимитов частоты (TRUST_PROXY на стороне API).
  const res = await serverGet<ManagedBooking>(`/public/bookings/${token}`, h.get('x-forwarded-for'));
  if (res.status === 404) notFound();
  if (!res.ok || !res.data) throw new Error(`manage: ${res.status}`);
  // Старая ссылка после переноса ведёт на новую запись.
  if (res.data.rescheduledToToken) redirect(`/b/${res.data.rescheduledToToken}?lang=${locale}`);
  return (
    <main lang={locale}>
      <LanguageSwitch path={`/b/${token}`} current={locale} />
      <ManageBooking token={token} booking={res.data} locale={locale} />
    </main>
  );
}
