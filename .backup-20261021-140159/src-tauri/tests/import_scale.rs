//! 追加导入的成本随"库里已经有多少目标"增长到哪儿去——这条是 §3 那几行同形状实测留下的问题：
//! 同样是 10000 行，2000 目标提交 2.05 s、10000 目标提交 6.4–7.4 s，而需求里的导入判据从来只测"空库导入"，
//! 没测过"往一个已经很大的台账里追加导入"。真实使用里后者才是常态。
//!
//! 这里做两件事：
//! 1. 用 `EXPLAIN QUERY PLAN` 直接钉住去重查询 `WHERE lower(display_name)=?1` 的执行计划
//!    （`migrations/0001_init.sql:113-114` 只给 `target_type` 与 `group_id` 建了索引，`display_name` 一个都没有；
//!    这条实测结论后来落成了 `migrations/0005_target_name_index.sql`，所以本文件现在**先摘掉出厂索引**再量差距）；
//! 2. 端到端测"库里有 N 个目标时提交 500 行"的真实耗时，N = 2000 与 10000 两档；
//! 3. `container_and_csv_same_content_10k_roundtrip_timing`：同一份 10000 行中文内容同时做成
//!    CSV 与容器，在同一进程里各导进一个空库，把"容器格式更快"这个读数单独否掉。
//!
//! 所有数据都是合成凭据，不含任何真实口令。默认 `#[ignore]`：要跑十几秒且只有 release 才有意义。
//! 复现：`cargo test --test import_scale --release -- --ignored --nocapture`

use std::path::Path;

use mon_dian_assistant_lib::auth::users;
use mon_dian_assistant_lib::crypto::vault_key::VaultKey;
use mon_dian_assistant_lib::crypto::SecretString;
use mon_dian_assistant_lib::db::{repo, Db};
use mon_dian_assistant_lib::importexport::{self, TargetLookup};

const CONTAINER_PASS: &str = "Scale#Pass2026!";
const APPEND_ROWS: usize = 500;
/// 写侧对照用的行数：用来量"补了名称索引之后，新建一个目标贵多少"
const WRITE_PROBE_ROWS: usize = 500;

/// 与 `importexport::TargetLookup::find` 用的是**同一个常量**（0005 之后它已经是契约面）。
/// 早前这里是手抄的一份，两边一旦漂移，第 2 步的耗时曲线就失去意义——所以现在直接引用。
const DEDUP_SQL: &str = mon_dian_assistant_lib::importexport::DEDUP_BY_NAME_SQL;

fn open_vault(dir: &Path, file: &str, db_key: u8, nickname: &str, master: &str) -> (Db, String, VaultKey) {
    let db = Db::open(&dir.join(file), &vec![db_key; 32]).unwrap();
    let (user_id, vk) = users::initialize(&db, nickname, master).unwrap();
    (db, user_id, vk)
}

fn lookup_of(db: &Db, vk: &VaultKey, user_id: &str) -> TargetLookup {
    let docs = repo::build_search_index(db, vk, user_id).unwrap();
    let index = mon_dian_assistant_lib::quick_launcher::search::SearchIndex::new(docs);
    TargetLookup::new(index.target_hints())
}

/// 造 n 个目标（各带 1 条凭据），名字与地址都唯一，前缀用来避免两批数据互相撞名。
fn seed_targets(db: &Db, vk: &VaultKey, user_id: &str, n: usize, prefix: &str) {
    for t in 0..n {
        let meta = repo::TargetSecretPayload {
            url: format!("https://{prefix}{t}.example.internal/login"),
            host: format!("{prefix}{t}.example.internal"),
            ..Default::default()
        };
        let target_id = repo::create_target(
            db,
            vk,
            user_id,
            &repo::NewTarget {
                target_type: "web".to_string(),
                display_name: format!("合成{prefix}系统{t:05}"),
                group_id: None,
                meta,
            },
        )
        .unwrap();
        let payload = repo::CredentialPayload {
            username: format!("user_{prefix}_{t}"),
            password: SecretString::new(format!("P@ss-{prefix}-{t}-synthetic")),
            auth_method: "password".to_string(),
            ..Default::default()
        };
        repo::create_item(
            db,
            vk,
            user_id,
            &repo::NewItem {
                target_id,
                account_alias: format!("别名{t}"),
                tags: vec!["存量".to_string()],
                favorite: false,
                payload,
                set_as_default: true,
            },
        )
        .unwrap();
    }
}

/// 带计时的造目标（含每条一个凭据），用于比较"名称索引存在与否"对写入的影响。
fn seed_timed(db: &Db, vk: &VaultKey, user_id: &str, n: usize, prefix: &str) -> std::time::Duration {
    let start = std::time::Instant::now();
    seed_targets(db, vk, user_id, n, prefix);
    start.elapsed()
}

/// 执行计划里每一行的描述文本（SQLite 用 "SCAN table" 表示全表扫描、"SEARCH table USING INDEX" 表示走了索引）。
fn plan(db: &Db) -> Vec<String> {
    let conn = db.lock_conn();
    let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {DEDUP_SQL}")).unwrap();
    let rows = stmt
        .query_map(["探针"], |r| r.get::<_, String>(3))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_else(|e| panic!("读取 EXPLAIN QUERY PLAN 失败：{e}"));
    rows.into_iter().filter(|s| !s.trim().is_empty()).collect()
}

#[test]
#[ignore]
fn append_import_cost_scales_with_existing_targets() {
    let dir = tempfile::tempdir().unwrap();

    // ---- 源库：造 APPEND_ROWS 行，导出成容器（与目标库的设备密钥/主密码都不同）----
    let (src_db, src_user, src_vk) = open_vault(dir.path(), "src.db", 81, "源机", "Source#Scale2026!");
    seed_targets(&src_db, &src_vk, &src_user, APPEND_ROWS, "导入");
    let container = dir.path().join("追加.mdaexport");
    let ex = importexport::export_commit(&src_db, &src_vk, &src_user, &container, true, Some(CONTAINER_PASS), None, None, None).unwrap();
    assert_eq!(ex.items, APPEND_ROWS);

    for existing in [2000usize, 10000] {
        // 两档：`false` 把 0005 出厂就带的名称索引摘掉，量"没有它要付多少钱"；
        // `true` 什么都不动，就是装机后用户实际拿到的那套 schema——0005 落地之后，
        // 只有这一档的预览/提交耗时才是"修好之后"的读数，摘索引那档只是对照。
        for indexed in [false, true] {
            let (dst_db, dst_user, dst_vk) = open_vault(
                dir.path(),
                &format!("dst{existing}-{}.db", if indexed { "idx" } else { "noidx" }),
                (90 + existing / 100 + if indexed { 7 } else { 0 }) as u8,
                "目标机",
                "Target#Scale2026!",
            );
            if !indexed {
                // 这里用 `IF EXISTS`、下面 ②b 用不带 IF 的 `CREATE INDEX`：万一迁移里那枚索引改了名，
                // 这条 DROP 会变成空操作，而那一次 CREATE 会当场报"索引已存在"，
                // 于是失配会立刻炸，不会静默地把"无索引"那档测成"有索引"。
                dst_db.lock_conn().execute_batch("DROP INDEX IF EXISTS idx_targets_name;").unwrap();
            }
            let seed_start = std::time::Instant::now();
            seed_targets(&dst_db, &dst_vk, &dst_user, existing, "存量");
            let seed_elapsed = seed_start.elapsed();

            let lk = lookup_of(&dst_db, &dst_vk, &dst_user);

            // ① 执行计划：这条查询到底走没走索引
            println!("[dedup_plan] 存量 {existing} 目标 / {}：{}", if indexed { "出厂索引" } else { "摘掉索引" }, plan(&dst_db).join(" / "));

            // ② 单次去重查询的实测：500 次必然未命中的查询（名字不与存量相撞）
            let probe = |label: &str| -> (std::time::Duration, usize) {
                let start = std::time::Instant::now();
                let mut hits = 0usize;
                for i in 0..APPEND_ROWS {
                    let needle = format!("不存在的名字{label}{i}");
                    let hit: Option<String> = dst_db.lock_conn().query_row(DEDUP_SQL, [needle], |r| r.get(0)).unwrap_or(None);
                    hits += usize::from(hit.is_some());
                }
                (start.elapsed(), hits)
            };
            let (probe_elapsed, hits) = probe(if indexed { "有索引" } else { "无索引" });
            assert_eq!(hits, 0, "探针名字必须与存量不撞，否则测的就不是未命中路径");

            // ③ 端到端：预览与提交各自计时——预览也会逐行跑同一条去重查询，是用户在界面上等的那一段
            let pv_start = std::time::Instant::now();
            let pv = importexport::container_preview(&dst_db, &container, CONTAINER_PASS, &lk).unwrap();
            let preview_elapsed = pv_start.elapsed();
            assert_eq!(pv.conflict_rows, 0, "导入行与存量目标不该撞名，否则测的就不是纯新增");
            let commit_start = std::time::Instant::now();
            let cm =
                importexport::container_commit(&dst_db, &dst_vk, &dst_user, &container, CONTAINER_PASS, &pv.fingerprint, "skip", &lk).unwrap();
            let commit_elapsed = commit_start.elapsed();
            assert_eq!(cm.created_items as usize, APPEND_ROWS);
            let scan_ms = probe_elapsed.as_secs_f64() * 1000.0;
            let e2e_ms = (preview_elapsed + commit_elapsed).as_secs_f64() * 1000.0;

            println!(
                "[append_import] 存量 {} 目标（灌存量 {:.2} s）| {} | 500 次未命中去重查询 {:.1} ms（{:.0} µs/次）| 500 行预览 {:.2} s + 提交 {:.2} s（{:.2} ms/行）| 去重查询（预览与提交各 500 次，即 2×上面那段）占端到端 {:.0}%",
                existing,
                seed_elapsed.as_secs_f64(),
                if indexed { "带出厂索引" } else { "已摘掉索引" },
                scan_ms,
                scan_ms * 1000.0 / APPEND_ROWS as f64,
                preview_elapsed.as_secs_f64(),
                commit_elapsed.as_secs_f64(),
                commit_elapsed.as_secs_f64() * 1000.0 / APPEND_ROWS as f64,
                200.0 * scan_ms / e2e_ms,
            );

            // ②b 只在"摘掉索引"那一档做写侧 A/B：同一座库里先建 500 个目标、再补索引、再建 500 个，
            // 比较的是"新建目标单价"，与端到端那次不可比（数据已经提交进去了，命中路径不同）。
            if !indexed {
                let write_without = seed_timed(&dst_db, &dst_vk, &dst_user, WRITE_PROBE_ROWS, "写入A");
                {
                    dst_db.lock_conn().execute_batch("CREATE INDEX idx_targets_name ON vault_targets(lower(display_name));").unwrap();
                }
                let (indexed_elapsed, hits2) = probe("有索引");
                assert_eq!(hits2, 0, "加了索引也不该命中存量名字");
                let write_with = seed_timed(&dst_db, &dst_vk, &dst_user, WRITE_PROBE_ROWS, "写入B");
                println!(
                    "[write_cost] 存量 {existing} 目标：新建目标单价 无索引 {:.2} ms/个 → 有索引 {:.2} ms/个（{:+.0}%）| 单查 {:.0} µs/次 → {:.0} µs/次",
                    write_without.as_secs_f64() * 1000.0 / WRITE_PROBE_ROWS as f64,
                    write_with.as_secs_f64() * 1000.0 / WRITE_PROBE_ROWS as f64,
                    (write_with.as_secs_f64() / write_without.as_secs_f64() - 1.0) * 100.0,
                    scan_ms * 1000.0 / APPEND_ROWS as f64,
                    indexed_elapsed.as_secs_f64() * 1_000_000.0 / APPEND_ROWS as f64,
                );
            }
        }
    }
}

/// 同一份内容走两趟：`.mdaexport` 容器 vs 18 列中文 CSV。
///
/// §3 先前只能用"外推 + 形状不同"解释两侧 8 倍的差距，本轮把形状对齐了（10000 目标 × 1 凭据）还差
/// **字段内容与文本宽度**这一层：容器那批用的是合成的短 ASCII 字段，CSV 用的是中文长名称 + 分组 + 标签。
/// 这条测试让两边**装同一份数据**（同一批目标名/地址/分组/标签/账号别名/用户名/口令），在同一进程里
/// 各跑一趟预览与提交，才谈得上"格式差别值多少钱"。
#[test]
#[ignore]
fn container_and_csv_same_content_10k_roundtrip_timing() {
    const N: usize = 10_000;
    const CSV_HEADER: &str = "目标名称,目标类型,地址,精确Origin,协议,主机,端口,分组,账号别名,标签,用户名,密码,令牌,私钥,私钥口令,认证方式,备注,设为默认";
    let dir = tempfile::tempdir().unwrap();

    // ---- 唯一一份数据源：10000 个目标（各 1 条凭据、20 个分组、标签"生产"）----
    let (src_db, src_user, src_vk) = open_vault(dir.path(), "src.db", 61, "源机", "Source#Same2026!");
    let groups: Vec<String> = (0..20).map(|g| repo::create_group(&src_db, &src_user, &format!("分组{g}"), None).unwrap()).collect();
    let seed_start = std::time::Instant::now();
    for i in 0..N {
        let meta = repo::TargetSecretPayload {
            url: format!("https://oa{i:05}.example.internal/login"),
            allowed_origin: format!("https://oa{i:05}.example.internal"),
            ..Default::default()
        };
        let target_id = repo::create_target(
            &src_db,
            &src_vk,
            &src_user,
            &repo::NewTarget {
                target_type: "web".to_string(),
                display_name: format!("营销业务系统 {} 区 {i:05}", i % 200),
                group_id: Some(groups[i % 20].clone()),
                meta,
            },
        )
        .unwrap();
        repo::create_item(
            &src_db,
            &src_vk,
            &src_user,
            &repo::NewItem {
                target_id,
                account_alias: if i % 3 == 0 { "运维".to_string() } else { "只读".to_string() },
                tags: vec!["生产".to_string()],
                favorite: false,
                payload: repo::CredentialPayload {
                    username: format!("zhangsan{i:05}"),
                    password: SecretString::new(format!("P@ss{i:05}")),
                    auth_method: "password".to_string(),
                    ..Default::default()
                },
                set_as_default: true,
            },
        )
        .unwrap();
    }
    let seed_elapsed = seed_start.elapsed();

    // ---- 同一份数据写成 18 列中文 CSV（列序与 IMPORT_COLUMNS 一致）----
    let mut csv = String::from(CSV_HEADER);
    csv.push('\n');
    for i in 0..N {
        let fields: [&str; 18] = [
            &format!("营销业务系统 {} 区 {i:05}", i % 200),
            "web",
            &format!("https://oa{i:05}.example.internal/login"),
            &format!("https://oa{i:05}.example.internal"),
            "", "", "",
            &format!("分组{}", i % 20),
            if i % 3 == 0 { "运维" } else { "只读" },
            "生产",
            &format!("zhangsan{i:05}"),
            &format!("P@ss{i:05}"),
            "", "", "", "password", "", "是",
        ];
        csv.push_str(&fields.join(","));
        csv.push('\n');
    }
    let csv_path = dir.path().join("same-content.csv");
    std::fs::write(&csv_path, &csv).unwrap();
    let csv_bytes = std::fs::metadata(&csv_path).unwrap().len();

    // ---- 容器由源库导出（含秘密）----
    let container = dir.path().join("same-content.mdaexport");
    let ex_start = std::time::Instant::now();
    let ex = importexport::export_commit(&src_db, &src_vk, &src_user, &container, true, Some(CONTAINER_PASS), None, None, None).unwrap();
    let export_elapsed = ex_start.elapsed();
    assert_eq!(ex.items, N);
    let container_bytes = std::fs::metadata(&container).unwrap().len();

    // ---- A 趟：容器 → 全新库 ----
    let (a_db, a_user, a_vk) = open_vault(dir.path(), "a.db", 62, "甲机", "Alpha#Same2026!");
    let a_lk = lookup_of(&a_db, &a_vk, &a_user);
    let t = std::time::Instant::now();
    let a_pv = importexport::container_preview(&a_db, &container, CONTAINER_PASS, &a_lk).unwrap();
    let a_preview = t.elapsed();
    assert_eq!(a_pv.valid_rows as usize, N);
    assert_eq!(a_pv.error_rows, 0, "同一份内容不该在容器侧被判成形态错误：{}/{}", a_pv.error_rows, a_pv.total_rows);
    let t = std::time::Instant::now();
    let a_cm = importexport::container_commit(&a_db, &a_vk, &a_user, &container, CONTAINER_PASS, &a_pv.fingerprint, "skip", &a_lk).unwrap();
    let a_commit = t.elapsed();
    assert_eq!(a_cm.created_targets as usize, N);
    assert_eq!(a_cm.created_items as usize, N);

    // ---- B 趟：CSV → 另一个全新库 ----
    let (b_db, b_user, b_vk) = open_vault(dir.path(), "b.db", 63, "乙机", "Bravo#Same2026!");
    let b_lk = lookup_of(&b_db, &b_vk, &b_user);
    let t = std::time::Instant::now();
    let b_pv = importexport::import_preview(&b_db, &b_user, &csv_path, &b_lk).unwrap();
    let b_preview = t.elapsed();
    assert_eq!(b_pv.total_rows, N);
    assert_eq!(b_pv.valid_rows, N, "同一份内容在 CSV 侧的有效行数必须与容器侧一致：错 {} 条", b_pv.error_rows);
    assert_eq!(b_pv.new_targets, N);
    let t = std::time::Instant::now();
    let b_cm = importexport::import_commit(&b_db, &b_vk, &b_user, &b_pv.job_id, None, "skip", None, &b_lk).unwrap();
    let b_commit = t.elapsed();
    assert_eq!(b_cm.created_targets, N);
    assert_eq!(b_cm.created_items, N);

    // ---- 落地内容必须真的可用（两侧各抽一条解密 + 搜索命中）----
    for (tag, db, vk, user) in [("容器", &a_db, &a_vk, &a_user), ("CSV", &b_db, &b_vk, &b_user)] {
        let target = repo::list_targets(db)
            .unwrap()
            .into_iter()
            .find(|t| t.display_name == "营销业务系统 123 区 00123")
            .unwrap_or_else(|| panic!("{tag} 侧导入后找不到抽样的那条目标"));
        let items = repo::list_items_for_target(db, &target.id, user).unwrap();
        let p = repo::item_payload(vk, db, &items[0].id).unwrap();
        assert_eq!(p.username, "zhangsan00123", "{tag} 侧用户名不对");
        assert_eq!(p.password.expose(), "P@ss00123", "{tag} 侧口令解不回来");
        let docs = repo::build_search_index(db, vk, user).unwrap();
        assert_eq!(docs.len(), N, "{tag} 侧索引条数不对");
        let idx = mon_dian_assistant_lib::quick_launcher::search::SearchIndex::new(docs);
        let parsed = mon_dian_assistant_lib::quick_launcher::parse("oa00123.example.internal, zhangsan00123").unwrap();
        assert!(idx.search(&parsed, 20).iter().any(|(d, _)| d.username == "zhangsan00123"), "{tag} 侧数据搜不到");
    }

    println!(
        "[same_content] 造 10000 行同一份数据 {:.2} s｜CSV {:.1} KiB vs 容器 {:.1} KiB｜导出 {:.2} s",
        seed_elapsed.as_secs_f64(),
        csv_bytes as f64 / 1024.0,
        container_bytes as f64 / 1024.0,
        export_elapsed.as_secs_f64(),
    );
    println!(
        "[same_content] 容器趟：预览 {:.2} s + 提交 {:.2} s = {:.2} s（{:.2} ms/行）",
        a_preview.as_secs_f64(),
        a_commit.as_secs_f64(),
        (a_preview + a_commit).as_secs_f64(),
        (a_preview + a_commit).as_secs_f64() * 1000.0 / N as f64,
    );
    println!(
        "[same_content] CSV 趟：预览 {:.2} s + 提交 {:.2} s = {:.2} s（{:.2} ms/行）",
        b_preview.as_secs_f64(),
        b_commit.as_secs_f64(),
        (b_preview + b_commit).as_secs_f64(),
        (b_preview + b_commit).as_secs_f64() * 1000.0 / N as f64,
    );
}
