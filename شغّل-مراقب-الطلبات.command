#!/bin/zsh
# مراقب طلبات بوابة فضاء 👻 — دبل كليك ويشتغل
cd "$(dirname "$0")/watcher"
if [ ! -d node_modules ]; then
  echo "⏳ تثبيت أول مرة (دقيقة وحدة)…"
  npm install --no-fund --no-audit
fi
node watch.js
