# 代码质量与架构风险审查 — 蒙电信产助手

- 审查日期：2026-10-19
- 审查目标：全面排查**过期/废弃 API、无用代码、逻辑缺陷、性能问题**（交付方原话）
- 方法：`risk-quality-reviewer` 场景技能 + 四路并行取证（前端 / Rust 后端 / 构建-样式-测试 / 业务域），每条发现由审查者本人回源复核；无法回源的一律降级为 `assumption` 并写出验证步骤
- 范围：`src/**`（68 个生产 ts/tsx）、`src-tauri/src/**`（81 条 tauri command）、`migrations/*.sql`（7 条）、`src/styles/*`、`src/**/*.test.*`（34 文件 / 398 条）、`extension/**`
- 基线对照：仓库**不是 git 仓库**，所以技能里的 diff 取证法改用 `.backup-20261019-132949/` 快照 + `dist` 产物
- 门禁现状（审查起点，非结论）：`npx tsc --noEmit` 无输出、`npm run build` rc=0、`npx vitest run` 34 文件 / 398 条全绿

## 结论先行

代码卫生层面这个项目**已经过度达标**：React 遗留 API、Tauri v1 API、`as any`、`@ts-ignore`、`eslint-disable`、`console.*`、`TODO/FIXME` 全部 **0 命中**；非测试区 Rust 只剩 5 处 `unwrap/expect`，其中 4 处是固定长度加密原语或构造保证；SQL 全走 `params!`，无可注入点；`global.css` 里生产不可达的类实测仅 3 枚且都是注释里的字符串（≈0）。

真正的问题**全在门禁看不见的地方**，而且集中成一条主线：**权限与状态判定的"多套口径"**——同一件事在两个入口有两种答案。这类缺陷类型检查发现不了，测试也发现不了（前端测试靠 mock 喂理想值，Rust 测试只数表结构）。最高优先级四条：

| # | 一句话 | 为什么现在就该修 |
|---|---|---|
| F1 | `list_roles` 的 SQL 引用了 `roles` 表**不存在的列**，该命令**每次调用必失败** | 已在真 SQLite 上复现报错；系统管理·使用者整块角色分配不可用 |
| F2 | `copy_username` 只要 `accounts.read` 就把**明文用户名**写进剪贴板，而列表视图在**没有 `view_secret` 时连用户名都不解密** | 同一字段两套保密口径，低权限侧反而是宽松的那条 |
| F3 | 导入路径**不过弱协议闸门**，而详情侧的弱协议徽章因参数错位**恒为 false** | 策略可绕过 + 绕过之后看不见 |
| F4 | 主列表取数键 `targetsPaged` 与 8 处作废键 `['targets']` **前缀不匹配** | 增删改系统后左栏不刷新，且 `verify` 全绿 |

## 一、发现表

严重度 = 影响 × 可达性；置信度按 `architecture-contract` 的分级（high = 直接代码/复现证据）。

### P0 — 正确性缺陷，今天就在错

| ID | 级别 | 证据（我本人复核） | 问题 | 后果 | 置信 |
|---|---|---|---|---|---|
| F1 | H | `src-tauri/src/commands/vault.rs:240`；`migrations/0001_init.sql:57-66`（roles 列：id/code/name/description/status/builtin/created_at/updated_at，**无 deleted_at**）。复现：把 0001 的 DDL 灌进临时 sqlite3 后执行该 SELECT → `Parse error: no such column: deleted_at` | `list_roles` 查询条件引用不存在的列 | 前端 `queryKeys.roles` 取数**恒错误**：使用者页角色区错误态、新建用户选不了角色。`migrate.rs:97` 只 `count(*) FROM roles`，从未跑命令里那条 SQL，所以 398 条测试全绿 | high |
| F2 | H | `src-tauri/src/commands/accounts.rs:460-473`（`copy_username` → `authorize(...CopyUsername...)`）+ `quick_launcher/actions.rs` 授权表 `CopyUsername => perm::ACC_READ`；对照 `commands/accounts.rs:38-55`（`to_view`：无 `ACC_VIEW_SECRET` 时"连用户名都不解密，避免『是否存在』信息泄露"） | 用户名的两套口径相互矛盾，且剪贴板这条路更宽 | 只有读权限的使用者可经"复制用户名"批量拿到本应看不到的明文用户名，并有 `accounts.copy.username` 审计但无拦截 | high |
| F3 | H | `src-tauri/src/importexport.rs:796-819`（导入建行直接 `repo::create_target`，全路径无 `is_insecure_protocol`）对照 `commands/accounts.rs:261-266`、`:274-286`（交互建/改先判 `allow_insecure_protocols`） | 弱协议闸门只在交互路径生效 | 一份含 `protocol=telnet/ftp` 的 CSV 或容器可以直接把明文协议目标灌进台账，绕开安全策略 | high |
| F4 | H | `commands/accounts.rs:196`：`repo::is_insecure_protocol(&meta.protocol.clone(), &meta.protocol)`；签名是 `is_insecure_protocol(target_type, protocol)`（`db/repo.rs:909-912`），其余 4 处调用（`accounts.rs:263/279`、`commands/launcher.rs:120/218`）第一参都传 target_type | 第一参传成了 protocol，两个分支恒 false | 详情抽屉的"明文协议"徽章（`TargetDetailDrawer.tsx:139`）**永远不显示**；与 F3 叠加 = 建得进来又看不见。前端测试把 `insecureProtocol` 当 mock 入参喂 true，测不出后端恒 false | high |
| F5 | H | `src/pages/AccountsPage.tsx:58` 取数 `queryKeys.targetsPaged({}, 1, LIST_LIMIT)`；`AccountsPage.tsx:91` 与另外 7 处作废全部走 `queryKeys.targetsAll`（= `['targets']`）；全仓库**无任何** `targetsPaged` 作废 | 前缀不匹配：`['targets']` 不是 `['targetsPaged',…]` 的前缀 | 新建/改名/删除系统后主列表不重取，界面停在旧数据（`ExportPanel.tsx:31` 用 `targets({})` 那一条能被作废，主列表不能）；`AccountsPage.tsx:66` 的 `rows[0]` 回落逻辑随之基于旧行判定 | high |
| F6 | M-H | `src/components/accounts/RevealField.tsx:56-70`：`reveal()` 里 `await api.revealSecret(itemId, activeField)` 之后**无条件** `setValue(...)` 并重启倒计时；`itemId/field` 变化只跑 `clear()`（`:52`），没有请求世代/`cancelled` 标志（对照 `ExportPanel.tsx:55-68` 就有） | 在途请求的迟到响应覆盖已清空的格 | 切换字段或条目后，上一条秘密会被写进新的那一格并重新计时——界面显示的是"另一个凭据的明文"；与组件自己的注释承诺（"切换条目/字段立即清除"）相反 | high（代码），medium（跨条目实际触发需列表复用同一实例） |
| F7 | M-H | `commands/accounts.rs:379-395` + `db/repo.rs:1429-1441`：`list_deleted_items` 的 WHERE 只有 `i.deleted_at IS NOT NULL`，不调 `can_access_item`/`can_see`（对照同文件 `target_items` 走 `can_see`，`:173`） | 回收站不做记录级可见性 | 任何持 `accounts.delete` 的使用者可枚举**全库**已删凭据（别名 + 目标名 + 时间），并恢复他人条目 | high（列表侧）；恢复侧 `repo::restore_item(&db,&user,…)` 是否过滤**未复核**，验证：`grep -n "fn restore_item" -A 25 src-tauri/src/db/repo.rs` |

### P1 — 业务能力缺口、性能与本机暴露面

| ID | 级别 | 证据 | 问题 | 后果 | 置信 |
|---|---|---|---|---|---|
| F8 | H | `commands/accounts.rs:379/387`（`list_deleted_items`/`restore_item` 已注册）、`src/lib/api.ts:161-162`、`components/accounts/DeletedItemsPanel.tsx:29/33/99`（列 + 恢复按钮都写好了），但**没有任何生产文件 import 该面板**（仅其自身测试）；`pages/AccountsPage.test.tsx:444-452` 断言回收站已撤下；`migrations/0002_seed.sql` 里 `p-acc-delete` 文案仍是"删除/恢复账号" | 软删后的恢复路径在 UI 上不可达 | 对使用者等于"删除即永久丢失"（只剩整库备份覆盖恢复）；权限名与产品口径仍在承诺可恢复 | high |
| F9 | H | `state.rs:113-120 rebuild_index()` 被 `commands/accounts.rs:269/284/295/317/343/360/374`（7+ 处写命令）无条件调用；`repo.rs:667-761 build_search_index` 内每条凭据跑 `can_access_item`（`repo.rs:766-781`，**3 个相关子查询**）+ `read_sealed` + AES-GCM `open_json` 解密 + `item_tags`，全程 `lock_conn` | 每次写操作全量重建内存索引 | 万条库：一次编辑 ≈ 3–4 万条 SQL + 1 万次解密，期间所有 IPC/审计 SQL 排队；文档记录的 10k CSV 导入本已 14.7 s，叠加后更差 | high（结构），medium（墙钟时长需 bench） |
| F10 | M | `grep -rn "async fn" src-tauri/src/commands/` → **0**；`spawn_blocking`/`async_runtime` → 项目内仅 4 处 `std::thread::spawn`（ipc.rs:53/59、lib.rs:349、accounts.rs:522），命令层 0 | 81 条命令全同步，重活（双 Argon2id 解锁、≤64 MB xlsx 解析 `importexport.rs:574/1450`、ureq 下载、F9 的全量重建）在 IPC 处理器里跑完才回包 | 解锁/导入/更新期间界面长时间无响应。**命令具体落在主线程还是 IPC 线程我没证实**（Tauri 2.12.3 的 `ipc/mod.rs:324-375` 只对 async 走 `respond_async` spawn） | high（无 async/无 spawn_blocking），medium（线程归属） |
| F11 | M | `src-tauri/src/ipc.rs:53-77`：accept 后**每连接裸 `thread::spawn`**，`handle()` 先 `read_line(&mut buf)`（无长度上限）**再**比对令牌（`:78` 之后） | 本机通道在鉴权前可被无界消耗 | 同一台机器上任意进程无需令牌即可用超大单行/大量并发连接耗尽内存与线程；信任边界是"同用户进程" | high |
| F12 | M | `ipc.rs:47-52`（令牌文件：先 `fs::write` 再 `set_permissions(0o600)`，`let _ =` 吞掉 chmod 失败）；`lib.rs:179/197` 同类；Windows 分支无任何权限收紧 | 密钥/令牌文件存在"写入到收紧权限之间"的窗口，且 chmod 失败静默 | 窗口期内文件权限取决于 umask；chmod 失败时进程照常继续，只剩一个全局可读的令牌文件 | high |
| F13 | M | `backup.rs:46-112/222-262`、`ipc.rs`、`lib.rs:179-183` 成片 `map_err(\|_\| AppError::Internal)`，且不打日志；`AppError` 的 `Display` 不含 cause | IO/解析失败被压成一个"内部错误" | 备份/恢复/密钥落盘出问题时现场不可定位（本项目已经吃过"闪退查不到原因"的同类亏，见 `lib.rs:59-66` 那段说明） | high |
| F14 | M | `update.rs:182`（清单 JSON 解析失败 → `UPDATE_SOURCE_UNREACHABLE`） | 错误语义错映射 | "更新源坏了"被报成"更新源不可达"，运维方向被误导 | high |
| F15 | M | `commands/launcher.rs` 全文件 `#[cfg(test)]` = 0；`TargetFormDialog.tsx:136-144` 只回带 tenant/vendor，`lib/targetAddress.ts:52-59` 由 URL 重派生 `allowedOrigin`，`repo.rs:853` `update_target_meta` 整块重写 | 编辑一次系统就可能覆盖导入带来的精确 Origin | "打开并填充"链路静默断裂（OriginNotAllowed）。填充握手是核心业务，却零后端测试 | medium（B7 由域审查给出，我复核了前半段代码，未跑端到端） |

### P2 — 卫生、可维护性与可测性

| ID | 级别 | 证据 | 问题 | 置信 |
|---|---|---|---|---|
| F16 | M | 死代码簇（**我逐条验证过引用**）：`components/accounts/StatsStrip.tsx`（0 生产引用，且它用的 `.stats-strip/.stats-item/...` 在 `global.css` 里已不存在 → 挂上就无样式）、`state/shell.ts`（0 引用，注释还在描述已删的侧栏折叠）、业务 `components/accounts/Pagination.tsx` 的 `Pagination` 组件（仅自身测试 import，活的只有 `pageItems`）、`DeletedItemsPanel`/`RecentAccessPanel`（仅测试 import）、死导出 `state/session.ts:isSessionError`、`lib/types.ts:TYPE_FILTERS` | 无人渲染的屏幕 + 靠自身测试维持"存活"假象；`state/shell.ts` 是 AD 轮删 `SideMenu` 时漏掉的伴生状态 | high |
| F17 | L-M | 无用依赖：npm `@tauri-apps/plugin-clipboard-manager`、`@tauri-apps/plugin-global-shortcut` 在 `dependencies`，前端 **0 引用**（剪贴板写入与快捷键注册都在 Rust 侧：`commands/accounts.rs:469 write_clipboard`、`lib.rs:30/389`；capabilities 需要的是权限而非 JS 包） | 交付安装图里多两枚无调用方的包 | high（引用为 0），medium（"移除后确实无影响"需一次 build + 真机剪贴板验证） |
| F18 | L | Rust 依赖 `regex`/`once_cell`/`subtle` 全项目 0 引用；`path_hint` 生产恒 None、`active_item_count`/`locked_response` 无生产调用方（域/Rust 两路审查给出，**我未逐条复核**） | 死依赖与死参数 | medium，验证：`grep -rn "regex::\|once_cell\|subtle::" src-tauri/src` |
| F19 | M | `vault_item_acl` 表**只有读**（`repo.rs:770`）没有任何写入路径；`can_access_item` 语义 = 创建者 ∨ ACL ∨ `system_admin` | 记录级共享机制半实现，实际模型是"创建者或管理员"；那条 ACL 子查询在 F9 里每行白跑一次 | high |
| F20 | L | `src/styles/global.css:70-101/105+`：`:root` 的 shadcn 词表实测 **27 枚在产物里没有任何 `var()` 引用**（`--primary/--background/--card/--muted/--accent/--destructive/--ring/--chart-1..5/--sidebar-*`…）；全项目只有 `border-border`（1 处）与 `border-input`（2 处）真在用 | 双词表并存且 `@theme inline` 直连 `--t-*`，**改 `--primary` 不产生任何视觉变化**——看着像真源其实是惰性等式 | high |
| F21 | M | 无 CI：`.github`、`.gitlab-ci.yml`、`Jenkinsfile` 均不存在，门禁只在开发者机器上跑 | 398 条测试没有任何一次自动执行过；与 F1/F4/F5 这类"测试全绿但功能坏"正好互为因果 | high |
| F22 | L | `tsconfig`：`noUncheckedIndexedAccess` 未开（实测开 = 91 处报错，**生产 13 / 测试 78**；13 处逐条复核均为"正则必选组"或已有上界守卫，无真实 undefined bug）；`exactOptionalPropertyTypes: false`（开 = 17 处）；`verbatimModuleSyntax` 未开（开 = **0 处**，免费） | 免费项没拿；已开项的代价是已知可控的 | high（三个数字均为 `npx tsc` 实测） |
| F23 | L | `AccountsPage.tsx:301` 把 `pending={setDefault.isPending \|\| favorite.isPending}` 传给**每一行**，而 `:404` 注释写的是"同一行的那两颗写命令钮"；`UsersSection.tsx:159` 同形 | 一行写操作禁用全表按钮，与注释承诺不一致 | high |
| F24 | L | `TargetFormDialog.tsx:131-135` 地址 ≥3 字符即发 `similarTargets`，**无防抖**（同项目另两处都防抖：`LauncherApp.tsx:78` 200ms、`ExportPanel.tsx:56` 250ms） | 输地址每击键一次 IPC + 全表相似查询 | high |
| F25 | L | `LauncherApp.tsx:143`：空结果按 ↓ → `Math.min(results.length - 1, i + 1)` = `-1`，而 `:97-99` 的 clamp 只修 `active >= length` | `active=-1` 悬空；当前渲染侥幸无害（`results[-1]` 为 undefined，动作表回空），但正是 F22 那面旗子挡不住的类别 | high |
| F26 | L | `SystemIODialog.tsx:77-86` 关闭重置清单漏 `dragOver`（`:309` 用 `key={e.rowNo}`，多行同 rowNo 会重复 key） | 拖拽悬停中关弹窗 → 重开残留高亮；React 重复 key 警告 | medium |
| F27 | L | 域审查：容器导出→导入往返丢 `login_url_override/browser_hint/favorite/confirm_before_fill`（一律回 true，`importexport.rs:1019-1042/839`）；"错误 N 行"按行去重可能虚报（`:614-649`）；恢复把原本 disabled 的项强制置 active（`repo.rs:795-805`）；角色变更后不重建索引（`vault.rs:300-308`，动作侧 RBAC 兜住，仅搜索结果延后） | "导出→导入"作为文档里的迁移路径**不完全可逆** | medium（我未逐条回源，验证命令见 remediation-plan） |

## 二、查过、确认**不是**问题（防止把设计选择当缺陷）

1. **换代残留**：React 18 遗留（`ReactDOM.render`/`findDOMNode`/`defaultProps`/`propTypes`）、Tauri v1 路径（`@tauri-apps/api/tauri`/`appWindow`）、`as any`、`@ts-ignore`、`eslint-disable`、`console.*`、`TODO/FIXME` 在 `src` 全为 **0 命中**；两个入口都是 `createRoot`。
2. **Rust panic 面**：按 `#[cfg(test)]` 切分逐文件扫描，非测试区 `unwrap/expect/panic!` 只剩 5 处，其中 `aead.rs:14`（HMAC 接受任意键长）、`tokens.rs:68`（固定长度 AES-GCM）、`tokens.rs:81`（刚赋值的 guard）、`state.rs:151`（文档明示"只给装配前绝不会被调到的命令用"）都由构造保证；`update.rs:248 dest.parent().unwrap()` 路径恒有父级，但**在 `panic = "abort"` 的 release 下它仍是唯一可被外部输入逼近的裸 unwrap**，建议顺手换成 `map_err`。
3. **启动竞态**：`finish_boot` 里 `state::set_global_core`（`lib.rs:287`）**早于** `launcher::ensure_window`（`lib.rs:305`），所以预建的启动器窗口不可能在装配前 invoke 到 `core()`；装配前就必须应答的 `vault_status`/`get_theme`/`device_key_consent_status` 已走 `core_or_await_consent`（这条本身就是历史上 SIGABRT rc=-6 修出来的）。残留风险只是"约定靠注释维持、无机器检查"。
4. **SQL 注入与迁移**：值全部 `params!`，`format!` 只拼内部常量表名；迁移幂等 + 事务回滚 + 版本门控，并有"出厂值 ↔ 迁移 SQL 双向漂移"守卫（`migrate.rs:121-139`、`lib.rs tests`）。
5. **样式层与产物无痕**：`global.css` 内类形标识 214 枚，其中生产不可达实测 **3 枚且全是注释里的字符串**（`tailwind.config`、`colors`、`form-input`）≈ 0 死类；`@layer mda` 层序、`rounded-sm=8px`、`-webkit-*` 双胞胎由 `globalCssEquivalence.test.ts` 打在 `dist` 上守着。
6. **异步清理**：`vaultEvents.ts`、`SystemIODialog` 拖拽、`UpdateSection` 的 Tauri `listen` 都有 `disposed/cancelled + unlisten` 双保险；`debounce` 均有 `return clearTimeout`；`RevealField` 的倒计时 `setInterval` 有卸载清理（F6 缺的是**响应世代**，不是定时器清理）。
7. **主密码策略**：`master_password_min_length` 仍在出厂值 12，但 `auth/policy.rs:1-10/43-52` 明示"主密码路径无强度策略，该下限只管导出容器口令"——文案与实现一致，不是残留闸门。

## 三、Business Application Fitness（业务应用适配度）

- **领域模型清晰度：高。** `vault_targets / vault_items / vault_item_secrets / roles / permissions / user_roles / audit_events / vault_target_preferences / quick_launcher_preferences` 齐备（`migrations/0001_init.sql`），DTO 与 Rust 结构在 `src/lib/types.ts` 与 `commands/*.rs` 两侧对得上，命名稳定。
- **数据与状态理解：中，有硬缺口。** 生命周期字段（`status`、`deleted_at`、`version`、`favorite`、`last_accessed`）都在，审计表 append-only 且有触发器保护；但**软删 → 恢复**这条链只有结构 + 未挂载的 UI 证据，缺行为证据（F7/F8，恢复侧连测试都没有）；`vault_item_acl` 是结构存在、机制缺失（F19）。
- **端到端路径落地：中。** 新建凭据、锁定（空闲/休眠/广播三源）、改主密码、含秘密导出→容器导入都有后端测试；**打开并填充**只有票据绑定测试，`commands/launcher.rs` 整个文件零测试；**软删恢复**零后端测试。
- **代理指令文件：无。** 仓库没有 `AGENTS.md`/`CLAUDE.md`，长期约束沉淀在 `docs/交付状态与验收.md`（2100+ 行，人类可读性极强但不是 agent 可直接消费的结构）。这个项目最容易出事的恰恰是"界面文案 vs 后端可达性"这类隐性契约，值得抽出 `AGENTS.md`。
- **业务校验就绪度：低。** 398 条前端测试大量走 mock（F1/F4 就是被 mock 掩盖的形态），后端 196+17 条测试不覆盖 F1/F4/F7 这三类"命令级"判定；无 CI（F21）。

## 四、假设与未知（不当结论用）

| 假设 | 现状 | 验证步骤 |
|---|---|---|
| F10 的重活是否真的阻塞主线程 | Tauri 2.12.3 里只有 async 命令显式走 `respond_async`+spawn，同步命令的执行线程我没证实 | 10k 库执行一次"删除凭据"（触发 F9 重建），期间拖动窗口/滚动列表，看是否卡住；或读 `tauri-2.12.3/src/ipc/command.rs` 宏展开 |
| F9 的墙钟代价 | 结构确定，秒级估算未测 | `cd src-tauri && cargo bench`（现有 `import_scale.rs` 是入口） |
| F7 恢复侧是否过滤 | `repo::restore_item(&db, &user, id)` 收了 user_id，但我没读函数体 | `grep -n "fn restore_item" -A 25 src-tauri/src/db/repo.rs` |
| F27 容器往返字段丢失 | 域审查报告给出，我未回源 | 用 `tests/container_e2e.rs` 的路子加一条"导出→导入→逐字段相等"断言 |
| F17 移除两枚 JS 插件包无副作用 | 引用计数为 0 | 删后跑 `npm run verify` + 真机"复制用户名/密码"与 Cmd+Shift+Space 各一次 |

## 六、构建链与测试面补充发现（第二路取证，已复核）

| ID | 级别 | 证据（我本人复核） | 问题 | 后果 | 置信 |
|---|---|---|---|---|---|
| F28 | M-H | `vite.config.ts:21` `sourcemap: !!process.env.TAURI_DEBUG`；对 `node_modules/@tauri-apps/cli-darwin-arm64/cli.darwin-arm64.node` 跑 `strings` → 只有 `TAURI_ENV_DEBUG / _ARCH / _PLATFORM / _TARGET / _FAMILY`，**无 `TAURI_DEBUG`** | 读的是 **Tauri v1 的环境变量名**，v2 已改名 | `tauri build --debug` 永远拿不到 sourcemap，线上栈只能对 `main-*.js` 的哈希；这正是本轮"过期 API"唯一实打实的命中 | high |
| F29 | H | `src/lib/api.ts` 223 行 / 81 条 `call('cmd')`，**无 api.test.ts**；`vi.mock('..../lib/api')` 出现在 17 个测试文件；双向比对 api.ts ↔ `lib.rs:447-529` 注册表今天 81↔81 对得上（第二路审查实测） | 唯一的 IPC 边界自身零测试，且被大面积整体 mock | 命令名/参数键错位可以全绿通过——**F1、F4、F5 全是这一类的实例**；今天对得上不等于守得住 | high |
| F30 | H | 从 34 个 `*.test.tsx` 沿 import 图做传递闭包：**92 个生产文件里有 19 个任何测试都到不了**（`state/shell.ts`、`SystemPage.tsx`、`DataPage.tsx`、`components/system/*Section` 含安全状态与备份区 6 枚、业务 `Pagination.tsx` 组件本体、`DeletedItemsPanel`/`RecentAccessPanel` 之外的挂载路径等）；71/92 没有同名测试 | 设置页与数据页整块只有源码级证据 | 交付方唯一能验这些页的方式退化为手测 | high |
| F31 | H | `globalCssEquivalence.test.ts:26-32 findBaseline()` 按目录名排序取**最后一个** `.backup-*/src/styles/global.css`；`.backup-20261019-132949/BASELINE.css.sha256` 存在但 `grep -rn "BASELINE" src scripts` 显示**没有任何代码读它**（命中的全是 `itemPatch.test.ts` 里同名局部常量） | 主门禁的基线是"最新快照目录"，且完整性锚点没被校验 | 删/改/新增一份快照，"逐声明等价"的结论会**静默翻转**：新增一份现代码的快照后，对账变成"新 vs 新"，永远绿 | high |
| F32 | M | CSP 三处两份文本：`tauri.conf.json:31` 含 `frame-ancestors 'none'`，`index.html:6` 与 `launcher.html:6` 的 meta **不含**（我逐字比对，两份 HTML 彼此相同） | 同一策略两处真源 | 改 conf 不传播到 HTML（反之亦然）；注意规范上 `frame-ancestors` 在 meta 里本来无效，所以"只写在 conf"是正确的，问题只在**漂移无人守** | high |
| F33 | M | `tauri.conf.json:39` `externalBin: ["binaries/mda_fill_host"]`，目录里**只有** `mda_fill_host-aarch64-apple-darwin`；`beforeBuildCommand` 仅 `npm run build`（不构建 sidecar） | 其余平台的 sidecar 既不存在也不由打包链生成 | 在 x86_64-apple-darwin / Windows / Linux 上 `tauri build` 会因缺 `binaries/mda_fill_host-<triple>` 失败；这与"三平台未验"（§9 第 1 条）是同一缺口的两个面 | high |
| F34 | M | 测试断言形态实测：`toHaveClass`/`querySelector('.user-avatar')`/钉 `className` 数组（`launcherApp.test.tsx:177-180`）、断 CSS 自定义属性值（`auth-a11y.test.tsx:105/153` 的 `--scene-switch-index`）与 `globalCssEquivalence` **双重锁死同一批类名**；`aria-invalid`/`aria-describedby`/`role=combobox` 在测试里 **0 次**；`fireEvent` 275 次 vs `user-event` 1 个文件；`pointer.ts` 全程同坐标、`pointermove` 0 次 | 断实现细节而非行为；新 Radix 控件的错误关联没有契约 | 纯改名/纯换样式即红，而字段与错误文案脱钩、指针路径回归、浮层定位偏差全都绿；`setup.ts` 四个 no-op 桩 + `css:false` 使 jsdom 里"浮层永远没有效果" | high |
| F35 | L | `global.css` 顶层选择器有 12 枚类名出现 ≥2 条规则（`auth-scene/auth-layout/auth-panel/auth-title/…`）；其中一部分在 `@media` 或主题块内属正常分层 | 同名重复需逐条判，**不能一概当缺陷** | 若确有同层重叠，后者永远生效，顺序一变即翻盘 | medium（我未逐条判定哪几对真是同层） |

**这一路的反向结论（查过、不是问题）**：`@source` 今天没有把测试独占类名漏进产物（实测泄漏 0 枚）；19/19 `@keyframes` 都被引用；动效双门（`prefers-reduced-motion` + `data-reduce-motion`）覆盖 20 处 `animation` 中的 19 处，剩一处时长由归零表管；21 处 `vi.mock` 全部落在 `lib/api`/`lib/dialogs`/`@tauri-apps/api` 边界，**Radix 原语与 `cn()` 没被 mock**（所以组件行为是真在跑）；`capabilities/default.json` 的 `windows: ["main","launcher"]` 与 `launcher.rs` 的 `LAUNCHER_LABEL` 一致。

## 七、按质量属性收敛

| 质量属性 | 判定 | 主要证据 |
|---|---|---|
| **可维护性** | 好，但有惰性等式与死件 | 卫生类指标全 0（F16/F20/F22）；死代码簇、27 枚惰性别名 |
| **正确性（业务口径一致）** | **不合格** | F1–F7、F15、F27 共 9 条"同一件事两套答案" |
| **性能** | 有风险，规模相关 | F9（每次写全量解密重建）+ F10（0 async）+ F24（无防抖） |
| **可靠性/可诊断性** | 弱 | F13（错误压成"内部错误"）、F14（错映射）、F28（无 sourcemap）、F26（状态残留） |
| **安全性/隐私** | 有 3 处实质缺口 | F2（用户名口径）、F7（回收站无可见性）、F11/F12（本机通道与文件权限窗口） |
| **可测试性** | 结构好，覆盖假象强 | F29/F30/F31/F34——398 条绿与"功能坏"共存就是本项的证据 |
| **可部署性** | 单平台可，跨平台断 | F33（sidecar 只有一枚）、§9 第 1 条 |

## 七之二、修复过程中新暴露的两条（写回来时才算完整账）

| ID | 级别 | 证据 | 问题 | 后果 | 置信 |
|---|---|---|---|---|---|
| F36 | M | 我把 `@theme inline` 的说明注释写成含"星号紧跟斜杠"的正文，`dist` 里 `.border-input` 整枚消失；源码侧那组逐声明对账**全绿**，产物级抽查（硬编码 7 枚清单）也没点中它 | CSS 注释被提前闭合 → 排在其后的 `@theme` 键被当块外内容丢弃 → 工具类静默不生成 | 这类事只在真机上表现为"某个边框色没了"，而所有门禁都看不见。已修：注释改写 + 新增**由源码用量推导**的产物守卫（`globalCssEquivalence.test.ts` 那条新 it），并顺带把 `--color-border`→`border-line` 的空写坐实 | high（两轮对照实验：修注释前后各测一次） |
| F37 | L | 现有产物级守卫是**手写 WATCH 清单**（7 枚类名），本次它没抓到第 8 枚的丢失 | 抽查式守卫的覆盖面等于写它的人当时想到的东西 | 已改为从 `@theme` 键 × 源码用量推导检查清单，并加"一枚都没扫到 = 守卫自己失效"的反向断言 | high |

## 八、工件与阅读顺序

- 本文件：`docs/代码质量审查-2026-10-19/architecture-review.md`
- 风险关系图源码：`risk-quality.dot`（Graphviz，`dot -Tsvg risk-quality.dot -o risk-quality.svg`）
- 质量属性场景：`quality-scenarios.md`
- 修复顺序与验收门：`remediation-plan.md`
- **修复进展与实测数字**：`fix-log.md`（2026-10-20：F1-F7、F9、F11-F20、F22-F29、F31-F35 的落点、判据，以及**未做的 7 项与为什么**）
- 建议阅读顺序：结论先行 → 一、发现表（P0 的 F1..F7）→ `fix-log.md`（哪些已经修了、怎么验的）→ 四、假设与未知 → `remediation-plan.md`

技能与格式：`architecture-visualization:risk-quality-reviewer` + `graphviz`（DOT 仅用于风险关系图；未产 C4，因为容器边界在本次结论里不承担判断）。所有发现均可用 `remediation-plan.md` 里的命令逐条复核。
