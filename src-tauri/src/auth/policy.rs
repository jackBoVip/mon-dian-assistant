//! 口令强度评估。注意：这里校验的是**本软件解锁密码**，与账号台账里的外部系统密码无关。
//!
//! **L 轮（2026-10-17）起，主密码路径上不再有强度策略**：交付方判定"不少于 12 位、混合三类字符、
//! 不含常见弱密码"这套要求在使用现场是负担，明确要求取消，使用者自定任意口令。撤销的是
//! `require_non_empty` 那道闸门里的三项判定（只剩"不能是空串"），需求侧的偏离声明见
//! docs/密钥生命周期与加密边界.md 与交付文档 §9。
//!
//! 本模块仍然存在，因为**导出容器口令还归它管**：那份文件离开本机，口令就是它的全部强度，
//! 所以 `export_commit` 继续用 `assess_with(口令, min_length(库))` 判定，`password_strength`
//! 继续给导出面板算实时提示。长度下限是可配置策略（`master_password_min_length`），但管理员
//! 只能**上调**：低于内置下限 `MIN_LENGTH` 的值会被夹紧，否则策略页可以把口令降到 4 位。

use crate::db::Db;
use crate::error::{AppError, Result};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordAssessment {
    pub acceptable: bool,
    /// 0-4
    pub score: u8,
    pub length_ok: bool,
    pub has_class_variation: bool,
    pub not_common: bool,
    pub hint: String,
}

/// 内置下限：任何配置都不能把**导出容器口令**的长度放到这个值以下。
/// 主密码已不走这条判定（L 轮），所以它不再是"解锁密码"的下限。
pub const MIN_LENGTH: usize = 10;
/// 出厂默认（与 lib.rs 的 seed 值、迁移 0003 一致）。L 轮起只作用于导出容器口令。
pub const DEFAULT_CONFIGURED_MIN_LENGTH: i64 = 12;
/// 配置上限：防止误填 1000 之类把界面和 KDF 输入撑坏。
pub const MAX_CONFIGURED_MIN_LENGTH: i64 = 64;

pub const COMMON: &[&str] = &[
    "password", "12345678", "qwerty", "abc12345", "111111111", "admin123",
    "iloveyou", "monkey123", "password1", "1q2w3e4r", "aa112233", "master123",
];

/// 当前生效的最小长度：读设置并夹紧到 `[MIN_LENGTH, MAX_CONFIGURED_MIN_LENGTH]`。
/// L 轮起只有导出容器口令与 `password_strength` 提示读它，主密码判定不再经过这里。
pub fn min_length(db: &Db) -> usize {
    crate::settings::get_i64(db, "master_password_min_length", DEFAULT_CONFIGURED_MIN_LENGTH)
        .clamp(MIN_LENGTH as i64, MAX_CONFIGURED_MIN_LENGTH) as usize
}

pub fn assess(pw: &str) -> PasswordAssessment {
    assess_with(pw, MIN_LENGTH)
}

/// 按指定长度下限评估强度。长度项与提示都用同一个 `min_len`，界面上说多少就按多少判。
pub fn assess_with(pw: &str, min_len: usize) -> PasswordAssessment {
    let length_ok = pw.chars().count() >= min_len;
    let classes = [
        pw.chars().any(|c| c.is_ascii_lowercase()),
        pw.chars().any(|c| c.is_ascii_uppercase()),
        pw.chars().any(|c| c.is_ascii_digit()),
        pw.chars().any(|c| !c.is_alphanumeric()),
    ]
    .iter()
    .filter(|b| **b)
    .count();
    let has_class_variation = classes >= 3;
    let lower = pw.to_lowercase();
    let not_common = !COMMON.iter().any(|c| lower.contains(c));
    let score = (length_ok as u8)
        + (has_class_variation as u8)
        + if pw.chars().count() >= 14 { 1 } else { 0 }
        + if not_common { 1 } else { 0 };
    let acceptable = length_ok && has_class_variation && not_common;
    let hint = if !length_ok {
        format!("至少 {min_len} 个字符")
    } else if !has_class_variation {
        "请混合大小写字母、数字或符号中的至少三类".to_string()
    } else if !not_common {
        "该密码过于常见，容易被字典攻击命中".to_string()
    } else if score >= 4 {
        "强度良好".to_string()
    } else {
        "可以再长一些以提升抗暴力猜测能力".to_string()
    };
    PasswordAssessment { acceptable, score, length_ok, has_class_variation, not_common, hint }
}

/// 主密码路径上唯一保留的一道校验：**不能是空串**。
///
/// L 轮（交付方 2026-10-17 的决定）撤掉了长度、字符类别、常见弱密码三项判定——建库、改密、
/// 新增使用者、管理员重置四种口令都接受任意非空输入，`master_password_min_length` 对它们
/// 不再有任何作用。空串仍然要挡：一旦写进库，"解锁"就成了直接回车，且这份库永远无法通过
/// 界面重设成有口令（口令字段本身是必填项）。只含空格的口令按空串同等对待，否则界面上
/// 看着什么都没填的库其实已经建好了。
///
/// 导出容器口令**不走这里**，它仍然按 `assess_with` 四项判定（见 `importexport::export_commit`）。
pub fn require_non_empty(pw: &str) -> Result<()> {
    if pw.trim().is_empty() {
        return Err(AppError::WeakPassword("主密码不能为空，也不能只输入空格。".to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_strong_passphrase() {
        let a = assess("蒙电#Vault2026!x");
        assert!(a.acceptable);
        assert_eq!(a.score, 4);
    }

    #[test]
    fn rejects_short_password() {
        assert!(!assess("Aa1!").acceptable);
        assert!(!assess("Aa1!").length_ok);
    }

    #[test]
    fn rejects_single_class_password() {
        let a = assess("aaaaaaaaaaaaa");
        assert!(!a.acceptable);
        assert!(!a.has_class_variation);
    }

    #[test]
    fn rejects_common_substrings() {
        assert!(!assess("MyPassword123!").acceptable);
        assert!(!assess("Qwerty2026!!").acceptable);
    }

    #[test]
    fn empty_is_unacceptable() {
        assert!(!assess("").acceptable);
    }

    /// 长度配置仍然要有牙齿——只不过 L 轮起它管的是导出容器口令：
    /// 夹紧区间、越界值不生效、非数字不 panic，判定入口换成 assess_with 逐条照旧断言。
    #[test]
    fn configured_min_length_still_gates_the_container_assessment() {
        let d = Db::open_in_memory(&vec![41u8; 32]).unwrap();
        // 未配置 → 出厂默认 12
        assert_eq!(min_length(&d), 12);
        assert!(!assess_with(&pw_of(11), min_length(&d)).length_ok, "11 位在默认策略下应判为过短");
        assert!(assess_with(&pw_of(12), min_length(&d)).acceptable);

        crate::settings::set(&d, "master_password_min_length", "20", "security").unwrap();
        assert_eq!(min_length(&d), 20);
        assert!(!assess_with(&pw_of(12), min_length(&d)).acceptable, "上调下限后原来的口令必须被拒");
        assert!(!assess_with(&pw_of(18), min_length(&d)).acceptable);
        assert!(assess_with(&pw_of(20), min_length(&d)).acceptable);

        // 管理员不能把配置降到内置下限以下（写什么都按 10 判）
        crate::settings::set(&d, "master_password_min_length", "3", "security").unwrap();
        assert_eq!(min_length(&d), 10);
        crate::settings::set(&d, "master_password_min_length", "9999", "security").unwrap();
        assert_eq!(min_length(&d), 64, "异常大的配置必须被夹紧");

        // 非数字配置不能造成 panic，也不能放开策略
        crate::settings::set(&d, "master_password_min_length", "十二", "security").unwrap();
        assert_eq!(min_length(&d), 12);
    }

    /// L 轮口径：主密码不再有强度策略。这一条同时守住两件事——
    /// ① 取消是真取消了（短、单类别、命中弱密码表、低于设置里那个 18 的口令全都能过）；
    /// ② 取消只发生在主密码这条路（同一批口令喂给容器口令那套判定，必须仍然全部不合格）。
    /// 守住 ② 是因为两条路共用本模块，谁顺手把 assess_with 改松了，界面上看不出来。
    #[test]
    fn master_password_has_no_complexity_policy_but_container_still_does() {
        let d = Db::open_in_memory(&vec![41u8; 32]).unwrap();
        crate::settings::set(&d, "master_password_min_length", "18", "security").unwrap();
        for pw in ["a", "12345678", "password", "aaaaaaaaaaaaaaaaa", "Ab1!"] {
            require_non_empty(pw).unwrap_or_else(|e| panic!("主密码 {pw:?} 应当被接受，却被拒：{e:?}"));
            assert!(!assess_with(pw, min_length(&d)).acceptable, "{pw:?} 仍应被导出容器口令的闸门拒掉");
        }
        // 长口令也不再受任何上限约束
        require_non_empty(&pw_of(200)).unwrap();

        let e = require_non_empty("").unwrap_err();
        assert_eq!(e.code(), "WEAK_PASSWORD");
        assert_eq!(e.safe_detail(), "主密码不能为空，也不能只输入空格。");
        assert_eq!(e.to_string(), "口令不满足要求", "L 轮起这句正文不再特指主密码，也不再说\"策略\"");
        require_non_empty("   ").unwrap_err();
    }

    /// 提示文案里的长度必须与判定所用的长度一致，否则界面与后端各说一套。
    #[test]
    fn hint_reports_the_effective_length() {
        assert!(assess("Ab1!").hint.contains("10"));
        assert!(assess_with("Ab1!", 16).hint.contains("16"));
    }

    /// 精确长度、含四类字符、且不含常见弱密码子串的测试密码。
    fn pw_of(len: usize) -> String {
        let base = "Ab1!xyz9q";
        let mut s = String::new();
        while s.len() < len {
            s.push_str(base);
        }
        s.truncate(len);
        s
    }

    /// 主密码不再有策略，但**导出容器口令**那句实时提示必须仍然自解释、仍然跟着配置走：
    /// 它是那枚口令唯一的人类可读依据（文件一旦离开本机，口令就是它的全部强度）。
    #[test]
    fn container_passphrase_hint_tracks_the_effective_length() {
        let d = Db::open_in_memory(&vec![41u8; 32]).unwrap();
        let a = assess_with("Ab1!", min_length(&d));
        assert!(!a.acceptable);
        assert!(a.hint.contains("至少 12 个字符"), "默认策略的位数要出现在提示里：{}", a.hint);

        crate::settings::set(&d, "master_password_min_length", "18", "security").unwrap();
        let a = assess_with(&pw_of(14), min_length(&d));
        assert!(a.hint.contains("至少 18 个字符"), "上调配置后提示里的位数要跟着变：{}", a.hint);
    }
}
