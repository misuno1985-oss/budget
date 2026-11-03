const B = import.meta.env.BASE_URL + 'logos/'

export interface Brand {
  key: string
  src: string
  /** Фирменный цвет — для рамок столбцов в налогах. */
  color?: string
}

const LIST: [RegExp, Brand][] = [
  [/canal\s*\+?|канал/i, { key: 'canal', src: B + 'canalplus.png' }],
  [/polsat|полсат/i, { key: 'polsat', src: B + 'polsat.png' }],
  [/youtube|ютуб/i, { key: 'youtube', src: B + 'youtube.svg' }],
  [/google\s*one|гугл/i, { key: 'googleone', src: B + 'googleone.png' }],
  [/t-?mobile/i, { key: 'tmobile', src: B + 'tmobile.svg' }],
  [/chat\s*gpt|openai/i, { key: 'openai', src: B + 'openai.svg' }],
  [/suno/i, { key: 'suno', src: B + 'suno.svg' }],
  [/icloud|айклауд/i, { key: 'icloud', src: B + 'icloud.svg' }],
  [/claude|клод/i, { key: 'claude', src: B + 'claude.svg' }],
  [/revolut|револют/i, { key: 'revolut', src: B + 'revolut.svg' }],
  [/hetzner/i, { key: 'hetzner', src: B + 'hetzner.svg' }],
  [/\bpko\b|пко/i, { key: 'pko', src: B + 'pko.png' }],
  [/patreon|патреон/i, { key: 'patreon', src: B + 'patreon.svg', color: '#FF424D' }],
  [/buy\s*me\s*a?\s*coffee|buymeacoffee|кофе/i, { key: 'bmc', src: B + 'buymeacoffee.svg', color: '#FFDD00' }],
]

/** Все бренды, упомянутые в названии строки (для «Canal+ / Polsat» — два). */
export function brandsOf(name: string): Brand[] {
  return LIST.filter(([re]) => re.test(name)).map(([, b]) => b)
}

export const KAS_LOGO = B + 'kas.png'

/** Разовая замена названий на оригинальные (только если строка всё ещё называется по-старому). */
export const RENAMES: Record<string, string> = {
  'Карта PKO': 'PKO Bank Polski',
  PKO: 'PKO Bank Polski',
  YouTube: 'YouTube Premium',
  iCloud: 'iCloud+',
  Клод: 'Claude',
  'Револют Метал': 'Revolut Metal',
  'Hetzner (сайт)': 'Hetzner',
  Кофе: 'Buy Me a Coffee',
  buymeacoffee: 'Buy Me a Coffee',
}
