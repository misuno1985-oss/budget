import type { CSSProperties } from 'react'

// Фигуры Лисицкого для каждой вкладки — в правом верхнем углу листа, за содержимым, ничего не перекрывают.
const INK = '#141414'
const RED = '#d62828'
const OCHRE = '#c49a3e'
const box = (s: CSSProperties) => s

const SHAPES: Record<string, CSSProperties[]> = {
  // «Проун»: красный круг, охристая планка, длинная диагональ.
  Месяц: [
    box({ right: -110, top: -120, width: 340, height: 340, borderRadius: '50%', background: RED }),
    box({ right: 250, top: -40, width: 34, height: 220, background: OCHRE, transform: 'rotate(26deg)' }),
    box({ right: -60, top: 250, width: 520, height: 2, background: INK, transform: 'rotate(-14deg)' }),
  ],
  // «Проун» с объёмным блоком: чёрный куб в аксонометрии и красная планка.
  Капитал: [
    box({ right: 70, top: 40, width: 150, height: 150, background: INK, transform: 'skewY(-18deg)' }),
    box({ right: 0, top: 40, width: 72, height: 150, background: '#3a3a3a', transform: 'skewY(30deg)' }),
    box({ right: 70, top: 10, width: 150, height: 48, background: '#5a5a5a', transform: 'skewX(-40deg)' }),
    box({ right: 20, top: 240, width: 220, height: 22, background: RED, transform: 'rotate(-18deg)' }),
  ],
  // «Клином красным бей белых»: красный клин входит в белый круг.
  Налоги: [
    box({ right: 20, top: -70, width: 250, height: 250, borderRadius: '50%', background: '#fff', border: `2px solid ${INK}` }),
    box({ right: 150, top: 20, width: 0, height: 0, borderTop: '36px solid transparent', borderBottom: '36px solid transparent', borderLeft: `280px solid ${RED}`, transform: 'rotate(-14deg)' }),
  ],
  // «Сказ про два квадрата».
  Покер: [
    box({ right: 120, top: 20, width: 140, height: 140, background: INK }),
    box({ right: 30, top: 110, width: 130, height: 130, background: RED, transform: 'rotate(-16deg)' }),
  ],
  // «Горизонтальный небоскрёб»: балка на опорах.
  Квартира: [
    box({ right: -20, top: 40, width: 300, height: 40, background: INK }),
    box({ right: 200, top: 80, width: 22, height: 120, background: INK }),
    box({ right: 40, top: 80, width: 22, height: 120, background: RED }),
  ],
  // Книга «Для голоса»: одна тонкая красная диагональ.
  Операции: [box({ right: -40, top: 20, width: 420, height: 3, background: RED, transform: 'rotate(-32deg)', transformOrigin: 'right' })],
  // Один маленький наклонённый красный квадрат.
  Дочка: [box({ right: 70, top: 20, width: 120, height: 120, background: RED, transform: 'rotate(-14deg)' })],
  // Одна чёрная планка, как линейка на листе.
  Настройки: [box({ right: 60, top: -20, width: 20, height: 300, background: INK, transform: 'rotate(12deg)' })],
}

export function Background({ tab }: { tab: string }) {
  return (
    <>
      {(SHAPES[tab] ?? SHAPES['Месяц']).map((s, i) => (
        <div key={tab + i} className="deco" style={s} aria-hidden />
      ))}
    </>
  )
}
