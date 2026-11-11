import type { Bank, Cur } from './types'

const CUR_WORDS: [RegExp, Cur][] = [
  [/^(zł|zl|pln)$/i, 'PLN'],
  [/^(eur|€)$/i, 'EUR'],
  [/^(usd|\$)$/i, 'USD'],
]
const curOf = (w: string): Cur | null => CUR_WORDS.find(([re]) => re.test(w))?.[1] ?? null

const NUM = String.raw`[+\-−]?\d{1,3}(?:[  ]\d{3})+(?:[.,]\d{1,2})?|[+\-−]?\d+(?:[.,]\d{1,2})?`
const CUR = String.raw`zł|zl|PLN|EUR|€|USD|\$`
const AFTER = new RegExp(`(${NUM})\\s?(${CUR})(?![\\p{L}])`, 'iu')
const BEFORE = new RegExp(`(${CUR})\\s?(${NUM})`, 'iu')

const toNum = (s: string) => Number(s.replace(/[  ]/g, '').replace('−', '-').replace(',', '.'))

// Порядок важен: «otrzyma od Ciebie» — это исходящий перевод, хотя в нём есть «otrzyma».
const OUT = [
  /od ciebie/i, /wydan[oa]/i, /wyda(łeś|łaś)/i, /zapłac/i, /płatnoś/i, /obciąż/i, /wypłat/i, /transakcj/i, /zakup/i,
  /przelew wychodz/i, /wysła(łeś|łaś|no)/i, /przela(łeś|łaś)/i, /\bspent\b/i, /\bpaid\b/i, /\bsent\b/i,
  /\bcard payment\b/i, /\bwithdraw/i,
]
const IN = [
  /otrzyma(łeś|łaś|no|łem|łam)/i, /wpły(w|nął|nęł|nęło)/i, /uznani/i, /zwrot/i, /przychodz/i,
  /(wysłał|przesłał|przelał)a? ci\b/i, /\breceived\b/i, /\brefund/i, /\btop.?up\b/i, /doładowan/i,
]

export interface Parsed {
  amount: number | null
  cur: Cur
  dir: 1 | -1 | 0
  /** Остаток на счёте после операции, если банк его пишет (PKO: «Stan konta po transakcji», Revolut: «Saldo PLN»). */
  balance?: number
}

const BALANCE = new RegExp(`(?:stan konta po transakcji|saldo po operacji|dostępne środki|saldo(?:\\s+(?:pln|zł))?)\\s*:?\\s*(${NUM})\\s?(?:zł|zl|PLN)`, 'iu')

export function parseNotification(text: string): Parsed {
  let amount: number | null = null
  let cur: Cur = 'PLN'
  let sign = 0
  const a = text.match(AFTER)
  const b = a ? null : text.match(BEFORE)
  if (a) {
    amount = toNum(a[1])
    cur = curOf(a[2]) ?? 'PLN'
  } else if (b) {
    amount = toNum(b[2])
    cur = curOf(b[1]) ?? 'PLN'
  }
  if (amount !== null && amount < 0) sign = -1
  else if (amount !== null && /^[+]/.test((a?.[1] ?? b?.[2]) || '')) sign = 1
  if (amount !== null) amount = Math.abs(amount)
  let dir: 1 | -1 | 0 = sign as 1 | -1 | 0
  if (!dir) {
    if (OUT.some(re => re.test(text))) dir = -1
    else if (IN.some(re => re.test(text))) dir = 1
  }
  const bal = text.match(BALANCE)
  return bal ? { amount, cur, dir, balance: toNum(bal[1]) } : { amount, cur, dir }
}

/**
 * Комментарий из Команды: «PKO: текст уведомления» или «revolut: текст».
 * Отметка времени из файла («3 lis 2026 o 17:18 - ») тоже допустима.
 */
export function splitComment(body: string): { bank: Bank | null; text: string } {
  const m = body.trim().match(/^(pko|revolut|revolute)\s*[:|\-–]\s*([\s\S]*)$/i)
  if (!m) return { bank: null, text: body.trim() }
  const bank: Bank = m[1].toLowerCase() === 'pko' ? 'pko' : 'revolut'
  return { bank, text: m[2].trim().replace(/^\d{1,2} \S+ \d{4} o \d{1,2}:\d{2}\s*-\s*/, '') }
}
