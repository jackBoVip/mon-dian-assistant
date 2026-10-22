import logoUrl from '../../assets/brand/logo.svg';

export interface BrandLogoProps {
  /** 标识边长（px）。侧栏品牌位用 28，认证页企业名条用 26，其余默认 44。 */
  size?: number;
  className?: string;
}

/**
 * 产品标识：绿色渐变闪电（尖上的白色节点已按交付方要求撤掉），无底板版，源文件 `design/app-mark.svg`。
 *
 * 只画标志本身——公司名与产品名由调用方单独排版（认证页见 `auth/CorpBrand`，主壳见侧栏），
 * 这样标识不会和文字合成一张难以替换的位图。打包图标（Dock/Finder/安装包）是另一版：
 * `design/app-icon.svg` 带深色圆角底板，28px 的界面位不需要那层底板。
 *
 * 三处落点旁边都排着文字名，所以标识本身对读屏静音（`alt=""`），
 * 避免"标识名 + 产品名"被念两遍。严禁拉伸、改色、加玻璃滤镜：正方形宽高 + 原始 viewBox
 * 保证比例不被破坏，取色全部留在 SVG 里。
 */
export function BrandLogo({ size = 44, className }: BrandLogoProps) {
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      className={className}
      data-brand-logo="app-mark"
      alt=""
      draggable={false}
    />
  );
}
