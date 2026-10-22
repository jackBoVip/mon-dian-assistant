import { BrandLogo } from '../ui/BrandLogo';

/**
 * 左上角企业标识条：产品标识 + 中英两行。
 *
 * 2026-10-18 R 轮：I 轮原型里那根 3×26 的主题渐变竖杠换成产品标识（无底板版）。
 * 整条 pointer-events:none，不拦窗口拖动，也不接受焦点；标识本身对读屏静音，
 * 名字由 header 的 aria-label 与右侧两行文字承担。文案是对外主体名称，不随主题与页面变化。
 */
export function CorpBrand() {
  return (
    <header className="corp-brand" aria-label="内蒙古电力（集团）有限责任公司">
      <BrandLogo size={26} className="corp-brand__mark" />
      <div className="corp-brand__text">
        <span className="corp-brand__name">内蒙古电力（集团）有限责任公司</span>
        <span className="corp-brand__sub">Inner Mongolia Power</span>
      </div>
    </header>
  );
}
