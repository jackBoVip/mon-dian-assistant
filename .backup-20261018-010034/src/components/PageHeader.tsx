import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  /** 一句说明：术语免责（外部台账 ≠ 本软件登录凭据）这类必须常驻的话写在这里。 */
  desc: ReactNode;
  /** 右侧动作区，控制台稿把「新增目标」这种主操作放到页头而不是筛选行末尾。 */
  actions?: ReactNode;
}

/**
 * 页头。标题原本挂在顶栏那条蓝栏上，壳层改成贴边控制台式以后顶栏只留工具，
 * 标题责任移交每一页——四个页面共用这一枚，免得页头标题在四处漂成第四种字号。
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
