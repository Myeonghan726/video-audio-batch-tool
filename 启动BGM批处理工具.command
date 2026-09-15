#!/bin/zsh
set -e

cd "$(dirname "$0")"

if [[ ! -x "bin/bgm_mux" || "native/bgm_mux.swift" -nt "bin/bgm_mux" ]]; then
  mkdir -p bin
  echo "正在准备视频处理引擎……"
  xcrun swiftc native/bgm_mux.swift -o bin/bgm_mux -framework AVFoundation -framework CoreMedia
fi

echo "正在启动，即将打开浏览器……"
/usr/bin/python3 server.py

