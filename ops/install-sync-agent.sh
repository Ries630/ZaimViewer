#!/bin/sh
# Zaim → D1 の同期を launchd に登録する（毎日 06:00、ローカルのタイムゾーン）。
#
# 同期は Worker 内で動かせないため手元で回す（ADR-0015）。Cron Trigger の
# 代わりがこれにあたる。plist をリポジトリに直接置かずここで生成するのは、
# bun とリポジトリの絶対パスを埋める必要があり、環境ごとに変わるため。
#
# 使い方: sh ops/install-sync-agent.sh
# 解除:   launchctl bootout gui/$(id -u)/dev.ries.zaimviewer.sync

set -eu

LABEL=dev.ries.zaimviewer.sync
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
BUN=$(command -v bun)
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/$LABEL.log"

if [ ! -f "$REPO_DIR/.dev.vars" ]; then
  echo ".dev.vars がない。.dev.vars.example を参照して作る" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"

# StartCalendarInterval は起動時刻を跨いでスリープしていた場合、
# 復帰時にまとめて 1 回実行される。Mac mini が寝ていても取りこぼさない。
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUN</string>
    <string>--env-file=.dev.vars</string>
    <string>run</string>
    <string>worker/scripts/sync.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>6</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
EOF

# 再実行できるように、登録済みなら一度外してから入れ直す
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "登録した: $PLIST"
echo "ログ:     $LOG"
echo "即時実行: launchctl kickstart -p gui/$(id -u)/$LABEL"
