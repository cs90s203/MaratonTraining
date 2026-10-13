// 測試挑「哪一週」的規則（README「本機開發」）。以前各支 harness 自己寫 TW+1、TW+2、Math.min(TW+3, 最後一週)、
// 寫死的第 1／3／9 週，結果哪天跑就哪天撞：計畫最後幾週 TW+k 超過最後一週（沒有那一週），
// 用 Math.min 夾住又讓兩個不同用途的週變成同一週，寫死的週次又剛好被 TW+k 追上。
//
//   const cal = require('./lib/weeks')(PlanData);
//   cal.TW, cal.TD          今天是第幾週星期幾（計畫之外：開始前 TW＝0、結束後 TW＝最後一週+1，TD＝0；只有 cal.inPlan 是 true 時才拿來比「今天」）
//   cal.future(k)          TW+k；超過最後一週回 null（呼叫的人印 SKIP，不要自己夾成別週）
//   cal.past(k)            TW-k；第 1 週之前回 null
//   cal.order(avoid)       所有「不是今天這週、不在 avoid 裡」的週，照 pick 的順序排好（要找「有某種日子的週」時從頭找起）
//   cal.pick(n, avoid)     order(avoid) 的前 n 個，也就是 n 個互不相同、都在計畫裡的週：先取今天之後的（TW+1、TW+2…），
//                         不夠了（計畫最後幾週）才往前補（TW-1、TW-2…）。avoid 放這支 harness 別處寫死用到的週
//                         （例如假的雲端資料用的第 20～22 週），回傳的週就一定不會跟它們撞
//   cal.isFuture(w)        w 是不是整週都在今天之後（pick 回來的週要「一定在未來」才能成立的測試，先問這個）
'use strict';
module.exports = function weeks(PlanData) {
  const total = PlanData.plan.totalWeeks;
  const loc = PlanData.locateToday();
  const inPlan = loc.status === 'in-plan';
  const TW = inPlan ? loc.weekNumber : loc.status === 'before-start' ? 0 : total + 1;
  const TD = inPlan ? loc.dayIndex : 0;
  const future = (k) => (TW + k >= 1 && TW + k <= total ? TW + k : null);
  const past = (k) => (TW - k >= 1 && TW - k <= total ? TW - k : null);
  function order(avoid = []) {
    const out = [];
    const ok = (w) => w >= 1 && w <= total && w !== TW && !avoid.includes(w);
    for (let w = TW + 1; w <= total; w++) if (ok(w)) out.push(w);
    for (let w = TW - 1; w >= 1; w--) if (ok(w)) out.push(w);
    return out;
  }
  function pick(n, avoid = []) {
    const out = order(avoid).slice(0, n);
    if (out.length < n) throw new Error(`計畫只有 ${total} 週，挑不出 ${n} 個互不相同的週（avoid: ${avoid.join(',')}）`);
    return out;
  }
  return { total, loc, inPlan, TW, TD, future, past, order, pick, isFuture: (w) => w > TW };
};
