import { t } from '@rezerwapp/shared';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { serverGet } from '../../../lib/api';
import { pickLocale } from '../../../lib/locale';
import { LanguageSwitch } from '../../LanguageSwitch';

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

interface StudioPage {
  name: string;
  address: string | null;
  staff: Array<{ displayName: string; publicSlug: string; independent: boolean }>;
}

/** Studio page салона (D-053): адрес и мастера, у каждого своя страница записи. */
export default async function Studio({ params, searchParams }: Props) {
  const { slug } = await params;
  const locale = pickLocale((await searchParams).lang, (await headers()).get('accept-language'));
  if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug)) notFound();
  const res = await serverGet<StudioPage>(`/public/locations/${slug}`);
  if (res.status === 404 || !res.data) notFound();
  const studio = res.data;
  return (
    <main lang={locale}>
      <LanguageSwitch path={`/l/${slug}`} current={locale} />
      <h1>{studio.name}</h1>
      {studio.address && <p className="muted">{studio.address}</p>}
      <h2>{t(locale, 'widget.studio_staff')}</h2>
      {studio.staff.map((s) => (
        <a key={s.publicSlug} className="option" href={`/${s.publicSlug}?lang=${locale}`}>
          <span>{s.displayName}</span>
          <span aria-hidden="true">›</span>
        </a>
      ))}
    </main>
  );
}
