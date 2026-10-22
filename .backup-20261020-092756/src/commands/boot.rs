//! 启动失败状态的查询命令。
//!
//! 它是界面在"数据库尚未装配"时**唯一**可以安全调用的读取入口之一（另一条是密钥降级闸门）：
//! 两者都只读应用状态，不碰 `state::core()`，所以在装配失败时调用也不会走到 panic。
//! 界面必须第一条就问它——问到失败就只渲染失败页，不再发出任何读库命令。

use tauri::{AppHandle, Manager};

use crate::BootFailure;

/// 把可选的失败状态整理成固定键集的 JSON。抽成纯函数是为了让键名契约能被测试钉住
/// （与 `update::tests::progress_event_matches_frontend_field_names` 同一套路）。
/// 未失败时其余字段一律为空串，前端不需要区分"没有这个键"和"值是空的"。
pub fn report(failure: Option<&BootFailure>) -> serde_json::Value {
    match failure {
        Some(f) => serde_json::json!({
            "failed": true,
            "stage": f.stage,
            "code": f.code,
            "message": f.message,
            "dataDir": f.data_dir,
        }),
        None => serde_json::json!({
            "failed": false,
            "stage": "",
            "code": "",
            "message": "",
            "dataDir": "",
        }),
    }
}

#[tauri::command]
pub fn boot_failure_status(app: AppHandle) -> serde_json::Value {
    match app.try_state::<BootFailure>() {
        Some(failure) => report(Some(&*failure)),
        None => report(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;

    fn sample(stage: &'static str, err: AppError) -> BootFailure {
        BootFailure::new(stage, &err, Some(std::path::Path::new("/tmp/mda-data")))
    }

    /// 键集就是前端 `BootFailureStatus` 的字段名，多一个少一个都会导致界面读不到东西。
    #[test]
    fn report_keys_are_the_stable_contract() {
        let mut keys: Vec<String> = report(Some(&sample(BootFailure::STAGE_ASSEMBLY, AppError::Internal)))
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        keys.sort();
        assert_eq!(keys, ["code", "dataDir", "failed", "message", "stage"]);
        let idle = report(None);
        assert_eq!(idle["failed"], serde_json::Value::Bool(false));
        for k in ["stage", "code", "message", "dataDir"] {
            assert_eq!(idle[k], "", "未失败时 {k} 必须是空串，前端按它判断呈现");
        }
    }

    /// 失败页要能区分三个失败阶段，且如实带上错误码与面向用户的中文说明。
    #[test]
    fn report_names_the_stage_and_the_stable_code() {
        let cases = [
            (BootFailure::STAGE_DATA_DIR, AppError::Internal, "INTERNAL"),
            (BootFailure::STAGE_DEVICE_KEY, AppError::DeviceKeyLostVaultIntact, "DEVICE_KEY_LOST_VAULT_INTACT"),
            (BootFailure::STAGE_ASSEMBLY, AppError::NotInitialized, "VAULT_NOT_INITIALIZED"),
        ];
        let mut stages: Vec<&str> = Vec::new();
        for (stage, err, code) in cases {
            let v = report(Some(&sample(stage, err)));
            assert_eq!(v["failed"], true, "{stage} 必须报 failed");
            assert_eq!(v["stage"], stage);
            assert_eq!(v["code"], code);
            assert!(!v["message"].as_str().unwrap().is_empty(), "{stage} 的说明不能为空");
            stages.push(stage);
        }
        stages.sort();
        stages.dedup();
        assert_eq!(stages.len(), 3, "三个阶段字面量不得重复");
    }

    /// 这条命令的返回面只有错误码、阶段、说明与目录：绝不允许出现密钥材料或库内容。
    /// 键集固定为五个，取值全部来自 `AppError::code()/Display` 与目录路径本身。
    #[test]
    fn report_has_no_field_that_could_carry_a_secret() {
        let v = report(Some(&sample(BootFailure::STAGE_DEVICE_KEY, AppError::DeviceKeyLostVaultIntact)));
        let obj = v.as_object().unwrap();
        for key in obj.keys() {
            assert!(["failed", "stage", "code", "message", "dataDir"].contains(&key.as_str()), "多出来的键 {key} 需要前端契约与评审");
        }
        assert_eq!(obj.len(), 5);
        assert_eq!(v["dataDir"], "/tmp/mda-data", "只报目录，不拼库文件名或任何记录内容");
    }
}
