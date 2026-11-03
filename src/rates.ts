import type { Rates } from './types'

const KEY = 'budget.rates'
// Резерв на случай, если NBP недоступен и в памяти ничего нет.
const FALLBACK: Rates = { PLN: 1, USD: 3.95, EUR: 4.41, BYN: 1.34, RUB: 0.049 }

export interface RatesInfo {
  rates: Rates
  date: string
  dateB: string
}

export function cachedRates(): RatesInfo {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (c?.rates) return c
  } catch {}
  return { rates: FALLBACK, date: '', dateB: '' }
}

/** Курсы NBP: таблица A (ежедневно) — доллар и евро, таблица B (раз в неделю) — белорусский и российский рубль. */
export async function fetchRates(): Promise<RatesInfo> {
  const get = (t: string) => fetch(`https://api.nbp.pl/api/exchangerates/tables/${t}/?format=json`).then(r => r.json())
  const [[a], [b]] = await Promise.all([get('A'), get('B')])
  const mid = (tbl: any, code: string) => tbl.rates.find((r: any) => r.code === code)?.mid
  const info: RatesInfo = {
    rates: {
      PLN: 1,
      USD: mid(a, 'USD') ?? FALLBACK.USD,
      EUR: mid(a, 'EUR') ?? FALLBACK.EUR,
      BYN: mid(b, 'BYN') ?? FALLBACK.BYN,
      RUB: mid(b, 'RUB') ?? FALLBACK.RUB,
    },
    date: a.effectiveDate,
    dateB: b.effectiveDate,
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(info))
  } catch {}
  return info
}
