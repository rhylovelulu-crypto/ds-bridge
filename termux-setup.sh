#!/data/data/com.termux/files/usr/bin/bash
# =====================================================================
#  ds-bridge 一键安装/启动（Termux / Android）
#
#  核心规则：脚本在哪里都能跑，代码永远装到固定位置 ~/ds-bridge。
#  从任何目录执行效果完全一样：
#
#    bash /sdcard/Download/ds-bridge/termux-setup.sh   # 首次
#    bash /sdcard/Download/微信/ds-bridge/termux-setup.sh
#    bash ~/ds-bridge/termux-setup.sh --start          # 以后重启
#
#  --start：跳过依赖安装，直接启动（已安装过时用）。
# =====================================================================
set -e

REPO_TARBALL="https://gh-proxy.com/https://github.com/rhylovelulu-crypto/ds-bridge/archive/refs/heads/main.tar.gz"
APP_DIR="$HOME/ds-bridge"

say() { echo -e "\033[1;36m[ds-bridge]\033[0m $*"; }
fail() { echo -e "\033[1;31m[错误]\033[0m $*" >&2; exit 1; }

# NOTE on paths: this script can live anywhere (Download, WeChat folder, ...).
# Section 2.5 resolves the app directory: running from an existing copy uses
# that copy; otherwise the tarball is downloaded to $APP_DIR. Either way the
# user runs the app later via:
#   bash ~/ds-bridge/termux-setup.sh     (or wherever the copy landed)
# Restart command is printed at the end so nobody has to remember the path.

# ---------- 0. Termux 检查 ----------
[ -d "/data/data/com.termux" ] || fail "请在 Termux 里运行本脚本（不是 sh、不是 sshd、不是 proot）。"
command -v pkg >/dev/null || fail "pkg 不可用。请从 F-Droid 安装最新版 Termux（GitHub 版已停更，别用 Play 商店版）。"

# ---------- 1. 依赖 ----------
if [ "$1" != "--start" ]; then
  say "安装依赖：nodejs-lts chromium（首次约 200MB，耐心等）…"
  pkg update -y
  # Upgrade everything first: a half-updated system breaks dynamic linking
  # (libcurl vs libssl symbol mismatches crash git/curl with CANNOT LINK).
  pkg upgrade -y
  pkg install -y nodejs-lts
  # chromium lives in the x11 repo, NOT in main — "no installation candidate"
  # without it. The gtk/X11 deps are heavy but headless mode never opens a
  # window, so they just sit there.
  if ! pkg list-installed 2>/dev/null | grep -q '^chromium/'; then
    pkg install -y x11-repo
    pkg install -y chromium
  fi
fi
command -v node >/dev/null || fail "node 未装上，手动跑：pkg install nodejs-lts"
node -e "const[m]=process.versions.node.split('.').map(Number);if(m<18)process.exit(1)" || fail "Node 版本太低（需要 18+，建议 22）。pkg install nodejs-lts 升级。"
say "Node $(node -v) OK"

# ---------- 2.5 代码目录 ----------
# Wherever the script itself lives (Download, WeChat dir, Bluetooth, anywhere),
# the app ALWAYS installs to $APP_DIR (= ~/ds-bridge). Priority:
#   1. ~/ds-bridge already has code  -> use it (restart / rerun case)
#   2. the folder the script sits in has code -> copy it into ~/ds-bridge
#   3. neither -> download the tarball
# The "copy the folder the script is in" branch means a user who transferred
# the project anywhere can just run `bash < wherever >/termux-setup.sh` and
# never think about paths again.
if [ -f "$APP_DIR/server.mjs" ]; then
  say "已安装：$APP_DIR"
elif [ -f "$(dirname "$0")/server.mjs" ] && [ "$(cd "$(dirname "$0")" && pwd)" != "$APP_DIR" ]; then
  say "从脚本所在目录复制代码到 $APP_DIR …"
  mkdir -p "$APP_DIR"
  cp -r "$(dirname "$0")/." "$APP_DIR/"
elif [ ! -f "$APP_DIR/server.mjs" ]; then
  say "从网络下载代码到 $APP_DIR …"
  # curl 先于 git：git 可能没装，curl 装得更快、报错也更少。
  command -v curl >/dev/null || pkg install -y curl
  mkdir -p "$APP_DIR"
  if curl -L "$REPO_TARBALL" | tar -xz -C "$APP_DIR" --strip-components=1; then
    :
  elif command -v git >/dev/null; then
    git clone --depth 1 "https://gh-proxy.com/https://github.com/rhylovelulu-crypto/ds-bridge.git" "$APP_DIR" || fail "下载失败，检查网络后重试"
  else
    fail "下载失败：先执行 pkg install git curl，再重跑本脚本"
  fi
fi
cd "$APP_DIR"

# ---------- 3. 浏览器路径 ----------
# Termux chromium installs to $PREFIX/bin/chromium-browser (x11 repo build).
export DS_BROWSER="$(command -v chromium-browser || command -v chromium)"
[ -n "$DS_BROWSER" ] || fail "chromium 没装上：pkg install x11-repo && pkg install chromium"

# ---------- 4. 配置 ----------
if [ ! -f config.json ]; then
  say "生成配置和 API key …"
  node scripts/init-config.mjs
  KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync('config.json','utf8')).apiKeys[0].key)")
  say "API Key（酒馆里用）：$KEY"
else
  say "配置已存在"
fi

# ---------- 5. 无头启动 ----------
# Android 上没有窗口系统，无头是唯一方式；Termux 关掉通知或杀后台会停服务，
# 拉一下 Termux 的通知唤醒锁：下拉通知栏点 "Acquire wakelock"。
say "以无头模式启动（0.0.0.0，局域网可访问）…"
export DS_HEADLESS=1
export DS_BRIDGE_HOST=0.0.0.0
export DS_CONCURRENCY=1   # 手机资源有限，默认 1 个并发标签

say "==========================================="
say " 服务地址（本机）   http://127.0.0.1:8788/v1"
say " 局域网             http://<手机IP>:8788/v1"
say " 酒馆填上面任意一个 + API Key 即可"
say "==========================================="
say " 首次登录（推荐）：电脑上登录过 ds-bridge 的话，把电脑用户目录下的"
say " .ds-bridge-profile-cn 文件夹传到手机，然后执行："
say "   cp -r /sdcard/<实际路径>/.ds-bridge-profile-cn ~/"
say " 再重启本脚本即可，不用扫码。"
say " 以后重启服务（无论脚本原文件夹还在不在，直接跑）："
say "   bash ~/ds-bridge/termux-setup.sh --start"
say "==========================================="

exec node server.mjs
