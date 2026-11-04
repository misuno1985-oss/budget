// Фон вкладки в духе Revolut: тонкие мягкие полосы, размытые блики, мелкое зерно. Рисуется программно.
const THEMES: Record<string, [base: string, dark: string, light: string]> = {
  Месяц: ['#4a1830', '#2a0d1b', '#f07aa3'],
  Капитал: ['#4e5a17', '#262e08', '#dceb7a'],
  Налоги: ['#6b3a1c', '#33190a', '#ecb98a'],
  Покер: ['#123a31', '#06201a', '#7fd9b6'],
  Квартира: ['#22417e', '#0e1d42', '#a9c4ff'],
  Операции: ['#35285f', '#160f30', '#bfaeff'],
  Дочка: ['#5a1f4f', '#2c0a26', '#f5a8e0'],
  Настройки: ['#33363b', '#15161a', '#bcc1c8'],
}

export function Background({ tab }: { tab: string }) {
  const [base, dark, light] = THEMES[tab] ?? THEMES['Месяц']
  const seed = tab.length * 11
  return (
    <div className="bg" style={{ backgroundColor: base }} aria-hidden>
      <svg xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none" viewBox="0 0 1000 1000">
        <defs>
          <filter id="bg-s" x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency="0.0018 0.11" numOctaves={5} seed={seed} />
            <feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .9 -.32" />
            <feGaussianBlur stdDeviation="1.6 2.6" />
          </filter>
          <filter id="bg-soft" x="-300%" y="-20%" width="700%" height="140%">
            <feGaussianBlur stdDeviation="22" />
          </filter>
          <filter id="bg-grain">
            <feTurbulence type="fractalNoise" baseFrequency="1.4" numOctaves={2} seed={3} />
            <feColorMatrix type="saturate" values="0" />
            <feComponentTransfer>
              <feFuncA type="linear" slope=".05" />
            </feComponentTransfer>
          </filter>
          <linearGradient id="bg-d" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={dark} />
            <stop offset=".5" stopColor={base} />
            <stop offset="1" stopColor={dark} />
          </linearGradient>
        </defs>
        <rect width="1000" height="1000" fill="url(#bg-d)" />
        <g transform="rotate(-7 500 500)" opacity=".42">
          <rect x="-200" y="-150" width="1400" height="1300" fill={light} filter="url(#bg-s)" />
        </g>
        <ellipse cx="660" cy="500" rx="70" ry="620" fill={light} opacity=".32" filter="url(#bg-soft)" />
        <ellipse cx="140" cy="520" rx="22" ry="640" fill={light} opacity=".2" filter="url(#bg-soft)" />
        <rect width="1000" height="1000" filter="url(#bg-grain)" />
      </svg>
    </div>
  )
}
