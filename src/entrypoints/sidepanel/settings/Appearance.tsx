import { useEffect, useState } from 'react';
import { DEFAULT_APPEARANCE, shadeOf, type Appearance, type Mode, type Style } from '@/shared/appearance';
import { loadAppearance, onAppearanceChanged, saveAppearance } from '@/shared/appearance-store';
import { Icon, type IconName } from '../ui/Icon';

const STYLES: readonly { id: Style; name: string; desc: string }[] = [
  { id: 'hud', name: '夜航', desc: '等宽标注 · 荧光绿 · 取景框' },
  { id: 'depth', name: '景深', desc: '毛玻璃 · 虚化聚焦 · 胶囊按钮' },
];

const MODES: readonly { id: Mode; label: string; icon: IconName }[] = [
  { id: 'system', label: '跟随系统', icon: 'monitor' },
  { id: 'day', label: '白天', icon: 'sun' },
  { id: 'night', label: '黑夜', icon: 'moon' },
];

/**
 * 外观：选风格，选明暗（CONTEXT.md `Appearance`）.
 *
 * It only writes storage. The panel (`main.tsx`) and the overlay on the page
 * (through the host's `THEME`) both change when storage does, so nothing here
 * has anyone else to tell.
 *
 * Each style's thumbnail is a small picture of that look, day and night side
 * by side; the preview below is painted by the real overlay tokens, so it is
 * what the page's card will look like.
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
      <h2>外观</h2>
      <div className="label" id="appearance-style">
        风格
      </div>
      <div className="styles" role="group" aria-labelledby="appearance-style">
        {STYLES.map((s) => (
          <button key={s.id} className="style-tile" aria-pressed={a.style === s.id} onClick={() => pick({ style: s.id })}>
            <span className={`thumb ${s.id}`} aria-hidden="true">
              {s.id === 'hud' ? <HudThumb /> : <DepthThumb />}
            </span>
            <span className="name-row">
              <span className="name">{s.name}</span>
              {a.style === s.id && (
                <span className="picked">
                  <Icon name="check" size={10} weight={3.2} />
                </span>
              )}
            </span>
            <span className="desc">{s.desc}</span>
          </button>
        ))}
      </div>
      <div className="label" id="appearance-mode">
        明暗
      </div>
      <div className="segmented modes" role="group" aria-labelledby="appearance-mode">
        {MODES.map((m) => (
          <button key={m.id} aria-pressed={a.mode === m.id} onClick={() => pick({ mode: m.id })}>
            <Icon name={m.icon} size={14} weight={2} />
            {m.label}
          </button>
        ))}
      </div>
      <p className="hint">{said}侧栏和网页上的引导卡片一起换。</p>
      <div className="label">预览 · 网页上的引导卡片</div>
      <div className="preview" aria-hidden="true">
        <span className="page">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span className="veil" />
        <span className="card">
          <span className="for-hud step">STEP 02</span>
          <span className="for-depth step">第 2 步</span>
          <span className="title">点「创建密钥」</span>
          <span className="actions">
            <span className="go">跳到目标</span>
            <span className="end">结束</span>
          </span>
        </span>
      </div>
    </section>
  );
}

/** 夜航, day and night: a segmented track, a title, lines, the ink button. */
function HudThumb() {
  return (
    <>
      {(['day', 'night'] as const).map((shade) => (
        <span key={shade} className={`half ${shade}`}>
          <span className="track">
            <i />
            <i />
            <i />
          </span>
          <span className="line title" />
          <span className="line" />
          <span className="line short" />
          <span className="button">
            <i />
          </span>
        </span>
      ))}
    </>
  );
}

/** 景深, day and night: a stepper, a frosted card, the pill button. */
function DepthThumb() {
  return (
    <>
      {(['day', 'night'] as const).map((shade) => (
        <span key={shade} className={`half ${shade}`}>
          <span className="stepper">
            <i className="done" />
            <i className="link done" />
            <i className="cur" />
            <i className="link" />
            <i />
          </span>
          <span className="glass">
            <i />
            <i />
          </span>
          <span className="button" />
        </span>
      ))}
    </>
  );
}
