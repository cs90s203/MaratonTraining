// moveWeekDay（插入語意）＋ App.moveWeekDay 的展開列跟隨規則
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
  document: { querySelector: () => null, getElementById: () => null },
  render: () => {},
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['js/plan-data.js', 'js/firebase-sync.js', 'js/store.js', 'js/app.js']) vm.runInContext(fs.readFileSync(path + '/' + f, 'utf8'), sandbox, { filename: f });
vm.runInContext('this.PlanData = PlanData; this.Store = Store; this.App = App;', sandbox);
function assert(c, m) { console.log((c ? 'PASS' : 'FAIL') + ': ' + m); if (!c) process.exitCode = 1; }
(async () => {
  await sandbox.PlanData.load();
  const { Store, App } = sandbox;
  Store.activeUserId = 'mick'; Store.init(); Store._cloudPush = () => {};
  const wn = 13;
  const ord = () => Store.effectiveDayOrder(wn, 'mick').join('');
  // 插入語意：把週一(0)拖到週三(2) → 1,2,0,3,4,5,6
  Store.moveWeekDay(wn, 0, 2);
  assert(ord() === '1203456', 'move 0→2 inserts (got ' + ord() + ')');
  // 再把第 2 格（內容 0）拖回第 0 格 → identity，dayOrder 清掉
  Store.moveWeekDay(wn, 2, 0);
  assert(ord() === '0123456', 'move back → identity (got ' + ord() + ')');
  const adj = Store.weekAdjustmentFor(wn, 'mick');
  assert(!adj || adj.dayOrder == null, 'identity clears dayOrder (no stale record)');
  // 往前拖：週六(5)拖到週二(1) → 0,5,1,2,3,4,6
  Store.moveWeekDay(wn, 5, 1);
  assert(ord() === '0512346', 'move 5→1 (got ' + ord() + ')');
  // 無效輸入
  assert(Store.moveWeekDay(wn, 3, 3) === null, 'same index → null');
  assert(Store.moveWeekDay(wn, -1, 3) === null, 'out of range → null');
  assert(Store.moveWeekDay(wn, 'x', 3) === null, 'NaN → null');
  assert(ord() === '0512346', 'invalid calls did not change order');
  Store.resetDayOrder(wn);
  assert(ord() === '0123456', 'reset → identity');
  // 教練模式：拖了也不生效（effectiveDayOrder 回 identity），但資料層仍照存——UI 不畫把手
  Store.coachMode = true;
  assert(ord() === '0123456', 'coach mode → identity view');
  Store.coachMode = false;

  // App.moveWeekDay：展開列跟著內容走
  App.state.expandedDay = { weekNumber: wn, dayIndex: 5 };
  App.moveWeekDay(wn, 5, 1);          // 被拖的就是展開列 → 落點 1
  assert(App.state.expandedDay.dayIndex === 1, 'expanded row follows dragged row (5→1 ⇒ 1)');
  Store.resetDayOrder(wn);
  App.state.expandedDay = { weekNumber: wn, dayIndex: 3 };
  App.moveWeekDay(wn, 5, 1);          // 3 在 [1,5) 內 → 順移成 4
  assert(App.state.expandedDay.dayIndex === 4, 'expanded row shifts down when a later row moves above it (got ' + App.state.expandedDay.dayIndex + ')');
  Store.resetDayOrder(wn);
  App.state.expandedDay = { weekNumber: wn, dayIndex: 3 };
  App.moveWeekDay(wn, 1, 5);          // 3 在 (1,5] 內 → 順移成 2
  assert(App.state.expandedDay.dayIndex === 2, 'expanded row shifts up when an earlier row moves below it (got ' + App.state.expandedDay.dayIndex + ')');
  Store.resetDayOrder(wn);
  App.state.expandedDay = { weekNumber: wn, dayIndex: 6 };
  App.moveWeekDay(wn, 0, 2);          // 6 不在範圍內 → 不動
  assert(App.state.expandedDay.dayIndex === 6, 'expanded row outside range unchanged');
  App.state.expandedDay = { weekNumber: 12, dayIndex: 2 };
  App.moveWeekDay(wn, 0, 2);
  assert(App.state.expandedDay.weekNumber === 12 && App.state.expandedDay.dayIndex === 2, 'other week expanded row untouched');
  console.log('done');
})();
