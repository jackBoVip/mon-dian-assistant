# 蒙电信产助手 v1.2.0 · 分发包

本目录存放可直接分发的二进制与浏览器扩展源码包，供 Gitee 仓库页面和 Release 下载。

## 先看这里：本目录的 exe 的拆包核对结果

拆包核对（`7z l`）后如实记录，别把这份当成完整交付物：

1. **缺 OCR 模型，答题助手不可用。** 包内 `ocr/` 下只有 `.gitkeep`（349 字节），没有 ppocrv5 模型文件。
   模型不入库（21 MB），打包前必须先跑 `node scripts/prepare-ocr-models.mjs`；CI 里这一步是**阻塞门禁**
   （取完再跑 `--check`），本机那次 build 没跑，于是包就带着空 `ocr/` 出厂了。
   这也是本目录 exe 只有 13.76 MiB、而 CI 那份 31.3 MiB 的差额来源。
2. **包里有 `mda_release.exe`（16,029,696 字节）——这不是本机事故，是历代打包行为。**
   那是离线发布签名工具（`src-tauri/src/bin/mda_release.rs`）。`Cargo.toml` 没写 `[[bin]]`，
   cargo 自动发现 `src/bin/` 下的两个 bin 目标，而 tauri 打包把 crate 的**全部 bin** 都收进产物：
   自 v1.0.0 起每一批的 NSIS / deb / macOS app 里都有它（`docs/部署手册.md` 的 v1.0.0 实物核对
   两节早已登记，2026-11-16 对 v1.2.1 的 CI 产物复核仍是同一形态）。它不含私钥（私钥是它运行时
   生成的外部文件）。同一机制还让 `mda_fill_host.exe` 在 NSIS 里登记两次（自动 bin 一次 +
   `externalBin` 一次，安装时后者覆盖前者）。**要不要把签名工具移出分发包是待交付方定的决策**，
   本轮未改；v1.2.1 的包里同样有它。

本目录的 exe 构建于首启死锁修复提交 `869f1a3` 之后；而 **GitHub Release `v1.2.0` 上的
`Windows-x64-setup.exe`（32,817,304 字节）target 是 `e17381a`，不含那项修复** —— 装了它会卡在
「正在按你的选择准备保险库…」。两者不是同一份包，别混用。

含死锁修复、且过 OCR 模型门禁的三端安装包由 **v1.2.1** 的 GitHub Release 交付。

## 文件清单

| 文件 | 说明 |
| --- | --- |
| `mon-dian-assistant_1.2.0_x64-setup.exe` | Windows NSIS 安装向导（x64）。**缺 OCR 模型；含签名工具（历代打包行为），见上。** |
| `mon-dian-assistant-browser-extension-v1.2.0.zip` | 浏览器扩展**源码包**（zip 形式，非 crx）。解压后得到单个 `mon-dian-assistant-extension/` 目录。 |
| `SHA256SUMS.txt` | 上述两个文件的 SHA-256 校验清单。 |

MSI 本轮未产出（原因见下方「环境与已知限制」），清单里没有 `.msi` 这一行。

文件名一律纯 ASCII：Gitee / GitHub 上传资源时会静默改写中文名，导致校验和校验失败。

## 安装顺序

1. 先装桌面应用（`.exe`），**完整启动一次**并设好主密码，让 `%APPDATA%\com.mda.assistant\` 下生成 `host-channel.json`。
2. 解压扩展 zip，Chrome / Edge 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选中解压出来的 `mon-dian-assistant-extension/` 文件夹（不要把 zip 直接拖进去）。
3. 扩展 ID 固定为 `abmoenilfcffmjochdnmifallbkjlmoi`，与桌面应用内置值一致，无需手工填写。
4. **Windows 必须手工补两步，否则扩展永远检测不到应用**（见下）。
5. 完全退出并重启浏览器（Chrome 只在启动时读取 Native Messaging 注册表键），再点扩展图标 →「重新检测」。

### Windows 的第 4 步：手写宿主清单 + 导入注册表键

代码事实（`src-tauri/src/fill_host.rs`）：`browser_manifest_dirs()` 在 Windows 分支返回空，
应用**不写注册表**；而生成清单的 `prepare()` 只挂在 `extension_host_status` / `extension_host_install`
两条命令上，前端目前**没有任何界面调用它们**。所以清单文件不会自动出现，必须自己写。

1. 新建 `%APPDATA%\com.mda.assistant\native-host\com.mda.fillhost.json`，内容：

   ```json
   {
     "name": "com.mda.fillhost",
     "description": "蒙电信产助手 一次性凭据填充宿主",
     "path": "<安装目录>\\mda_fill_host.exe",
     "type": "stdio",
     "allowed_origins": ["chrome-extension://abmoenilfcffmjochdnmifallbkjlmoi/"]
   }
   ```

   `<安装目录>` 换成实际装到的那个目录（开始菜单快捷方式上右键 →「打开文件位置」即可看到）。
   `path` 必须指向该目录下**实际存在**的那枚宿主 exe（若文件名带 `x86_64-pc-windows-msvc`
   三元组后缀，就写带后缀的那个）；JSON 里反斜杠必须转义成 `\\`。
2. 导入注册表键，默认值指向上面那份 json（Edge 把 `Google\Chrome` 换成 `Microsoft\Edge`）：

   ```powershell
   $json = "$env:APPDATA\com.mda.assistant\native-host\com.mda.fillhost.json"
   $key  = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.mda.fillhost'
   New-Item -Path $key -Force | Out-Null
   Set-ItemProperty -Path $key -Name '(default)' -Value $json
   ```

`docs/部署手册.md` 里那条注册表路径少了 `native-host` 这一层，照抄会指向不存在的文件；以上面的为准。
扩展当前把「宿主没装 / 注册表键缺失」也报成 `APP_NOT_RUNNING`（「桌面应用未运行」），
所以那句提示**不能**用来判断应用是否真的在跑。

### 关于「数据库主密钥要落在本机文件」

首次启动会要求显式同意把主密钥落到本机文件，这是设计上的一次性闸门。点「我了解风险，使用本机文件密钥」后界面永久停在「正在按你的选择准备保险库…」的死锁，已由提交 `869f1a3` 修掉（同步 command 跑在 WebView IPC 回调栈上，`finish_boot` 里嵌套创建 WebView2 窗口与主线程消息循环互等；改为从独立线程派发到主线程事件队列）。本目录的 exe 含该修复，GitHub Release `v1.2.0` 那份不含，自 `v1.2.1` 起的 CI 产物都含。修好后同意即直达「设置你的主密码」。

## 校验

```powershell
Get-FileHash -Algorithm SHA256 .\mon-dian-assistant_1.2.0_x64-setup.exe
Get-FileHash -Algorithm SHA256 .\mon-dian-assistant-browser-extension-v1.2.0.zip
```

或与 `SHA256SUMS.txt` 比对。

## 环境与已知限制

- **Windows 10**：系统没有 DWM 窗口圆角属性，v1.2.0 起回退为 `SetWindowRgn` 裁四角（无抗锯齿、DWM 阴影会被裁掉）；Win11 仍走系统原生圆角。
- **WebView2 Runtime**：前端用 Tailwind v4（`@layer` / `color-mix` / `@property`），需要 Chromium 111+。Win10 上若卡片和按钮变成直角、样式退化，请先升级 WebView2 Evergreen Runtime 到 111 以上；安装包使用 `downloadBootstrapper` 模式，离线机器需预置 Runtime。
- **MSI**：Tauri 的 WiX 打包在 `externalBin` sidecar 上会报 ICE30（同一个文件被两个组件登记），属上游缺陷；NSIS 安装包是主交付物。
- 扩展 zip 由 `node scripts/package-extension.mjs` 产出，时间戳钉死、条目按名排序，同一份源码重复打包字节一致。
