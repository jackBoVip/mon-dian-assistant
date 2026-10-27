#!/usr/bin/env bash
# Debian Policy §5.6.6 要求 deb 的 Package 字段是小写 ASCII，而 Tauri 的 deb
# 打包直接把 productName 当包名，DebConfig 又没有包名覆写键（见
# node_modules/@tauri-apps/cli/config.schema.json 的 DebConfig properties）。
# 本脚本只重写 control 里的 Package 并同步文件名：包内可执行文件与桌面入口
# 的显示名（/usr/share/applications/蒙电信产助手.desktop、Name=蒙电信产助手）
# 一律不动，产品可见名称保持不变。
#
# 为什么不用 dpkg-deb -R：它在**解析** control 时就用同一套包名规则校验，而旧包里
# 那句非法包名正是被解析的对象。本轮 CI 实测两次都死在这里：
#   dpkg:       error: package name '蒙电信产助手' is invalid: must start with an alphanumeric character
#   dpkg-deb -R: error: parsing file '.../control' near line 1:
#                invalid package name in 'Package' field: must start with an alphanumeric character
# 所以输入侧只用 ar/tar 拆包，重打包仍交给 dpkg-deb -b——它校验的是已经改好的 control。
#
# 用法：scripts/fix-deb-package-name.sh <deb 文件或 bundle/deb 目录> [包名]
# 依赖 ar/tar/dpkg-deb/dpkg，仅适用于 Linux 宿主（deb 本来也只能在 Linux 上打）。
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <deb file or bundle/deb dir> [package-name]" >&2
  exit 2
fi

target="$1"
pkgname="${2:-mon-dian-assistant}"

if ! printf '%s' "$pkgname" | grep -Eq '^[a-z0-9][a-z0-9+.-]+$'; then
  echo "ERROR: 包名不符合 Debian Policy §5.6.6（小写 ASCII，仅 a-z0-9+.-）：$pkgname" >&2
  exit 1
fi

if [ -d "$target" ]; then
  deb="$(find "$target" -maxdepth 1 -name '*.deb' -print -quit)"
else
  deb="$target"
fi
if [ -z "${deb:-}" ] || [ ! -f "$deb" ]; then
  echo "ERROR: 找不到 deb 文件：$target" >&2
  exit 1
fi
deb="$(readlink -f "$deb")"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/stage/DEBIAN" "$tmp/raw"

# 用「进临时目录再 ar x」这种各版本 ar 都支持的写法，不依赖 --output 修饰符。
(cd "$tmp/raw" && ar x "$deb")

ctl="$(find "$tmp/raw" -maxdepth 1 -name 'control.tar.*' -print -quit)"
dat="$(find "$tmp/raw" -maxdepth 1 -name 'data.tar.*' -print -quit)"
if [ -z "$ctl" ] || [ -z "$dat" ]; then
  echo "ERROR: 拆包没拿到 control/data 成员：$(ls "$tmp/raw")" >&2
  exit 1
fi

# control 的成员是 control / md5sums（无 ./ 前缀），data 的成员是 usr/...
tar -xf "$ctl" -C "$tmp/stage/DEBIAN"
tar -xf "$dat" -C "$tmp/stage"

control="$tmp/stage/DEBIAN/control"
[ -f "$control" ] || { echo "ERROR: 解出来的树里没有 DEBIAN/control" >&2; exit 1; }

# Version / Architecture 也只能从这里读：dpkg-deb -f 同样会去解析那份非法 control。
version="$(sed -n 's/^Version: //p' "$control" | head -n1)"
arch="$(sed -n 's/^Architecture: //p' "$control" | head -n1)"
if [ -z "$version" ] || [ -z "$arch" ]; then
  echo "ERROR: control 里缺 Version/Architecture（version='$version' arch='$arch'）" >&2
  exit 1
fi

sed -i "s/^Package: .*/Package: ${pkgname}/" "$control"

out="$(dirname "$deb")/${pkgname}_${version}_${arch}.deb"
# --root-owner-group：解包再打包会把属主变成当前用户，这里固定回 root:root。
dpkg-deb --root-owner-group -b "$tmp/stage" "$out"
if [ "$deb" != "$out" ]; then
  rm -f "$deb"
fi

# dpkg 自己的校验器给结论，不靠肉眼对 Policy 条文。
# 用 `--validate-pkgname`（dpkg 1.18.16 起，各受支持发行版都有），不用
# `--validate-thing`——后者在 dpkg 1.21（Ubuntu 22.04）里并不存在。
# 退出码：0 合法 / 1 合法但不严格（lax 告警）/ 2 非法。
rc=0
dpkg --validate-pkgname "$pkgname" || rc=$?
if [ "$rc" -eq 2 ]; then
  echo "ERROR: dpkg 判定包名非法：$pkgname" >&2
  exit 1
fi
if [ "$rc" -eq 1 ]; then
  echo "WARNING: dpkg 判定包名仅 lax 合法（不符合严格规则）：$pkgname" >&2
fi
echo "deb package name: $(dpkg-deb -f "$out" Package) (file: $(basename "$out"))"
