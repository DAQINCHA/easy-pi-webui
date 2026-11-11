#!/bin/zsh
# 双击启动：工作目录不再由本脚本固定，改由服务端按
# 「--workspace > PI_WORKSPACE > 本机保存 > 页面首次选择」决定。
cd "$(dirname "$0")"

export PORT="${PORT:-30142}"

node server.js &
SERVER_PID=$!

# 只向自己记录的 SERVER_PID 转发信号并 wait 回收。
# 先清空 trap，避免 EXIT 与信号 trap 互相触发造成递归或重复清理。
forward_signal() {
  local sig="$1"
  trap - INT TERM HUP EXIT
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -"$sig" "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
}
trap 'forward_signal INT' INT
trap 'forward_signal TERM' TERM
trap 'forward_signal HUP' HUP
trap 'forward_signal TERM' EXIT

sleep 1
open "http://127.0.0.1:${PORT}"
wait "$SERVER_PID"
