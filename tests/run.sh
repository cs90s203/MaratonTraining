#!/bin/sh
# 跑全部測試（node，不用安裝任何套件）。有任何一項 FAIL 或腳本丟錯就回傳非 0。
#
#   ./tests/run.sh                  真實日期跑一遍，再把「今天」固定在幾個日子各跑一遍（日子見 tests/lib/dates.js）
#   ./tests/run.sh --quick          只跑真實日期（改一行程式、來回調整時用）
#   ./tests/run.sh --on 2026-12-14 [22 ...]
#                                   把今天固定在那一天跑；後面可以只指定幾支 harness（22、harness22 都行）。
#                                   環境變數 MARATHON_TODAY=2026-12-14 ./tests/run.sh 一樣
#   ./tests/run.sh --scan 2026-09-06 2027-03-08 [天數間隔]
#                                   一天一天掃（發版前用，每天約 5 秒）
#
# 為什麼要固定日期：harness 用 PlanData.locateToday() 排「這週」「今天」，結果跟哪天跑有關（README「本機開發」）。
# 一次只跑一個 node、不要平行：有幾個測試靠 20ms 的 setTimeout 等非同步做完，CPU 一忙就會假失敗。
cd "$(dirname "$0")/.." || exit 1

usage() {
  cat <<'EOF'
./tests/run.sh                          真實日期跑一遍，再把「今天」固定在幾個日子各跑一遍
./tests/run.sh --quick                  只跑真實日期
./tests/run.sh --on 2026-12-14 [22 ...] 把今天固定在那一天跑（可以只指定幾支 harness）
./tests/run.sh --scan FROM TO [間隔]    一天一天掃，例如 --scan 2026-09-06 2027-03-08
EOF
  exit "${1:-2}"
}

nl='
'
mode=default; pin=${MARATHON_TODAY:-}; [ "$pin" = real ] && pin=; names=""; step=1; from=""; to=""
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) mode=quick ;;
    --on) [ $# -ge 2 ] || usage; pin=$2; shift ;;
    --scan)
      [ $# -ge 3 ] || usage; mode=scan; from=$2; to=$3; shift 2
      # 這時 $1 是 TO、$2 才是可有可無的間隔；迴圈尾巴的 shift 會吃掉 TO
      case "${2:-}" in ''|*[!0-9]*) ;; *) step=$2; shift ;; esac ;;
    -h|--help) usage 0 ;;
    -*) usage ;;
    *) names="$names $1" ;;
  esac
  shift
done
[ -n "$pin" ] && [ "$mode" = default ] && mode=on
[ -n "$pin" ] && { node tests/lib/dates.js label "$pin" >/dev/null || exit 2; }

# 22 / harness22 / tests/harness22.js 都認得；之後所有清單都用換行分隔（日期的說明裡有空格）
if [ -n "$names" ]; then
  files=""
  for n in $names; do n=${n##*/}; n=${n%.js}; n=${n#harness}; files="$files${files:+$nl}tests/harness$n.js"; done
else
  files=$(ls tests/harness*.js)
fi
IFS=$nl

# 用 vm.runInNewContext／vm.Script 開沙盒的 harness 不會經過 tests/lib/clock.js 包的 vm.createContext，
# 固定日期對它無效卻不會出聲——寧可直接擋下來
bad=$(grep -l 'runInNewContext\|vm\.Script\|runInThisContext' tests/harness*.js 2>/dev/null)
[ -z "$bad" ] || { echo "✗ 這些 harness 用了不會被固定日期的 vm 寫法（改用 vm.createContext）：$bad"; exit 1; }

total=0; failed=0
# run_pass <固定的日子，空字串＝真實日期> <是否逐檔印：yes|no>
# 跑所有 harness 一輪，累計到 total／failed；這一輪自己的結果放在 pass_n／pass_bad／pass_skip／detail
run_pass() {
  pass_n=0; pass_bad=0; pass_skip=0; detail=""
  for f in $files; do
    out=$(MARATHON_TODAY=${1:-real} node -r ./tests/lib/clock.js "$f" 2>&1); code=$?
    p=$(printf '%s\n' "$out" | grep -c '^PASS'); x=$(printf '%s\n' "$out" | grep -c '^FAIL'); s=$(printf '%s\n' "$out" | grep -c '^SKIP')
    pass_n=$((pass_n + p)); pass_skip=$((pass_skip + s))
    if [ "$x" -gt 0 ] || [ "$code" -ne 0 ]; then
      pass_bad=$((pass_bad + 1))
      line="✗ $f  pass=$p fail=$x$nl$(printf '%s\n' "$out" | grep -E '^FAIL|Error' | head -5 | sed 's/^/    /')"
      detail="$detail$line$nl"
      [ "$2" = yes ] && echo "$line"
    elif [ "$2" = yes ]; then
      echo "✓ $f  $p"; printf '%s\n' "$out" | grep '^SKIP' | sed 's/^/    /'
    fi
  done
  total=$((total + pass_n)); failed=$((failed + pass_bad))
}

if [ "$mode" = on ]; then
  run_pass "$pin" yes
  echo "—— 今天固定在 $pin（$(node tests/lib/dates.js label "$pin")）：共 $pass_n 項通過；$pass_bad 個檔案有問題"
  [ "$failed" -eq 0 ]; exit
fi

run_pass "" yes
if [ "$mode" = quick ]; then
  echo "（這次沒有固定日期。發版前請不加 --quick 跑完整的）"
  echo "—— 共 $total 項通過；$failed 個檔案有問題"
  [ "$failed" -eq 0 ]; exit
fi
echo "—— 真實日期：共 $pass_n 項通過；$pass_bad 個檔案有問題"

if [ "$mode" = scan ]; then
  list=$(node tests/lib/dates.js range "$from" "$to" "$step") || exit 2
  echo "把今天固定在 $from～$to（每 $step 天）各跑一遍："
else
  list=$(node tests/lib/dates.js presets)
  echo "把今天固定在這幾天各跑一遍（只跑真實日期：--quick）："
fi
for entry in $list; do
  d=${entry%% *}
  run_pass "$d" no
  if [ "$pass_bad" -eq 0 ]; then
    extra=""; [ "$pass_skip" -gt 0 ] && extra="，$pass_skip 項略過"
    echo "✓ $entry  $pass_n 項通過$extra"
  else
    echo "✗ $entry  $pass_n 項通過；$pass_bad 個檔案有問題"
    printf '%s' "$detail" | sed 's/^/  /'
    echo "  重現：./tests/run.sh --on $d <出事的 harness 編號>"
  fi
done
echo "—— 共 $total 項通過；$failed 個檔案有問題"
[ "$failed" -eq 0 ]
