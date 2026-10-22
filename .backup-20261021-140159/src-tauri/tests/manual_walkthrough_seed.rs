//! 真机手工走查用的保险库播种器：把一份**合成**台账写进指定数据目录，
//! 让发布产物启动后直接落在解锁页，从而能在真机上验"有数据时"的界面行为
//! （台账分页 / 筛选 / 浮层推荐 / 失焦隐藏）。
//!
//! 只有显式设置 `MDA_SEED_DIR` 时才会写盘，否则直接返回——它不可能在 `cargo test`
//! 里误伤任何真实目录。所有口令与系统名都是合成的，不含任何真实凭据。
//!
//! 用法（配合真机走查脚本）：
//! 1. 准备一个空数据目录，写入 `vault.device.key`（32 字节，0600）；
//! 2. `MDA_SEED_DIR=<该目录> MDA_SEED_ROWS=300 cargo test --test manual_walkthrough_seed --release -- --ignored --nocapture`；
//! 3. 用同一个目录作 `HOME` 启动发布产物，界面应停在解锁页，主密码见下方常量。

use mon_dian_assistant_lib::auth::users;
use mon_dian_assistant_lib::crypto::SecretString;
use mon_dian_assistant_lib::db::{repo, Db};

/// 走查用的合成主密码：真机上要把它敲进解锁页，所以固定写在源码里，不读环境变量、不打日志。
const SEED_MASTER: &str = "Walkthrough#Pass2026!";
const SEED_NICKNAME: &str = "走查机";

#[test]
#[ignore = "真机手工走查用的播种器：只在显式给出 MDA_SEED_DIR 时写盘"]
fn seed_vault_for_manual_walkthrough() {
    let Ok(dir) = std::env::var("MDA_SEED_DIR") else {
        eprintln!("未设置 MDA_SEED_DIR，跳过播种（这条测试不该在常规跑批里写任何目录）");
        return;
    };
    let rows = std::env::var("MDA_SEED_ROWS").ok().and_then(|v| v.parse().ok()).unwrap_or(300usize);
    let data_dir = std::path::PathBuf::from(dir);
    let key = std::fs::read(data_dir.join("vault.device.key")).expect("先写入 32 字节的 vault.device.key");
    assert_eq!(key.len(), 32, "设备密钥文件必须是 32 字节");

    let db = Db::open(&data_dir.join("vault.db"), &key).unwrap();
    let (user_id, vk) = users::initialize(&db, SEED_NICKNAME, SEED_MASTER).unwrap();

    let group_ids = (0..10)
        .map(|g| repo::create_group(&db, &user_id, &format!("走查分组{g:02}"), None).unwrap())
        .collect::<Vec<_>>();

    for i in 0..rows {
        let meta = repo::TargetSecretPayload {
            url: format!("https://walk{i:04}.example.internal/login"),
            host: format!("walk{i:04}.example.internal"),
            allowed_origin: format!("https://walk{i:04}.example.internal"),
            ..Default::default()
        };
        let target_id = repo::create_target(
            &db,
            &vk,
            &user_id,
            &repo::NewTarget {
                target_type: "web".to_string(),
                display_name: format!("走查系统 {} 区 {:04}", i % 20, i),
                group_id: Some(group_ids[i % group_ids.len()].clone()),
                meta,
            },
        )
        .unwrap();
        repo::create_item(
            &db,
            &vk,
            &user_id,
            &repo::NewItem {
                target_id,
                account_alias: if i % 3 == 0 { "运维".to_string() } else { "只读".to_string() },
                tags: vec![if i % 4 == 0 { "重点".to_string() } else { "常规".to_string() }],
                favorite: i % 7 == 0,
                payload: repo::CredentialPayload {
                    username: format!("walkuser{i:04}"),
                    password: SecretString::new(format!("W@lk{i:04}")),
                    auth_method: "password".to_string(),
                    ..Default::default()
                },
                set_as_default: true,
            },
        )
        .unwrap();
    }

    let targets = repo::list_targets(&db).unwrap().len();
    let docs = repo::build_search_index(&db, &vk, &user_id).unwrap();
    println!("[seed] 数据目录={}：{} 个目标、{} 条索引文档、{} 个分组", data_dir.display(), targets, docs.len(), group_ids.len());
    assert_eq!(targets, rows);
    assert_eq!(docs.len(), rows);
}
