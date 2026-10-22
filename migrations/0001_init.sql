-- 蒙电信产助手 / 0001_init.sql
-- 领域边界（不得混淆）：
--   app_users             = 本软件本地使用者（解锁保险库的人）
--   vault_targets         = 外部系统「目标/地址」
--   vault_items           = 某个目标下的一条外部账号凭据（同一目标允许多条）
--   vault_target_preferences = 每位本地使用者 × 每个目标 的默认凭据偏好
-- 全库由 SQLCipher 加密；凭据载荷再叠加应用层 AEAD。

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- 本地使用者
CREATE TABLE app_users (
  id                     TEXT PRIMARY KEY,           -- UUIDv7，系统生成
  generated_account_code TEXT NOT NULL UNIQUE,       -- 内部标识，系统生成，用户不输入
  nickname               TEXT NOT NULL,              -- 显示名，允许重复，非唯一键
  status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  -- 主密码只保存 Argon2id 派生的验证材料，绝不保存可逆原文
  pwd_kdf_alg            TEXT NOT NULL,
  pwd_verify_salt        BLOB NOT NULL,
  pwd_verify_hash        BLOB NOT NULL,
  pwd_kdf_m_kib          INTEGER NOT NULL,
  pwd_kdf_t              INTEGER NOT NULL,
  pwd_kdf_p              INTEGER NOT NULL,
  failed_login_count     INTEGER NOT NULL DEFAULT 0,
  locked_until           TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  last_login_at          TEXT,
  deleted_at             TEXT
);

-- 保险库数据密钥（DEK）对每位授权使用者的加密封装
CREATE TABLE user_key_wrappers (
  app_user_id    TEXT NOT NULL REFERENCES app_users(id),
  key_version    INTEGER NOT NULL,
  wrap_alg       TEXT NOT NULL,                      -- AES-256-GCM-KW
  wrap_salt      BLOB NOT NULL,                      -- 与验证盐独立
  wrap_nonce     BLOB NOT NULL,
  wrapped_dek    BLOB NOT NULL,
  aad            TEXT NOT NULL,                      -- 绑定 user_id + key_version
  created_at     TEXT NOT NULL,
  primary key (app_user_id, key_version)
);

CREATE TABLE key_metadata (
  key_version  INTEGER PRIMARY KEY,
  status       TEXT NOT NULL CHECK (status IN ('active','rotating','retired')),
  created_at   TEXT NOT NULL,
  rotated_at   TEXT
);

-- ---------------------------------------------------------------- RBAC
CREATE TABLE roles (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  builtin     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE permissions (
  id            TEXT PRIMARY KEY,
  permission_key TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('menu','action')),
  description   TEXT
);

CREATE TABLE user_roles (
  user_id TEXT NOT NULL REFERENCES app_users(id),
  role_id TEXT NOT NULL REFERENCES roles(id),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE role_permissions (
  role_id       TEXT NOT NULL REFERENCES roles(id),
  permission_id TEXT NOT NULL REFERENCES permissions(id),
  PRIMARY KEY (role_id, permission_id)
);

-- ---------------------------------------------------------------- 外部凭据台账
CREATE TABLE vault_groups (
  id         TEXT PRIMARY KEY,
  parent_id  TEXT REFERENCES vault_groups(id),
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE vault_targets (
  id           TEXT PRIMARY KEY,
  target_type  TEXT NOT NULL CHECK (target_type IN
                 ('web','terminal','database','network_device','cloud_service',
                  'file_transfer','application','generic_secret')),
  display_name TEXT NOT NULL,
  group_id     TEXT REFERENCES vault_groups(id),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_by   TEXT REFERENCES app_users(id),
  updated_by   TEXT REFERENCES app_users(id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  -- 地址/URL 绝不作为唯一约束：同一地址允许多个目标与多条凭据
  last_accessed_at TEXT
);
CREATE INDEX idx_targets_type ON vault_targets(target_type);
CREATE INDEX idx_targets_group ON vault_targets(group_id);

CREATE TABLE vault_target_secrets (
  target_id             TEXT PRIMARY KEY REFERENCES vault_targets(id),
  ciphertext            BLOB NOT NULL,
  algorithm             TEXT NOT NULL,
  nonce                 BLOB NOT NULL,
  key_version           INTEGER NOT NULL,
  payload_schema_version INTEGER NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE vault_items (
  id            TEXT PRIMARY KEY,
  target_id     TEXT NOT NULL REFERENCES vault_targets(id),
  account_alias TEXT NOT NULL,
  item_type     TEXT NOT NULL CHECK (item_type IN
                  ('web','terminal','database','network_device','cloud_service',
                   'file_transfer','application','generic_secret')),
  group_id      TEXT REFERENCES vault_groups(id),
  favorite      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_by    TEXT REFERENCES app_users(id),
  updated_by    TEXT REFERENCES app_users(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  deleted_at    TEXT,
  last_accessed_at TEXT
  -- 故意不建 (target_id, username) 唯一索引：同一目标下多账号是合法场景
);
CREATE INDEX idx_items_target ON vault_items(target_id);
CREATE INDEX idx_items_type ON vault_items(item_type);

CREATE TABLE vault_item_secrets (
  item_id                TEXT PRIMARY KEY REFERENCES vault_items(id),
  ciphertext             BLOB NOT NULL,
  algorithm              TEXT NOT NULL,
  nonce                  BLOB NOT NULL,
  key_version            INTEGER NOT NULL,
  payload_schema_version INTEGER NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE TABLE vault_item_tags (
  item_id TEXT NOT NULL REFERENCES vault_items(id),
  tag     TEXT NOT NULL,
  PRIMARY KEY (item_id, tag)
);
CREATE INDEX idx_tags_tag ON vault_item_tags(tag);

CREATE TABLE vault_item_acl (
  id                    TEXT PRIMARY KEY,
  item_id               TEXT NOT NULL REFERENCES vault_items(id),
  subject_type          TEXT NOT NULL CHECK (subject_type IN ('user','role')),
  subject_id            TEXT NOT NULL,
  actions               TEXT NOT NULL,   -- 逗号分隔动作集合
  granted_by            TEXT REFERENCES app_users(id),
  created_at            TEXT NOT NULL
);

-- 默认账号：每位本地使用者 × 每个目标，最多一条
CREATE TABLE vault_target_preferences (
  app_user_id          TEXT NOT NULL REFERENCES app_users(id),
  target_id            TEXT NOT NULL REFERENCES vault_targets(id),
  default_vault_item_id TEXT NOT NULL REFERENCES vault_items(id),
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (app_user_id, target_id)
);

-- 默认凭据必须属于同一目标且未删除，否则拒绝写入
CREATE TRIGGER trg_pref_item_same_target
BEFORE INSERT ON vault_target_preferences
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM vault_items i
    WHERE i.id = NEW.default_vault_item_id
      AND i.target_id = NEW.target_id
      AND i.deleted_at IS NULL
  ) THEN RAISE(ABORT, 'default credential must belong to the same active target') END;
END;

CREATE TRIGGER trg_pref_item_same_target_update
BEFORE UPDATE ON vault_target_preferences
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM vault_items i
    WHERE i.id = NEW.default_vault_item_id
      AND i.target_id = NEW.target_id
      AND i.deleted_at IS NULL
  ) THEN RAISE(ABORT, 'default credential must belong to the same active target') END;
END;

-- 默认凭据被软删除时，同事务链路上清除偏好（避免悬空默认）
CREATE TRIGGER trg_pref_clear_on_item_delete
AFTER UPDATE OF deleted_at ON vault_items
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
BEGIN
  DELETE FROM vault_target_preferences WHERE default_vault_item_id = NEW.id;
END;

CREATE TRIGGER trg_pref_clear_on_item_disable
AFTER UPDATE OF status ON vault_items
WHEN NEW.status = 'disabled'
BEGIN
  DELETE FROM vault_target_preferences WHERE default_vault_item_id = NEW.id;
END;

-- ---------------------------------------------------------------- 设置与偏好
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT 'install' CHECK (scope IN ('install','security','ui')),
  updated_at TEXT NOT NULL
);

-- 本地使用者个人偏好（不与安装级设置互相覆盖）
CREATE TABLE user_preferences (
  app_user_id TEXT NOT NULL REFERENCES app_users(id),
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (app_user_id, key)
);

CREATE TABLE quick_launcher_preferences (
  app_user_id TEXT NOT NULL REFERENCES app_users(id),
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (app_user_id, key)
);

-- ---------------------------------------------------------------- 审计
CREATE TABLE audit_events (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  result      TEXT NOT NULL CHECK (result IN ('success','failure','denied')),
  error_code  TEXT,
  source      TEXT,
  metadata    TEXT   -- 仅动作元数据，禁止秘密正文
);
CREATE INDEX idx_audit_ts ON audit_events(ts);
CREATE INDEX idx_audit_actor ON audit_events(actor_id);

-- 审计日志只追加：禁止 UPDATE / DELETE
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;

-- ---------------------------------------------------------------- 导入任务
CREATE TABLE import_jobs (
  id          TEXT PRIMARY KEY,
  created_by  TEXT REFERENCES app_users(id),
  filename    TEXT NOT NULL,
  file_format TEXT NOT NULL CHECK (file_format IN ('csv','xlsx')),
  status      TEXT NOT NULL CHECK (status IN ('pending','parsing','preview','running','success','failed','cancelled')),
  conflict_policy TEXT NOT NULL DEFAULT 'skip' CHECK (conflict_policy IN ('skip','abort','update')),
  total_rows  INTEGER NOT NULL DEFAULT 0,
  valid_rows  INTEGER NOT NULL DEFAULT 0,
  error_rows  INTEGER NOT NULL DEFAULT 0,
  conflict_rows INTEGER NOT NULL DEFAULT 0,
  imported_rows INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT,
  finished_at TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE import_job_errors (
  id        TEXT PRIMARY KEY,
  job_id    TEXT NOT NULL REFERENCES import_jobs(id),
  row_no    INTEGER NOT NULL,
  code      TEXT NOT NULL,
  message   TEXT NOT NULL,   -- 不得复制敏感单元格原文
  field     TEXT
);
CREATE INDEX idx_import_err_job ON import_job_errors(job_id);

CREATE TABLE update_checks (
  id            TEXT PRIMARY KEY,
  ts            TEXT NOT NULL,
  channel       TEXT NOT NULL,
  current_version TEXT NOT NULL,
  latest_version  TEXT,
  signature_ok  INTEGER,
  result        TEXT NOT NULL,
  error_code    TEXT
);
