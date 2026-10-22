/**
 * 左上角企业标识条：一条渐变竖杠 + 中英两行（原型的 .corp-brand）。
 *
 * 竖杠的两端取当前主题的主色与强调色，所以换主题它就换色；整条 pointer-events:none，
 * 不拦窗口拖动，也不接受焦点。文案是对外主体名称，不随主题与页面变化。
 */
export function CorpBrand() {
  return (
    <header className="corp-brand" aria-label="内蒙古电力（集团）有限责任公司">
      <div className="corp-brand__text">
        <span className="corp-brand__name">内蒙古电力（集团）有限责任公司</span>
        <span className="corp-brand__sub">Inner Mongolia Power</span>
      </div>
    </header>
  );
}
