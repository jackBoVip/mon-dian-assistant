import { useEffect, useMemo, useState } from 'react';
import { useTheme } from '../../state/theme';
import { THEME_STYLES } from '../../lib/theme';
import { BUILTIN_THEME_LABELS, customThemeStyle, type BuiltinThemeStyle, type ThemeStyle } from '../../lib/types';
import { THEME_TOKEN_NAMES, TOKEN_TEMPLATE, parseThemeTokens } from '../../lib/themeTokens';
import { toNormalisedError } from '../../lib/errors';
import { notify } from '../../state/notify';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Badge } from '../ui/Badge';
import { Input } from '../ui/field-primitives';
import { Checkbox } from '../ui/checkbox';
import { Label } from '../ui/field-primitives';

/**
 * 界面外观：当前主题一览 + 内置四套的挑选 + 自定义主题的粘贴与删除。
 *
 * 三块口径拼在这里：
 *  - **改动即保存**（与 BC 轮那两页同一条）：选一套、开个关都直接落库，不再有那枚「保存外观」——
 *    顶栏那枚下拉早就是"点了就走"，同一件事在这一屏还要再点一次保存，是两套行为。
 *  - **预览吃的是那一套自己的令牌**：`data-theme` 是个普通属性，套在任意子树上就让那棵子树
 *    整套 var() 换一档，所以这里既没有第二份色值表，也不会出现"预览与实际不一致"。
 *  - **粘贴进来的 token 先过校验再谈保存**：逐枚白名单与字面形状（lib/themeTokens.ts），
 *    不合规就把行号与原因逐条列出来；校验没过连预览都不给，免得半套色被当成成品看。
 */

/** 一屏上能选的所有档：内置四套在前，自定义按落库顺序接在后面。 */
function useAllThemes(): Array<{ style: ThemeStyle; label: string }> {
  const custom = useTheme((s) => s.custom);
  return useMemo(
    () => [
      ...THEME_STYLES.map((s) => ({ style: s as ThemeStyle, label: BUILTIN_THEME_LABELS[s] })),
      ...custom.map((t) => ({ style: customThemeStyle(t.id), label: t.name })),
    ],
    [custom],
  );
}

/** 自定义档的 id：只要 [a-z0-9-]{2,32} 且以字母数字开头（后端还会再校一遍）。 */
function newThemeId(): string {
  return `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`.toLowerCase();
}

export function AppearanceSection() {
  const style = useTheme((s) => s.style);
  const reduceMotion = useTheme((s) => s.reduceMotion);
  const loaded = useTheme((s) => s.loaded);
  const custom = useTheme((s) => s.custom);
  const all = useAllThemes();

  const [name, setName] = useState('');
  const [pasted, setPasted] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 正常路径下 get_theme 由 session bootstrap 发（装配前发那条命令没人应答）；
  // 这里只是兜底：直接落到这一屏而 bootstrap 还没回来的场合，补一次 load。
  useEffect(() => {
    if (!loaded) void useTheme.getState().load();
  }, [loaded]);

  const parsed = useMemo(() => parseThemeTokens(pasted), [pasted]);
  const canSave = parsed.ok && name.trim().length > 0 && !busy;
  const currentLabel = all.find((t) => t.style === style)?.label ?? '极光液态';

  async function pick(next: ThemeStyle) {
    useTheme.getState().setStyle(next);
    try {
      await useTheme.getState().persist();
    } catch (raw) {
      notify('danger', toNormalisedError(raw).message);
    }
  }

  async function toggleReduceMotion(next: boolean) {
    useTheme.getState().setReduceMotion(next);
    try {
      await useTheme.getState().persist();
    } catch (raw) {
      notify('danger', toNormalisedError(raw).message);
    }
  }

  async function save() {
    if (!parsed.ok) return;
    const id = newThemeId();
    setBusy(true);
    try {
      await useTheme.getState().addTheme(id, name.trim(), parsed.tokens);
      setPasted('');
      setName('');
      notify('success', `已新增主题「${name.trim()}」，切换即生效`);
    } catch (raw) {
      notify('danger', toNormalisedError(raw).message);
    } finally {
      setBusy(false);
    }
  }

  async function copyTemplate() {
    try {
      await navigator.clipboard.writeText(TOKEN_TEMPLATE);
      notify('success', '模板已复制，改完粘回左边这个框即可');
    } catch {
      // 剪贴板拿不到时不谎报"已复制"：模板全文就摆在下面的折叠里，看得见也抄得走
      notify('warning', '剪贴板不可用：请展开「看模板」直接抄');
    }
  }

  async function remove(id: string) {
    const target = custom.find((t) => t.id === id);
    setPendingDelete(null);
    try {
      await useTheme.getState().removeTheme(id);
      notify('success', `已删除主题「${target?.name ?? id}」`);
    } catch (raw) {
      notify('danger', toNormalisedError(raw).message);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 border-b border-line pb-2">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-ink">界面外观</h2>
          <p className="mt-0.5 text-[11px] leading-4 text-ink-muted">
            界面主题与减少动态；只影响本机外观，不改任何安全策略。
          </p>
        </div>
        <Badge tone="muted">自动保存</Badge>
      </div>

      {/* 三枚指标：这一屏"现在是什么状态"一眼可读，不必展开下拉去比 */}
      <div className="grid grid-cols-[repeat(3,minmax(0,1fr))] gap-2.5">
        <div className="panel p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-body">当前主题</div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5">
            <ThemeFace style={style} size="chip" />
            <span className="min-w-0 truncate text-[13px] font-semibold text-ink">{currentLabel}</span>
          </div>
        </div>
        <div className="panel p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-body">自定义主题</div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-[18px] font-semibold text-ink">{custom.length}</span>
            <span className="text-[11px] text-ink-muted">档（内置 4 档之外）</span>
          </div>
        </div>
        <div className="panel p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-body">动效</div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-[18px] font-semibold text-ink">{reduceMotion ? '已减少' : '完整'}</span>
            <span className="text-[11px] text-ink-muted">{reduceMotion ? '过渡与位移都收敛' : '含过渡、按压与滑块回弹'}</span>
          </div>
        </div>
      </div>

      <section className="panel p-3">
        <h3 className="mb-2.5 text-[13px] font-semibold text-ink">主题风格</h3>
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {all.map((t) => {
            const active = t.style === style;
            return (
              <button
                key={t.style}
                type="button"
                aria-pressed={active}
                onClick={() => void pick(t.style)}
                className={`theme-card${active ? ' is-active' : ''}`}
              >
                <ThemeFace style={t.style} size="wide" />
                <span className="mt-2 flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate text-[13px] font-semibold text-ink">{t.label}</span>
                  {active ? <Icon name="check" size={14} className="ml-auto shrink-0 text-primary" /> : null}
                </span>
                <span className="mt-0.5 text-[11px] leading-4 text-ink-muted">
                  {THEME_STYLES.includes(t.style as BuiltinThemeStyle) ? '内置' : '自定义'}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="panel p-3">
        <div className="mb-2.5 flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <div className="min-w-0">
            <h3 className="text-[13px] font-semibold text-ink">新增一档自定义主题</h3>
            <p className="mt-0.5 text-[11px] leading-4 text-ink-muted">
              粘一整套设计令牌（形如 <code className="text-[10.5px]">--t-primary: …;</code>），32 枚齐全且逐枚合法才会存下来。
              改哪几枚写哪几枚；删掉的行会被点名，把那几行从模板里粘回来即可。
            </p>
          </div>
          <Button variant="ghost" onClick={() => void copyTemplate()}>
            <Icon name="copy" size={14} />
            复制模板
          </Button>
        </div>

        <div className="grid gap-2.5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-2.5">
            <div className="field">
              <label htmlFor="theme-name">主题名称</label>
              <Input
                id="theme-name"
                value={name}
                maxLength={24}
                placeholder="例如：海盐蓝"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="theme-tokens">设计令牌</label>
              <textarea
                id="theme-tokens"
                className="input theme-tokens"
                rows={9}
                spellCheck={false}
                value={pasted}
                placeholder={TOKEN_TEMPLATE.split('\n').slice(0, 6).join('\n')}
                aria-invalid={pasted.length > 0 && !parsed.ok ? true : undefined}
                onChange={(e) => setPasted(e.target.value)}
              />
              <span className="text-[11px] leading-4 text-ink-muted">
                {pasted.length === 0
                  ? '一行一枚；行首的 /* 注释 */ 与空行都会被跳过。'
                  : parsed.ok
                    ? `校验通过：${THEME_TOKEN_NAMES.length} 枚齐全。`
                    : `有 ${parsed.errors.length} 处不合规，逐条列在下面。`}
              </span>
            </div>

            {parsed.ok === false && pasted.length > 0 ? (
              <ul className="theme-errors" role="alert" aria-label="令牌校验结果">
                {parsed.errors.map((e) => (
                  <li key={`${e.line}-${e.reason}`}>
                    <span className="mono">第 {e.line || '—'} 行</span>
                    <span>{e.reason}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="flex items-center gap-2">
              <Button variant="primary" onClick={() => void save()} disabled={!canSave}>
                {busy ? '保存中…' : '保存为新主题'}
              </Button>
              {pasted.length > 0 && !parsed.ok ? (
                <span className="text-[11px] text-ink-muted">先修完上面那几处才能存</span>
              ) : null}
            </div>
          </div>

          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between text-[11px] font-semibold text-ink-body">
              <span>已有自定义主题</span>
              <span>{custom.length} 档</span>
            </div>
            {custom.length === 0 ? (
              <p className="text-[11px] leading-4 text-ink-muted">
                还没有一档。左边粘一份就能建：先「复制模板」，改几个颜色，再粘回来。
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {custom.map((t) => {
                  const s = customThemeStyle(t.id);
                  return (
                    <li key={t.id} className={`theme-row${style === s ? ' is-active' : ''}`}>
                      <ThemeFace style={s} size="chip" />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink">{t.name}</span>
                      {style === s ? (
                        <span className="text-[11px] text-ink-muted">使用中</span>
                      ) : (
                        <Button variant="ghost" onClick={() => void pick(s)}>
                          使用
                        </Button>
                      )}
                      {pendingDelete === t.id ? (
                        <>
                          <Button variant="ghost" onClick={() => void remove(t.id)}>
                            确认删除
                          </Button>
                          <Button variant="ghost" onClick={() => setPendingDelete(null)}>
                            取消
                          </Button>
                        </>
                      ) : (
                        <Button variant="ghost" aria-label={`删除 ${t.name}`} onClick={() => setPendingDelete(t.id)}>
                          <Icon name="trash" size={14} />
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-[11px] leading-4 text-ink-muted">
              删除不可撤销；正在使用的那一档被删掉后会自动回到「极光液态」。
            </p>
          </div>
        </div>
      </section>

      <section className="panel p-3">
        <h3 className="mb-2 text-[13px] font-semibold text-ink">动效</h3>
        <div className="flex items-center gap-2 text-sm">
          <Checkbox
            id="appearance-reduce-motion"
            className="size-[15px]"
            checked={reduceMotion}
            onCheckedChange={(c) => void toggleReduceMotion(c === true)}
          />
          <Label htmlFor="appearance-reduce-motion">减少动态效果</Label>
        </div>
        <p className="mt-1 text-[11px] leading-4 text-ink-muted">
          该开关即时影响本窗口动效，并随后端 set_reduce_motion 持久化到本机设置；系统的「减少动态效果」偏好会叠加生效。
        </p>
      </section>
    </div>
  );
}

/**
 * 一块小样：底色、一条主色带、两行字与一枚实心主色按钮，全用它所在子树的那一套令牌。
 *
 * 关键就在 `data-theme` 挂在**这块**上而不是 <html> 上——CSS 自定义属性往内继承，
 * 于是同一屏里可以同时摆着四套（以及任意多档自定义）的真实样子，
 * 不需要在 TS 里再抄一份色值表，也就不会有"预览与实际不一致"这件事。
 */
function ThemeFace({ style, size = 'full' }: { style: ThemeStyle; size?: 'full' | 'wide' | 'chip' }) {
  return (
    <span
      data-theme={style}
      className={`theme-face${size === 'full' ? '' : ` theme-face--${size}`}`}
      aria-hidden
    >
      <span className="theme-face-bar" />
      <span className="theme-face-line" />
      <span className="theme-face-line theme-face-line--short" />
      <span className="theme-face-cta" />
    </span>
  );
}
