import { capital, daysLeft, month, prepaidLeft, tax, toPln } from './calc'
import { parseNotification, splitComment } from './parse'
import { emptyState } from './state'
import type { Rates, State } from './types'

const rates: Rates = { PLN: 1, USD: 4, EUR: 4.5, BYN: 1.3, RUB: 0.05 }
const today = new Date(2026, 10, 3, 15, 30)

describe('разбор уведомлений', () => {
  it('Revolut: исходящий перевод', () => {
    const t = 'Ja otrzyma od Ciebie 20 zł. Spodziewany termin realizacji: Przelew zostanie zrealizowany w kilka sekund.'
    expect(parseNotification(t)).toEqual({ amount: 20, cur: 'PLN', dir: -1 })
  })
  it('поступление', () => {
    expect(parseNotification('Otrzymałeś 1 250,50 zł od Jan Kowalski')).toEqual({ amount: 1250.5, cur: 'PLN', dir: 1 })
    expect(parseNotification('Wpływ na konto: 300,00 PLN')).toMatchObject({ amount: 300, dir: 1 })
  })
  it('оплата картой и валюта впереди', () => {
    expect(parseNotification('Zapłacono 14,90 zł w ZABKA Z1234')).toMatchObject({ amount: 14.9, dir: -1 })
    expect(parseNotification('You spent €12.50 at Lidl')).toEqual({ amount: 12.5, cur: 'EUR', dir: -1 })
  })
  it('знак суммы важнее слов', () => {
    expect(parseNotification('Transakcja: -45,00 PLN')).toMatchObject({ amount: 45, dir: -1 })
    expect(parseNotification('Operacja +45,00 PLN')).toMatchObject({ amount: 45, dir: 1 })
  })
  it('непонятное — направление 0', () => {
    expect(parseNotification('Coś się stało 10 zł')).toMatchObject({ amount: 10, dir: 0 })
    expect(parseNotification('Bez kwoty')).toMatchObject({ amount: null })
  })
  it('банк и отметка времени из файла', () => {
    expect(splitComment('PKO: 3 lis 2026 o 17:21 - Wpływ 20 zł')).toEqual({ bank: 'pko', text: 'Wpływ 20 zł' })
    expect(splitComment('Revolute: abc')).toEqual({ bank: 'revolut', text: 'abc' })
    expect(splitComment('abc').bank).toBeNull()
  })
})

function sample(): State {
  const s = emptyState()
  s.payday = '2026-11-13'
  s.incomes = [
    { id: 'a', name: 'PKO', amt: { v: 150, cur: 'PLN' } },
    { id: 'b', name: 'Revolut', amt: { v: 1000, cur: 'PLN' } },
  ]
  s.expenses = [{ id: 'c', name: 'Танцы', amt: { v: 0, cur: 'PLN' }, plan: 500 }]
  s.subs = [
    { id: 's1', name: 'Hetzner', day: 5, price: 50, paid: false },
    { id: 's2', name: 'YouTube', day: 8, price: 30, paid: true },
  ]
  s.assets = [
    { id: 'r', name: 'Revolut', amt: { v: 100000, cur: 'PLN' } },
    { id: 'k', name: 'Копилка', amt: { v: 20000, cur: 'PLN' } },
  ]
  s.liabilities = [{ id: 'p', name: 'Долг', amt: { v: 1000, cur: 'PLN' } }]
  s.tax.columns = [
    { id: 't1', name: 'Patreon', rate: 12, items: [{ id: 'x', v: 10000 }] },
    { id: 't2', name: 'Кофе', rate: 12, items: [{ id: 'y', v: 5000 }] },
    { id: 't3', name: 'Зарплата', rate: 6.1, items: [{ id: 'z', v: 50000 }] },
  ]
  s.tax.payments = [{ id: 'q', date: '2026-03-10', amount: 4800 }]
  s.prepaid = { paidOn: '2026-05-08', until: '2026-11-08', amount: 12000 }
  return s
}

describe('расчёты', () => {
  it('остаток и бюджет на день', () => {
    const m = month(sample(), rates, today)
    expect(m.rest).toBe(1100)
    expect(m.days).toBe(10)
    expect(m.perDay).toBe(110)
  })
  it('план не входит в остаток, звёздочки переносятся', () => {
    const s = sample()
    s.toCapital = 100
    s.fromCapital = 30
    expect(month(s, rates, today).rest).toBe(1030)
    const c = capital(s, rates, today)
    expect(c.assets).toBe(120100)
  })
  it('день поступления и прошедшая дата', () => {
    expect(daysLeft('2026-11-03', today)).toBe(0)
    expect(month({ ...sample(), payday: '2026-11-01' }, rates, today).perDay).toBeNull()
  })
  it('налог: 12% и 6,1%, минус взносы', () => {
    const t = tax(sample())
    expect(t.due).toBeCloseTo(4850, 6)
    expect(t.left).toBeCloseTo(50, 6)
  })
  it('квартира наперёд — одна доля в ноябре до 8-го, потом 0', () => {
    const p = sample().prepaid
    expect(prepaidLeft(p, new Date(2026, 4, 8))).toBe(12000)
    expect(prepaidLeft(p, new Date(2026, 5, 8))).toBe(10000)
    expect(prepaidLeft(p, today)).toBe(2000)
    expect(prepaidLeft(p, new Date(2026, 10, 8))).toBe(0)
  })
  it('капитал', () => {
    const c = capital(sample(), rates, today)
    expect(c.onHand).toBeCloseTo(120000 - 1000 - 50, 6)
    expect(c.total).toBeCloseTo(c.onHand + 2000, 6)
  })
  it('валюта: зафиксированный курс и текущий', () => {
    expect(toPln({ v: 100, cur: 'USD' }, rates)).toBe(400)
    expect(toPln({ v: 100, cur: 'USD', rate: 3.9 }, rates)).toBe(390)
  })
})

describe('уведомления меняют счета', () => {
  it('Revolut −20, PKO +20, повтор не считается', async () => {
    const { ingest } = await import('./state')
    const s = sample()
    s.bankLinks = { pko: 'a', revolut: 'b' }
    const c = [
      { id: 2, created_at: '2026-11-03T16:23:00Z', body: 'PKO: 3 lis 2026 o 17:23 - Wpływ 20,00 zł' },
      { id: 1, created_at: '2026-11-03T16:20:00Z', body: 'revolut: 3 lis 2026 o 17:20 - Ja otrzyma od Ciebie 20 zł.' },
    ]
    const s2 = ingest(s, c, rates)
    expect(s2.incomes.find(r => r.id === 'a')!.amt.v).toBe(170)
    expect(s2.incomes.find(r => r.id === 'b')!.amt.v).toBe(980)
    expect(s2.ops.map(o => o.status)).toEqual(['applied', 'applied'])
    const s3 = ingest(s2, c, rates)
    expect(s3.incomes.find(r => r.id === 'a')!.amt.v).toBe(170)
    expect(s.incomes[0].amt.v).toBe(150)
  })
})

describe('уведомления в формате банков', () => {
  const rev = 'revolut: 3 lis 2026 o 19:21 - Ja otrzyma od Ciebie 20 zł. Spodziewany termin realizacji: Przelew zostanie zrealizowany w kilka sekund.'
  const pko =
    'PKO: 3 lis 2026 o 19:21 - +20,00 PLN Przelew na telefon - odebrany\n\n\nKonto nadawcy: 11..1111\n\nNadawca: JAN KOWALSKI   \n\nTytuł: PRZELEW NA TELEFON BLIK\n\nNa koncie: 22..2222\n\nStan konta po transakcji: +233,15 PLN'
  it('разбор PKO с остатком', () => {
    expect(parseNotification(splitComment(pko).text)).toEqual({ amount: 20, cur: 'PLN', dir: 1, balance: 233.15 })
  })
  it('PKO ставит остаток банка, Revolut вычитает; отмена возвращает', async () => {
    const { ingest, undoOp } = await import('./state')
    const s = sample()
    s.incomes[0].amt.v = 200 // расходится с банком — остаток банка важнее
    s.bankLinks = { pko: 'a', revolut: 'b' }
    const s2 = ingest(s, [
      { id: 1, created_at: '2026-11-03T18:21:02Z', body: rev },
      { id: 2, created_at: '2026-11-03T18:21:07Z', body: pko },
    ], rates)
    expect(s2.incomes[0].amt.v).toBe(233.15)
    expect(s2.incomes[1].amt.v).toBe(980)
    undoOp(s2, s2.ops[0], rates)
    expect(s2.incomes[0].amt.v).toBe(200)
  })
})

describe('обновление старых данных', () => {
  it('переименовывает бренды и добавляет покер один раз', async () => {
    const { migrate } = await import('./state')
    const old: any = { ...sample(), version: 1, poker: undefined }
    old.subs = [{ id: 's', name: 'Клод', day: 1, price: 1, paid: true }]
    old.tax.columns[1].name = 'Кофе'
    const m = migrate(old)
    expect(m.version).toBe(2)
    expect(m.subs[0].name).toBe('Claude')
    expect(m.tax.columns[1].name).toBe('Buy Me a Coffee')
    expect(m.poker).toEqual([])
    expect(migrate(m)).toBe(m)
  })
})

describe('ручные операции и защита от двойного учёта', () => {
  const rev = (id: number, at: string, sum: string) => ({ id, created_at: at, body: `revolut: Ja otrzyma od Ciebie ${sum} zł.` })
  async function setup() {
    const st = await import('./state')
    const s = sample()
    s.bankLinks = { pko: 'a', revolut: 'b' }
    return { st, s }
  }
  it('вручную −12,22, через два дня уведомление — второй раз не списывается', async () => {
    const { st, s } = await setup()
    st.addManual(s, 'revolut', -1, 12.22, 'жене', rates, '2026-11-03T19:00:00Z')
    expect(s.incomes[1].amt.v).toBe(987.78)
    const s2 = st.ingest(s, [rev(5, '2026-11-05T09:00:00Z', '12,22')], rates)
    expect(s2.incomes[1].amt.v).toBe(987.78)
    const auto = s2.ops.find(o => o.id === 5)!
    expect(auto.status).toBe('matched')
    expect(s2.ops.find(o => o.manual)!.matchedWith).toBe(5)
  })
  it('другая сумма, другой банк или старше 10 дней — считается как обычно', async () => {
    const { st, s } = await setup()
    st.addManual(s, 'revolut', -1, 12.22, '', rates, '2026-11-03T19:00:00Z')
    const s2 = st.ingest(s, [rev(6, '2026-11-04T09:00:00Z', '12,20'), rev(7, '2026-11-20T09:00:00Z', '12,22')], rates)
    expect(s2.ops.filter(o => o.status === 'matched')).toHaveLength(0)
    expect(s2.incomes[1].amt.v).toBe(963.36)
  })
  it('две одинаковые ручные — два уведомления совпадают по одному', async () => {
    const { st, s } = await setup()
    st.addManual(s, 'revolut', -1, 10, '', rates, '2026-11-03T10:00:00Z')
    st.addManual(s, 'revolut', -1, 10, '', rates, '2026-11-03T11:00:00Z')
    const s2 = st.ingest(s, [rev(8, '2026-11-04T09:00:00Z', '10'), rev(9, '2026-11-04T10:00:00Z', '10'), rev(10, '2026-11-04T11:00:00Z', '10')], rates)
    expect(s2.ops.filter(o => o.status === 'matched')).toHaveLength(2)
    expect(s2.incomes[1].amt.v).toBe(970)
  })
  it('удалить ручную — деньги возвращаются, уведомление ждёт решения; «другие деньги» — учесть', async () => {
    const { st, s } = await setup()
    st.addManual(s, 'revolut', -1, 12.22, '', rates, '2026-11-03T19:00:00Z')
    const s2 = st.ingest(s, [rev(5, '2026-11-04T09:00:00Z', '12,22')], rates)
    st.unmatch(s2, 5, rates)
    expect(s2.incomes[1].amt.v).toBe(975.56)
    const m = s2.ops.find(o => o.manual)!
    st.removeManual(s2, m.id, rates)
    expect(s2.incomes[1].amt.v).toBe(987.78)
  })
  it('предупреждение: такое уведомление уже пришло', async () => {
    const { st, s } = await setup()
    const s2 = st.ingest(s, [rev(5, '2026-11-04T09:00:00Z', '12,22')], rates)
    const probe = { id: 0, at: '2026-11-05T09:00:00Z', bank: 'revolut', text: '', amount: 12.22, cur: 'PLN', dir: -1, status: 'unknown' } as const
    expect(st.findAutoTwin(s2, { ...probe })?.id).toBe(5)
  })
})
