/**
 * Минимальная разметка юридических текстов (legal/*.md): заголовки #, цитаты >, абзацы через пустую строку.
 * Без HTML: блоки рендерятся React-элементами, текст экранируется, внедрить разметку через документ нельзя.
 */
export type Block = { kind: 'h1' | 'h2' | 'h3' | 'quote' | 'p'; text: string };

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of source.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const text = chunk.trim();
    if (!text) continue;
    const heading = /^(#{1,3})\s+(.*)$/s.exec(text);
    if (heading) {
      blocks.push({ kind: (['h1', 'h2', 'h3'] as const)[heading[1]!.length - 1]!, text: heading[2]!.trim() });
    } else if (text.startsWith('>')) {
      blocks.push({ kind: 'quote', text: text.replace(/^>\s?/gm, '').trim() });
    } else {
      blocks.push({ kind: 'p', text });
    }
  }
  return blocks;
}
