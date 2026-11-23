import { statementRows, statementTitle, statementTotals, type StatementBank } from './statement'
import type { Bank, State } from './types'

/**
 * Выписка сразу файлом PDF в «Загрузки». Текст настоящий (не картинка), шрифт PT Sans с кириллицей.
 * Библиотека и шрифты грузятся только при нажатии кнопки — остальная программа от этого не тяжелеет.
 */
const BANK: Record<Bank, string> = { pko: 'PKO', revolut: 'Revolut' }
const SIGN: Record<string, string> = { PLN: 'zł', EUR: '€', USD: '$' }
const INK: [number, number, number] = [20, 20, 20]
const RED: [number, number, number] = [214, 40, 40]
const GREEN: [number, number, number] = [47, 107, 42]
const MUTED: [number, number, number] = [93, 90, 82]

const money = (n: number) => n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ | /g, ' ')
const dmy = (d: string) => d.split('-').reverse().join('.')

async function fontBase64(name: string): Promise<string> {
  const buf = await (await fetch(import.meta.env.BASE_URL + 'fonts/' + name)).arrayBuffer()
  let bin = ''
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

export async function downloadStatementPdf(s: State, bank: StatementBank, from: string, to: string, now = new Date()) {
  const [{ jsPDF }, { default: autoTable }, regular, bold] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
    fontBase64('PTSans-Regular.ttf'),
    fontBase64('PTSans-Bold.ttf'),
  ])
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  doc.addFileToVFS('PTSans-Regular.ttf', regular)
  doc.addFont('PTSans-Regular.ttf', 'PTSans', 'normal')
  doc.addFileToVFS('PTSans-Bold.ttf', bold)
  doc.addFont('PTSans-Bold.ttf', 'PTSans', 'bold')

  const rows = statementRows(s, bank, from, to)
  const who = bank === 'all' ? 'PKO и Revolut' : BANK[bank]
  const W = doc.internal.pageSize.getWidth()

  // Шапка: «ВЫПИСКА ОПЕРАЦИЙ», справа банк, период и время.
  doc.setFont('PTSans', 'bold').setFontSize(20).setTextColor(...INK).text('ВЫПИСКА', 12, 18)
  doc.setTextColor(...RED).text('ОПЕРАЦИЙ', 12 + doc.getTextWidth('ВЫПИСКА '), 18)
  doc.setFont('PTSans', 'normal').setFontSize(9).setTextColor(...MUTED)
  const stamp = now.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  doc.text([who, `${dmy(from)} — ${dmy(to)}`, `сформирована ${stamp}`], W - 12, 10, { align: 'right' })
  doc.setDrawColor(...INK).setLineWidth(0.8).line(12, 22, W - 12, 22)
  const note = doc.setFontSize(8).splitTextToSize('Из программы «Бюджет»: операции из выписок банков и ручные записи. Отменённые операции и дубли не включены. Это не официальная выписка банка.', W - 24)
  doc.text(note, 12, 27)

  autoTable(doc, {
    startY: 27 + note.length * 3.4 + 1.5,
    margin: { left: 12, right: 12 },
    head: [['Дата', 'Банк', 'Описание', 'Источник', 'Приход', 'Расход', '']],
    body: rows.length
      ? rows.map(r => [dmy(r.date), BANK[r.bank], r.where ? `${r.text}\n${r.where}` : r.text, r.source, r.inc ? '+' + money(r.inc) : '', r.out ? '−' + money(r.out) : '', SIGN[r.cur] ?? r.cur])
      : [['', '', 'За этот период операций нет.', '', '', '', '']],
    styles: { font: 'PTSans', fontSize: 8.5, cellPadding: 1.6, textColor: INK, lineColor: [221, 213, 195], lineWidth: { bottom: 0.2 } },
    headStyles: { font: 'PTSans', fontStyle: 'bold', fillColor: [255, 255, 255], textColor: INK, lineColor: INK, lineWidth: { bottom: 0.6 } },
    columnStyles: {
      0: { cellWidth: 18 },
      1: { cellWidth: 15 },
      3: { cellWidth: 16, textColor: MUTED },
      4: { cellWidth: 22, halign: 'right', textColor: GREEN },
      5: { cellWidth: 22, halign: 'right', textColor: RED },
      6: { cellWidth: 7 },
    },
    didParseCell: d => {
      if (d.section === 'head' && (d.column.index === 4 || d.column.index === 5)) d.cell.styles.halign = 'right'
    },
  })

  // Итоги по банкам и всего.
  const totalRow = (label: string, b: StatementBank) =>
    Object.entries(statementTotals(b === 'all' ? rows : rows.filter(r => r.bank === b))).map(([cur, t]) => [
      label + (cur !== 'PLN' ? ` · ${cur}` : ''),
      String(t.count),
      '+' + money(t.inc),
      '−' + money(t.out),
      `${t.diff >= 0 ? '+' : '−'}${money(Math.abs(t.diff))} ${SIGN[cur] ?? cur}`,
    ])
  const totals = [...(bank === 'all' ? [...totalRow('PKO', 'pko'), ...totalRow('Revolut', 'revolut')] : []), ...totalRow(bank === 'all' ? 'Всего' : BANK[bank], bank)]
  let y = (doc as any).lastAutoTable.finalY + 9
  if (y > doc.internal.pageSize.getHeight() - 40) {
    doc.addPage()
    y = 18
  }
  doc.setFillColor(...RED).rect(12, y - 3.2, 3, 3, 'F')
  doc.setFont('PTSans', 'bold').setFontSize(12).setTextColor(...INK).text('ИТОГИ', 17, y)
  autoTable(doc, {
    startY: y + 3,
    margin: { left: 12, right: 12 },
    head: [['', 'Операций', 'Пришло', 'Ушло', 'Разница']],
    body: totals.length ? totals : [['—', '0', '', '', '']],
    styles: { font: 'PTSans', fontSize: 10, cellPadding: 1.8, textColor: INK, lineColor: [221, 213, 195], lineWidth: { bottom: 0.2 } },
    headStyles: { font: 'PTSans', fontStyle: 'bold', fillColor: [255, 255, 255], textColor: INK, lineColor: INK, lineWidth: { bottom: 0.6 }, halign: 'right' },
    columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right', textColor: GREEN }, 3: { halign: 'right', textColor: RED }, 4: { halign: 'right', fontStyle: 'bold' } },
  })

  doc.save(statementTitle(bank, from, to) + '.pdf')
}
