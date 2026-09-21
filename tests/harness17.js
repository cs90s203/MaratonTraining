// 決策紀錄第 48 條：階段目標的跑量拆三行（目標／預計／實際）；總覽進度的平均週跑量
const fs = require('fs');
const vm = require('vm');
const path = require('path').resolve(__dirname, '..'); // repo 根目錄
const load = (f) => JSON.parse(fs.readFileSync(path + '/data/' + f));
const map = { 'plan.json': load('plan.json'), 'videos.json': load('videos.json'), 'workouts.json': load('workouts.json'), 'users.json': load('users.json') };
const store = {};
const sandbox = {
  console, window: {}, crypto: require('crypto').webcrypto, location: { href: 'x' }, setTimeout,
  document: { getElementById: () => null, addEventListener: () => {}, querySelector: () => null },
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: () => {} },
  fetch: async (u) => ({ json: async () => map[Object.keys(map).find((k) => u.includes(k))] }),
  alert: (m) => sandbox.__alerts.push(m), confirm: () => true, __alerts: [],
  APP_VERSION: 't', Sortable: function () {},
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['js/plan-data.js', 'js/firebase-sync.js', 'js/store.js', 'js/views.js', 'js/app.js']) vm.runInContext(fs.readFileSync(path + '/' + f, 'utf8'), sandbox, { filename: f });
vm.runInContext('this.PlanData = PlanData; this.Store = Store; this.App = App; this.Sync = Sync; globalThis.render = () => {};', sandbox);
function assert(c, m) { console.log((c ? 'PASS' : 'FAIL') + ': ' + m); if (!c) process.exitCode = 1; }
const fn = (name) => vm.runInContext(name, sandbox);
(async () => {
  await sandbox.PlanData.load();
  const { PlanData, Store, App, Sync } = sandbox;
  Store.activeUserId = 'mick'; Store.init(); Store._cloudPush = () => {};
  Sync.subscribeOtherEntries = () => {}; Sync.subscribeOtherProfile = () => {}; Sync.subscribeOtherWeekAdjustments = () => {};

  // ── 平均週跑量 ──
  const realLocate = PlanData.locateToday;
  const p1 = PlanData.plan.phases[0];
  PlanData.locateToday = () => ({ status: 'in-plan', weekNumber: 4, dayIndex: 2, key: PlanData.keyForWeekDay(4, 2) });
  Store.isFutureKey = () => false; // 測試用：假裝第 1–3 週都過了
  assert(Store.averageWeeklyVolume('mick') === null, 'no records yet: average is null (shown as —)');
  const runDay = (wn) => Store.effectiveWeek(wn).days.findIndex((d) => !d.selectOne && d.items.some((it) => it.type === 'run'));
  Store.setActualStats(PlanData.keyForWeekDay(1, runDay(1)), { distanceKm: 4 });
  Store.setActualStats(PlanData.keyForWeekDay(3, runDay(3)), { distanceKm: 6 });
  Store.setActualStats(PlanData.keyForWeekDay(3, runDay(3) + 2 <= 6 ? runDay(3) + 2 : 0), { distanceKm: 2 });
  const avg = Store.averageWeeklyVolume('mick');
  const w3 = Store.weekVolume(3, 'mick').actual;
  assert(avg && avg.weeks === 2 && Math.abs(avg.km - Math.round(((4 + w3) / 2) * 10) / 10) < 1e-9, `average over finished weeks with records only (weeks 1 and 3, week 2 empty not counted as 0): ${JSON.stringify(avg)}`);
  Store.setActualStats(PlanData.keyForWeekDay(4, runDay(4)), { distanceKm: 30 });
  assert(Store.averageWeeklyVolume('mick').km === avg.km, 'the current (unfinished) week is not averaged in');
  PlanData.locateToday = () => ({ status: 'before-start', daysUntilStart: 3 });
  assert(Store.averageWeeklyVolume('mick') === null, 'before the plan starts: null');
  PlanData.locateToday = () => ({ status: 'in-plan', weekNumber: 4, dayIndex: 2, key: PlanData.keyForWeekDay(4, 2) });

  const page = fn('renderOverviewPage')(App.state);
  assert(/平均週跑量 km（2 週）/.test(page) && page.includes(`<div class="n">${avg.km}</div>`), 'overview 進度 shows 平均週跑量 with the week count');

  // ── 階段目標：三行 ──
  App.state.overviewPhaseId = p1.phaseId;
  const plan = Store.phaseVolumeAutoRange(p1.phaseId, 'mick');
  const actual = Store.phaseVolumeActual(p1.phaseId, 'mick');
  let card = fn('renderPhaseTargetsCard')(p1, 'mick', true, PlanData.userById.mick, App.state);
  const iT = card.indexOf('目標跑量'), iP = card.indexOf('預計跑量'), iA = card.indexOf('實際跑量');
  assert(iT > 0 && iP > iT && iA > iP, 'three rows in order: 目標跑量 → 預計跑量 → 實際跑量');
  assert(card.includes('name="volumeKm_min"') && !/name="volumeKm_min"[^>]*placeholder/.test(card), '目標跑量 is a free input without the plan number as placeholder');
  assert(card.includes(`${plan.min}–${plan.max}`) || card.includes(`${plan.min}`), '預計跑量 shows the plan total for the phase');
  assert(card.includes(`<span class="ptgt-val">${actual}</span>`), '實際跑量 shows the phase total of logged km');
  assert(!card.includes('課表這階段大約') && !card.includes('你的目標比這高') && !card.includes('ptgt-progress'), 'no linkage between target and plan/actual (no hint, no warning, no progress bar)');

  // 別人的、沒開教練模式（唯讀）：沒有目標也看得到預計／實際
  Store.coachMode = false;
  card = fn('renderPhaseTargetsCard')(p1, 'annlin', false, PlanData.userById.annlin || { displayName: 'Annlin' }, App.state);
  assert(card.includes('預計跑量') && card.includes('實際跑量') && card.includes('教練還沒設定這階段的目標') && !card.includes('name="volumeKm_min"'), 'read-only without targets: plan and actual rows + 還沒設定目標');
  Store.setPhaseTargetsForPhase(p1.phaseId, { volumeKm: { min: 40, max: 50 } }, 'annlin');
  card = fn('renderPhaseTargetsCard')(p1, 'annlin', false, PlanData.userById.annlin || { displayName: 'Annlin' }, App.state);
  assert(card.includes('<span class="ptgt-val">40–50</span>') && !card.includes('教練還沒設定'), 'read-only with a target: shows 目標跑量 40–50');

  PlanData.locateToday = realLocate;
})();
