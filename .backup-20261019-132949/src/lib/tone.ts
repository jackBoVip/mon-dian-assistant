/**
 * 界面共用的"情绪"档位：详情抽屉的头部带按这一套染色。
 * S 轮起染底不再是 tokens.css 里的 --state-* 独立令牌，而是在 global.css 的
 * `[data-tone] .drawer-head` 里直接对当前主题的语义色做 color-mix（12% 叠在面上），
 * 状态本身另靠头部带上沿那条 2px 实心语义色表达，不只靠颜色。
 */
export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'idle';
