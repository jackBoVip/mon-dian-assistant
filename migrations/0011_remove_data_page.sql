-- 0011_remove_data_page.sql —— 完整移除「导入/导出」页面。
-- 页面本体与它的菜单节点一起退场：节点、节点派生的菜单权限、各角色的授权行都要清掉，
-- 否则权限页会留下点不到入口的孤儿卡。账号中心的导入/导出弹窗与后端命令不受影响。
--
-- 可重放：migrate.rs 的升级路径守卫会把最新一档真的重跑一遍；删不到东西也算成功。
-- 顺序受外键约束（role_permissions.permission_id → permissions.id）：授权 → 权限 → 节点。

DELETE FROM role_permissions
 WHERE permission_id IN (
   SELECT id FROM permissions
    WHERE permission_key = 'menu.node.tools.data'
       OR permission_key IN (SELECT 'menu.node.' || node_key FROM menu_nodes WHERE page_key = 'data')
 );

DELETE FROM permissions
 WHERE permission_key = 'menu.node.tools.data'
    OR permission_key IN (SELECT 'menu.node.' || node_key FROM menu_nodes WHERE page_key = 'data');

DELETE FROM menu_nodes WHERE page_key = 'data';
