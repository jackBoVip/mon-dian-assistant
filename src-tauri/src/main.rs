//! 桌面入口。真正的装配逻辑在库crate里，便于单元/基准测试复用。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mon_dian_assistant_lib::run();
}
