//! 快捷键配置的纯逻辑：格式校验、平台预设、冲突提示。
//! 真正的系统注册在 `lib.rs` 中通过 tauri-plugin-global-shortcut 完成，
//! 注册失败必须回退到旧快捷键并向用户明确报错（不得静默失效）。

use crate::error::{AppError, Result};

pub const MODIFIER_TOKENS: &[&str] = &["Cmd", "Command", "Ctrl", "Control", "Alt", "Option", "Shift", "Super", "Meta"];

/// 平台默认预设。均可能与其他应用冲突，因此必须可改、可检测。
pub const DEFAULT_ACCELERATORS: &[(&str, &str)] = &[
    ("macos", "Cmd+Shift+Space"),
    ("windows", "Ctrl+Alt+Space"),
    ("linux", "Ctrl+Alt+Space"),
];

pub fn platform_key() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

pub fn default_accelerator() -> &'static str {
    DEFAULT_ACCELERATORS
        .iter()
        .find(|(k, _)| *k == platform_key())
        .map(|(_, v)| *v)
        .unwrap_or("Ctrl+Alt+Space")
}

/// 校验 Tauri global-shortcut 可解析的加速键串。
/// 规则：`Mod+Mod+Key`，至少一个修饰键，键部分非空且不含空格以外的非法字符。
pub fn validate_accelerator(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput);
    }
    let parts: Vec<&str> = trimmed.split('+').map(|p| p.trim()).collect();
    if parts.len() < 2 {
        return Err(AppError::QuerySyntax("快捷键至少要包含一个修饰键和一个按键，例如 Ctrl+Alt+Space".into()));
    }
    let (keys, last) = parts.split_at(parts.len() - 1);
    let last_token = last[0];
    if last_token.is_empty() {
        return Err(AppError::QuerySyntax("快捷键缺少最后的按键".into()));
    }
    for k in keys {
        if !MODIFIER_TOKENS.iter().any(|m| m.eq_ignore_ascii_case(k)) {
            return Err(AppError::QuerySyntax(format!("「{k}」不是有效的修饰键（Cmd/Ctrl/Alt/Shift/Super）")));
        }
    }
    let normalizable = ["Space", "Tab", "Enter", "Esc", "Backspace", "Delete", "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown"];
    let is_named = normalizable.iter().any(|n| n.eq_ignore_ascii_case(last_token));
    let is_single = last_token.chars().count() == 1;
    let is_fn = last_token.len() <= 5 && last_token.to_ascii_lowercase().starts_with('f')
        && last_token[1..].chars().all(|c| c.is_ascii_digit());
    if !(is_named || is_single || is_fn) {
        return Err(AppError::QuerySyntax(format!("「{last_token}」不是可识别的按键")));
    }
    if !keys.iter().any(|k| !k.eq_ignore_ascii_case("shift")) {
        return Err(AppError::QuerySyntax("仅使用 Shift 作为修饰键容易与其他应用冲突，请再添加 Ctrl、Alt 或 Cmd".into()));
    }
    Ok(parts.join("+"))
}

/// 两条加速键是否等价（大小写与修饰键顺序无关）。
pub fn equivalent(a: &str, b: &str) -> bool {
    norm(a) == norm(b)
}

fn norm(raw: &str) -> String {
    // 不能假设主键排在最后：用户在系统管理里可能以任何顺序输入。
    // 先把修饰键别名统一，再「修饰键排序 + 其余按键」拼成规范形式。
    let mut mods: Vec<&'static str> = Vec::new();
    let mut keys: Vec<String> = Vec::new();
    for p in raw.split('+').map(|p| p.trim().to_ascii_lowercase()).filter(|p| !p.is_empty()) {
        match canonical_modifier(&p) {
            Some(m) => mods.push(m),
            None => keys.push(p),
        }
    }
    mods.sort();
    mods.dedup();
    keys.sort();
    format!("{}+{}", mods.join("+"), keys.join("+"))
}

/// 各平台写法归一到同一组内部名，避免 Ctrl/Control、Alt/Option、Super/Cmd 被判成两个组合。
fn canonical_modifier(token: &str) -> Option<&'static str> {
    match token {
        "ctrl" | "control" => Some("ctrl"),
        "alt" | "option" => Some("alt"),
        "shift" => Some("shift"),
        "super" | "cmd" | "command" | "meta" | "win" => Some("super"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_standard_combinations() {
        assert!(validate_accelerator("Cmd+Shift+Space").is_ok());
        assert!(validate_accelerator("ctrl+alt+space").is_ok());
        assert!(validate_accelerator("Ctrl+Alt+F12").is_ok());
        assert!(validate_accelerator("Super+J").is_ok());
    }

    #[test]
    fn rejects_bare_key_and_bad_modifier() {
        assert!(validate_accelerator("Space").is_err());
        assert!(validate_accelerator("Foo+Space").is_err());
        assert!(validate_accelerator("Ctrl+").is_err());
        assert!(validate_accelerator("   ").is_err());
    }

    #[test]
    fn rejects_shift_only_because_it_always_conflicts() {
        assert!(validate_accelerator("Shift+Space").is_err());
    }

    #[test]
    fn default_accelerator_matches_current_platform() {
        let d = default_accelerator();
        assert!(validate_accelerator(d).is_ok(), "平台默认值必须自身合法: {d}");
    }

    #[test]
    fn equivalence_ignores_case_and_order() {
        assert!(equivalent("Ctrl+Alt+Space", "alt+space+CTRL"));
        assert!(!equivalent("Ctrl+Alt+Space", "Ctrl+Shift+Space"));
    }
}
