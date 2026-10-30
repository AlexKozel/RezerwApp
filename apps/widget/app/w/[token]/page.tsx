import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { serverGet, type WaitlistView } from '../../../lib/api';
import { pickLocale } from '../../../lib/locale';
import { LanguageSwitch } from '../../LanguageSwitch';
import { WaitlistEntry } from './WaitlistEntry';

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Место в листе ожидания по ссылке из подтверждения (D-068): статус, действующее предложение, выход. */
export default async function WaitlistPage({ params, searchParams }: Props) {
  const { token } = await params;
  const h = await headers();
  const locale = pickLocale((await searchParams).lang, h.get('accept-language'));
  if (!/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) notFound();
  const res = await serverGet<WaitlistView>(`/public/waitlist/${token}`, h.get('x-forwarded-for'));
  if (res.status === 404) notFound();
  if (!res.ok || !res.data) throw new Error(`waitlist: ${res.status}`);
  return (
    <main lang={locale}>
      <LanguageSwitch path={`/w/${token}`} current={locale} />
      <WaitlistEntry token={token} entry={res.data} locale={locale} />
    </main>
  );
}
