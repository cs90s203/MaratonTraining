// 決策紀錄第 23 條：填數字自動完成、拿掉「錯過」、舊 'missed' 文件的相容
const fs = require('fs');
const vm = require('vm');
const path = require('path').resolve(__dirname, '..'); // repo 根目錄
const plan = JSON.parse(fs.readFileSync(path + '/data/plan.json'));
const videos = JSON.parse(fs.readFileSync(path + '/data/videos.json'));
const workouts = JSON.parse(fs.readFileSync(path + '/data/workouts.json'));
const users = JSON.parse(fs.readFileSync(path + '/data/users.json'));
const store = {};
const sandbox = {
  console,
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  window: {}, crypto: require('crypto').webcrypto,
  fetch: async (url) => { const map = { 'plan.json': plan, 'videos.json': videos, 'workouts.json': workouts, 'users.json': users }; const key = Object.keys(map).find((k) => url.includes(k)); return { json: async () => map[key] }; },
  APP_VERSION: 'test',
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['js/plan-data.js', 'js/firebase-sync.js', 'js/store.js']) vm.runInContext(fs.readFileSync(path + '/' + f, 'utf8'), sandbox, { filename: f });
vm.runInContext('this.PlanData = PlanData; this.Store = Store;', sandbox);
function assert(c, m) { console.log((c ? 'PASS' : 'FAIL') + ': ' + m); if (!c) process.exitCode = 1; }
(async () => {
  await sandbox.PlanData.load();
  const { Store, PlanData } = sandbox;
  Store.activeUserId = 'mick'; Store.init(); Store._cloudPush = () => {};
  // W13 的日子形狀最齊（距離型長跑、時間型 Zone 2、二擇一）但它在未來。這個檔測的是自動打勾的
  // 規則本身，把「今天」當成計畫結束後；未來日子不能打勾的守衛由 harness8 測（決策紀錄第 31 條）。
  Store.isFutureKey = () => false;
  const wn = 13;

  // ── 單一項目的日子：填數字自動完成（① 實際公里／分鐘＋完成）──
  const longRunDay = PlanData.keyForWeekDay(wn, 5); // 長跑，distance-based, single item
  let w = Store.effectiveWeek(wn);
  const longItem = w.days[Store.effectiveDayOrder(wn, 'mick')[5]].items[0];
  assert(!w.days[Store.effectiveDayOrder(wn, 'mick')[5]].selectOne, 'long run day is not selectOne (sanity)');
  Store.setActualStats(longRunDay, { distanceKm: 9 });
  let e = Store.entryFor('mick', longRunDay);
  assert(e.done[longItem.id] === true, 'filling km auto-ticks the single item, got ' + JSON.stringify(e.done));
  assert(Store.dayStatus(wn, 5) === 'done', 'day becomes done after km fill, got ' + Store.dayStatus(wn, 5));

  // 清掉數字不會取消完成（單向）
  Store.setActualStats(longRunDay, { distanceKm: null });
  e = Store.entryFor('mick', longRunDay);
  assert(e.done[longItem.id] === true, 'clearing km does NOT untick (one-way), got ' + JSON.stringify(e.done));
  Store.toggleItem = null; // sanity: no such method, tick lives in Store.toggleItemDone
  Store.toggleItemDone(longRunDay, longItem.id);
  e = Store.entryFor('mick', longRunDay);
  assert(e.done[longItem.id] === false, 'the done button itself still un-ticks manually');

  // ── 已經是「更換項目／自主休息」的日子：填數字不會自動完成（不覆蓋 status）──
  const tue = PlanData.keyForWeekDay(wn, 1); // Zone2 run, time-based, single item
  Store.setDayStatus(tue, 'rested');
  Store.setActualStats(tue, { durationMinutes: 20 }); // 理論上 rested 不會顯示分鐘框，但防呆一下 Store 層
  e = Store.entryFor('mick', tue);
  assert(e.status === 'rested', 'filling a number while rested does not clear the rested status, got ' + e.status);

  // ── 二擇一的日子：填數字不自動完成（selectOne 用選的動作本身算完成）──
  const sunDay = PlanData.keyForWeekDay(wn, 6); // 完全休息 或 散步＋伸展，selectOne
  w = Store.effectiveWeek(wn);
  const sunD = w.days[Store.effectiveDayOrder(wn, 'mick')[6]];
  assert(sunD.selectOne, 'Sunday is selectOne (sanity)');
  const walkItem = sunD.items.find((it) => it.type !== 'rest');
  Store.setSelectedItem(sunDay, walkItem.id);
  Store.setActualStats(sunDay, { durationMinutes: 15 });
  e = Store.entryFor('mick', sunDay);
  assert(e.selectedItemId === walkItem.id && e.done[walkItem.id] === true, 'selecting already completes selectOne day (unchanged)');

  // ── 兩項都要做的日子：填一個分鐘不會自動完成兩項（數字對不到哪一項）──
  const w9 = 9;
  const thu9 = PlanData.keyForWeekDay(w9, 3); // 跑姿訓練日 + 核心
  const w9days = Store.effectiveWeek(w9);
  const thu9D = w9days.days[Store.effectiveDayOrder(w9, 'mick')[3]];
  assert(!thu9D.selectOne && thu9D.items.length === 2, 'W9 Thu has two required items (sanity), got ' + JSON.stringify(thu9D.items.map((i) => i.title)));
  Store.setActualStats(thu9, { durationMinutes: 20 });
  e = Store.entryFor('mick', thu9);
  assert(!e.done || Object.values(e.done).every((v) => !v), 'two-item day: filling minutes does not auto-tick either item, got ' + JSON.stringify(e && e.done));

  // ── entryStatus() 相容舊的 'missed' 文件（決策紀錄第 23 條：讀成 null，資料不用改）──
  const wed = PlanData.keyForWeekDay(wn, 2);
  Store.mergeRemoteEntry('mick', wed, { status: 'missed', done: {}, updatedAt: new Date().toISOString() });
  e = Store.entryFor('mick', wed);
  assert(e.status === 'missed', 'raw stored value is untouched by merge (sanity)');
  assert(Store.dayStatus(wn, 2) !== 'missed', "dayStatus never returns the legacy 'missed' string, got " + Store.dayStatus(wn, 2));
  const vLegacy = Store.weekVolume(wn, 'mick');
  assert(typeof vLegacy.actual !== 'undefined', 'weekVolume computes fine with a legacy missed doc present');

  // 填數字在舊 'missed' 的日子上也能自動完成，並把舊 status 清掉
  w = Store.effectiveWeek(wn);
  const wedItem = w.days[Store.effectiveDayOrder(wn, 'mick')[2]].items[0];
  const wedIsSingle = !w.days[Store.effectiveDayOrder(wn, 'mick')[2]].selectOne && w.days[Store.effectiveDayOrder(wn, 'mick')[2]].items.length === 1;
  if (wedIsSingle) {
    Store.setActualStats(wed, { durationMinutes: 30 });
    e = Store.entryFor('mick', wed);
    assert(e.status === null, 'filling a number on a legacy missed day clears the stale status, got ' + e.status);
    assert(e.done[wedItem.id] === true, 'and auto-ticks, got ' + JSON.stringify(e.done));
  } else {
    console.log('SKIP: W13 Wed is not a single-item day in this plan, skipped the legacy-missed auto-complete check');
  }

  console.log('done');
})();
