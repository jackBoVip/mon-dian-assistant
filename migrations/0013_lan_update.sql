-- 0013：局域网单源镜像更新。
--
-- 同网段里只要有一台机器拿到了新版，其他机器就应当能发现它并拉取。
-- 这条通道不改变安全模型：清单仍必须通过 Ed25519 验签，包仍必须匹配 SHA-256；
-- 放宽的只有信道——仅对私网 IP 字面量允许明文 HTTP。
--
-- 权限单独一枚：开放入站端口是运维暴露面，与「改更新源」「装更新」不是同一类授权。
INSERT OR IGNORE INTO permissions (id, permission_key, name, type, description) VALUES
  ('p-sys-update-serve', 'system.update.serve', '局域网更新源', 'action', '允许本机向同网段提供已签名的更新包');

-- 0002 里「全部权限给 r-admin」是一条当时的快照，新权限必须显式补授。
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'r-admin', id FROM permissions WHERE permission_key = 'system.update.serve';

-- lan_discovery_enabled 出厂即为 true：只是被动监听组播，不监听端口、不暴露任何内容。
-- 真正需要管理员显式同意的是 lan_serve_enabled（会 bind 0.0.0.0 并弹防火墙）。
INSERT OR IGNORE INTO app_settings (key, value, scope, updated_at) VALUES
  ('lan_discovery_enabled', 'true', 'security', '2026-10-23T00:00:00Z'),
  ('lan_serve_enabled', 'false', 'security', '2026-10-23T00:00:00Z'),
  ('lan_serve_dir', '', 'security', '2026-10-23T00:00:00Z'),
  ('lan_manual_source', '', 'security', '2026-10-23T00:00:00Z');
