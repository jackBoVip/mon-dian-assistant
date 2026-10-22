# 修复优先级计划 — 蒙电信产助手代码质量审查 2026-10-19

排序依据：`blast radius × 用户可见度 ÷ 可逆性`，并考虑工作量。每条都给了**验收判据**（技能质量门要求 recommendation 必须带验证方式）；没有判据的一律不写在这里。

Owner 假设：本项目由交付方一人定义需求与验收，前端/后端均由同一人收口，因此"owner"列一律记为**交付方表态 + 我执行**；涉及真机/装机的一步必须注明，因为 `panic=abort` 的 release 产物与剪贴板/快捷键只有装了才验得到。

## P0 — 今天就错，且改动小、可逆

| # | 动作 | 证据 | 验收判据 | 预估 | 可逆性 |
|---|---|---|---|---|---|
| 1 | **F1** `list_roles` 去掉 `WHERE deleted_at IS NULL`（roles 用 `status` 表达停用，没有软删列），或给 roles 加迁移补列——**二选一要先定**：若产品语义上角色不该软删，就删条件 | `commands/vault.rs:240` vs `migrations/0001_init.sql:57-66` | 新增一条**命令级** Rust 测试：装配后调 `list_roles()` 断言 `is_ok()` 且 3 条（今天的 `migrate.rs:97` 只数行，跑不到这条 SQL）；`cd src-tauri && cargo test --lib roles` | 15 分钟（含测试） | 高 |
| 2 | **F4** `accounts.rs:196` 第一参改成 `&meta.target_type`（对照 `:263` 的正确写法），并删掉多余的 `.clone()` | `db/repo.rs:909` 签名 + 4 处正确调用 | 后端测试：建一个 `target_type=terminal, protocol=telnet` 的目标，调 `target_detail` 断言 `insecure_protocol == true`；前端把 `targetDetail` 的 mock 换成"从后端 DTO 形状推导"至少一条真值用例 | 20 分钟 | 高 |
| 3 | **F5** 作废键补 `targetsPaged`：把 8 处 `queryKeys.targetsAll` 改成同时作废两族（或直接给 `targetsPaged` 加一条 `pagedAll: ['targetsPaged'] as const`，一次 invalidate 两个前缀） | `AccountsPage.tsx:58` vs `:91` | 组件测试：新建系统后断言 `targetsPaged` 被 invalidate（用 spy 断 `queryClient.invalidateQueries` 的入参包含两族）；再加一条**契约测试**：枚举所有 `useQuery` 取数键，断言每个键都有对应的作废前缀（顺带把 F29 的一半窟窿堵上） | 30 分钟 | 高 |
| 4 | **F2** 统一用户名口径：`copy_username` 的授权改成 `ACC_VIEW_SECRET`（与 `to_view` 一致），或反过来让视图允许显示掩码用户名但保持"不解密"——**这是产品决定，我不能替你选** | `accounts.rs:38-55` vs `:460-473` + `actions.rs` 授权表 | 后端测试两条：无 `view_secret` 时 `copy_username` 必须回 `PermissionDenied` 且**不写剪贴板**、**不写审计成功记录**；`grep -c "ACC_READ" quick_launcher/actions.rs` 的 CopyUsername 行变更 | 20 分钟 + 你一句决定 | 高 |
| 5 | **F3** 导入路径补弱协议闸门：`importexport.rs` 建目标前判 `is_insecure_protocol` × `allow_insecure_protocols`，被拒的行计入"错误行"而不是静默入库 | `importexport.rs:796-819` 无判定 vs `accounts.rs:261-266` | 后端测试：`allow_insecure_protocols=false` 时导入含 telnet 的 CSV，断言该行进 `errors`、目标未创建；`=true` 时放行 | 40 分钟 | 高 |

## P1 — 数据可见性、性能与本机暴露

| # | 动作 | 验收判据 | 预估 |
|---|---|---|---|
| 6 | **F7/F8 一起定策略**：回收站要么补记录级可见性（`can_access_item` 进列表 WHERE / 逐行过滤）并**给它一个入口**，要么显式撤下 `list_deleted_items`/`restore_item` 与"删除/恢复"权限文案 | 若选补：后端测试两条（他人条目不出现在列表、恢复他人条目被拒）；若选撤：命令注册表与 `migrations/0002_seed.sql` 的权限描述同步改，`grep -c "restore_item" src-tauri/src/lib.rs` → 0 | 1–2 小时（含界面挂载） |
| 7 | **F9 索引增量化**：把 `rebuild_index()` 从"写后全量"改成"按受影响的 item/target 增量替换"，或至少把重建挪出写事务路径（写命令只作废，首次搜索时懒建） | `cargo bench`（现有 `tests/import_scale.rs` 为入口）给 10k 库一组数：单条 item 改名前后写命令 P50/P95；判据 = 单次写不再触发 N 次解密 | 0.5–1 天，需你确认口径 |
| 8 | **F10 重活挪出同步命令**：解锁（双 Argon2id）、xlsx 解析（≤64MB）、ureq 下载三条先标 `async`（Tauri 走 `respond_async`+`async_runtime::spawn`，`ipc/mod.rs:324-375` 已证），或包 `spawn_blocking` | 实测：10k 库删一条凭据期间拖动主窗不卡；`grep -c "async fn" src-tauri/src/commands/` > 0。**先测线程归属再动**（第四节假设表第 1 条） | 0.5 天 |
| 9 | **F11 IPC 加固**：`read_line` 换成 `take(N).read_line`（N 取 64KB 足够），accept 循环加并发上限/连接节流 | 一条 Rust 测试：发 1MB 无换行数据必须被拒且不 OOM；本机 `nc` 手工验证 | 1 小时 |
| 10 | **F12 文件权限**：改 `OpenOptions::new().mode(0o600).create(true).write(true)`（创建即带权限），Windows 侧补 `ACL` 或至少在失败时 `log::warn!`；chmod 失败不再 `let _ =` 吞 | `cargo test --lib` 加一条：写出的令牌文件 `metadata().permissions().mode() & 0o777 == 0o600` | 1 小时 |
| 11 | **F13/F14/F28 可诊断性三连**：错误映射保留 cause（`AppError::Internal(String)` 或 `#[from] std::io::Error`）+ 关键失败路径 `log::warn!`；清单解析失败改 `InvalidUpdateManifest`；`vite.config.ts:21` 改 `!!process.env.TAURI_ENV_DEBUG` | 三条 grep 判据：`grep -c "map_err(|_| AppError::Internal)" src-tauri/src` 显著下降；`grep -n "TAURI_DEBUG" vite.config.ts` → 0；跑一次 `tauri build --debug` 后 `ls dist/assets/*.map` 非空 | 2–3 小时 |
| 12 | **F33 跨平台 sidecar**：把 sidecar 构建挂进 `beforeBuildCommand`（或按 target triple 分别构建），否则在 `docs/部署手册.md` 明确"其他平台需先手工产出 `binaries/mda_fill_host-<triple>`" | 判据：`ls src-tauri/binaries` 列出与 `bundle.externalBin` 匹配的每个目标；或文档补一节 | 2 小时（构建脚本） |
| 13 | **F15 编辑不覆盖 allowedOrigin**：`TargetFormDialog` 提交时把后端原值带回（它已经这么处理 tenant/vendor），或地址变更才重派生 | 后端测试：导入一条 `allowed_origin != origin(url)` 的目标 → 只改显示名保存 → 断言 origin 未变；再走一次"打开并填充"集成路径 | 1 小时 |

## P2 — 卫生与守卫（一次批量清，风险最低）

| # | 动作 | 验收判据 |
|---|---|---|
| 14 | **F16 死件清账**：删 `StatsStrip.tsx`、`state/shell.ts`（AD 轮删 SideMenu 时漏的伴生状态）、业务 `Pagination.tsx` 的 `Pagination` 组件（保留活的 `pageItems`）；`DeletedItemsPanel`/`RecentAccessPanel` **按"停用可逆"口径保留还是删，需你一句**（与 F8 的取舍联动）；死导出 `isSessionError`/`TYPE_FILTERS` 去掉 export 或删 | `grep -rn "StatsStrip\|state/shell'" src` → 0；`npm run verify` 全绿 |
| 15 | **F17/F18 依赖瘦身**：移除 npm `@tauri-apps/plugin-clipboard-manager`、`@tauri-apps/plugin-global-shortcut`（前端 0 引用，能力在 Rust + capabilities 侧）；复核 Rust `regex`/`once_cell`/`subtle` | 移除后 `npm run verify` + 真机各一次"复制用户名""Cmd+Shift+Space"；`cargo check` 无告警 |
| 16 | **F20 词表收敛**：删 `:root` 与 `@theme inline` 里的 `--chart-1..5`、`--sidebar-*`（无组件消费，实测 11+ 枚死声明），并在测试里加一条**惰性等式守卫**：产物中每条 `--x:` 定义要么被 `var()` 引用，要么在登记表里带 `why` | 复用我这次跑的脚本（`grep -o -- "--\(sidebar\|chart\)-[a-z0-9-]*:" dist/…` → 0）；新守卫进 `globalCssEquivalence.test.ts` 或 `themeContrast.test.ts` |
| 17 | **F31 基线完整性**：让等价测试**读并校验** `BASELINE.css.sha256`，并把基线目录名从"排序取最新"改成"登记表里显式钉住一个快照名" | 新增一条断言：`sha256(baseline global.css) === 登记表里的值`；随便改一份快照内容 → 测试必须红 |
| 18 | **F29/F30/F34/F21 测试结构**：① `api.ts` 与 `lib.rs` 注册表的双向 diff 固化成一条测试（我这次实测 81↔81，但没有守卫）；② 取数键↔作废键契约（P0#3 已含）；③ 新 Radix 控件补 `aria-invalid`/`aria-describedby`/`combobox` 断言（实测 0 处）；④ 把"钉 className/钉 CSS 变量"的断言逐步换成行为断言；⑤ 一条最小 CI（`npm run verify` + `cargo test`） | 判据即上述计数从 0 变非 0；CI 首跑绿 |
| 19 | **F22 免费严格项**：开 `verbatimModuleSyntax`（实测 0 错）、`noImplicitOverride`（0 错）；`noPropertyAccessFromIndexSignature`(40) / `exactOptionalPropertyTypes`(17) / `noUncheckedIndexedAccess`(91，其中生产仅 13 且已逐条判为守卫充分) **暂不开**，登记为待办 | `npx tsc --noEmit` 无输出即为验收；三个数字来自 `npx tsc --noEmit --<flag> | grep -c "error TS"` 实测 |
| 20 | **F23/F25/F26/F35 小修**：`pending` 改按行传（或拆 mutation 变量携带 id）；`ArrowDown` 空结果时不动 `active`（把 clamp 扩到下界）；`SystemIODialog` 重置清单补 `dragOver`、错误行 key 加 index；12 枚同名类逐条判层后合并或注明 | 每条一个组件测试；`grep -n "dragOver" SystemIODialog.tsx` 出现在重置函数里 |
| 21 | **F32 CSP 单源**：要么把 meta 删掉只留 conf（Tauri 注入头），要么加一条测试断言三处文本等价；注意 `frame-ancestors` 在 meta 里本就无效 | 判据：三份文本逐字节相同，或只剩一份 |

## 建议执行顺序与理由

1. **P0 #1–#5**（一天内）：全部是可逆的小改动，且 #1/#4/#5 属"功能今天就不对"。
2. **P2 #17**（F31 基线校验）：在继续大改之前把主门禁钉牢，否则后续任何"布局一致"的结论都可能建立在被换掉的基线上——这一条我建议排在性能类改动（P1 #7/#8）之前。
3. **P1 #6 → #13**：#6 需要你先定回收站的产品去留，它同时决定 F7 是修还是撤。
4. **P1 #7/#8**（性能）必须带测量：先跑 `cargo bench` 拿 10k 基线，再改，再跑——否则无法证明改进，也无法回滚判断。
5. **P2 批量**最后扫，风险最低、最容易被前面几步的改动牵连（例如 #16 删 sidebar/chart 别称若与样式层改动同批，等价测试的豁免表要一起更新）。

## 不要动（交付方点名的刻意决策，改动即违规）

- 不引 Web 字体；四套主题只走 `[data-theme]`；字面色只住 `tokens.css`；legacy 样式住 `@layer mda` 且不用 `@apply`
- 启动器浮层窗口不引入 Radix / Portal / `vh` / `fixed` / 遮罩（`launcherApp.test.tsx:339-372` 反向守卫）
- CSP 的 `style-src 'unsafe-inline'` 必须保留（Radix 内联样式）
- 主密码无强度策略；含明文口令导出无二次认证（出厂策略值，闸门机制留着）
- DEK 全库轮换不实现；无 `npm run lint`（已按决策删除，静态检查口径 = tsc + vitest）
- `useMemo`/`useCallback` 不新增（"最新惯用法"= 停止手工 memo）
