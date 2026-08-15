#!/usr/bin/env bash
#
# ホーム画面アイコンの PNG を public/icon.svg から作り直す。
#
#   ./scripts/make-icons.sh
#
# 絵柄を変えるときは public/icon.svg だけ差し替えて、これを実行して
# 生成物をコミットする。PNG も追跡対象なので、CI とデプロイでは走らない。
#
# ラスタライズにはシステムの Chrome を使う。SVG を PNG にする道具
# （rsvg-convert / ImageMagick）はどれも手元に無く、sips は SVG の
# stroke を正しく解釈しないため。Chrome ならブラウザで見えるとおりに出る。
set -euo pipefail

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public"

if [[ ! -x "$CHROME" ]]; then
  echo "Chrome が $CHROME に無い" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp "$OUT/icon.svg" "$TMP/icon.svg"

# ラスタライズは必ずこの一辺で行い、小さい版は縮小で作る。
#
# Chrome のウィンドウには下限があり、--window-size で 192 などを指定しても
# 実際にはそれより大きい窓が開く。中央寄せした絵柄は指定サイズの外に出て、
# 切り取られた PNG には地色しか写らない（実際に 192 と 180 で踏んだ）
readonly CANVAS=512

# 指定サイズの PNG を 1 枚書き出す。
#
# $1 出力ファイル名（public/ からの相対）
# $2 一辺のピクセル数
# $3 canvas に対する原本の倍率（%）。maskable だけ縮める
render() {
  local name=$1 size=$2 scale=$3
  cat >"$TMP/page.html" <<HTML
<!doctype html>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; padding: 0; width: ${CANVAS}px; height: ${CANVAS}px; background: #0e7a57; }
  img { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: ${scale}%; height: ${scale}%; }
</style>
<img src="icon.svg" />
HTML
  # virtual-time-budget を付けないと SVG の読み込みを待たずに撮ることがある
  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 --window-size="${CANVAS},${CANVAS}" \
    --virtual-time-budget=3000 \
    --screenshot="$TMP/$name" "file://$TMP/page.html" >/dev/null 2>&1

  if [[ "$size" == "$CANVAS" ]]; then
    cp "$TMP/$name" "$OUT/$name"
  else
    sips -z "$size" "$size" "$TMP/$name" --out "$OUT/$name" >/dev/null
  fi
  echo "  public/$name (${size}px, ${scale}%)"
}

echo "アイコンを生成:"
# マニフェストの purpose: any。全面が絵柄
render icon-192.png 192 100
render icon-512.png 512 100
# purpose: maskable。ランチャに丸や角丸で抜かれるので、中央 80% の
# 安全圏に収まるところまで縮める（グリフが canvas の 58% * 79% = 46%）
render icon-maskable-512.png 512 79
# iOS はマニフェストの icons より apple-touch-icon を優先する。
# 角丸は OS が付けるので、こちらも全面のまま出す
render apple-touch-icon.png 180 100
