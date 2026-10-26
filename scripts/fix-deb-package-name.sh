#!/usr/bin/env bash
# Debian Policy §5.6.6 要求 deb 的 Package 字段是小写 ASCII，而 Tauri 的 deb
# 打包直接把 productName 当包名，DebConfig 又没有包名覆写键（见
# node_modules/@tauri-apps/cli/config.schema.json 的 DebConfig properties）。
# 本脚本只重写 control 里的 Package 并同步文件名：包内可执行文件与桌面入口
# 的显示名（/usr/share/applications/蒙电信产助手.desktop、Name=蒙电信产助手）
# 一律不动，产品可见名称保持不变。
#
# 用法：scripts/fix-deb-package-name.sh <deb 文件或 bundle/deb 目录> [包名]
# 依赖 dpkg-deb / dpkg，仅适用于 Linux 宿主（deb 本来也只能在 Linux 上打）。
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

version="$(dpkg-deb -f "$deb" Version)"
arch="$(dpkg-deb -f "$deb" Architecture)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

dpkg-deb -R "$deb" "$work/pkg"
sed -i "s/^Package: .*/Package: ${pkgname}/" "$work/pkg/DEBIAN/control"
out="$(dirname "$deb")/${pkgname}_${version}_${arch}.deb"
# --root-owner-group：解包再打包会把文件属主变成当前用户，这里固定回 root:root。
dpkg-deb --root-owner-group -b "$work/pkg" "$out" >/dev/null
if [ "$(readlink -f "$deb")" != "$(readlink -f "$out")" ]; then
  rm -f "$deb"
fi

# dpkg 自己的校验器给结论，不靠肉眼对 Policy 条文。
dpkg --validate-thing pkgname "$pkgname"
echo "deb package name: $(dpkg-deb -f "$out" Package) (file: $(basename "$out"))"
