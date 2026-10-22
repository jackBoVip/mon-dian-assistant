//! V 轮新增的两个出口的真实往返验证：**xlsx 产物**与**浏览器形状（Chrome / Edge 那五列）**。
//!
//! 为什么这两条必须端到端跑：交付方要求"导出保持和谷歌浏览器、Edge 浏览器一样"，
//! 而"一样"只有两个可证伪判据——表头逐字符等于那五列，以及导出的文件能被自己的导入路径读回来
//! 且口令一字不差。中间还夹着一条注入防线：电子表格会把以 `=` 开头的单元格当公式执行，
//! 所以名称里带 `=HYPERLINK(...)` 的目标必须在两条路上都仍然是一段**文本**。
//!
//! 所有数据都是合成凭据，不含任何真实口令。

use std::path::Path;

use mon_dian_assistant_lib::auth::users;
use mon_dian_assistant_lib::crypto::vault_key::VaultKey;
use mon_dian_assistant_lib::crypto::SecretString;
use mon_dian_assistant_lib::db::{repo, Db};
use mon_dian_assistant_lib::importexport::{self, TargetLookup};

const PASS_A: &str = "P@ssA-src";
const PASS_B: &str = "P@ssB-src";
const PASS_C: &str = "P@ssC-src";
/// 以 `=` 开头，正是 CSV 公式注入攻击会挑的形状；名字里再带一个双引号，顺带压一遍引用转义。
const INJECT_NAME: &str = "=HYPERLINK(\"http://evil\")";

fn lookup_of(db: &Db, vk: &VaultKey, user_id: &str) -> TargetLookup {
    let docs = repo::build_search_index(db, vk, user_id).unwrap();
    let index = mon_dian_assistant_lib::quick_launcher::search::SearchIndex::new(docs);
    TargetLookup::new(index.target_hints())
}

fn open_vault(dir: &Path, file: &str, db_key: u8, nickname: &str, master: &str) -> (Db, String, VaultKey) {
    let db = Db::open(&dir.join(file), &vec![db_key; 32]).unwrap();
    let (user_id, vk) = users::initialize(&db, nickname, master).unwrap();
    (db, user_id, vk)
}

/// 三条形状各不相同的凭据，专门覆盖浏览器形状那五列兑不出来的部位：
/// 网页（有 URL）、终端（只有主机+端口，没有 URL）、名称以 `=` 开头的注入哨兵。
fn seed(db: &Db, vk: &VaultKey, user_id: &str) {
    let specs = [
        ("营销系统A", "web", "https://a.example.internal/login", "", "", "", "ops1", "user_a", PASS_A),
        ("机房终端B", "terminal", "", "10.0.0.9", "22", "", "root", "root", PASS_B),
        (INJECT_NAME, "web", "https://c.example.internal/login", "", "", "", "ops3", "user_c", PASS_C),
    ];
    for (name, kind, url, host, port, protocol, alias, username, password) in specs {
        let meta = repo::TargetSecretPayload {
            url: url.to_string(),
            host: host.to_string(),
            port: port.to_string(),
            protocol: protocol.to_string(),
            ..Default::default()
        };
        let target_id = repo::create_target(
            db,
            vk,
            user_id,
            &repo::NewTarget { target_type: kind.to_string(), display_name: name.to_string(), group_id: None, meta },
        )
        .unwrap();
        let payload = repo::CredentialPayload {
            username: username.to_string(),
            password: SecretString::new(password.to_string()),
            auth_method: "password".to_string(),
            confirm_before_fill: true,
            ..Default::default()
        };
        let item = repo::NewItem {
            target_id,
            account_alias: alias.to_string(),
            tags: Vec::new(),
            favorite: false,
            payload,
            set_as_default: true,
        };
        repo::create_item(db, vk, user_id, &item).unwrap();
    }
}

fn payload_of(db: &Db, vk: &VaultKey, user_id: &str, target_name: &str) -> repo::CredentialPayload {
    let target = repo::list_targets(db).unwrap().into_iter().find(|t| t.display_name == target_name).expect("目标应存在");
    let items = repo::list_items_for_target(db, target.id.as_str(), user_id).unwrap();
    assert_eq!(items.len(), 1, "{target_name} 下应恰好一条凭据");
    repo::item_payload(vk, db, &items[0].id).unwrap()
}

fn type_of(db: &Db, target_name: &str) -> String {
    repo::list_targets(db).unwrap().into_iter().find(|t| t.display_name == target_name).map(|t| t.target_type).unwrap_or_default()
}

/// 预览 + 提交，返回落库结果；两份产物（csv / xlsx）都走这一条，避免测试各写一遍语义。
fn import_into(file: &std::path::Path, db: &Db, vk: &VaultKey, user_id: &str) -> importexport::ImportCommitResult {
    let lk = lookup_of(db, vk, user_id);
    let pv = importexport::import_preview(db, user_id, file, &lk).unwrap();
    assert_eq!(pv.error_rows, 0, "导出的文件不该有任何错误行：{:?}", pv.errors);
    importexport::import_commit(db, vk, user_id, &pv.job_id, None, "skip", None, &lk).unwrap()
}

#[test]
fn xlsx_export_reads_back_with_secrets_and_stays_plain_text() {
    let dir = tempfile::tempdir().unwrap();
    let (src_db, src_user, src_vk) = open_vault(dir.path(), "src.db", 11, "源机", "Source#Pass2026!");
    seed(&src_db, &src_vk, &src_user);

    let out = dir.path().join("台账.xlsx");
    let ex = importexport::export_commit(&src_db, &src_vk, &src_user, &out, true, None, None, Some("xlsx"), None).unwrap();
    assert_eq!(ex.format, "xlsx");
    assert!(!ex.encrypted, "xlsx 是可读产物，绝不能自称加密");
    let bytes = std::fs::read(&out).unwrap();
    assert!(bytes.starts_with(b"PK\x03\x04"), "xlsx 必须是 zip 容器形状：前 4 字节 {bytes:?}");

    // 目标库：设备密钥与主密码都不同，模拟换了台机器
    let (db, user, vk) = open_vault(dir.path(), "dst.db", 22, "新机", "Target#Pass2026!");
    let res = import_into(&out, &db, &vk, &user);
    assert_eq!(res.created_targets, 3, "三个目标都该建出来");
    assert_eq!(res.created_items, 3, "三条凭据都该落库");
    assert_eq!(payload_of(&db, &vk, &user, "营销系统A").password.expose(), PASS_A, "口令必须一字不差");
    assert_eq!(payload_of(&db, &vk, &user, "机房终端B").password.expose(), PASS_B);
    // 注入哨兵必须仍以文本回来：write_string 产不出公式单元格，所以不需要 `'` 前缀，也就没被剥掉什么
    let inj = repo::list_targets(&db).unwrap().into_iter().find(|t| t.display_name == INJECT_NAME);
    assert!(inj.is_some(), "xlsx 里名称应以原文存成共享字符串，导入后仍是 {INJECT_NAME}");
    assert_eq!(type_of(&db, "机房终端B"), "terminal", "缺省类型列时台账形状仍带着类型");
}

#[test]
fn browser_shape_is_exactly_the_five_chrome_columns_and_reimports() {
    let dir = tempfile::tempdir().unwrap();
    let (src_db, src_user, src_vk) = open_vault(dir.path(), "src.db", 11, "源机", "Source#Pass2026!");
    seed(&src_db, &src_vk, &src_user);

    let out = dir.path().join("密码.csv");
    let ex = importexport::export_commit(&src_db, &src_vk, &src_user, &out, true, None, None, Some("csv"), Some("browser")).unwrap();
    assert_eq!(ex.format, "csv");
    let text = std::fs::read_to_string(&out).unwrap();
    assert_eq!(text.lines().next().unwrap(), "name,url,username,password,note", "表头必须逐字符等于 Chrome 的那五列");
    // 终端没有 URL，那一列退化成 `主机:端口`——浏览器形状只有五列，这一列得能定位到系统
    assert!(text.contains("10.0.0.9:22"), "终端行的地址列应拼出主机与端口：{text}");
    assert!(text.contains(PASS_A) && text.contains(PASS_B), "勾选明文口令后 password 列必须有值");

    let (db, user, vk) = open_vault(dir.path(), "dst.db", 22, "新机", "Target#Pass2026!");
    let res = import_into(&out, &db, &vk, &user);
    assert_eq!(res.created_items, 3);
    // 文件里没有"目标类型"与"账号别名"两列，这两项由内容推断：地址前缀定类型，用户名当别名
    assert_eq!(type_of(&db, "营销系统A"), "web");
    assert_eq!(type_of(&db, "机房终端B"), "terminal");
    assert_eq!(payload_of(&db, &vk, &user, "营销系统A").username, "user_a");
    assert_eq!(payload_of(&db, &vk, &user, "营销系统A").password.expose(), PASS_A);
    let items = repo::list_items_for_target(&db, repo::list_targets(&db).unwrap().iter().find(|t| t.display_name == "营销系统A").unwrap().id.as_str(), &user).unwrap();
    assert_eq!(items[0].account_alias, "user_a", "别名应由用户名推断出来，而不是留空被拒");
    // 名称以 = 开头的行在 CSV 里带 `'` 前缀，导入侧按非秘密列还原
    assert!(repo::list_targets(&db).unwrap().iter().any(|t| t.display_name == INJECT_NAME), "CSV 的注入前缀应被还原掉");
}

/// 真的拿一份"从 Chrome 导出的形状"喂进来：name 列空着、url 带尾部斜杠、没有别名与类型列。
/// Chrome 自己就不填 name，所以这一条才是"和它一样"的硬判据。
#[test]
fn a_real_chrome_shaped_file_imports_without_alias_or_type_columns() {
    let dir = tempfile::tempdir().unwrap();
    let (db, user, vk) = open_vault(dir.path(), "dst.db", 22, "新机", "Target#Pass2026!");
    let file = dir.path().join("Google-Chrome-密码.csv");
    std::fs::write(
        &file,
        "name,url,username,password,note\n,https://oa.example.cn/,ops1,chrome#Pass1,\n,https://mail.example.cn/,ops2,chrome#Pass2,邮箱\n",
    )
    .unwrap();
    let lk = lookup_of(&db, &vk, &user);
    let pv = importexport::import_preview(&db, &user, &file, &lk).unwrap();
    assert_eq!(pv.total_rows, 2, "两行都该认出来");
    assert_eq!(pv.error_rows, 0, "空 name / 无类型 / 无别名都不该报错：{:?}", pv.errors);
    assert_eq!(pv.file_format, "csv");
    let cm = importexport::import_commit(&db, &vk, &user, &pv.job_id, None, "skip", None, &lk).unwrap();
    assert_eq!(cm.created_items, 2);
    // name 空 → 用站点主机当目标名；类型由 https:// 前缀推断
    assert_eq!(type_of(&db, "oa.example.cn"), "web", "目标名应取自地址主机部分");
    assert_eq!(payload_of(&db, &vk, &user, "mail.example.cn").note, "邮箱");
}

#[test]
fn browser_shape_without_the_checkbox_leaves_the_password_column_empty() {
    let dir = tempfile::tempdir().unwrap();
    let (src_db, src_user, src_vk) = open_vault(dir.path(), "src.db", 11, "源机", "Source#Pass2026!");
    seed(&src_db, &src_vk, &src_user);

    let out = dir.path().join("密码.csv");
    importexport::export_commit(&src_db, &src_vk, &src_user, &out, false, None, None, Some("csv"), Some("browser")).unwrap();
    let text = std::fs::read_to_string(&out).unwrap();
    assert_eq!(text.lines().next().unwrap(), "name,url,username,password,note", "列集合保持稳定，未勾选时 password 留空");
    assert!(!text.contains(PASS_A) && !text.contains(PASS_B) && !text.contains(PASS_C), "未勾选明文口令时文件里不得出现任何口令");
}

/// 台账形状 + 明文口令：文本列仍加 `'` 注入前缀，秘密列不加（加了就把口令本身改错一个字符）。
#[test]
fn ledger_shape_with_secrets_keeps_injection_guard_on_text_columns_only() {
    let dir = tempfile::tempdir().unwrap();
    let (src_db, src_user, src_vk) = open_vault(dir.path(), "src.db", 11, "源机", "Source#Pass2026!");
    seed(&src_db, &src_vk, &src_user);

    let out = dir.path().join("台账.csv");
    let ex = importexport::export_commit(&src_db, &src_vk, &src_user, &out, true, None, None, Some("csv"), Some("ledger")).unwrap();
    assert_eq!(ex.format, "csv");
    let text = std::fs::read_to_string(&out).unwrap();
    assert_eq!(text.lines().next().unwrap().split(',').count(), 18, "台账形状带秘密时应是全部 18 列");
    assert!(text.contains("'=HYPERLINK"), "以 = 开头的名称必须被中和：{text}");
    assert!(text.contains(PASS_A), "勾选后密码列应写出明文");

    let (db, user, vk) = open_vault(dir.path(), "dst.db", 22, "新机", "Target#Pass2026!");
    import_into(&out, &db, &vk, &user);
    assert!(repo::list_targets(&db).unwrap().iter().any(|t| t.display_name == INJECT_NAME), "前缀应在导入时还原");
    assert_eq!(payload_of(&db, &vk, &user, "营销系统A").password.expose(), PASS_A);
}

#[test]
fn content_sniffing_beats_a_lying_extension() {
    let dir = tempfile::tempdir().unwrap();
    let (src_db, src_user, src_vk) = open_vault(dir.path(), "src.db", 11, "源机", "Source#Pass2026!");
    seed(&src_db, &src_vk, &src_user);
    let xlsx = dir.path().join("台账.xlsx");
    importexport::export_commit(&src_db, &src_vk, &src_user, &xlsx, true, None, None, Some("xlsx"), None).unwrap();

    // 同一份字节改个 .csv 名字：导入侧看的是文件头，不是后缀
    let lied = dir.path().join("台账.csv");
    std::fs::copy(&xlsx, &lied).unwrap();
    let (db, user, vk) = open_vault(dir.path(), "dst.db", 22, "新机", "Target#Pass2026!");
    let lk = lookup_of(&db, &vk, &user);
    let pv = importexport::import_preview(&db, &user, &lied, &lk).unwrap();
    assert_eq!(pv.file_format, "xlsx", "应按内容识别成 xlsx");
    assert_eq!(pv.total_rows, 3);
}

#[test]
fn format_shape_and_extension_must_agree_or_nothing_is_written() {
    let dir = tempfile::tempdir().unwrap();
    let (db, user, vk) = open_vault(dir.path(), "src.db", 11, "源机", "Source#Pass2026!");
    seed(&db, &vk, &user);

    let csv_name = dir.path().join("台账.csv");
    let e = importexport::export_commit(&db, &vk, &user, &csv_name, true, None, None, Some("xlsx"), None).unwrap_err();
    assert_eq!(e.code(), "INVALID_INPUT", "xlsx 产物却用 .csv 后缀必须拒：{e:?}");
    assert!(!csv_name.exists(), "被拒时不得留下任何文件");

    let xlsx_name = dir.path().join("台账.xlsx");
    let e = importexport::export_commit(&db, &vk, &user, &xlsx_name, false, None, None, Some("csv"), None).unwrap_err();
    assert_eq!(e.code(), "INVALID_INPUT");

    let e = importexport::export_commit(&db, &vk, &user, &xlsx_name, false, None, None, Some("container"), None).unwrap_err();
    assert_eq!(e.code(), "INVALID_INPUT", "不含秘密的容器没有意义：打不开也没有口令可派生密钥");

    let e = importexport::export_commit(&db, &vk, &user, &csv_name, true, None, None, Some("pdf"), None).unwrap_err();
    assert_eq!(e.code(), "INVALID_INPUT", "不认识的格式不能默默退化成 CSV");
    let e = importexport::export_commit(&db, &vk, &user, &csv_name, true, None, None, Some("csv"), Some("v3")).unwrap_err();
    assert_eq!(e.code(), "INVALID_INPUT");
}

/// 没传 format / shape 的调用方（导入导出页）产物必须逐字节不变：含秘密仍是加密容器。
#[test]
fn legacy_callers_get_the_container_default_still() {
    let dir = tempfile::tempdir().unwrap();
    let (db, user, vk) = open_vault(dir.path(), "src.db", 11, "源机", "Source#Pass2026!");
    seed(&db, &vk, &user);
    let container = dir.path().join("台账.mdaexport");
    let ex = importexport::export_commit(&db, &vk, &user, &container, true, Some("Legacy#Pass2026!x"), None, None, None).unwrap();
    assert_eq!(ex.format, "mdaexport");
    assert!(ex.encrypted);
    let plain = dir.path().join("台账2.csv");
    let ex = importexport::export_commit(&db, &vk, &user, &plain, false, None, None, None, None).unwrap();
    assert_eq!(ex.format, "csv");
    assert!(!ex.encrypted);
}

#[test]
fn preview_reports_the_columns_that_will_actually_be_written() {
    let dir = tempfile::tempdir().unwrap();
    let (db, user, vk) = open_vault(dir.path(), "src.db", 11, "源机", "Source#Pass2026!");
    seed(&db, &vk, &user);

    let p = importexport::export_preview(&db, &vk, &user, true, None, Some("xlsx"), Some("browser")).unwrap();
    assert_eq!(p.columns, vec!["name", "url", "username", "password", "note"]);
    assert_eq!(p.format, "xlsx (Excel)");
    assert_eq!(p.items, 3);
    assert!(p.warning.contains("明文口令"), "警告必须说清这份文件没有保护：{}", p.warning);

    let q = importexport::export_preview(&db, &vk, &user, false, None, Some("csv"), Some("browser")).unwrap();
    assert_eq!(q.columns, vec!["name", "url", "username", "password", "note"], "列集合不随勾选变化");
    assert!(!q.warning.contains("明文口令"), "没勾明文口令就不该吓唬人：{}", q.warning);

    let r = importexport::export_preview(&db, &vk, &user, false, None, None, None).unwrap();
    assert_eq!(r.format, "csv", "未传 format 时预览的口径与实际产物一致");
    assert_eq!(r.columns.len(), 13, "台账形状不含秘密时是 13 列");
}
