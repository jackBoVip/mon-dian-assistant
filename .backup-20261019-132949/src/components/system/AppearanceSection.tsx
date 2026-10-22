import { useEffect } from 'react';
import { useTheme } from '../../state/theme';
import { THEME_LABELS, type ThemeStyle } from '../../lib/types';
import { Button } from '../ui/Button';
import { notify } from '../../state/notify';
import { toNormalisedError } from '../../lib/errors';

/** 外观：原型那四套主题 + 减少动态，切换即时 applyTheme，落库要显式点保存。 */
export function AppearanceSection() {
  const t = useTheme();

  useEffect(() => {
    if (!t.loaded) void t.load();
  }, [t]);

  const styles = Object.keys(THEME_LABELS) as ThemeStyle[];

  async function save() {
    try {
      await t.persist();
      notify('success', '界面风格已保存');
    } catch (raw) {
      notify('danger', toNormalisedError(raw).message);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-ink-muted">
        四套主题各自带自己的明暗身份与模糊档位，切换即时生效、按后端持久化，不重启、不丢失表单状态。
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
                className="surface flex items-center gap-2 px-3 py-2 text-left text-sm"
                style={active ? { borderColor: 'var(--color-primary)' } : undefined}
              >
                <span className="theme-preview" data-preview={s} aria-hidden />
                {THEME_LABELS[s]}
              </button>
            );
          })}
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
