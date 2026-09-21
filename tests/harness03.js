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
  const wn = 13;
  const base = Store.weekVolume(wn, 'mick');
  // Tuesday W13 = Zone 2 run (duration only). Mark substituted + bike + 20km: must NOT count.
  const tue = PlanData.keyForWeekDay(wn, 1);
  Store.setDayStatus(tue, 'substituted');
  Store.setActualStats(tue, { distanceKm: 20 });
  Store.setSubstituteType(tue, 'bike');
  const e = Store.entryFor('mick', tue);
  assert(e.substituteType === 'bike', 'substituteType stored');
  assert(e.actualDistanceKm === null, 'km cleared when switching to a non-run substitute');
  Store.setActualStats(tue, { distanceKm: 20 }); // user types km again anyway
  const v1 = Store.weekVolume(wn, 'mick');
  assert(v1.actual == null || v1.actual < 20, 'bike km not counted in weekly actual, actual=' + v1.actual);
  assert(v1.target.max < base.target.max, 'substituted-non-run day removed from target');
  // Switch substitute to run: km counts, day back in target
  Store.setSubstituteType(tue, 'run');
  const v2 = Store.weekVolume(wn, 'mick');
  assert(v2.actual === 20, 'run substitute km counted, actual=' + v2.actual);
  assert(v2.target.max === base.target.max, 'run substitute day back in target');
  // Effort
  Store.setEffort(tue, 7);
  assert(Store.entryFor('mick', tue).effort === 7, 'effort stored');
  Store.setEffort(tue, 7);
  assert(Store.entryFor('mick', tue).effort === null, 'tapping same effort clears');
  Store.setEffort(tue, 11);
  assert(Store.entryFor('mick', tue).effort === null, 'out-of-range effort rejected');
  Store.setEffort(tue, 5);
  // 決策紀錄第 23 條：「錯過」拿掉，'missed' 不再是合法值——setDayStatus 一律當 null 處理，
  // 等同「取消覆寫、回到照表」（tue 這天有跑步項目，回到照表不清 km；沒有時長項目才清分鐘）。
  Store.setDayStatus(tue, 'missed');
  const em = Store.entryFor('mick', tue);
  assert(em.status === null && em.substituteType === null, "'missed' is treated as null (not a valid status), back to 照表");
  assert(em.effort === 5 && em.actualDistanceKm === 20, '回到照表不隱含清掉已經填的體感/公里，got effort=' + em.effort + ' km=' + em.actualDistanceKm);
  Store.setDayStatus(tue, 'substituted'); // 真的設一次，再取消，驗證「再點同一個＝取消」對 substituted 仍然成立
  Store.setDayStatus(tue, 'substituted');
  assert(Store.entryFor('mick', tue).status === null && Store.entryFor('mick', tue).substituteType === null, 'toggling substituted twice clears status/substituteType');
  // tue 的段落到此結束（現在留著 20km、狀態照表）——清掉，不要污染下面單獨測 thu 的加總。
  Store.setActualStats(tue, { distanceKm: null });
  // legacy substituted (no substituteType) with km still counts
  const thu = PlanData.keyForWeekDay(wn, 5); // Saturday long run
  Store.setDayStatus(thu, 'substituted');
  Store.setActualStats(thu, { distanceKm: 9 });
  const v3 = Store.weekVolume(wn, 'mick');
  assert(v3.actual === 9, 'legacy substituted without type still counts km, actual=' + v3.actual);
  console.log('done');
})();
