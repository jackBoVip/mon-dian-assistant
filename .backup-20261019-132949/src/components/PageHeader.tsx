import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  /** 一句说明：术语免责（外部台账 ≠ 本软件登录凭据）这类必须常驻的话写在这里。 */
  desc: ReactNode;
  /** 右侧动作区，控制台稿把「新增目标」这种主操作放到页头而不是筛选行末尾。 */
  actions?: ReactNode;
}

/**
 * 页头：标题 + 一句说明 + 右侧动作区。
 *
 * S 轮（2026-10-18）重新启用：顶栏换成原型那枚胶囊导航后不再承载页名，标题回到各页自己头上，
 * 整屏仍是唯一一枚 h1。P 轮把它撤下、R/Q 轮把标题搬到顶栏的那段历史见交付文档。
 */
export function PageHeader({ title, desc, actions }: PageHeaderProps) {
  return (
    <div className="page-header">
      <div className="page-heading">
        <h1 className="page-title">{title}</h1>
        <p className="page-desc">{desc}</p>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}
