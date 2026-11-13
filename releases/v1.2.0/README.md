# 蒙电信产助手 v1.2.0 · 分发包

本目录存放可直接分发的二进制与浏览器扩展源码包，供 Gitee 仓库页面和 Release 下载。

## 文件清单

| 文件 | 说明 |
| --- | --- |
| `mon-dian-assistant_1.2.0_x64-setup.exe` | Windows NSIS 安装向导（推荐，x64）。安装后自动注册 Native Messaging 宿主所需的随包 sidecar。 |
| `mon-dian-assistant_1.2.0_x64_en-US.msi` | Windows MSI 企业静默安装包（若本轮产出）。 |
| `mon-dian-assistant-browser-extension-v1.2.0.zip` | 浏览器扩展**源码包**（zip 形式，非 crx）。解压后得到单个 `mon-dian-assistant-extension/` 目录。 |
| `SHA256SUMS.txt` | 上述文件的 SHA-256 校验清单。 |

文件名一律纯 ASCII：Gitee / GitHub 上传资源时会静默改写中文名，导致校验和校验失败。

## 安装顺序

1. 先装桌面应用（`.exe` 或 `.msi`），**完整启动一次**并设好主密码，让 `%APPDATA%\com.mda.assistant\` 下生成 `host-channel.json`。
2. 解压扩展 zip，Chrome / Edge 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选中解压出来的 `mon-dian-assistant-extension/` 文件夹（不要把 zip 直接拖进去）。
3. 扩展 ID 固定为 `abmoenilfcffmjochdnmifallbkjlmoi`，与桌面应用内置值一致，无需手工填写。
4. 点击扩展图标 →「重新检测」，应显示「已连接（可填充）」。若显示「未连接」，先确认桌面应用正在运行，再完全退出并重启浏览器（Chrome 只在启动时读取 Native Messaging 注册表键）。

### 关于「数据库主密钥要落在本机文件」

首次启动会要求显式同意把主密钥落到本机文件，这是设计上的一次性闸门。v1.2.0 修复了点「我了解风险，使用本机文件密钥」后界面永久停在「正在按你的选择准备保险库…」的死锁；同意后应直接进入「设置你的主密码」。

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
