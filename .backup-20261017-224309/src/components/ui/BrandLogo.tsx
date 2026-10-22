import logoUrl from '../../assets/brand/logo-placeholder.svg';

export interface BrandLogoProps {
  /** 标识直径（px）。左栏完整品牌区用默认值，紧凑品牌区传小一档。 */
  size?: number;
  className?: string;
}

/**
 * 企业标志图形。只画标志本身——公司名与产品名由调用方单独排版（认证页见 `auth/CorpBrand`，主壳见侧栏），
 * 这样正式 Logo 不会被和产品名合成一张难以替换的位图。
 *
 * ⚠️ 当前素材是 **placeholder**：按设计参考图重绘的示意标，不是企业授权素材，
 * 不得对外称为官网原版。替换时只改下面这一行 import（文件放 src/assets/brand/logo.svg），
 * 页面布局与样式都不需要改动。
 * 严禁拉伸、改色、加玻璃滤镜；正方形宽高保证比例不被破坏。
 */
export function BrandLogo({ size = 44, className }: BrandLogoProps) {
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      className={className}
      data-brand-logo="placeholder"
      alt="内蒙古电力（集团）有限责任公司标识（占位重绘，非官方授权素材）"
    />
  );
}
