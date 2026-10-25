import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { serverGet } from '../../../../lib/api';
import { pickLocale } from '../../../../lib/locale';
import { parseMarkdown } from '../../../../lib/markdown';

type Props = {
  params: Promise<{ slug: string; type: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const TYPES = ['terms', 'privacy', 'health', 'marketing'];

/** Документ специалиста для клиента (D-055): Regulamin, клауза, согласия. Перевода нет: польский. */
export default async function LegalPage({ params, searchParams }: Props) {
  const { slug, type } = await params;
  const locale = pickLocale((await searchParams).lang, (await headers()).get('accept-language'));
  if (!TYPES.includes(type)) notFound();
  const res = await serverGet<{ language: string; version: string; body: string }>(`/public/staff/${encodeURIComponent(slug)}/legal/${type}?language=${locale}`);
  if (!res.ok || !res.data) notFound();
  const doc = res.data;
  return (
    <main lang={doc.language} className="doc">
      {parseMarkdown(doc.body).map((b, i) => {
        if (b.kind === 'quote') return <blockquote key={i}>{b.text}</blockquote>;
        const Tag = b.kind;
        return <Tag key={i}>{b.text}</Tag>;
      })}
      <p className="muted">v. {doc.version}</p>
    </main>
  );
}
