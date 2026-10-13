// 固定測試用的「今天」。沒設 MARATHON_TODAY 時什麼都不做（用真實時鐘），所以直接 `node tests/harnessNN.js` 跟以前一樣。
//
//   MARATHON_TODAY=2026-12-14 node -r ./tests/lib/clock.js tests/harness22.js
//   ./tests/run.sh --on 2026-12-14 harness22        # 同上，少打一點字
//
// 為什麼要有這個：harness 用 PlanData.locateToday() 排「這週」「今天」，結果跟哪天跑有關。
// 做了兩件事：
//   1. 把 Date 換成「今天固定在那一天的中午、每次呼叫往前走 1ms」的子類。一定要往前走：
//      nowIso() 的 updatedAt 重複會讓課表同步的版本比對失常（所有 new Date()／Date.now() 都拿到不同的值）。
//   2. harness 都用 vm.createContext(sandbox) 另開沙盒，沙盒裡的 Date 是它自己的內建，外面換掉沒用——
//      所以把 createContext 包起來，開完就把同一個 Date 塞進沙盒。
// 用 -r 預載、不是每支 harness 自己 require：以後新增、照抄範本的 harness 不用記得這一行也會被固定到。
// 只包 vm.createContext；不要在 harness 裡用 vm.runInNewContext（它不會經過這裡）。
'use strict';
const vm = require('vm');

const raw = process.env.MARATHON_TODAY;
if (raw && raw !== 'real') {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const noon = m && new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0, 0);
  // 2026-02-30 這種會被 Date 默默進位成 3/2：寧可直接報錯，不然掃了一整輪才發現掃的不是那天
  if (!noon || noon.getFullYear() !== +m[1] || noon.getMonth() !== +m[2] - 1 || noon.getDate() !== +m[3]) {
    throw new Error(`MARATHON_TODAY 要寫成真的存在的 YYYY-MM-DD（或 real），收到「${raw}」`);
  }
  const fixed = noon.getTime();
  const RealDate = Date;
  let tick = 0;
  class PinnedDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(fixed + (++tick)); else super(...a); }
    static now() { return fixed + (++tick); }
  }
  Object.defineProperty(PinnedDate, 'name', { value: 'Date' }); // 有人會看 constructor.name
  globalThis.Date = PinnedDate; // harness 自己的 new Date()（例如造一筆「剛剛」的雲端資料）也要跟沙盒同一個時鐘
  const createContext = vm.createContext;
  vm.createContext = function (obj, ...rest) {
    const o = obj === undefined ? {} : obj;
    const ctx = createContext.call(vm, o, ...rest);
    Object.defineProperty(o, 'Date', { value: PinnedDate, writable: true, configurable: true }); // 開完才塞：createContext 會換成新的內建
    return ctx;
  };
  console.error(`[clock] 今天固定在 ${raw}（本地中午，每次呼叫 +1ms）`);
}
