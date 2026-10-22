/**
 * 界面共用的"情绪"档位：详情抽屉的头部带与「此刻」面板的头部带都按这一套染色，
 * 面染令牌是 tokens.css 里的 --state-*（亮 12% / 暗 6%，由 themeContrast.test.ts 守住
 * 次要文字仍达 4.5:1），状态本身另靠头部带上沿那条 2px 实心语义色表达。
 */
export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'idle';
