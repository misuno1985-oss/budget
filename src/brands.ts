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

/**
 * Как подписка выглядит в уведомлении банка о списании. strong — слово однозначное, цену можно не сверять;
 * иначе (общие слова вроде «APPLE.COM/BILL» или «opłata») списание засчитывается, только если сумма близка к цене.
 */
const MERCHANT: Record<string, { re: RegExp; strong: boolean }> = {
  canal: { re: /canal\s*\+|canalplus|canal plus/i, strong: true },
  polsat: { re: /polsat/i, strong: true },
  youtube: { re: /youtube/i, strong: true },
  googleone: { re: /google\s*\*?\s*one|google\s*storage/i, strong: true },
  tmobile: { re: /t-?mobile/i, strong: true },
  openai: { re: /openai|chatgpt/i, strong: true },
  suno: { re: /\bsuno\b/i, strong: true },
  icloud: { re: /icloud|apple\.com\/bill|apple services/i, strong: false },
  claude: { re: /anthropic|claude/i, strong: true },
  revolut: { re: /\bmetal\b|opłata za plan|plan fee/i, strong: false },
  hetzner: { re: /hetzner/i, strong: true },
  pko: { re: /opłata|prowizja/i, strong: false },
}

/** Насколько уверенно текст списания относится к подписке с таким названием: 2 — точно, 1 — если сойдётся цена, 0 — нет. */
export function merchantHit(subName: string, text: string): 0 | 1 | 2 {
  const brands = brandsOf(subName)
  if (brands.length) {
    let best: 0 | 1 | 2 = 0
    for (const b of brands) {
      const m = MERCHANT[b.key]
      if (m?.re.test(text)) best = Math.max(best, m.strong ? 2 : 1) as 0 | 1 | 2
    }
    return best
  }
  // Подписки без известного бренда (например, «Цветы»): совпадение длинного слова из названия, плюс цена.
  const words = subName.toLowerCase().match(/[\p{L}\d]{4,}/gu) ?? []
  return words.some(w => text.toLowerCase().includes(w)) ? 1 : 0
}
