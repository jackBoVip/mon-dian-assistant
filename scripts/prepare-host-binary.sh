#!/usr/bin/env bash
# 构建 Native Messaging 宿主，并放到 Tauri 约定的 sidecar 路径。
# tauri.conf.json 的 bundle.externalBin 声明的是 "binaries/mda_fill_host"，
# Tauri 实际查找 binaries/mda_fill_host-<target-triple>[.exe]（依据 config.schema.json）。
# 打包前必须先跑本脚本，否则 tauri build 会因找不到对应三元组的二进制而失败。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src-tauri"
TRIPLE="$(rustc -Vv | grep '^host:' | cut -d' ' -f2)"
EXT=""
case "$TRIPLE" in
  *windows*) EXT=".exe" ;;
esac

echo "target triple: $TRIPLE"
cargo build --manifest-path "$SRC/Cargo.toml" --release --bin mda_fill_host

mkdir -p "$SRC/binaries"
DEST="$SRC/binaries/mda_fill_host-$TRIPLE$EXT"
cp "$SRC/target/release/mda_fill_host$EXT" "$DEST"
chmod +x "$DEST"
echo "sidecar ready: $DEST"
