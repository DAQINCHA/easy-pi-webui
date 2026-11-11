#!/bin/zsh
# 双击启动：工作目录默认是这个仓库的根目录，可用 PI_WORKSPACE 覆盖
cd "$(dirname "$0")"

export PI_WORKSPACE="${PI_WORKSPACE:-$(cd ../.. && pwd)}"
export PORT="${PORT:-30142}"

node server.js &
SERVER_PID=$!
sleep 1
open "http://127.0.0.1:${PORT}"
wait "$SERVER_PID"
