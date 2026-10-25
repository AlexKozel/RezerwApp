import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { serverGet, type PublicProfile } from '../../lib/api';
import { pickLocale } from '../../lib/locale';
import { LanguageSwitch } from '../LanguageSwitch';
import { BookingFlow } from './BookingFlow';

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

async function load(slug: string): Promise<PublicProfile> {
  if (!SLUG_RE.test(slug)) notFound();
  const res = await serverGet<PublicProfile>(`/public/staff/${slug}`);
  if (res.status === 404) notFound();
  if (!res.ok || !res.data) throw new Error(`profile ${slug}: ${res.status}`);
  return res.data;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const profile = await load(slug);
  return { title: `${profile.displayName} · RezerwApp` };
}

/** Страница специалиста (link-in-bio): серверный рендер каталога, дальше запись в браузере (BookingFlow). */
export default async function StaffPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const locale = pickLocale((await searchParams).lang, (await headers()).get('accept-language'));
  const profile = await load(slug);
  return (
    <main lang={locale}>
      <LanguageSwitch path={`/${slug}`} current={locale} />
      <h1>{profile.displayName}</h1>
      <BookingFlow slug={slug} profile={profile} locale={locale} />
    </main>
  );
}
