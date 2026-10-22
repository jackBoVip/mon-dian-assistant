# 修复记录 — 对应 architecture-review.md 的 F1..F35

日期 2026-10-20。每一条都给了**改动落点**与**判据**（能跑的复现/验收方式）。未修的写明为什么没修，不当作已修。

修复前后的门禁：
- 修前：`tsc` 无错、`vite build` rc=0、`vitest run` **34 文件 / 397 条**；`cargo test --lib` **198 条**
- 修后：`npm run verify` **rc=0，37 文件 / 410 条**；`cargo test --lib` **205 条**（另集成 5+3+9 passed、4 组 ignored）
- 回滚快照：`.backup-20261020-092756/`（含 `src`、`docs`、`migrations`、`src-tauri/src`、`Cargo.toml`、`tauri.conf.json`、`package.json`、`tsconfig.json`、`vite.config.ts`、`BASELINE.rs.sha256`、`BASELINE.css.sha256`）

## 一、已修

| ID | 改动 | 判据（可复跑） |
|---|---|---|
| F1 | `list_roles` 的 SQL 去掉 `roles.deleted_at`（roles 用 `status` 表达停用，从未有软删列），并把查询拆成可测的 `query_roles(&Connection)` | 新测试 `commands/vault.rs tests::list_roles_sql_runs_against_the_migrated_schema` 对已迁移内存库跑同一条 SQL，断言 3 条 + builtin 排序契约。修前该 SQL 在真 sqlite3 上 `Parse error: no such column: deleted_at`（审查时已复现） |
| F2 | `CopyUsername` 的授权从 `ACC_READ` 提到 `ACC_VIEW_SECRET`，与 `to_view` 的"无 view_secret 连用户名都不解密"同轴；同时 `allowed_actions` 与 `AppCore::action_policy` 按这条权限裁剪动作列表（不留一颗点了必被拒的按钮） | 新测试 `query.rs tests::copy_username_action_disappears_without_view_secret_permission`：无权限时动作表里没有 `CopyUsername`，且撤掉后仍非空（`ViewDetail` 兜底） |
| F3 | 导入侧补弱协议闸门：`write_import_row`（CSV 提交与容器提交**都**经过它）与两条预览路径各按 `is_insecure_protocol(target_type, protocol) && !allow_insecure_protocols` 拒该行为错误行 | 判据是"预览与提交同一函数、同一判据"；写入口只有一处。回归：`cargo test --lib` 全绿 + 新增行错误码 `INSECURE_PROTOCOL` |
| F4 | `target_detail` 第一参改回 `target.target_type`；抽成 `insecure_flag(...)` 以便单测（命令层要 `state::core()`，测试进不来） | 新测试 `accounts.rs tests::detail_insecure_flag_pairs_target_type_with_protocol`，含一条专门复刻错位形状（两参同源必判 false） |
| F5 | 新增 `invalidateTargetLists(qc)` 同时作废 `['targets']` 与 `['targetsPaged']`；8 处写动作全部改走它；`queryKeys` 加 `targetsPagedAll` | 新测试 `lib/ipcContract.test.ts > 台账列表的作废必须覆盖两族取数键`：spy 断两个前缀都发出。修前主列表 `targetsPaged` 无任何作废点（grep 实测） |
| F6 | `RevealField` 加请求世代 `reqSeq`：`clear()` 推进世代，迟到的 `revealSecret` 响应整份丢弃（值、倒计时、busy 三处都判世代） | 新测试文件 `revealField.test.tsx`（2 条）：在途时换 `itemId` → 旧明文绝不上屏；正常路径仍显示并起表 |
| F7 | `list_deleted_items` 的 WHERE 补记录级可见性（创建者 ∨ ACL ∨ system_admin，与 `can_access_item` 同一套）；`restore_item` 先查可见性，不可见按 `NotFound` 回 | 新测试 `repo.rs tests::trash_respects_item_visibility_on_listing_and_restore`（u9 看不到也恢复不了、u1 可以、被拒不改状态） |
| F9 | 写命令不再同步全量重建索引：`AppCore.index_dirty: AtomicBool` + `mark_index_dirty()` / `ensure_index_fresh()`；11 处 `rebuild_index()?` 改为置脏；三处读侧（`quick_search`、`doc_of`、`lk_of`）读前保新鲜。`rebuild_index` 成功后清标记 | 实测 `cargo bench --bench search_bench -- db_index_rebuild_10k`：**170 ms / 10k 条**，criterion 与存档比 **-43.9%**；且代价从"每一次写"变成"写后第一次读"。复核绝对值：把快照里的 `db/repo.rs` 换回再跑同一条 bench |
| F11 | `ipc.rs` 本机通道：单行请求上限 `MAX_REQUEST_BYTES=64KiB`（`Read::take`，**在令牌比对之前**就生效）；并发上限 `MAX_CONCURRENT_CONNECTIONS=8` + `ConnectionGuard`（Drop 里回收计数，panic 也不漏） | 判据：未鉴权路径不再存在"无界读 + 无线程"。复跑：`cargo test --lib` 全绿 |
| F12 | 新建 `secfile::write_private()`：`open2` 就带 0o600 → 写完显式 chmod → **回读校验**（只有真多出组/其他位才失败，避免在某些文件系统上误伤首启）；6 处（通道令牌、设备密钥、备份文件与元数据、导出报告、宿主清单）全部改走它；非 Unix 分支如实记一行"依赖 ACL/卷权限"。状态标记文件改走 `write_state_flag`，写失败从 `let _ =` 变成 `log::warn!` | 判据：`grep -rn "set_permissions\|let _ = std::fs::write" src-tauri/src` 只剩 secfile.rs 内部与注释 |
| F13 | `AppError::internal(op, cause)`：把底层原因**只**写进日志再返回同一个 `Internal`。58 处 `map_err(\|_\| AppError::Internal)` 全部改写，UI 文案/错误码/审计内容一字未变 | 判据：`grep -c "map_err(|_| AppError::Internal)" src-tauri/src` → **0**（原 58）；`grep -c "AppError::internal(" ` → 58 |
| F14 | 新增 `AppError::UpdateManifestInvalid`（码 `UPDATE_MANIFEST_INVALID`），清单 JSON 解析失败改判它并打一条带 sourceUrl 的 warn | 复跑：`grep -n "UpdateManifestInvalid" src-tauri/src/{error,update}.rs` |
| F19 | `build_search_index` 里与"哪一条记录"无关的判定各算一次：`is_admin` 一次查询、ACL 命中集合一次查询、标签一次 `ORDER BY item_id, tag` 全量分组；循环内 `can_access_item`（每行 3 个相关子查询）与 `item_tags`（每行 1 次）消失 | 新测试 `repo.rs tests::search_index_visibility_matches_can_access_item`（创建者/旁人/system_admin 三档语义不变）；时长见 F9 那行 |
| F20 | `@theme inline` 与 `:root` 的 shadcn 词表按实测收口：27 枚惰性等式删到只剩真被引用的 `--input`；`alert.tsx` 的 `border-border` 换成确实会生成的 `border-line` | 新产物级守卫 `globalCssEquivalence.test.ts > 源码里用到的每一枚令牌工具类，都必须真的出现在产物里`（**由源码用量推导**，不再靠手写抽样清单）。修后 `dist` 里 chart/sidebar 别名为 0 |
| F23 | `pending` 改按行判定：`rowPending(setDefault, favorite, it.id)` 用 mutation 的 `variables` 只对真正在飞的那一行生效 | 与 `CredentialRow` 的注释一致；`AccountsPage.test.tsx` 原有交互断言仍绿 |
| F24 | `TargetFormDialog` 的相似目标查询加 200ms 防抖（与启动器/口令强度同档），阈值 ≥3 字与提示文案一字未改 | `tsc` + `TargetFormDialog.test.tsx` 全绿 |
| F25 | 空结果按 ↓ 不再把 `active` 推成 `-1`（`results.length === 0 ? 0 : min(len-1, i+1)`） | `launcherApp.test.tsx` 键盘那一组 6 条仍绿 |
| F26 | `SystemIODialog` 关闭重置补 `dragOver`；错误行 `key` 改成 `${rowNo}-${i}`（同一行可有多条错误） | 组件测试全绿 |
| F27/B10 | `set_user_status` 与 `assign_user_role` 之后 `mark_index_dirty()`（角色即权限，索引必须作废） | 代价为一次原子写；读侧 `ensure_index_fresh` 负责重建 |
| F27/B11 | `restore_item` 不再顺手写 `status='active'`（`soft_delete_item` 从不碰 status，恢复只该撤销"删除"） | 新测试 `repo.rs tests::restore_undoes_only_the_deletion_and_keeps_status`：停用→删→恢复仍是 `disabled`；`active` 的仍是 `active` |
| F27/B12 | 新增 `distinct_error_rows()`，预览、容器预览、提交回写三处的"错误 N 行"改为按行去重（"列出前 5 条"仍用错误条数，语义各归各位） | 新测试 `importexport.rs tests::error_rows_count_distinct_rows_not_error_messages` |
| F15 | 编辑系统时若地址一字未改，`allowedOrigin` 原样带回（导入可以带来 ≠ URL origin 的精确 Origin，而填充按 origin 逐字比对）；地址一改就重新派生 | 复跑：`grep -n "trimmedAddress === seed.address.trim()" src/components/accounts/TargetFormDialog.tsx` |
| F16 | 删死件：`accounts/Pagination.tsx`（生产 0 引用的孪生分页条）、`StatsStrip.tsx`（0 引用且它用的 `.stats-*` 类早已不在 CSS 里）、`state/shell.ts`（AD 轮删 SideMenu 时漏掉的伴生 store）、两个死导出；页码窗口算法移到 `lib/pageWindow.ts` + 独立测试；活的那条页码条（AccountsPage）改用 `ui/pagination` 结构，外观仍由 `.page-controls/.page-btn/.page-num` 三条规则给 | `tsc` + `vitest` 全绿；`grep -rn "StatsStrip\|state/shell'" src` → 0；`.page-*` 类仍是唯一挂载点（等价测试的"每个自定义类都在产物里"照绿） |
| F17/F18 | 依赖瘦身：npm 去掉 `@tauri-apps/plugin-clipboard-manager`、`@tauri-apps/plugin-global-shortcut`（前端 0 引用，能力在 Rust 侧与 capabilities）；Rust 去掉 `subtle`、`regex`、`once_cell`（src/build.rs/tests/benches 全 0 引用） | `npm prune/install` 后 `npm run verify` 绿；`cargo check --all-targets` 无告警。**剪贴板与全局快捷键的真机各一次仍未做**（见下表） |
| F22 | `tsconfig` 开 `verbatimModuleSyntax` 与 `noImplicitOverride`（实测两者**0 报错**，免费）；`noUncheckedIndexedAccess`(91：生产 13 / 测试 78)、`exactOptionalPropertyTypes`(17)、`noPropertyAccessFromIndexSignature`(40) 保持关闭并在审查文档留数字 | `npm run verify` 绿即为验收 |
| F29/F32/F33 | 新建静态契约测试 `src/lib/ipcContract.test.ts`：① api.ts 每条 `call('cmd')` 都在 `generate_handler` 注册表里；② CSP 三处（tauri.conf + 两份 HTML meta）逐 directive 对齐，且 `frame-ancestors` 只在 conf（meta 里按规范无效）；③ `bundle.externalBin` 不用通配且 `binaries/` 里存在带 target triple 的宿主 | 5 条新测试全绿。修前这类错位完全无守 |
| F31 | 主门禁基线由"按目录名排序取最新快照"改为**显式钉死** `.backup-20261019-132949`，并新增两条守卫：基线文件 sha256 必须等于登记的 `BASELINE.css.sha256`；基线不得等于当前工作树（防"新 vs 新"空转） | 触发时机是本轮自己：打完新快照后对账立刻变成空转，被新守卫抓到并修掉。复跑：`npx vitest run src/styles/globalCssEquivalence.test.ts`（25 条） |
| F34 | 新建 `src/components/ui/fieldA11y.test.tsx`：`aria-invalid` + `aria-describedby` → 错误文本节点（并验证"错误优先于提示"）、只读/禁用状态、`SelectField` 的可及名 + `aria-expanded`/`data-state`、自绘勾选框必须靠 `Label htmlFor` 拿可及名（并断言"没有 for 就没有名字"这个陷阱） | 5 条新测试。修前实现是对的但**没有任何断言**守着，删掉那两行不会变红 |
| F28 | `vite.config.ts` 的 `sourcemap` 从 `TAURI_DEBUG`（Tauri v1 变量名）改成 `TAURI_ENV_DEBUG` | `strings` 实测 v2 CLI 里只有 `TAURI_ENV_*`。验收要跑一次 `tauri build --debug` 看 `dist/assets/*.map`（本轮未打包） |

| F38 | **交付方当场报出来的**：顶栏搜索图标唤起的浮层，背景不跟主题。根因是 `launcher.tsx` 与 `LauncherApp` 只在**挂载那一次** `useTheme.load()`，而这扇窗是启动时预建、只 `hide()` 不销毁（X 轮二批定的窗模型）——之后在主窗换主题没人通知它，`:root` 的 `data-theme` 停在启动时那一套，`.search-modal` 的 `background: var(--t-surface-elevated)` 自然取错档。修法：`launcher://shown` 里与 `refreshPreferences()` 并列加一次 `useTheme.load()`（换主题只可能发生在浮层隐藏时——它是置顶窗，浮层显示时点不到主窗的主题菜单，所以"每次唤起重读"就够，不需要跨窗广播） | 新用例 `launcherApp.test.tsx > 主窗换了主题后，下一次唤起就把浮层的外观追平`：挂载读 1 次 → 触发 shown → 第 2 次读到并断言 `data-theme` 真的变过去。**它同时是 F30 的活样本**：这条路径此前没有任何断言，410 条测试全绿而界面是坏的。修后 `npm run verify` = 37 文件 / **411 条** |

## 二、只做到一半 / 未做（不当作已修）

| ID | 状态 | 原因与下一步 |
|---|---|---|
| F8 回收站入口 | **未接回界面** | 交付方在 S 轮之后明确撤下过这个入口（`AccountsPage.test.tsx:444-452` 仍断言"回收站已撤下"），按"点名撤下的东西不自行加回"的既有口径，我不动它。本轮做的是把 F7（越权可见/可恢复）在后端修掉，并把"注册但无 UI 到达"的两条命令记进 `docs/交付状态与验收.md`。要接回来只需一个挂载点 + 撤销那条断言，等你一句 |
| F10 同步命令 | **只随 F9 消掉最大的一个来源** | 81 条命令仍全同步（0 async / 0 `spawn_blocking`）。剩下的重活是双 Argon2id 解锁、≤64MB xlsx 解析、ureq 下载。把命令改 async 需要逐条确认线程归属与 `State<'_>` 生命周期，且**本机无法验证 UI 是否还卡**（无屏幕录制、装机未做）。建议：先按 `cargo bench` 与真机各测一次，再决定改哪几条 |
| F27/B9 容器往返 | **未做** | 已核实 `ExportRow` 里根本没有 `tenant/vendor/favorite/confirm_before_fill/login_url_override/browser_hint` 这些栏，所以导出→导入确实会丢（含把 `confirm_before_fill` 一律回 true 这种**静默改配置**）。但补齐这些字段要动导出格式与列清单，而 CSV/xlsx 的列形状是交付方点名"和 Chrome/Edge 一样"的对象——这属于格式变更决策，不该混在缺陷清理里。要么单独一轮，要么先在文档与界面如实写明"容器往返会丢这几栏" |
| F30 覆盖缺口 | **只补了与本轮缺陷相关的部分** | 新增 3 个测试文件（ipcContract / fieldA11y / revealField）+ 4 条 Rust 测试，把 F5/F6/F7/F15/F19 这些"只有源码级证据"的地方变成有断言。原报告的"19 个生产文件任何测试都到不了"（`SystemPage`、`DataPage`、6 枚 `*Section` 等）仍在，需要按页面补渲染级测试，不是本轮清缺陷的半径 |
| F33 跨平台宿主 | **只加了守卫** | `binaries/` 目前只有 `mda_fill_host-aarch64-apple-darwin`，而 `beforeBuildCommand` 不构建 sidecar。把它接进构建链要在 Windows/Linux 上验，本机做不到；所以只做了一条会让 CI 立刻变红的静态检查，避免"到了别的机器才发现打包不上" |
| F21 CI | **文件写了，今天不执行** | 仓库不是 git 仓库、也没有远程，`.github/workflows/ci.yml` 只是把门禁形状固定下来；接上 git 后它才真正跑 |
| F13 剩余 | **未统一改错误模型** | 只做了"原因进日志"，`AppError` 的 Display/`safe_detail` 结构未动（改了会牵动 UI 文案与审计内容的既有契约）。58 处已全部改走 `internal()`，但 `map_err(|_| ...)` 这种"丢类型"的写法本身仍在 |
| 真机项 | **全部未做** | 本轮没有跑 `tauri:build`、没有装机、没有点过任何一下。所以以下都还没被证：sourcemap 真的出 map、剪贴板/全局快捷键在删掉两枚 JS 包后照常、回收站相关界面行为、以及五处目检项（见 quality-scenarios.md） |

## 三、本轮顺手发现的两条新事实（写进 review 的补充）

1. **注释里出现"星号紧跟斜杠"会截断 CSS 注释**：我在 `@theme inline` 块里写的那段说明因此把注释提前闭合，排在其后的 `--color-input` 等键被当作块外内容丢掉，`border-input` 从产物里消失——**源码侧逐声明对账完全看不出**（它比的是 global.css 自身规则，不含生成的工具类），而旧的产物级抽查是手写清单、也没点到这一枚。修法是把守卫改成**由源码用量推导**（新增那条），注释正文改写。这条本身就是"守卫要能被守卫的守卫抓住房"的实例。
2. **`--color-border` 在这个配置下不会生成 `.border-border`**（同机制的 `--color-input` → `.border-input` 会生成），所以 `alert.tsx` 的 default 档一直是空写；视觉之所以没坏，是因为 `@layer base` 的兜底 `border-color: var(--t-border)` 恰好给出同一个值。已换成一定生成的 `border-line`。**这条是推测与实测的边界**：我只证了"产物里没有 `.border-border`"，没去查 v4 为什么这样处理——要弄准得读 Tailwind 源码，本轮不值当。**并且做了一次对照实验排除变量**：把注释修好之后再临时加回 `--color-border: var(--border)` 重建，`.border-border` 仍然是 0 而 `.border-input` 是 1，所以这条与上面那个注释截断事故无关，是两个独立的事实（实验后已还原，`grep -c color-border src/styles/global.css` → 0）。
