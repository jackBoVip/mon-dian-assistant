//! 批量导入的真实端到端验证：走 import_preview → import_commit 生产入口，
//! 而不是只测 parse_csv。覆盖需求 §9.1「导入：模板/预览/重复处理/错误行/事务与冲突策略」，
//! 以及「10k 行导入 < 60s」那条性能指标。
//!
//! 这里的 CSV 是合成数据，不含任何真实凭据。

use std::path::Path;
use std::time::Instant;

use mon_dian_assistant_lib::auth::users;
use mon_dian_assistant_lib::crypto::vault_key::VaultKey;
use mon_dian_assistant_lib::db::{repo, Db};
use mon_dian_assistant_lib::importexport::{self, TargetLookup};

const HEADER: &str = "目标名称,目标类型,地址,精确Origin,协议,主机,端口,分组,账号别名,标签,用户名,密码,令牌,私钥,私钥口令,认证方式,备注,设为默认";

/// 一行 CSV：列顺序与 IMPORT_COLUMNS 完全一致，未给的列留空。
fn row(fields: [String; 18]) -> String {
    fields.join(",")
}

fn blank_row() -> [String; 18] {
    std::array::from_fn(|_| String::new())
}

fn set_row(r: &mut [String; 18], name: &str, kind: &str, url: &str, alias: &str, user: &str, pass: &str) {
    r[0] = name.to_string();
    r[1] = kind.to_string();
    r[2] = url.to_string();
    r[8] = alias.to_string();
    r[10] = user.to_string();
    r[11] = pass.to_string();
}

/// 预览 + 提交都要用到的查重表：库是刚初始化的，先按当前索引构造。
fn lookup_of(db: &Db, vk: &VaultKey, user_id: &str) -> TargetLookup {
    let docs = repo::build_search_index(db, vk, user_id).unwrap();
    let index = mon_dian_assistant_lib::quick_launcher::search::SearchIndex::new(docs);
    TargetLookup::new(index.target_hints())
}

fn write_csv(dir: &Path, name: &str, rows: &[String]) -> std::path::PathBuf {
    let mut text = String::from(HEADER);
    text.push('\n');
    for r in rows {
        text.push_str(r);
        text.push('\n');
    }
    let p = dir.join(name);
    std::fs::write(&p, text).unwrap();
    p
}

fn setup(dir: &Path) -> (Db, String, VaultKey) {
    let db = Db::open(&dir.join("vault.db"), &vec![7u8; 32]).unwrap();
    let (user_id, vk) = users::initialize(&db, "导入验收", "Import#Pass2026!").unwrap();
    (db, user_id, vk)
}

/// 20 条合法 + 2 条冲突 + 6 条错误行：预览计数、错误码、冲突策略、落库后可解密。
#[test]
fn preview_and_commit_cover_errors_conflicts_and_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let (db, user_id, vk) = setup(dir.path());

    // 库里先放一个目标（无凭据），用于制造"与台账冲突"的那一行。
    let existing_target_id = repo::create_target(
        &db,
        &vk,
        &user_id,
        &repo::NewTarget {
            target_type: "web".to_string(),
            display_name: "既有系统".to_string(),
            group_id: None,
            meta: repo::TargetSecretPayload {
                url: "https://exist.example.internal/x".to_string(),
                host: "exist.example.internal".to_string(),
                ..Default::default()
            },
        },
    )
    .unwrap();

    let mut rows: Vec<String> = Vec::new();
    for i in 1..=20usize {
        let mut r = blank_row();
        set_row(
            &mut r,
            &format!("营销系统A{i:02}"),
            "web",
            &format!("https://a{i:02}.example.internal/login"),
            "ops1",
            &format!("user{i:02}"),
            &format!("P@ss{i:02}"),
        );
        // 第 5 行带分组值：验证导入会建组并把新目标挂到组上
        if i == 5 {
            r[7] = "生产环境".to_string();
        }
        rows.push(row(r));
    }
    // 与台账已有目标同名 → 冲突（名称查重走 SQL，与内存索引无关）
    let mut r = blank_row();
    set_row(&mut r, "既有系统", "web", "https://other.example.internal/y", "ops2", "u2", "p2");
    rows.push(row(r));
    // 文件内 (目标名称, 账号别名) 重复 → 冲突
    let mut r = blank_row();
    set_row(&mut r, "营销系统A01", "web", "https://a01.example.internal/login", "ops1", "dup", "dup");
    rows.push(row(r));
    // 6 条错误行，每条恰好一个错误码，便于精确断言计数
    let mut r = blank_row();
    set_row(&mut r, "", "web", "https://e1.example.internal", "ops", "u", "p");
    rows.push(row(r));
    let mut r = blank_row();
    set_row(&mut r, "坏类型", "spaceship", "https://e2.example.internal", "ops", "u", "p");
    rows.push(row(r));
    let mut r = blank_row();
    set_row(&mut r, "无地址", "web", "", "ops", "u", "p");
    rows.push(row(r));
    let mut r = blank_row();
    r[0] = "坏Origin".into();
    r[1] = "web".into();
    r[2] = "https://e4.example.internal".into();
    // 2026-10-29 起 http:// 是合法 Origin（自动填充放开一档），所以这里用一个
    // 仍然非法的写法来覆盖 BAD_ORIGIN：不带协议前缀。
    r[3] = "e4.example.internal".into();
    r[8] = "ops".into();
    rows.push(row(r));
    let mut r = blank_row();
    r[0] = "坏端口".into();
    r[1] = "terminal".into();
    r[2] = "ssh://10.0.0.9".into();
    r[6] = "99999".into();
    r[8] = "ops".into();
    rows.push(row(r));
    let mut r = blank_row();
    set_row(&mut r, &"长".repeat(121), "web", "https://e6.example.internal", "ops", "u", "p");
    rows.push(row(r));

    let file = write_csv(dir.path(), "mix.csv", &rows);
    let lk = lookup_of(&db, &vk, &user_id);
    let pv = importexport::import_preview(&db, &user_id, &file, &lk).unwrap();

    assert_eq!(pv.total_rows, 28, "总行数");
    assert_eq!(pv.error_rows, 6, "错误行应各计一个错误码");
    assert_eq!(pv.conflict_rows, 2, "同名目标 1 行 + 文件内重复别名 1 行");
    assert_eq!(pv.valid_rows, 22, "无错误的行都算可导入（含冲突行）");
    assert_eq!(pv.new_targets, 20, "只有 20 个目标是台账里没有的");
    assert_eq!(pv.columns.len(), 18, "模板 18 列全部识别");
    assert!(!pv.truncated, "错误数远未到 200 上限");
    for code in [
        "MISSING_DISPLAY_NAME",
        "UNKNOWN_TYPE",
        "NO_ADDRESS",
        "BAD_ORIGIN",
        "BAD_PORT",
        "DISPLAY_NAME_TOO_LONG",
    ] {
        assert!(pv.errors.iter().any(|e| e.code == code), "预览应报出 {code}");
    }
    assert!(pv.errors.iter().all(|e| e.row_no >= 2), "错误必须定位到行号（表头是第 1 行）");
    // 错误消息里不得出现口令原文
    assert!(
        pv.errors.iter().all(|e| !e.message.contains("P@ss") && !e.message.contains("dup")),
        "错误报告不得复制单元格原文"
    );

    // skip：冲突行不写入
    let cm = importexport::import_commit(&db, &vk, &user_id, &pv.job_id, None, "skip", None, &lk).unwrap();
    assert_eq!(cm.created_targets, 20);
    assert_eq!(cm.created_items, 20);
    assert_eq!(cm.conflict_rows, 2, "同名目标与文件内重复都在提交时被识别");
    assert_eq!(cm.skipped_rows, 8, "2 冲突 + 6 错误");
    assert_eq!(cm.imported_rows, 20);

    // 落库结果必须能解密回原值，且同一目标下别名相同的凭据没有被重复写第二条
    let targets = repo::list_targets(&db).unwrap();
    let a07 = targets.iter().find(|t| t.display_name == "营销系统A07").expect("A07 应已建为独立目标");
    assert_eq!(a07.credential_count, 1);
    let items = repo::list_items_for_target(&db, &a07.id, &user_id).unwrap();
    let p = repo::item_payload(&vk, &db, &items[0].id).unwrap();
    assert_eq!(p.username, "user07");
    assert_eq!(p.password.expose(), "P@ss07", "导入的口令必须能用同一 DEK 解密回原值");
    assert!(p.confirm_before_fill, "导入的凭据出厂即要求填充前确认");

    let exist_items = repo::list_items_for_target(&db, &existing_target_id, &user_id).unwrap();
    assert!(exist_items.is_empty(), "skip 策略下与台账同名目标的行不得写入");

    // 分组列不是摆设：导入要建组，且目标必须真的挂在这个组上
    let groups = repo::list_groups(&db).unwrap();
    let prod = groups.iter().find(|g| g.name == "生产环境").expect("导入应自动建组「生产环境」");
    assert_eq!(prod.target_count, 1);
    let a05 = targets.iter().find(|t| t.display_name == "营销系统A05").unwrap();
    assert_eq!(a05.group_id.as_deref(), Some(prod.id.as_str()));

    // update：复用已有目标，只加凭据，不产生同名重复目标
    let cm2 = importexport::import_commit(&db, &vk, &user_id, &pv.job_id, None, "update", None, &lk).unwrap();
    assert_eq!(cm2.created_targets, 0, "update 不得重复建目标");
    assert_eq!(cm2.created_items, 22, "20 个已存在目标 + 既有系统，加上文件内重复的那一行都可复用写入");
    let targets2 = repo::list_targets(&db).unwrap();
    let dup_names: std::collections::HashSet<_> = targets2.iter().map(|t| t.display_name.clone()).collect();
    assert_eq!(dup_names.len(), targets2.len(), "目标名不得出现重复项");
    let a07b = targets2.iter().find(|t| t.display_name == "营销系统A07").unwrap();
    assert_eq!(a07b.credential_count, 2, "同一目标下允许第二条凭据");

    // abort：此时全部行都与台账冲突，必须一行不写
    let lk3 = lookup_of(&db, &vk, &user_id);
    let pv3 = importexport::import_preview(&db, &user_id, &file, &lk3).unwrap();
    let before = repo::list_items_for_target(&db, &a07b.id, &user_id).unwrap().len();
    let cm3 = importexport::import_commit(&db, &vk, &user_id, &pv3.job_id, None, "abort", None, &lk3).unwrap();
    assert_eq!(cm3.created_items, 0, "abort 策略下冲突行不得写入");
    let after = repo::list_items_for_target(&db, &a07b.id, &user_id).unwrap().len();
    assert_eq!(before, after);

    // 文件在预览之后被改动 → 提交必须拒绝（预览与内容摘要绑定）
    std::fs::write(&file, format!("{HEADER}\n")).unwrap();
    let e = importexport::import_commit(&db, &vk, &user_id, &pv.job_id, None, "skip", None, &lk);
    assert!(e.is_err(), "文件内容变了还允许提交 = 导入用户没确认过的数据");
}

/// 10k 行真实导入：预览 + 提交都必须走完整生产入口，并落在需求规定的 60s 以内。
/// 用 `cargo test --release --test import_e2e -- --ignored --nocapture` 跑（性能口径取发布构建）。
#[test]
#[ignore = "10k 行规模测试：显式用 --release -- --ignored 运行"]
fn ten_thousand_row_import_under_60s() {
    let dir = tempfile::tempdir().unwrap();
    let (db, user_id, vk) = setup(dir.path());

    const N: usize = 10_000;
    let mut rows = Vec::with_capacity(N);
    for i in 0..N {
        let mut r = blank_row();
        set_row(
            &mut r,
            &format!("营销业务系统 {} 区 {:05}", i % 200, i),
            "web",
            &format!("https://oa{i:05}.example.internal/login"),
            if i % 3 == 0 { "运维" } else { "只读" },
            &format!("zhangsan{i:05}"),
            &format!("P@ss{i:05}"),
        );
        r[3] = format!("https://oa{i:05}.example.internal");
        r[7] = format!("分组{}", i % 20);
        r[9] = "生产".to_string();
        r[15] = "password".to_string();
        rows.push(row(r));
    }
    let file = write_csv(dir.path(), "tenk.csv", &rows);

    let lk = lookup_of(&db, &vk, &user_id);
    let t = Instant::now();
    let pv = importexport::import_preview(&db, &user_id, &file, &lk).unwrap();
    let preview_elapsed = t.elapsed();
    assert_eq!(pv.total_rows, N);
    assert_eq!(pv.valid_rows, N);
    assert_eq!(pv.error_rows, 0);
    assert_eq!(pv.conflict_rows, 0);
    assert_eq!(pv.new_targets, N);

    let t = Instant::now();
    let cm = importexport::import_commit(&db, &vk, &user_id, &pv.job_id, None, "skip", None, &lk).unwrap();
    let commit_elapsed = t.elapsed();
    assert_eq!(cm.created_targets, N);
    assert_eq!(cm.created_items, N);
    assert_eq!(cm.skipped_rows, 0);

    let total = preview_elapsed + commit_elapsed;
    println!(
        "10k 行 CSV 端到端：预览 {} ms + 提交 {} ms = 合计 {:.1} s（要求 < 60 s）",
        preview_elapsed.as_millis(),
        commit_elapsed.as_millis(),
        total.as_secs_f64()
    );
    assert!(total.as_secs() < 60, "10k 行导入必须小于 60 秒，实测 {:.1}s", total.as_secs_f64());

    // 导入后的数据必须在同一次运行里可被检索与解密——否则"导入成功"只是行数对得上
    let t = Instant::now();
    let docs = repo::build_search_index(&db, &vk, &user_id).unwrap();
    let index_query = t.elapsed();
    assert_eq!(docs.len(), N);
    let t = Instant::now();
    let idx = mon_dian_assistant_lib::quick_launcher::search::SearchIndex::new(docs);
    println!(
        "10k 条：取数+AEAD 解密 {} ms，内存索引折叠 {} ms",
        index_query.as_millis(),
        t.elapsed().as_millis()
    );
    let parsed = mon_dian_assistant_lib::quick_launcher::parse("oa00123.example.internal, zhangsan00123").unwrap();
    let hits = idx.search(&parsed, 20);
    assert!(hits.iter().any(|(d, _)| d.username == "zhangsan00123"), "导入的数据必须可被多条件 AND 搜索命中");

    let target = repo::list_targets(&db).unwrap().into_iter().find(|t| t.display_name == "营销业务系统 123 区 00123").unwrap();
    let items = repo::list_items_for_target(&db, &target.id, &user_id).unwrap();
    let p = repo::item_payload(&vk, &db, &items[0].id).unwrap();
    assert_eq!(p.username, "zhangsan00123");
    assert_eq!(p.password.expose(), "P@ss00123");

    // 全库加密证据：磁盘上的库文件（含 WAL）不得出现明文口令
    let needle = b"P@ss00123";
    for extra in ["", "-wal", "-journal"] {
        let p = format!("{}vault.db{extra}", dir.path().display());
        if let Ok(raw) = std::fs::read(&p) {
            assert!(!raw.windows(needle.len()).any(|w| w == needle), "{p} 中不得出现明文口令");
        }
    }
    assert!(repo::active_item_count(&db, &target.id).unwrap() >= 1);
}

/// 缺陷回归：同一个目标下的多条凭据（靠别名区分）曾被导入侧当成"与台账冲突"。
///
/// `existing_target` 查的是实时库，所以从第 2 行起它会查到本次第 1 行刚刚建出来的那个目标，
/// 于是 skip 策略把它丢弃、abort 策略让整次导入停在第 2 行——预览却报"全部有效、0 冲突"。
/// 这条测试用最小形状（2 个目标、其中一个挂 3 条凭据）把两边口径钉在一起。
#[test]
fn same_target_multi_alias_rows_all_import_under_skip() {
    let dir = tempfile::tempdir().unwrap();
    let (db, user_id, vk) = setup(dir.path());

    let mk = |name: &str, url: &str, alias: &str, user: &str| {
        let mut f = blank_row();
        set_row(&mut f, name, "web", url, alias, user, "P@ss-synthetic");
        row(f)
    };
    let rows = vec![
        mk("营销系统甲", "https://a.example.internal/login", "运营", "ops1"),
        mk("营销系统甲", "https://a.example.internal/login", "财务", "fin1"),
        mk("营销系统甲", "https://a.example.internal/login", "只读", "ro1"),
        mk("报表库乙", "https://b.example.internal/login", "默认", "dba1"),
    ];
    let csv = write_csv(dir.path(), "多账号.csv", &rows);

    let lk = lookup_of(&db, &vk, &user_id);
    let pv = importexport::import_preview(&db, &user_id, &csv, &lk).unwrap();
    assert_eq!(pv.total_rows, 4, "四行都该被读到");
    assert_eq!(pv.error_rows, 0);
    assert_eq!(pv.conflict_rows, 0, "空台账里一个目标三条凭据不是冲突——预览就是这么说的");
    assert_eq!(pv.new_targets, 2, "两个目标名，不是四个");

    let cm = importexport::import_commit(&db, &vk, &user_id, &pv.job_id, Some(csv.to_str().unwrap()), "skip", None, &lk).unwrap();
    assert_eq!(cm.created_targets, 2);
    assert_eq!(cm.created_items, 4, "四条凭据必须全部落库，一条都不能被当成冲突丢掉");
    assert_eq!(cm.skipped_rows, 0);
    assert_eq!(cm.conflict_rows, 0, "本次运行内自建的目标不该计为冲突");

    // 落库形状：甲 3 条、乙 1 条，且别名互不相同
    let targets = repo::list_targets(&db).unwrap();
    assert_eq!(targets.len(), 2);
    let jia = targets.iter().find(|t| t.display_name == "营销系统甲").unwrap();
    let yi = targets.iter().find(|t| t.display_name == "报表库乙").unwrap();
    assert_eq!(repo::list_items_for_target(&db, jia.id.as_str(), &user_id).unwrap().len(), 3);
    assert_eq!(repo::list_items_for_target(&db, yi.id.as_str(), &user_id).unwrap().len(), 1);

    // 再导一次同一份文件：这时目标在**本次运行开始之前**就已存在，冲突策略照旧生效
    let lk2 = lookup_of(&db, &vk, &user_id);
    let pv2 = importexport::import_preview(&db, &user_id, &csv, &lk2).unwrap();
    assert_eq!(pv2.conflict_rows, 4, "四个目标名都已存在，预览该报 4 条冲突");
    let skip2 = importexport::import_commit(&db, &vk, &user_id, &pv2.job_id, Some(csv.to_str().unwrap()), "skip", None, &lk2).unwrap();
    assert_eq!(skip2.created_items, 0, "skip 下重导不得新增凭据");
    assert_eq!(skip2.conflict_rows, 4);
    let upd = importexport::import_commit(&db, &vk, &user_id, &pv2.job_id, Some(csv.to_str().unwrap()), "update", None, &lk2).unwrap();
    assert_eq!(upd.created_targets, 0, "update 复用已有目标");
    assert_eq!(upd.created_items, 4, "update 是把四条凭据都补进来，不是只补一条");
    assert_eq!(repo::list_targets(&db).unwrap().len(), 2);
}

/// 文件内 (目标, 别名) 重复仍是冲突：预览与提交必须给同一个答案。
#[test]
fn intra_file_duplicate_alias_conflicts_in_both_preview_and_commit() {
    let dir = tempfile::tempdir().unwrap();
    let (db, user_id, vk) = setup(dir.path());

    let mk = |alias: &str, user: &str| {
        let mut f = blank_row();
        set_row(&mut f, "营销系统甲", "web", "https://a.example.internal/login", alias, user, "P@ss-synthetic");
        row(f)
    };
    let rows = vec![mk("运营", "ops1"), mk("财务", "fin1"), mk("运营", "ops2")];
    let csv = write_csv(dir.path(), "重复别名.csv", &rows);

    let lk = lookup_of(&db, &vk, &user_id);
    let pv = importexport::import_preview(&db, &user_id, &csv, &lk).unwrap();
    assert_eq!(pv.conflict_rows, 1, "只有第三行（同目标同别名）是冲突");
    assert_eq!(pv.conflicts[0].row_no, 4);

    let cm = importexport::import_commit(&db, &vk, &user_id, &pv.job_id, Some(csv.to_str().unwrap()), "skip", None, &lk).unwrap();
    assert_eq!(cm.created_items, 2, "前两行写入，重复别名那行按 skip 跳过");
    assert_eq!(cm.conflict_rows, 1);
    assert_eq!(cm.created_targets, 1);

    // 同一份文件走 abort：冲突行是最后一行，前面的行照常写入后中止（不回滚，界面上有说明）
    let lk2 = lookup_of(&db, &vk, &user_id);
    let pv2 = importexport::import_preview(&db, &user_id, &csv, &lk2).unwrap();
    let ab = importexport::import_commit(&db, &vk, &user_id, &pv2.job_id, Some(csv.to_str().unwrap()), "abort", None, &lk2).unwrap();
    assert!(ab.message.contains("中止"), "{}", ab.message);
    assert_eq!(ab.conflict_rows, 1);
}
