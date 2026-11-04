export const CURRENCIES = ['PLN', 'USD', 'EUR', 'BYN', 'RUB'] as const
export type Cur = (typeof CURRENCIES)[number]
export const CUR_SIGN: Record<Cur, string> = { PLN: 'zł', USD: '$', EUR: '€', BYN: 'BYN', RUB: '₽' }

/** Сумма в любой валюте. rate — курс к злотому, зафиксированный при вводе; без него берётся текущий. */
export interface Money {
  v: number
  cur: Cur
  rate?: number
}

export interface Row {
  id: string
  name: string
  amt: Money
  /** Предполагаемая сумма (только для расходов), в остаток не входит. */
  plan?: number
}

export interface Sub {
  id: string
  name: string
  day: number
  /** Цена в валюте cur (по умолчанию злотые); в злотые пересчитывается по текущему курсу. */
  price: number
  cur?: Cur
  paid: boolean
  /** Можно платить частями (несколько телефонов одной строкой): сколько злотых уже списано в этом месяце. */
  partial?: boolean
  paidAmt?: number
}

/** Поступление дохода: дата и сумма как пришла. Валютное — по курсу NBP за последний рабочий день перед датой (rate). */
export interface TaxItem {
  id: string
  v: number
  date?: string
  cur?: Cur
  rate?: number
  /** Дата курса NBP (последний рабочий день перед поступлением). */
  rateDay?: string
}

export interface TaxColumn {
  id: string
  name: string
  rate: number
  items: TaxItem[]
}

export interface RentPayment {
  id: string
  date: string
  chynsh: number
  electr: number
  rent: number
  note: string
}

export type Bank = 'pko' | 'revolut'

export interface Op {
  id: number
  at: string
  bank: Bank
  text: string
  amount: number | null
  cur: Cur
  /** +1 пришло, −1 ушло, 0 не распознано */
  dir: 1 | -1 | 0
  /** matched — совпало с ручной записью, повторно не учтено. */
  status: 'applied' | 'unknown' | 'ignored' | 'matched'
  /** Внесено вручную во вкладке «Операции». */
  manual?: boolean
  note?: string
  /** Пара «ручная запись ↔ уведомление банка». */
  matchedWith?: number
  /** Остаток после операции из текста банка — важнее суммы операции. */
  balance?: number
  /** Сколько злотых изменилось на счёте. */
  pln?: number
  /** Подписка, которую это списание отметило оплаченной. */
  subId?: string
  /** Если подписку платят частями — сколько злотых этой операцией засчитано. */
  subPart?: number
}

export interface PokerWin {
  id: string
  date: string
  name: string
  amount: number
}

export interface State {
  version: 2
  payday: string
  incomes: Row[]
  expenses: Row[]
  /** «Отложить в капитал*» — расход месяца и актив капитала. */
  toCapital: number
  /** «Взял из капитала*» — доход месяца и долг капитала. */
  fromCapital: number
  subs: Sub[]
  assets: Row[]
  liabilities: Row[]
  prepaid: { paidOn: string; until: string; amount: number }
  tax: { year: number; columns: TaxColumn[]; payments: { id: string; date: string; amount: number }[] }
  rent: RentPayment[]
  bankLinks: Record<Bank, string | null>
  ops: Op[]
  lastCommentId: number
  /** Выигрыши в покер — учёт без налога. */
  poker: PokerWin[]
}

export type Rates = Record<Cur, number>
