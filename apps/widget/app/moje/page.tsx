import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { pickLocale } from '../../lib/locale';
import { LanguageSwitch } from '../LanguageSwitch';
import { MyBookings } from './MyBookings';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export const metadata: Metadata = { title: 'RezerwApp', robots: { index: false, follow: false } };

/** «Мои записи» (D-069): список целиком в браузере клиента, сервер его не видит. */
export default async function MyPage({ searchParams }: Props) {
  const locale = pickLocale((await searchParams).lang, (await headers()).get('accept-language'));
  return (
    <main lang={locale}>
      <LanguageSwitch path="/moje" current={locale} />
      <MyBookings locale={locale} />
    </main>
  );
}
