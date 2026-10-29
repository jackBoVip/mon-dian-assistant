-- 0015_quiz.sql —— 题库、导入任务、答题助手偏好与全库检索索引。
--
-- 三件事被放在同一档里，因为它们互为前置：题库表没有 FTS 就查不动，导入任务的发布目标
-- 只能落在题库表上，助手的「全部/指定题库」范围又直接引用题库 id。
--
-- 题库存进同一个 SQLCipher 保险库（而不是另开一个明文文件）是刻意的：题目里常常带客户名、
-- 工程编号这类信息，锁库就该连题库一起锁；备份、审计、RBAC 也一并复用，不必再造一套。
-- 代价是「锁库后 OCR 必须停」——这一点由 assistant 的每 tick 会话检查兑现，不靠界面提示。
--
-- 一律可重放（IF NOT EXISTS / INSERT OR IGNORE）：`migrate.rs` 的升级路径守卫会把最新
-- 这一档真的重跑一遍。

-- 题库：允许重名（同一份资料按版本反复导入是常态，用 created_at/updated_at 区分即可），
-- 但不允许空名。created_by 不建外键：删掉一个用户不该连带删掉他导入的题库。
CREATE TABLE IF NOT EXISTS quiz_libraries (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  source_format   TEXT NOT NULL CHECK (source_format IN ('docx','txt','xlsx','csv')),
  source_filename TEXT NOT NULL DEFAULT '',
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK (length(trim(name)) BETWEEN 1 AND 64)
);

-- 题目：stem_norm/options_norm/answer_norm 是匹配用的归一化文本（全角转半角、去题号与标点），
-- 原文另存 stem/options_json/answer_json 供界面展示与导出，绝不用归一化文本回显。
-- UNIQUE (library_id, seq) 让发布时能按 seq 稳定对齐、也能让重复导入被识别。
CREATE TABLE IF NOT EXISTS quiz_questions (
  id             TEXT PRIMARY KEY,
  library_id     TEXT NOT NULL REFERENCES quiz_libraries(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  qtype          TEXT NOT NULL CHECK (qtype IN ('single','multiple','true_false','fill_blank')),
  stem           TEXT NOT NULL,
  stem_norm      TEXT NOT NULL,
  options_json   TEXT NOT NULL DEFAULT '[]',
  options_norm   TEXT NOT NULL DEFAULT '',
  answer_json    TEXT NOT NULL,
  answer_display TEXT NOT NULL,
  answer_norm    TEXT NOT NULL DEFAULT '',
  tags_json      TEXT NOT NULL DEFAULT '[]',
  confidence     REAL NOT NULL DEFAULT 1,
  issues_json    TEXT NOT NULL DEFAULT '[]',
  source_ref     TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (library_id, seq)
);

-- 导入任务：解析完先落成 review，复核通过才发布成题库。发布后行数据仍留着供追溯，
-- 但 published_library_id 才是它真正去了哪。
CREATE TABLE IF NOT EXISTS quiz_import_jobs (
  id                   TEXT PRIMARY KEY,
  library_name         TEXT NOT NULL,
  source_format        TEXT NOT NULL CHECK (source_format IN ('docx','txt','xlsx','csv')),
  source_filename      TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('review','published','discarded','failed')),
  total_rows           INTEGER NOT NULL DEFAULT 0,
  included_rows        INTEGER NOT NULL DEFAULT 0,
  issue_rows           INTEGER NOT NULL DEFAULT 0,
  error_code           TEXT,
  created_by           TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  published_library_id TEXT REFERENCES quiz_libraries(id) ON DELETE SET NULL
);

-- 待复核行：include=0 的行发布时跳过（默认排除文内重复与低置信），edited 只用于在复核表上
-- 标出「这行被人改过」，不参与任何判定。
CREATE TABLE IF NOT EXISTS quiz_import_rows (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES quiz_import_jobs(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  qtype         TEXT NOT NULL CHECK (qtype IN ('single','multiple','true_false','fill_blank')),
  stem          TEXT NOT NULL,
  options_json  TEXT NOT NULL DEFAULT '[]',
  answer_json   TEXT NOT NULL,
  tags_json     TEXT NOT NULL DEFAULT '[]',
  confidence    REAL NOT NULL DEFAULT 0,
  issues_json   TEXT NOT NULL DEFAULT '[]',
  source_ref    TEXT,
  include       INTEGER NOT NULL DEFAULT 1 CHECK (include IN (0,1)),
  edited        INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0,1)),
  UNIQUE (job_id, seq)
);

-- 助手偏好：一人一行。dwell_ms 的上限比界面滑块略宽，留出以后调参的余量。
CREATE TABLE IF NOT EXISTS quiz_assistant_preferences (
  app_user_id  TEXT PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  enabled      INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  scope_mode   TEXT NOT NULL DEFAULT 'all' CHECK (scope_mode IN ('all','selected')),
  dwell_ms     INTEGER NOT NULL DEFAULT 520 CHECK (dwell_ms BETWEEN 200 AND 2000),
  hotkey       TEXT NOT NULL DEFAULT 'CmdOrCtrl+Alt+Q',
  show_options INTEGER NOT NULL DEFAULT 1 CHECK (show_options IN (0,1)),
  updated_at   TEXT NOT NULL
);

-- 「指定题库」模式下的白名单：空集合在命令侧按 QUIZ_SCOPE_EMPTY 拒绝，不允许默默退回全库。
CREATE TABLE IF NOT EXISTS quiz_assistant_scope (
  app_user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  library_id  TEXT NOT NULL REFERENCES quiz_libraries(id) ON DELETE CASCADE,
  PRIMARY KEY (app_user_id, library_id)
);

CREATE INDEX IF NOT EXISTS idx_quiz_libraries_updated ON quiz_libraries(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_quiz_questions_library_seq ON quiz_questions(library_id, seq);
CREATE INDEX IF NOT EXISTS idx_quiz_questions_library_type_seq ON quiz_questions(library_id, qtype, seq);
CREATE INDEX IF NOT EXISTS idx_quiz_import_rows_job_seq ON quiz_import_rows(job_id, seq);
CREATE INDEX IF NOT EXISTS idx_quiz_import_jobs_status ON quiz_import_jobs(status, updated_at DESC);

-- 全文检索：external content 表 + 三个标准触发器。
-- trigram 分词器是这一档的关键选择——默认 unicode61 会把一整句中文当成一个 token，
-- 输入「下列哪个选项」永远命中不了「下列关于…的说法正确的是」；trigram 按三字窗口切，
-- 中文子串检索才成立。代价是查询串必须 ≥3 个字符（2 字查询由 match.rs 回落 LIKE）。
-- detail='full' 才能让 bm25() 参与排序；stem_norm/options_norm 必须作为真实列存在，
-- 否则 'rebuild' 指令会失败——它们在上面 quiz_questions 里已经有了。
CREATE VIRTUAL TABLE IF NOT EXISTS quiz_question_fts USING fts5(
  stem_norm,
  options_norm,
  content='quiz_questions',
  content_rowid='rowid',
  tokenize='trigram',
  detail='full'
);

CREATE TRIGGER IF NOT EXISTS quiz_questions_ai AFTER INSERT ON quiz_questions BEGIN
  INSERT INTO quiz_question_fts(rowid, stem_norm, options_norm)
    VALUES (new.rowid, new.stem_norm, new.options_norm);
END;

CREATE TRIGGER IF NOT EXISTS quiz_questions_ad AFTER DELETE ON quiz_questions BEGIN
  INSERT INTO quiz_question_fts(quiz_question_fts, rowid, stem_norm, options_norm)
    VALUES ('delete', old.rowid, old.stem_norm, old.options_norm);
END;

CREATE TRIGGER IF NOT EXISTS quiz_questions_au AFTER UPDATE OF stem_norm, options_norm ON quiz_questions BEGIN
  INSERT INTO quiz_question_fts(quiz_question_fts, rowid, stem_norm, options_norm)
    VALUES ('delete', old.rowid, old.stem_norm, old.options_norm);
  INSERT INTO quiz_question_fts(rowid, stem_norm, options_norm)
    VALUES (new.rowid, new.stem_norm, new.options_norm);
END;

-- 第五枚一级入口「题库」：parent_id 为 NULL 的 page 节点（与 top.accounts 同形）。
-- sort_order=15 把它放在「账号中心」与「系统管理」之间；菜单只决定入口是否出现，
-- 页面里能不能读/导/改由 quiz.* 这几枚权限说了算。
INSERT OR IGNORE INTO menu_nodes
  (id, node_key, parent_id, label, page_key, kind, builtin, status, sort_order, created_at, updated_at)
VALUES
  ('mn-top-quiz', 'top.quiz', NULL, '题库', 'quiz', 'page', 1, 'active', 15,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- 菜单权限：与 0010 同一口径，节点键 = menu.node.<node_key>，回填给每一枚既有角色。
INSERT OR IGNORE INTO permissions (id, permission_key, name, type, description) VALUES
  ('p-menu-node-top-quiz', 'menu.node.top.quiz', '题库', 'menu', '一级菜单入口（题库）');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key = 'menu.node.top.quiz';

-- 操作权限：读题库与用助手是普通用户就该有的能力；导入与删改题目属于台账维护，
-- 只给两档管理员。自定义角色不在这里种，之后由权限页显式勾选。
INSERT OR IGNORE INTO permissions (id, permission_key, name, type, description) VALUES
  ('p-quiz-library-read',    'quiz.library.read',    '查看题库',   'action', '查看题库列表与题目'),
  ('p-quiz-library-import',  'quiz.library.import',  '导入题库',   'action', '解析并发布导入任务'),
  ('p-quiz-library-manage',  'quiz.library.manage',  '管理题库',   'action', '重命名、删除、重建索引'),
  ('p-quiz-assistant-use',   'quiz.assistant.use',   '使用答题助手', 'action', '开启悬停取词、手动识别与修改助手配置');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM roles r
   JOIN permissions p ON p.permission_key IN ('quiz.library.read', 'quiz.assistant.use')
  WHERE r.id IN ('r-admin', 'r-mgr', 'r-user');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM roles r
   JOIN permissions p ON p.permission_key IN ('quiz.library.import', 'quiz.library.manage')
  WHERE r.id IN ('r-admin', 'r-mgr');
