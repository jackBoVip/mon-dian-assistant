# 蒙电信产助手（mon-dian-assistant）

离线、单机、跨平台的凭据台账桌面应用。Tauri 2 + Rust + React + TypeScript + Tailwind 设计令牌 + SQLite/SQLCipher。

## 三个概念，永远不要混用

| 术语 | 含义 | 出现位置 |
| --- | --- | --- |
| **本地使用者 / App User** | 本软件自己的登录者（昵称 + 头像 + 内部 ID `MDA-…`），决定能看哪些台账 | 系统管理 → 使用者与权限 |
| **凭据记录 / Vault Item** | **外部系统**的一条账号凭据（账号名、口令、Token、私钥…） | 账号管理 |
| **主密码 / Master Password** | 解开本机保险库的口令，Argon2id 派生密钥，任何地方都不可逆存储 | 初始化 / 解锁 / 二次认证 |

左侧菜单 **1 = 账号管理**：外部系统的账号口令台账，里面的用户名口令都不是本软件的登录凭据。
左侧菜单 **2 = 系统管理**：本软件自身的使用者、角色、菜单与动作权限、主密码策略、会话安全、主题、更新、审计、备份。

其它硬约束：

- 首次初始化**只问昵称与主密码**，内部账号 ID 自动生成；任何页面不得要求填写用户名/账号名/邮箱/手机号。
- 同一地址/主机/库 **允许多条凭据**；地址永远不是凭据的唯一键，凭据靠「账号别名」区分。
- 默认账号是 **(本地使用者 × 目标)** 的偏好：第一条自动成为默认，后续新增不覆盖，改默认绝不影响其它记录。
- 全局快捷启动器：系统级快捷键唤起置顶搜索框，逗号（`,`/`，`）分隔的多条件按 **AND** 组合；结果可直接打开目标 / 打开网页并安全填充 / 复制账号 / 复制口令 / 查看详情 / 改选其它账号 / 设为默认，全部复用既有鉴权与安全流程。
- 主题：7 种风格 × 明暗模式的所有颜色只写在 `src/styles/tokens.css` 这一层，组件里不出现字面色值。两个入口（`src/main.tsx`、`src/launcher.tsx`）都必须引入这一层——漏掉不会报错，只会让整套主题静默失效。`src/styles/themeContrast.test.ts` 同时守住引入关系和 WCAG 2.1 AA 的文字对比度（逐主题 × 逐模式 × 玻璃强度三档）。

## 目录

```
src/                 React + TS 前端（页面、组件、状态、IPC 类型镜像）
src/launcher/        快捷启动器独立窗口
src-tauri/src/       Rust 后端（命令层、鉴权、加密、数据库、快捷启动器、填充宿主）
src-tauri/src/bin/mda_fill_host.rs   Native Messaging 宿主（sidecar，独立进程）
src-tauri/benches/   10k 记录规模的性能实测
extension/           浏览器扩展（MV3，仅通过一次性票据取用凭据）
scripts/             构建辅助脚本
docs/                交付状态与验收说明
```

## 开发

```bash
npm install
npm run tauri dev          # 主窗口 + 快捷启动器
```

Rust 侧改动后（工作目录 `src-tauri`）：

```bash
cargo test --lib           # 全部后端单测
cargo bench --bench search_bench          # 10k 记录性能实测
```

前端：

```bash
npm run typecheck
npx vitest run
```

## 打包（三平台）

打包前必须先生成 sidecar 宿主二进制（`tauri.conf.json` 的 `bundle.externalBin` 会按
`mda_fill_host-<target-triple>[.exe]` 命名规则查找）：

```bash
scripts/prepare-host-binary.sh          # 用当前 rustc host triple 构建并复制到 src-tauri/binaries/
npm run tauri:build                     # 即 tauri build；bundle.targets 已声明 7 种格式，
                                        # Tauri 只会构建当前操作系统能产出的那几种
```

- **macOS**：产出 `.app` 与 `.dmg`。Keychain 作为系统安全存储；
  首次运行需在「系统设置 → 隐私与安全」允许辅助功能（全局快捷键与填充所需）。
- **Linux（主流发行版）**：`npm run tauri:build -- --bundles deb,rpm,appimage`。
  运行期依赖 `libsecret`（Secret Service）与 GTK/WebKit2GTK；打包机需安装
  `libsecret-1-dev`、`libwebkit2gtk-4.1-dev`、`libayatana-appindicator3-dev`。
  无 Secret Service（例如纯自绘 WM 未起 keyring）时，数据库主密钥落到 `0600` 本机文件，
  并在「系统管理 → 安全状态」显式告警——**不会把保险库数据降级为明文**。
- **Windows 11**：`npm run tauri:build -- --bundles nsis,msi`（`webviewInstallMode` 已设为
  `downloadBootstrapper`）。Credential Manager 作为系统安全存储。sidecar 随主程序同目录发布
  （带 target triple 后缀）。Native Messaging 清单在 Windows 上写注册表键，程序只给出键名提示
  （见 `fill_host::registry_hint()`），需要用户/管理员手动导入 `.reg`，本项目不自动改注册表。

签名与公证（notarize）不在本仓库自动化：发布方需自备 Apple 开发者证书、Windows 代码签名证书，
更新清单的 ed25519 公钥通过配置注入（`release_pubkey()`），**仓库内不含任何私钥或初始口令**。

## 快捷启动器的运行前提（需求 §2.6 明确要求在此说明）

- 全局快捷键是由**本进程的 Rust 后端**注册与响应的：应用没有运行时，按键不会有任何反应，也不存在"系统帮你唤起"的路径。
- 因此要让快捷键在任何其它前台应用里都唤得起浮层，**应用必须保持运行**。关掉主窗口是不是等于退出进程，随平台与窗口配置而变，本项目没有做托盘驻留来保证它——请不要依赖"关了窗应该还在"，验收时按下一条的口径确认。
- 本项目**没有**实现托盘驻留，也**没有**实现开机自启。需求 §2.6 要求这两件事"必须由用户明确启用"，在没有做同意闸门与可关闭开关之前，不默认往系统启动项或托盘里塞进程——所以请按上面第一条对待：需要快捷键时保持应用在运行。
- 浮层自身的关闭是**隐藏而不是销毁**（`Esc` 与锁定都走 `getCurrentWindow().hide()`），所以一次唤起之后进程照常监听快捷键。
- 唤起后浮层里能显示什么，由后端说了算：锁定/超时状态下只回解锁提示、零条结果；"输入为空时显示最近使用/收藏推荐"受设置 `quick_launcher_show_recent` 控制（安装级设置，需要系统安全权限才能改），关掉后空输入一条都不给。

- 浮层里的键盘操作（需求 line 261）：`↑`/`↓` 切换结果，`Tab`/`Shift+Tab` 在**当前这条结果的可用操作**之间循环（0 号恒为主操作），`Enter` 执行当前选中的操作，`Esc` 关闭。行内会实时显示"Enter 执行『某操作』"并列出该条全部可用操作。`Tab` 只在"这条结果多于一个操作"时才接管裸键，`Ctrl`/`Cmd`/`Alt` 组合与输入框内的编辑快捷键（复制、粘贴、全选、左右移动光标）一律放行。
- 两条硬约束：`Enter` 永远不会落在"复制密码"上（前端选主操作时显式排除它，后端 36 种动作形状穷举测试钉住这一点）；换到另一条结果时动作选择自动退回主操作，所以上一次 `Tab` 停在"复制密码"也不会因为按了 `Enter` 而复制。复制密码始终要显式 `Tab` 到它或点它，并按策略走二次认证。
- 结果排序（需求 line 294）：先按匹配等级 完全匹配 > 前缀匹配 > 包含匹配，这是固定的；同一等级内再按 收藏 > 默认账号 > 最近使用 微调，这一档由安装级设置 `quick_launcher_rank_recent_favorite` 控制，关掉后只按匹配等级排。两个设置（连同 `quick_launcher_show_recent`）都是**每次查询实时读取**，管理员改完下一次唤起即生效，不需要重启；任何设置都不能把被 AND 条件过滤掉的记录排回结果里。

## 安全底线（实现与验收对照见 docs/交付状态与验收.md）

- 主密码：Argon2id 派生 KEK，永不落盘、不可逆存储；日志、审计、IPC 均不含口令/哈希/令牌/密钥。
- 可恢复凭据：AES-256-GCM，AAD 绑定 `记录 id + 字段类型 + 版本`，DEK 随机生成并由 KEK 封装。
- 内存搜索索引：只在解锁期间存在，锁定/登出/超时/切换使用者/退出即清零，从不落盘。
- 权限一律后端复核（`rbac::require`），前端传来的用户/角色/权限/路径/作用域一概不信。
- 填充：一次性短时票据，绑定 目标 + 凭据 + Origin + 使用者 + 会话；扩展与宿主都不缓存秘密。
- Telnet/FTP 等风险协议默认禁用，需要显式开关。
- 含秘密导出：产物是 `.mdaexport`（AES-256-GCM，密钥**只**由操作员口令经 Argon2id 派生，与设备密钥无关，
  所以它是设备密钥丢失后唯一还能恢复数据的产物）。读取侧（预览/提交）与写入侧都已实现，口令强度判定在
  后端、写文件之前；口令错与文件被篡改返回同一个错误码，不给外部可判定的 oracle。详见 docs/部署手册.md §5.3。
- 全库单连接互斥锁不可重入；`db::lock_conn()`（测试构建）与 `VaultState::lock_inner()` 会在
  同线程重入时显式 panic，而不是无声挂死。
