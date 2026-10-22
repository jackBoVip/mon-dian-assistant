//! 口令加密容器的真实端到端验证：export_commit（写侧）→ container_preview → container_commit（读侧）。
//!
//! 这一条路是"设备密钥丢失后唯一还能把台账重建出来"的产物，所以测试必须真的用**两台机器**的形状来做：
//! 源库与目标库各有不同的设备密钥与主密码，容器只用口令派生密钥。若容器其实依赖设备密钥，
//! 下面第一步的 preview 就打不开，测试会当场失败。
//!
//! 所有数据都是合成凭据，不含任何真实口令。

use std::path::Path;

use mon_dian_assistant_lib::auth::users;
use mon_dian_assistant_lib::crypto::vault_key::VaultKey;
use mon_dian_assistant_lib::crypto::SecretString;
use mon_dian_assistant_lib::db::{repo, Db};
use mon_dian_assistant_lib::error::AppError;
use mon_dian_assistant_lib::importexport::{self, TargetLookup};

const CONTAINER_PASS: &str = "Contain#Pass2026!";

fn lookup_of(db: &Db, vk: &VaultKey, user_id: &str) -> TargetLookup {
    let docs = repo::build_search_index(db, vk, user_id).unwrap();
    let index = mon_dian_assistant_lib::quick_launcher::search::SearchIndex::new(docs);
    TargetLookup::new(index.target_hints())
}

/// 两个独立保险库：设备密钥与主密码都不同，模拟"换了一台机器"。
fn open_vault(dir: &Path, file: &str, db_key: u8, nickname: &str, master: &str) -> (Db, String, VaultKey) {
    let db = Db::open(&dir.join(file), &vec![db_key; 32]).unwrap();
    let (user_id, vk) = users::initialize(&db, nickname, master).unwrap();
    (db, user_id, vk)
}

/// 源库里放 3 条凭据：web（用户名口令）、terminal（私钥 + 私钥口令）、db（令牌，且设为默认）。
/// 私钥/私钥口令这两列曾经根本不在导出里，所以这里给它们独一的哨兵值，专门验证它们能回来。
fn seed_source(db: &Db, vk: &VaultKey, user_id: &str) {
    let specs = [
        ("营销系统A", "web", "https://a.example.internal/login", "ops1", "user_a", "P@ssA-src", "", "", true, "生产"),
        ("机房终端B", "terminal", "ssh://10.0.0.9", "root", "root", "", "PRIVATE-KEY-BLOB-SRC", "key-pass-SRC", false, "机房,SSH"),
        ("报表库C", "database", "jdbc:oracle://c.example.internal:1521/orcl", "readonly", "", "", "", "", true, "只读"),
    ];
    for (name, kind, url, alias, username, password, private_key, passphrase, set_as_default, tags) in specs {
        let meta = repo::TargetSecretPayload {
            url: url.to_string(),
            host: url.to_string(),
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
            token: SecretString::new(String::new()),
            private_key: SecretString::new(private_key.to_string()),
            passphrase: SecretString::new(passphrase.to_string()),
            auth_method: if private_key.is_empty() { "password".to_string() } else { "key".to_string() },
            note: String::new(),
            confirm_before_fill: true,
            ..Default::default()
        };
        let item = repo::NewItem {
            target_id,
            account_alias: alias.to_string(),
            tags: tags.split(',').map(|t| t.to_string()).filter(|t| !t.is_empty()).collect(),
            favorite: false,
            payload,
            set_as_default,
        };
        repo::create_item(db, vk, user_id, &item).unwrap();
    }
}

fn expose(db: &Db, vk: &VaultKey, user_id: &str, target_name: &str) -> repo::CredentialPayload {
    let target = repo::list_targets(db).unwrap().into_iter().find(|t| t.display_name == target_name).expect("目标应存在");
    let items = repo::list_items_for_target(db, target.id.as_str(), user_id).unwrap();
    assert_eq!(items.len(), 1, "{target_name} 下应恰好一条凭据");
    repo::item_payload(vk, db, &items[0].id).unwrap()
}

#[test]
fn container_roundtrip_between_two_independent_vaults() {
    let dir = tempfile::tempdir().unwrap();

    // —— 源库 ——
    let (src_db, src_user, src_vk) = open_vault(dir.path(), "src.db", 11, "源机", "Source#Pass2026!");
    seed_source(&src_db, &src_vk, &src_user);

    let container = dir.path().join("台账.mdaexport");
    let ex = importexport::export_commit(&src_db, &src_vk, &src_user, &container, true, Some(CONTAINER_PASS), None, None, None).unwrap();
    assert_eq!(ex.format, "mdaexport");
    assert!(ex.encrypted);
    assert_eq!(ex.items, 3);
    let bytes = std::fs::read(&container).unwrap();
    assert_eq!(ex.sha256, sha256(&bytes), "导出的摘要必须对得上落盘字节");
    // 容器本身不得含任何明文哨兵
    for sentinel in ["P@ssA-src", "PRIVATE-KEY-BLOB-SRC", "key-pass-SRC", "user_a"] {
        assert!(!bytes.windows(sentinel.len()).any(|w| w == sentinel.as_bytes()), "容器里出现明文 {sentinel}");
    }

    // —— 目标库：设备密钥、主密码全都不同 ——
    let (db, user_id, vk) = open_vault(dir.path(), "dst.db", 22, "新机", "Target#Pass2026!");
    let lk = lookup_of(&db, &vk, &user_id);

    let pv = importexport::container_preview(&db, &container, CONTAINER_PASS, &lk).unwrap();
    assert_eq!(pv.total_rows, 3);
    assert_eq!(pv.valid_rows, 3);
    assert_eq!(pv.error_rows, 0);
    assert_eq!(pv.conflict_rows, 0);
    assert_eq!(pv.new_targets, 3);
    assert!(pv.contains_secrets, "含秘密容器必须在预览里如实标出");
    assert_eq!(pv.fingerprint, sha256(&bytes));
    // 预览响应里绝不能带出任何秘密原文
    let pv_json = serde_json::to_string(&pv).unwrap();
    for sentinel in ["P@ssA-src", "PRIVATE-KEY-BLOB-SRC", "key-pass-SRC", "user_a"] {
        assert!(!pv_json.contains(sentinel), "预览不得回显 {sentinel}");
    }

    let cm = importexport::container_commit(&db, &vk, &user_id, &container, CONTAINER_PASS, &pv.fingerprint, "skip", &lk).unwrap();
    assert_eq!(cm.created_targets, 3);
    assert_eq!(cm.created_items, 3);
    assert_eq!(cm.skipped_rows, 0);
    assert!(cm.message.starts_with("容器导入完成"), "{}", cm.message);

    // 落库后必须能用**目标库自己的**密钥解密回原值——尤其私钥与私钥口令
    let a = expose(&db, &vk, &user_id, "营销系统A");
    assert_eq!(a.username, "user_a");
    assert_eq!(a.password.expose(), "P@ssA-src");
    assert!(a.confirm_before_fill, "导入的凭据出厂即要求填充前确认");
    let b = expose(&db, &vk, &user_id, "机房终端B");
    assert_eq!(b.private_key.expose(), "PRIVATE-KEY-BLOB-SRC", "私钥正文必须随容器一起迁过来");
    assert_eq!(b.passphrase.expose(), "key-pass-SRC", "私钥口令必须随容器一起迁过来");
    assert!(b.password.expose().is_empty());

    // 标签与"设为默认"也不能在容器路径上丢失
    let targets = repo::list_targets(&db).unwrap();
    let c_target = targets.iter().find(|t| t.display_name == "报表库C").unwrap();
    let c_items = repo::list_items_for_target(&db, &c_target.id, &user_id).unwrap();
    assert!(c_items[0].is_default_for_current_user, "容器里的设为默认必须生效");
    let a_target = targets.iter().find(|t| t.display_name == "营销系统A").unwrap();
    let a_items = repo::list_items_for_target(&db, &a_target.id, &user_id).unwrap();
    assert_eq!(a_items[0].tags, vec!["生产".to_string()], "标签应原样带过来");

    // 目标库的磁盘文件（含 WAL）不得出现任何明文哨兵：秘密是用目标库密钥重新封过存的
    for extra in ["", "-wal", "-journal"] {
        let p = format!("{}dst.db{extra}", dir.path().display());
        if let Ok(raw) = std::fs::read(&p) {
            for sentinel in ["P@ssA-src", "PRIVATE-KEY-BLOB-SRC", "key-pass-SRC"] {
                assert!(!raw.windows(sentinel.len()).any(|w| w == sentinel.as_bytes()), "{p} 中不得出现明文 {sentinel}");
            }
        }
    }

    // —— 冲突策略在同一份容器上重跑一遍 ——
    let lk2 = lookup_of(&db, &vk, &user_id);
    let pv2 = importexport::container_preview(&db, &container, CONTAINER_PASS, &lk2).unwrap();
    assert_eq!(pv2.conflict_rows, 3, "第二次导入时三条目标都已存在");
    assert_eq!(pv2.new_targets, 0);
    assert!(pv2.conflicts.iter().all(|c| c.row_no >= 1));

    let before = repo::list_items_for_target(&db, &a_target.id, &user_id).unwrap().len();
    let skip = importexport::container_commit(&db, &vk, &user_id, &container, CONTAINER_PASS, &pv2.fingerprint, "skip", &lk2).unwrap();
    assert_eq!(skip.created_items, 0, "skip 不得写任何凭据");
    assert_eq!(skip.conflict_rows, 3);
    assert_eq!(repo::list_items_for_target(&db, &a_target.id, &user_id).unwrap().len(), before);

    let abort = importexport::container_commit(&db, &vk, &user_id, &container, CONTAINER_PASS, &pv2.fingerprint, "abort", &lk2).unwrap();
    assert_eq!(abort.created_items, 0, "abort 遇冲突即停，一行不写");
    assert!(abort.message.contains("中止"), "{}", abort.message);

    let update = importexport::container_commit(&db, &vk, &user_id, &container, CONTAINER_PASS, &pv2.fingerprint, "update", &lk2).unwrap();
    assert_eq!(update.created_targets, 0, "update 不得重复建目标");
    assert_eq!(update.created_items, 3, "update 复用已有目标，只新增凭据");
    let targets_after = repo::list_targets(&db).unwrap();
    assert_eq!(targets_after.len(), 3, "三条目标不得变成六条");
}

#[test]
fn container_refuses_wrong_passphrase_tampering_and_stale_preview() {
    let dir = tempfile::tempdir().unwrap();
    let (src_db, src_user, src_vk) = open_vault(dir.path(), "src.db", 33, "源机", "Source#Pass2026!");
    seed_source(&src_db, &src_vk, &src_user);
    let container = dir.path().join("台账.mdaexport");
    importexport::export_commit(&src_db, &src_vk, &src_user, &container, true, Some(CONTAINER_PASS), None, None, None).unwrap();

    let (db, user_id, vk) = open_vault(dir.path(), "dst.db", 44, "新机", "Target#Pass2026!");
    let lk = lookup_of(&db, &vk, &user_id);

    // 口令错：与"文件被人动过"同一个错误码，不给外部区分二者的 oracle
    let e = importexport::container_preview(&db, &container, "Contain#Wr0ng2026!", &lk).unwrap_err();
    assert!(matches!(e, AppError::ContainerUnopenable), "{e:?}");
    assert_eq!(e.code(), "CONTAINER_UNOPENABLE");

    // 篡改密文一个字节（nonce 之后）→ AEAD 校验失败
    let mut tampered = std::fs::read(&container).unwrap();
    let last = tampered.len() - 1;
    tampered[last] ^= 0x01;
    std::fs::write(&container, &tampered).unwrap();
    let e = importexport::container_preview(&db, &container, CONTAINER_PASS, &lk).unwrap_err();
    assert!(matches!(e, AppError::ContainerUnopenable), "{e:?}");

    // 预览与提交之间文件被换回原样 → 摘要不同 ⇒ 拒绝提交（用户没确认过这份字节）
    std::fs::write(&container, &tampered).unwrap();
    let stale = {
        let mut b = std::fs::read(&container).unwrap();
        b.push(0x00);
        b
    };
    std::fs::write(&container, &stale).unwrap();
    let good_fp = sha256(&tampered);
    let e = importexport::container_commit(&db, &vk, &user_id, &container, CONTAINER_PASS, &good_fp, "skip", &lk).unwrap_err();
    assert!(matches!(e, AppError::ContainerStale), "{e:?}");

    // 冲突策略非法必须在读文件之前就被拒
    let fresh = dir.path().join("other.mdaexport");
    std::fs::write(&fresh, &stale).unwrap();
    let e = importexport::container_commit(&db, &vk, &user_id, &fresh, CONTAINER_PASS, &good_fp, "overwrite-everything", &lk).unwrap_err();
    assert!(matches!(e, AppError::InvalidInput), "{e:?}");
}

#[test]
fn container_rejects_non_container_and_malformed_files() {
    let dir = tempfile::tempdir().unwrap();
    let (db, user_id, vk) = open_vault(dir.path(), "dst.db", 55, "新机", "Target#Pass2026!");
    let lk = lookup_of(&db, &vk, &user_id);

    // CSV 当成容器开：不是 MDAX1 头
    let csv = dir.path().join("台账.csv");
    std::fs::write(&csv, "目标名称,目标类型\nA,web\n").unwrap();
    let e = importexport::container_preview(&db, &csv, CONTAINER_PASS, &lk).unwrap_err();
    assert!(matches!(e, AppError::FileFormatInvalid), "{e:?}");

    // 有头但长度不足（连 nonce 都凑不齐）
    let short = dir.path().join("short.mdaexport");
    std::fs::write(&short, b"MDAX1tooshort").unwrap();
    let e = importexport::container_preview(&db, &short, CONTAINER_PASS, &lk).unwrap_err();
    assert!(matches!(e, AppError::FileFormatInvalid), "{e:?}");

    // 不存在的文件
    let missing = dir.path().join("nope.mdaexport");
    let e = importexport::container_preview(&db, &missing, CONTAINER_PASS, &lk).unwrap_err();
    assert!(matches!(e, AppError::InvalidInput), "{e:?}");
}

/// 空名称/空别名的行在容器路径上也必须被拒绝——CSV 有 parse 阶段做校验，容器没有，
/// 所以那份判定必须真的存在于共用写入路径里，而不是只写在 CSV 侧。
#[test]
fn container_rejects_rows_without_name_or_alias() {
    let dir = tempfile::tempdir().unwrap();
    let (db, user_id, vk) = open_vault(dir.path(), "dst.db", 66, "新机", "Target#Pass2026!");
    let lk = lookup_of(&db, &vk, &user_id);

    let rows = vec![
        export_row("", "web", "https://n1.example.internal", "ops", "u1", "p1"),
        export_row("无名目标", "web", "https://n2.example.internal", "", "u2", "p2"),
        export_row("无名目标2", "spaceship", "https://n3.example.internal", "ops", "u3", "p3"),
        export_row("合法目标", "web", "https://n4.example.internal", "ops", "u4", "p4"),
    ];
    let file = dir.path().join("形状.mdaexport");
    write_container(&file, &rows);

    let pv = importexport::container_preview(&db, &file, CONTAINER_PASS, &lk).unwrap();
    assert_eq!(pv.total_rows, 4);
    assert_eq!(pv.error_rows, 3, "缺名称、缺别名、坏类型各一行");
    assert_eq!(pv.valid_rows, 1);
    assert_eq!(pv.new_targets, 1);
    for code in ["MISSING_DISPLAY_NAME", "EMPTY_ALIAS", "UNKNOWN_TYPE"] {
        assert!(pv.errors.iter().any(|e| e.code == code), "预览应报出 {code}");
    }
    assert!(pv.errors.iter().all(|e| e.row_no >= 1), "容器行号从 1 起算");

    let cm = importexport::container_commit(&db, &vk, &user_id, &file, CONTAINER_PASS, &pv.fingerprint, "skip", &lk).unwrap();
    assert_eq!(cm.created_items, 1);
    assert_eq!(cm.skipped_rows, 3);
    assert_eq!(repo::list_targets(&db).unwrap().len(), 1, "被拒的行不得留下半个目标");
}

fn export_row(name: &str, kind: &str, url: &str, alias: &str, username: &str, password: &str) -> importexport::ExportRow {
    importexport::ExportRow {
        target_name: name.to_string(),
        target_type: kind.to_string(),
        url: url.to_string(),
        allowed_origin: String::new(),
        protocol: String::new(),
        host: String::new(),
        port: String::new(),
        group: String::new(),
        account_alias: alias.to_string(),
        tags: String::new(),
        auth_method: "password".to_string(),
        note: String::new(),
        set_default: false,
        username: username.to_string(),
        password: password.to_string(),
        token: String::new(),
        private_key: String::new(),
        passphrase: String::new(),
    }
}

/// 按导出的同一套格式（MDAX1 + 盐 + nonce + AES-256-GCM）合成容器，用于不需要源库的行形状测试。
fn write_container(path: &Path, rows: &[importexport::ExportRow]) {
    use mon_dian_assistant_lib::crypto::kdf::KdfParams;
    let body = serde_json::to_vec(rows).unwrap();
    let salt = mon_dian_assistant_lib::crypto::random_bytes(16);
    let params = KdfParams::default();
    let key = mon_dian_assistant_lib::crypto::kdf::derive(CONTAINER_PASS, &salt, b"mda/export-container-v1", &params).unwrap();
    let (ct, nonce) = mon_dian_assistant_lib::crypto::aead::encrypt(key.as_ref(), &body, b"mda-export-v1").unwrap();
    let mut file = Vec::new();
    file.extend_from_slice(b"MDAX1");
    file.extend_from_slice(&salt);
    file.extend_from_slice(&nonce);
    file.extend_from_slice(&ct);
    std::fs::write(path, file).unwrap();
}

/// 与生产写入同一套 SHA-256：直接用 backup 模块导出的实现，避免测试自己算一份对不上。
fn sha256(bytes: &[u8]) -> String {
    mon_dian_assistant_lib::backup::sha256_hex(bytes)
}

#[test]
fn secret_export_passphrase_must_pass_the_password_policy_and_leaves_no_partial_file() {
    //! 这枚口令就是那份文件的全部强度（容器密钥只由它派生，与设备密钥无关），
    //! 所以判定必须在后端、必须在写文件之前，且被拒时不能留下半份容器。
    let dir = tempfile::tempdir().unwrap();
    let (db, user, vk) = open_vault(dir.path(), "src.db", 55, "源机", "Source#Pass2026!");
    seed_source(&db, &vk, &user);
    let out = dir.path().join("台账.mdaexport");

    let e = importexport::export_commit(&db, &vk, &user, &out, true, None, None, None, None).unwrap_err();
    assert_eq!(e.code(), "INVALID_INPUT", "含秘密导出没有口令：{e:?}");
    let e = importexport::export_commit(&db, &vk, &user, &out, true, Some(""), None, None, None).unwrap_err();
    assert_eq!(e.code(), "INVALID_INPUT", "空串口令不算口令：{e:?}");
    let e = importexport::export_commit(&db, &vk, &user, &out, true, Some("a"), None, None, None).unwrap_err();
    assert_eq!(e.code(), "WEAK_PASSWORD", "低于策略最小长度必须拒：{e:?}");
    assert!(
        !out.exists(),
        "三次被拒之后磁盘上不得出现被拒的容器文件（那会是一份没有口令保护的半成品）"
    );

    // 对照：不含秘密那条路本来就不需要口令，且明确标成未加密
    let csv = dir.path().join("台账.csv");
    let plain = importexport::export_commit(&db, &vk, &user, &csv, false, None, None, None, None).unwrap();
    assert_eq!(plain.format, "csv");
    assert!(!plain.encrypted);
    assert_eq!(plain.items, 3);

    // 过了闸门的口令才真写出容器
    let ok = importexport::export_commit(&db, &vk, &user, &out, true, Some(CONTAINER_PASS), None, None, None).unwrap();
    assert_eq!(ok.format, "mdaexport");
    assert!(ok.encrypted);
    assert_eq!(ok.sha256, sha256(&std::fs::read(&out).unwrap()));
}

/// 规模计时（默认 ignore，只在需要数字时跑）：
/// `cargo test --test container_e2e --release -- --ignored --nocapture`
/// 规模可用环境变量改（默认 200 目标 × 5 凭据 = 1000 行）：
/// `MDA_SCALE_TARGETS=2000 MDA_SCALE_PER_TARGET=5 cargo test --test container_e2e --release -- --ignored container_scale_timing -- --exact --nocapture`
///
/// 存在的理由：容器这一侧每一次预览与提交都要**各**做一轮 Argon2id 派生（19 MiB / t=2 / p=1），
/// CSV 那批数字不能拿来代替。这里不做阈值断言（换台机器就变，误红没有价值），只把三段真实耗时打出来。
#[test]
#[ignore]
fn container_scale_timing() {
    let targets = std::env::var("MDA_SCALE_TARGETS").ok().and_then(|v| v.parse().ok()).unwrap_or(200usize);
    let per_target = std::env::var("MDA_SCALE_PER_TARGET").ok().and_then(|v| v.parse().ok()).unwrap_or(5usize);
    let rows = targets * per_target;

    let dir = tempfile::tempdir().unwrap();
    let (src_db, src_user, src_vk) = open_vault(dir.path(), "src.db", 71, "源机", "Source#Pass2026!");

    let seed_start = std::time::Instant::now();
    for t in 0..targets {
        let meta = repo::TargetSecretPayload {
            url: format!("https://sys{t}.example.internal/login"),
            host: format!("sys{t}.example.internal"),
            ..Default::default()
        };
        let target_id = repo::create_target(
            &src_db,
            &src_vk,
            &src_user,
            &repo::NewTarget {
                target_type: "web".to_string(),
                display_name: format!("合成系统{t:03}"),
                group_id: None,
                meta,
            },
        )
        .unwrap();
        for i in 0..per_target {
            let payload = repo::CredentialPayload {
                username: format!("user_{t}_{i}"),
                password: SecretString::new(format!("P@ss-{t}-{i}-synthetic")),
                token: SecretString::new(format!("tok-{t}-{i}")),
                auth_method: "password".to_string(),
                confirm_before_fill: true,
                ..Default::default()
            };
            repo::create_item(
                &src_db,
                &src_vk,
                &src_user,
                &repo::NewItem {
                    target_id: target_id.clone(),
                    account_alias: format!("别名{i}"),
                    tags: vec!["规模".to_string()],
                    favorite: false,
                    payload,
                    set_as_default: i == 0,
                },
            )
            .unwrap();
        }
    }
    let seed_elapsed = seed_start.elapsed();

    let container = dir.path().join("规模.mdaexport");

    let ex_start = std::time::Instant::now();
    let ex = importexport::export_commit(&src_db, &src_vk, &src_user, &container, true, Some(CONTAINER_PASS), None, None, None).unwrap();
    let export_elapsed = ex_start.elapsed();
    assert_eq!(ex.items, rows);
    let bytes = std::fs::read(&container).unwrap();

    let (dst_db, dst_user, dst_vk) = open_vault(dir.path(), "dst.db", 72, "新机", "Target#Pass2026!");
    let lk = lookup_of(&dst_db, &dst_vk, &dst_user);

    let pv_start = std::time::Instant::now();
    let pv = importexport::container_preview(&dst_db, &container, CONTAINER_PASS, &lk).unwrap();
    let preview_elapsed = pv_start.elapsed();
    assert_eq!(pv.total_rows as usize, rows);
    assert_eq!(pv.valid_rows as usize, rows);
    assert_eq!(pv.new_targets, targets);

    let cm_start = std::time::Instant::now();
    let cm = importexport::container_commit(
        &dst_db, &dst_vk, &dst_user, &container, CONTAINER_PASS, &pv.fingerprint, "skip", &lk,
    )
    .unwrap();
    let commit_elapsed = cm_start.elapsed();
    assert_eq!(cm.created_items as usize, rows);
    assert_eq!(cm.created_targets as usize, targets);

    let per_row_ms = |d: std::time::Duration| d.as_secs_f64() * 1000.0 / (rows) as f64;
    println!(
        "[container_scale] 行数 {} 目标 {} | 源库灌数据 {:.2} s | 容器 {:.1} KiB | 导出(含1次派生) {:.2} s ({:.3} ms/行) | 预览(含1次派生) {:.2} s ({:.3} ms/行) | 提交(含1次派生) {:.2} s ({:.3} ms/行)",
        rows,
        targets,
        seed_elapsed.as_secs_f64(),
        bytes.len() as f64 / 1024.0,
        export_elapsed.as_secs_f64(),
        per_row_ms(export_elapsed),
        preview_elapsed.as_secs_f64(),
        per_row_ms(preview_elapsed),
        commit_elapsed.as_secs_f64(),
        per_row_ms(commit_elapsed),
    );
}
