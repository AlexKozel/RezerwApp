/**
 * Разбор CSV (RFC 4180): поля в кавычках, удвоенные кавычки, переносы строк внутри кавычек, CRLF/LF, BOM.
 * Разделитель определяется по первой строке: «;» (так сохраняет польский и русский Excel) или «,».
 * Возвращает строки вместе с номером строки файла, на которой запись начинается (для сообщений об ошибках).
 */
export function parseCsv(input: string): { rows: Array<{ line: number; cells: string[] }>; delimiter: ',' | ';' } {
  const text = input.replace(/^﻿/, '');
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';

  const rows: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;

  const endCell = () => {
    cells.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    if (!(cells.length === 1 && cells[0] === '')) rows.push({ line: rowLine, cells });
    cells = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        if (ch === '\n') line += 1;
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRow();
      line += 1;
      rowLine = line;
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || cells.length > 0) endRow();
  return { rows, delimiter };
}

/** Убирает защитный апостроф, который наш экспорт ставит перед =, +, -, @ (CrmService, toCsv): импорт своего экспорта даёт исходные значения. */
export function unescapeFormula(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}
