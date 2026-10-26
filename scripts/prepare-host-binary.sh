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

mkdir -p "$SRC/binaries"
DEST="$SRC/binaries/mda_fill_host-$TRIPLE$EXT"

echo "target triple: $TRIPLE"

# 自举死锁：本 crate 的 build.rs（tauri_build）在编译任何 target 之前就要
# externalBin 对应三元组的文件存在，而那个文件正是这一步要产出的。全新检出
# （CI 三端都是）第一次跑必挂：`resource path binaries/... doesn't exist`。
# 先立一枚占位，构建成功后用真二进制覆盖；**失败就撤掉占位**，绝不能让空文件
# 留在 binaries/ 里被下一次 tauri build 打进包（那会产出一个填充宿主全坏的装机包）。
PLACEHOLDER=""
if [ ! -f "$DEST" ]; then
  : > "$DEST"
  PLACEHOLDER="$DEST"
  trap 'if [ -n "${PLACEHOLDER:-}" ] && [ -f "$PLACEHOLDER" ] && [ ! -s "$PLACEHOLDER" ]; then rm -f "$PLACEHOLDER"; fi' EXIT
  echo "bootstrapped placeholder sidecar for first build: $DEST"
fi

cargo build --manifest-path "$SRC/Cargo.toml" --release --bin mda_fill_host

cp "$SRC/target/release/mda_fill_host$EXT" "$DEST"
chmod +x "$DEST"

# 覆盖完成，占位已经变成真二进制；解除清理钩子，别把交付物删了。
if [ -n "$PLACEHOLDER" ]; then
  trap - EXIT
  if [ ! -s "$DEST" ]; then
    echo "ERROR: $DEST 仍为空，构建产物没有覆盖上去" >&2
    exit 1
  fi
fi

echo "sidecar ready: $DEST ($(wc -c < "$DEST" | tr -d ' ') bytes)"
