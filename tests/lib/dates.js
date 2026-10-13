// 給 tests/run.sh 用：列出要固定的「今天」。日期從 data/plan.json 的 startDate／totalWeeks 推出來，
// 不寫死絕對日期——換一份課表（開賽日不一樣）時，挑的還是「第一天、某個週一、最後一週……」。
//
//   node tests/lib/dates.js presets             預設要掃的幾個日子，每行「日期 說明」
//   node tests/lib/dates.js range FROM TO [N]   FROM～TO 每 N 天一個（預設 1），給 run.sh --scan 用
//   node tests/lib/dates.js label DATE          這一天是第幾週星期幾（或計畫之外）
//
// 日期一律用「年/月/日三個數字」建構本地 Date（見 js/plan-data.js 開頭的註解：不用字串餵 Date、不用 toISOString）。
'use strict';
const fs = require('fs');
const path = require('path');

const plan = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'data', 'plan.json'), 'utf8'));
const pad = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) throw new Error(`日期要寫成 YYYY-MM-DD，收到「${s}」`);
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) throw new Error(`沒有這一天：${s}`); // 2026-02-30 會被 Date 默默進位成 3/2
  return d;
};
const start = parse(plan.startDate);
const total = plan.totalWeeks;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const WEEKDAY = ['一', '二', '三', '四', '五', '六', '日']; // dayIndex 0 = 週一

function label(dateStr) {
  const diff = Math.round((parse(dateStr) - start) / 86400000);
  if (diff < 0) return `計畫開始前 ${-diff} 天`;
  if (diff >= total * 7) return `計畫結束後 ${diff - total * 7 + 1} 天`;
  return `第 ${Math.floor(diff / 7) + 1} 週 週${WEEKDAY[diff % 7]}`;
}
const day = (week, dayIndex) => key(addDays(start, (Math.min(Math.max(week, 1), total) - 1) * 7 + dayIndex));

// 每個日子各自對應一種容易出事的情況（寫的是 2026-09-07 開跑的這份課表上實際撞到過的；課表換了，週次會被夾進範圍裡）：
//   開始前一天／結束後一天  計畫之外：沒有「這週」，要印 SKIP 或用預設週，不能丟例外
//   第 1 週週三             今天跟昨天都是過期日（plan.expiredBefore 之前不計分）；第 1 週就是這週，不是「過去的一週」
//   第 6 週週一             週一：沒有過去的日子；寫死的第 9 週跟 TW+3 撞
//   第 10 週週五            週五：前一天已經有兩個項目，↑ 一下到不了最前面
//   第 12 週週日            週日：沒有「明天」；週日是二擇一（第 1～16 週），打勾要配「選了這個」才算
//   第 15 週週一            TW+2 剛好是第 17 週：週日從「二擇一」變成純休息
//   第 17 週週四            TW+4 落在寫死的第 20～22 週
//   第 23 週週三            TW+4 之後沒有「二擇一又有休息」的日子、沒有距離型的長跑
//   第 25 週週四            TW+1 就是最後一週、TW+2 開始超過
//   最後一週的最後一天      TW+1 就超過最後一週；今天＝賽前最後一天
// 改了這份清單就跑一次 `./tests/run.sh --scan` 看每一種失敗至少有一個日子抓得到（README「本機開發」）。
function presets() {
  return [
    key(addDays(start, -1)),
    day(1, 2), day(6, 0), day(10, 4), day(12, 6), day(15, 0), day(17, 3), day(23, 2), day(25, 3), day(total, 6),
    key(addDays(start, total * 7)),
  ].filter((d, i, a) => a.indexOf(d) === i).map((d) => `${d} ${label(d)}`);
}

try {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === 'presets') console.log(presets().join('\n'));
  else if (cmd === 'label') console.log(label(a));
  else if (cmd === 'range') {
    const step = Math.max(1, +(c || 1));
    const out = [];
    for (let d = parse(a); key(d) <= b; d = addDays(d, step)) out.push(`${key(d)} ${label(key(d))}`);
    console.log(out.join('\n'));
  } else throw new Error('用法：node tests/lib/dates.js presets | label DATE | range FROM TO [STEP]');
} catch (e) {
  console.error(e.message); // 給 run.sh 看的：只講原因，不印 stack
  process.exit(2);
}
