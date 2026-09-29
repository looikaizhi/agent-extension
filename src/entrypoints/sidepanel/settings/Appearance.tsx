import { useEffect, useState } from 'react';
import { DEFAULT_APPEARANCE, shadeOf, type Appearance, type Mode, type Style } from '@/shared/appearance';
import { loadAppearance, onAppearanceChanged, saveAppearance } from '@/shared/appearance-store';

const STYLES: readonly { id: Style; name: string; desc: string }[] = [
  { id: 'hud', name: '夜航', desc: '等宽标注 · 荧光绿 · 取景框' },
  { id: 'depth', name: '景深', desc: '毛玻璃 · 虚化聚焦 · 胶囊按钮' },
];

const MODES: readonly { id: Mode; label: string }[] = [
  { id: 'system', label: '跟随系统' },
  { id: 'day', label: '白天' },
  { id: 'night', label: '黑夜' },
];

/**
 * 外观：选风格，选明暗（CONTEXT.md `Appearance`）.
 *
 * It only writes storage. The panel (`main.tsx`) and the overlay on the page
 * (through the host's `THEME`) both change when storage does, so nothing here
 * has anyone else to tell.
 *
 * Each style's thumbnail is painted by the real tokens: its two halves carry
 * their own `data-style` / `data-shade`, so what the tile shows is what picking
 * it gives.
 */
export function AppearanceSettings() {
  const [a, setA] = useState<Appearance>(DEFAULT_APPEARANCE);
  useEffect(() => {
    void loadAppearance().then(setA);
    return onAppearanceChanged(setA);
  }, []);

  const pick = (patch: Partial<Appearance>) => {
    const next = { ...a, ...patch };
    setA(next);
    void saveAppearance(next);
  };

  const systemNow = shadeOf('system', matchMedia('(prefers-color-scheme: dark)').matches) === 'night' ? '黑夜' : '白天';
  const said = a.mode === 'system' ? `跟随系统，现在是${systemNow}。` : a.mode === 'day' ? '固定用白天。' : '固定用黑夜。';

  return (
    <section className="appearance">
      <h3>外观</h3>
      <div className="label" id="appearance-style">
        风格
      </div>
      <div className="styles" role="group" aria-labelledby="appearance-style">
        {STYLES.map((s) => (
          <button key={s.id} className="style-tile" aria-pressed={a.style === s.id} onClick={() => pick({ style: s.id })}>
            <span className="thumb" aria-hidden="true">
              {(['day', 'night'] as const).map((shade) => (
                <span key={shade} className="swatch" data-style={s.id} data-shade={shade}>
                  <span className="bar" />
                  <span className="line" />
                  <span className="line short" />
                  <span className="pill" />
                </span>
              ))}
            </span>
            <span className="name">{s.name}</span>
            <span className="desc">{s.desc}</span>
          </button>
        ))}
      </div>
      <div className="label" id="appearance-mode">
        明暗
      </div>
      <div className="segmented" role="group" aria-labelledby="appearance-mode">
        {MODES.map((m) => (
          <button key={m.id} aria-pressed={a.mode === m.id} onClick={() => pick({ mode: m.id })}>
            {m.label}
          </button>
        ))}
      </div>
      <p className="hint">{said}侧栏和网页上的引导卡片一起换。</p>
    </section>
  );
}
