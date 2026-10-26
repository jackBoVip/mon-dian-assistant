/**
 * 审计日志的中文显示层。
 *
 * 后端写进 `audit_events.action` / `.target_type` 的是稳定标识（`accounts.item.create`、`role`…），
 * 那些字面量同时被 `rbac` 与查询条件用着，不能改；界面要中文，就在这一层翻。
 * 名单由被检对象推导：`auditLabels.test.ts` 扫 `src-tauri/src` 里每一处 `audit(…)`) /
 * `audit::record(…)` 调用，把动作与对象类型逐条对到这张表上——后端新增一条而这里没登记，测试就红。
 * 查不到的键一律回落到原标识：库里可能留着更早版本写下的记录，宁可显示英文也不能显示空白。
 */

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  'accounts.connect': '连接目标',
  'accounts.copy.password': '复制密码',
  'accounts.copy.username': '复制账号名',
  'accounts.default.set': '设为默认账号',
  'accounts.export.commit': '导出台账',
  'accounts.export.plaintext_secrets': '导出明文秘密',
  'accounts.export.with_secrets': '导出（含秘密）',
  'accounts.fill.request': '发起自动填充',
  'accounts.fill.success': '自动填充成功',
  'accounts.fill.unavailable': '自动填充不可用',
  'accounts.group.create': '新建分组',
  'accounts.import.commit': '导入台账',
  'accounts.import.preview': '预览导入文件',
  'accounts.item.create': '新增凭据',
  'accounts.item.delete': '删除凭据',
  'accounts.item.restore': '还原凭据',
  'accounts.item.status': '启用/停用凭据',
  'accounts.item.update': '修改凭据',
  'accounts.open_target': '打开目标地址',
  'accounts.secret.reveal': '查看密码',
  'accounts.target.create': '新增目标',
  'accounts.target.delete': '删除目标',
  'accounts.target.status': '启用/停用目标',
  'accounts.target.update': '修改目标',
  'auth.admin_reset': '管理员重置主密码',
  'auth.change_password': '修改主密码',
  'auth.unlock': '解锁保险库',
  'container.import.commit': '导入加密容器',
  'container.import.preview': '预览加密容器',
  'extension.challenge.denied': '扩展来源被拒',
  'extension.fill.denied': '扩展填充被拒',
  'extension.hello': '扩展接入',
  'extension.host_manifest.install': '安装扩展通道清单',
  'extension.host_manifest.uninstall': '卸载扩展通道清单',
  'lan.serve.disable': '停止提供局域网更新',
  'lan.serve.enable': '开始提供局域网更新',
  'lan.update.check': '从局域网检查更新',
  'profile.nickname': '修改自己的昵称',
  'quick_launcher.shortcut.set': '设置启动器快捷键',
  'quick_launcher.view_detail': '从启动器查看详情',
  'session.auto_lock': '空闲自动锁定',
  'session.lock': '锁定保险库',
  'session.reauth': '二次认证',
  'session.sleep_lock': '系统休眠锁定',
  'system.backup.create': '创建备份',
  'system.backup.restore': '恢复备份',
  'system.backup.verify': '校验备份',
  'system.device_key.consent': '同意使用本机文件密钥',
  'system.menu.create': '新增菜单',
  'system.menu.delete': '删除菜单',
  'system.menu.move': '调整菜单顺序',
  'system.menu.rename': '修改菜单名称',
  'system.menu.status': '启用/停用菜单',
  'system.role.create': '新建角色',
  'system.role.delete': '删除角色',
  'system.role.menus': '保存角色菜单可见性',
  'system.role.permissions': '保存角色操作权限',
  'system.role.update': '修改角色',
  'system.setting.update': '修改应用设置',
  'system.user.create': '新增使用者',
  'system.user.roles': '调整使用者角色',
  'system.user.status': '启用/停用使用者',
  'vault.initialize': '初始化保险库',
};

/** `audit_events.target_type` 的中文名单；与动作表同一套回落规则。 */
export const AUDIT_ENTITY_LABELS: Record<string, string> = {
  app_user: '使用者',
  backup: '备份文件',
  channel: '扩展通道',
  device: '设备密钥',
  file: '文件',
  group: '分组',
  import_container: '加密容器',
  import_job: '导入任务',
  item: '凭据',
  menu_node: '菜单节点',
  origin: '来源站点',
  role: '角色',
  session: '会话',
  setting: '设置项',
  target: '目标',
  update: '更新通道',
  vault: '保险库',
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

export function auditEntityLabel(targetType: string): string {
  return AUDIT_ENTITY_LABELS[targetType] ?? targetType;
}

/**
 * 「这串 id 只是主键，读不出任何信息」的判据：UUID，或 `ci-` / `r-` / `t-` 这类前缀 + UUID。
 * 审计界面上这一类一律不上屏（交付方 2026-10-22：对象列那串 UUID 不要），
 * 但**不透明的只有 UUID**——导出文件名（`蒙电台账-2026-10-22.json.enc`）、
 * 菜单节点键（`mn-settings-backup`）这类可读标识仍然显示，否则那一行就指不到东西了。
 */
const OPAQUE_ID = /^[a-z]*-?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isOpaqueAuditId(targetId: string): boolean {
  return OPAQUE_ID.test(targetId);
}
