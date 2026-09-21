#!/bin/sh
# 跑全部測試（node，不用安裝任何套件）。有任何一項 FAIL 或腳本丟錯就回傳非 0。
cd "$(dirname "$0")/.." || exit 1
total=0; failed=0
for f in tests/harness*.js; do
  out=$(node "$f" 2>&1); code=$?
  p=$(printf '%s\n' "$out" | grep -c '^PASS'); x=$(printf '%s\n' "$out" | grep -c '^FAIL')
  total=$((total + p))
  if [ "$x" -gt 0 ] || [ "$code" -ne 0 ]; then
    failed=$((failed + 1)); echo "✗ $f  pass=$p fail=$x"; printf '%s\n' "$out" | grep -E '^FAIL|Error' | head -5
  else
    echo "✓ $f  $p"
  fi
done
echo "—— 共 $total 項通過；$failed 個檔案有問題"
[ "$failed" -eq 0 ]
