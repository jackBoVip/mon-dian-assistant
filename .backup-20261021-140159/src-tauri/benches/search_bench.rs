//! 性能基准：内存索引检索 + 1 万条规模的数据层索引重建。
//!
//! 运行方式（发布模式，避免 debug 开销污染数据）：
//!   cargo bench --bench search_bench
//! 结果里的 median / Pi95 对应需求中的"快捷搜索 P95 < 200ms"与"数据库查询 P95 < 300ms"。
//! 合成数据仅用于测量吞吐，不是任何真实业务数据。

use std::hint::black_box;
use std::time::Instant;

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};

use mon_dian_assistant_lib::auth::users;
use mon_dian_assistant_lib::crypto::vault_key::VaultKey;
use mon_dian_assistant_lib::db::{repo, Db};
use mon_dian_assistant_lib::quick_launcher::search::{MatchKind, SearchDoc, SearchIndex};
use mon_dian_assistant_lib::quick_launcher::{parse, query::search_unlocked, query::ActionPolicy};

const ROWS: usize = 10_000;

fn synthetic_docs(n: usize) -> Vec<SearchDoc> {
    (0..n)
        .map(|i| SearchDoc {
            target_id: format!("tg{i:06}"),
            item_id: format!("it{i:06}"),
            system_name: format!("营销业务系统 {} 区", i % 200),
            address: format!("https://oa{:05}.example.internal/login", i % 500),
            host: format!("oa{:05}.example.internal", i % 500),
            port: String::new(),
            username: format!("zhangsan{:05}", i),
            account_alias: if i % 3 == 0 { "运维" } else { "只读" }.to_string(),
            item_type: "web".to_string(),
            group_name: format!("分组{}", i % 20),
            tags: vec![format!("标签{}", i % 7), "生产".to_string()],
            note: String::new(),
            favorite: i % 97 == 0,
            is_default: i % 2 == 0,
            last_accessed_at: if i % 5 == 0 { Some(format!("2026-01-{:02}", (i % 28) + 1)) } else { None },
            credential_count: 1 + (i % 4),
        })
        .collect()
}

/// 单条查询（AND 多条件）在内存索引上的耗时分布。
fn bench_index_search(c: &mut Criterion) {
    let docs = synthetic_docs(ROWS);
    let index = SearchIndex::new(docs);
    let policy = ActionPolicy { allow_copy_password: true, require_reauth_for_password: false, can_copy_username: true };
    let queries = [
        "营销业务系统 7 区, oa00123",
        "系统:营销业务系统 12 区，账号:运维",
        "张三, 生产",
        "不存在的系统xyz, 运维",
        "标签:标签3, 只读, 区",
    ];
    let mut g = c.benchmark_group("quick_search_10k");
    for q in queries {
        g.bench_with_input(BenchmarkId::new("and_query", q), &(), |b, _| {
            b.iter(|| {
                let parsed = parse(black_box(q)).unwrap();
                let hits = index.search(&parsed, 20);
                black_box(hits.len())
            })
        });
    }
    // 与命令层完全相同的入口（含策略与扩展门）
    g.bench_function("via_search_unlocked", |b| {
        b.iter(|| black_box(search_unlocked(&index, black_box("营销业务系统 7 区, oa00123"), 20, true, &policy, true, true).map(|v| v.len())))
    });
    g.finish();

    // 直接打印 P95 近似值：criterion 自身也会给 percentile，这里额外做一次顺序采样
    let mut samples: Vec<u128> = Vec::new();
    for i in 0..2000 {
        let q = format!("营销业务系统 {} 区, oa{:05}", i % 200, i % 500);
        let t = Instant::now();
        if let Ok(parsed) = parse(&q) {
            black_box(index.search(&parsed, 20).len());
        }
        samples.push(t.elapsed().as_micros());
    }
    samples.sort_unstable();
    let p50 = samples[samples.len() / 2];
    let p95 = samples[(samples.len() as f64 * 0.95) as usize];
    let p99 = samples[(samples.len() as f64 * 0.99) as usize];
    println!("内存索引检索 10k 条 / 2000 次采样：P50={p50}µs P95={p95}µs P99={p99}µs（要求 P95 < 200000µs）");
    assert!(p95 < 200_000, "快捷搜索 P95 必须小于 200ms，实测 {p95}µs");
}

/// 数据层：1 万条凭据的索引重建（解密 + 查询），对应"数据库查询 P95 < 300ms"。
fn bench_db_index_build(c: &mut Criterion) {
    let dir = tempfile::tempdir().unwrap();
    let key = vec![11u8; 32];
    let db = Db::open(&dir.path().join("bench.db"), &key).unwrap();
    let (user_id, vk): (String, VaultKey) = users::initialize(&db, "基准用户", "Bench#Pass2026!").unwrap();
    let t0 = Instant::now();
    for i in 0..ROWS {
        let nt = repo::NewTarget {
            target_type: "web".to_string(),
            display_name: format!("营销业务系统 {} 区", i % 200),
            group_id: None,
            meta: repo::TargetSecretPayload {
                url: format!("https://oa{i:05}.example.internal/login"),
                allowed_origin: format!("https://oa{i:05}.example.internal"),
                host: format!("oa{i:05}.example.internal"),
                ..Default::default()
            },
        };
        let target_id = repo::create_target(&db, &vk, &user_id, &nt).unwrap();
        let item = repo::NewItem {
            target_id,
            account_alias: if i % 3 == 0 { "运维".to_string() } else { "只读".to_string() },
            tags: vec!["生产".to_string()],
            favorite: false,
            payload: repo::CredentialPayload {
                username: format!("user{i:05}"),
                password: mon_dian_assistant_lib::crypto::SecretString::new(format!("P@ss{i:05}")),
                ..Default::default()
            },
            set_as_default: i % 2 == 0,
        };
        repo::create_item(&db, &vk, &user_id, &item).unwrap();
    }
    let seeded = t0.elapsed();
    println!("10k 条凭据写入耗时：{} ms（含 AEAD 封装与事务提交）", seeded.as_millis());

    let mut g = c.benchmark_group("db_index_rebuild_10k");
    g.sample_size(10);
    g.bench_function("build_search_index", |b| {
        b.iter(|| {
            let docs = repo::build_search_index(&db, black_box(&vk), black_box(&user_id)).unwrap();
            black_box(docs.len())
        })
    });
    g.finish();

    let t = Instant::now();
    let docs = repo::build_search_index(&db, &vk, &user_id).unwrap();
    let elapsed = t.elapsed();
    println!("索引重建（10k 条，含解密）：{} ms，得到 {} 条文档（要求 P95 < 300ms）", elapsed.as_millis(), docs.len());

    // 数据库查询延迟分布：这是"数据库查询 P95 < 300ms"的直接证据，
    // 覆盖台账列表、单条读取、默认账号解析三种真实查询形状。
    {
        let mut samples: Vec<u128> = Vec::new();
        for i in 0..300 {
            let t = Instant::now();
            match i % 3 {
                0 => {
                    black_box(repo::list_targets(&db).map(|v| v.len()).unwrap_or(0));
                }
                1 => {
                    let tid = format!("tg{:06}", i % 500);
                    black_box(repo::list_items_for_target(&db, &tid, &user_id).map(|v| v.len()).unwrap_or(0));
                }
                _ => {
                    let tid = format!("tg{:06}", (i * 7) % 500);
                    black_box(repo::default_credential(&db, &user_id, &tid).map(|v| v.is_some()).unwrap_or(false));
                }
            }
            samples.push(t.elapsed().as_micros());
        }
        samples.sort_unstable();
        let p50 = samples[samples.len() / 2];
        let p95 = samples[(samples.len() as f64 * 0.95) as usize];
        let p99 = samples[(samples.len() as f64 * 0.99) as usize];
        println!(
            "SQLite+SQLCipher 查询延迟 10k 条 / 300 次采样：P50={}µs P95={}µs P99={}µs（要求 P95 < 300000µs）",
            p50, p95, p99
        );
        assert!(p95 < 300_000, "数据库查询 P95 必须小于 300ms，实测 {p95}µs");
    }

    // 索引丢弃必须清零
    let mut idx = SearchIndex::new(docs);
    idx.wipe();
    assert_eq!(idx.len(), 0);
    assert_eq!(format!("{:?}", MatchKind::Exact), "Exact");
}

/// 台账列表分页延迟：需求要求 1 万条数据下"输入搜索和切换页面应保持流畅"。
/// 复用 `bench_db_index_build` 那份 10k 目标 + 10k 凭据的库，走生产同一条 `query_targets`。
/// 四种形状对应界面上真实会发生的四种操作：翻页、关键字搜索、类型+仅收藏、类型+标签。
/// 另外测两个新数据源：标签下拉（全表 DISTINCT）与最近访问（按时间倒序取 8 条）。
fn bench_paged_target_list(c: &mut Criterion) {
    let dir = tempfile::tempdir().unwrap();
    let key = vec![11u8; 32];
    let db = Db::open(&dir.path().join("paged.db"), &key).unwrap();
    let (user_id, vk): (String, VaultKey) = users::initialize(&db, "分页基准", "Bench#Pass2026!").unwrap();
    let t0 = Instant::now();
    let mut accessed: Vec<String> = Vec::new();
    for i in 0..ROWS {
        let nt = repo::NewTarget {
            target_type: "web".to_string(),
            display_name: format!("营销业务系统 {} 区", i % 200),
            group_id: None,
            meta: repo::TargetSecretPayload {
                url: format!("https://oa{i:05}.example.internal/login"),
                allowed_origin: format!("https://oa{i:05}.example.internal"),
                host: format!("oa{i:05}.example.internal"),
                ..Default::default()
            },
        };
        let target_id = repo::create_target(&db, &vk, &user_id, &nt).unwrap();
        let item = repo::NewItem {
            target_id,
            account_alias: if i % 3 == 0 { "运维".to_string() } else { "只读".to_string() },
            // 标签一半一半，保证标签筛选是"有选择性的条件"而不是命中全部或命中 0 条
            tags: vec![if i % 2 == 0 { "生产" } else { "测试" }.to_string()],
            // 每 97 条收藏一次，保证"仅收藏"分支真的能命中记录而不是恒返回空
            favorite: i % 97 == 0,
            payload: repo::CredentialPayload {
                username: format!("user{i:05}"),
                password: mon_dian_assistant_lib::crypto::SecretString::new(format!("P@ss{i:05}")),
                ..Default::default()
            },
            set_as_default: false,
        };
        let item_id = repo::create_item(&db, &vk, &user_id, &item).unwrap();
        if i % 500 == 0 {
            accessed.push(item_id);
        }
    }
    // 每 500 条留一次"访问过"的痕迹，让 recent_access 基准读到真实数据而不是空集
    for id in &accessed {
        repo::touch_last_accessed(&db, id).unwrap();
    }
    println!("分页基准库写入 10k 目标 + 10k 凭据：{} ms", t0.elapsed().as_millis());

    let unpaged = Instant::now();
    let all = repo::query_targets(&db, &repo::TargetQuery::default()).unwrap();
    println!(
        "整表取回（分页前的做法）：{} ms，{} 行 / total {} —— 这就是以前每次都塞进 DOM 的量",
        unpaged.elapsed().as_millis(),
        all.0.len(),
        all.1
    );

    // 新增两个入口的数据源也测一次：标签下拉与最近访问
    let tags_t = Instant::now();
    let tags = repo::list_item_tags(&db).unwrap();
    println!(
        "标签下拉数据源 list_item_tags（10k 凭据、{} 个不同标签）：{} ms",
        tags.len(),
        tags_t.elapsed().as_millis()
    );
    let recent_t = Instant::now();
    let recent = repo::recent_access(&db, 8).unwrap();
    println!(
        "最近访问取数 recent_access（{} 条有访问痕迹，取 8 条）：{} µs",
        accessed.len(),
        recent_t.elapsed().as_micros()
    );
    assert_eq!(recent.len(), 8.min(accessed.len()), "取数必须真的命中记录，否则这条基准是空的");
    // 标签条件必须真的筛掉一半，否则"类型+标签"形状测的是恒真条件
    let (_, tag_total) = repo::query_targets(&db, &repo::TargetQuery { tag: Some("生产"), ..Default::default() }).unwrap();
    assert_eq!(tag_total as usize, ROWS / 2, "标签「生产」应命中一半目标，实测 {tag_total}");

    let mut g = c.benchmark_group("target_list_paged_10k");
    for (name, q) in [
        ("翻页 第50页", repo::TargetQuery { limit: Some(20), offset: 980, ..Default::default() }),
        ("关键字", repo::TargetQuery { keyword: Some("营销业务系统 12 区"), limit: Some(20), offset: 20, ..Default::default() }),
        ("类型+仅收藏", repo::TargetQuery { item_type: Some("web"), favorite_only: true, ..Default::default() }),
        ("类型+标签", repo::TargetQuery { item_type: Some("web"), tag: Some("生产"), limit: Some(20), offset: 20, ..Default::default() }),
    ] {
        g.bench_with_input(BenchmarkId::new("query_targets", name), &q, |b, q| {
            b.iter(|| {
                let (rows, total) = repo::query_targets(black_box(&db), black_box(q)).unwrap();
                black_box((rows.len(), total))
            })
        });
    }
    g.finish();

    let mut samples: Vec<u128> = Vec::new();
    for i in 0..300 {
        let q = match i % 4 {
            0 => repo::TargetQuery { limit: Some(20), offset: ((i % 50) as i64) * 20, ..Default::default() },
            1 => repo::TargetQuery { keyword: Some("营销业务系统 12 区"), limit: Some(20), offset: 20, ..Default::default() },
            2 => repo::TargetQuery { item_type: Some("web"), favorite_only: true, limit: Some(20), ..Default::default() },
            _ => repo::TargetQuery { item_type: Some("web"), tag: Some("生产"), limit: Some(20), offset: 20, ..Default::default() },
        };
        let t = Instant::now();
        let (rows, total) = repo::query_targets(&db, &q).unwrap();
        samples.push(t.elapsed().as_micros());
        black_box((rows.len(), total));
    }
    samples.sort_unstable();
    let p50 = samples[samples.len() / 2];
    let p95 = samples[(samples.len() as f64 * 0.95) as usize];
    let p99 = samples[(samples.len() as f64 * 0.99) as usize];
    println!(
        "台账分页查询（每页 20 条 + 符合条件的总数）10k 目标 / 300 次采样：P50={p50}µs P95={p95}µs P99={p99}µs（要求 P95 < 300000µs）"
    );
    assert!(p95 < 300_000, "分页列表查询 P95 必须小于 300ms，实测 {p95}µs");
    // 翻页的正确性顺带断言：每页确实只有 20 行，总数不受切片影响
    let page = repo::query_targets(&db, &repo::TargetQuery { limit: Some(20), offset: 980, ..Default::default() }).unwrap();
    assert_eq!(page.0.len(), 20);
    assert_eq!(page.1, ROWS as i64);
}

criterion_group!(benches, bench_index_search, bench_db_index_build, bench_paged_target_list);
criterion_main!(benches);
