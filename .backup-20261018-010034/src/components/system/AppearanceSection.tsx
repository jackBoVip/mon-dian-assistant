import { useEffect } from 'react';
import { useTheme } from '../../state/theme';
import { APPEARANCE_MODES } from '../../lib/theme';
import { THEME_LABELS, type AppearanceMode, type ThemeStyle } from '../../lib/types';
import { Button } from '../ui/Button';
import { notify } from '../../state/notify';
import { toNormalisedError } from '../../lib/errors';

const MODE_LABELS: Record<AppearanceMode, string> = { system: '跟随系统', light: '浅色', dark: '深色' };

/** 外观：8 种主题风格 × 明暗模式 + 玻璃强度 + 减少动态，全部走设计令牌并即时 applyTheme。 */
export function AppearanceSection() {
  const t = useTheme();

  useEffect(() => {
    if (!t.loaded) void t.load();
  }, [t]);

  const styles = Object.keys(THEME_LABELS) as ThemeStyle[];

  async function save() {
    try {
      await t.persist();
      notify('success', '外观已保存并即时生效');
    } catch (raw) {
      notify('danger', toNormalisedError(raw).message);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-ink-muted">
        主题"风格"与外观"模式"分离，切换即时生效、按后端持久化，不重启、不丢失表单状态。玻璃主题在系统"减少透明度"时自动降级为不透明回退。
      </p>

      <section className="panel p-4">
        <h3 className="panel-title mb-2">主题风格</h3>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {styles.map((s) => {
            const active = t.style === s;
            return (
              <button
                key={s}
                type="button"
                aria-pressed={active}
                onClick={() => t.setStyle(s)}
                className="surface px-3 py-2 text-left text-sm"
                style={active ? { borderColor: 'var(--color-primary)' } : undefined}
              >
                {THEME_LABELS[s]}
              </button>
            );
          })}
        </div>
      </section>

      <section className="panel p-4">
        <h3 className="panel-title mb-2">外观模式</h3>
        <div className="flex gap-2">
          {APPEARANCE_MODES.map((m) => (
            <Button key={m} variant={t.mode === m ? 'primary' : 'default'} onClick={() => t.setMode(m)}>
              {MODE_LABELS[m]}
            </Button>
          ))}
        </div>
      </section>

      <section className="panel p-4">
        <h3 className="panel-title mb-2">玻璃效果强度（仅玻璃主题生效）</h3>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={100}
            value={t.glassIntensity}
            onChange={(e) => t.setGlassIntensity(Number(e.target.value))}
            aria-label="玻璃效果强度"
            className="w-64"
          />
          <span className="mono text-sm">{t.glassIntensity}%</span>
        </div>
      </section>

      <section>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={t.reduceMotion} onChange={(e) => t.setReduceMotion(e.target.checked)} />
          减少动态效果
        </label>
        <p className="mt-1 text-xs text-ink-muted">
          该开关即时影响本窗口动效；保存时经后端 set_reduce_motion 持久化到本机设置。
        </p>
      </section>

      <div>
        <Button variant="primary" onClick={() => void save()}>
          保存外观
        </Button>
      </div>
    </div>
  );
}
