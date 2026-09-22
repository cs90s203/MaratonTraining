// 決策紀錄第 49 條（週目標跑量不被課表卡死）、第 51 條（登入後身分固定、晚回來的寫入結果不蓋現在的身分）
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
const tick = () => new Promise((r) => setTimeout(r, 5));
(async () => {
  await sandbox.PlanData.load();
  const { PlanData, Store, App, Sync } = sandbox;
  Store.activeUserId = 'mick'; Store.init(); Store._cloudPush = () => {}; Store._cloudPushPlanWeek = () => {};

  // ── 第 49 條：週目標跑量 ──
  Store.coachMode = true;
  const W = PlanData.locateToday().weekNumber + 2;
  const auto = Store.weekTargetAuto(W, 'mick', { planOnly: true });
  App.setWeeklyVolume(W, String(auto.max + 10), String(auto.max + 15));
  const vol = Store.weekVolume(W, 'mick');
  assert(vol.goal && vol.goal.min === auto.max + 10 && vol.goal.max === auto.max + 15, `goal above the plan total is kept as typed (${JSON.stringify(vol.goal)})`);
  assert(vol.target.min === Store.weekTargetAuto(W, 'mick').min && vol.target.max === Store.weekTargetAuto(W, 'mick').max, 'target (預計) stays the plan total, not clamped or replaced by the goal');
  assert(!sandbox.__alerts.some((m) => m.includes('不能高於課表加總')), 'no "cannot exceed plan" refusal');
  const panel = fn('renderWeekCoachPanel')(W, Store.effectiveWeek(W, 'mick'), true, 'mick');
  assert(panel.includes('目標跑量（K）') && panel.includes(`value="${auto.max + 10}"`) && panel.includes('預計跑量') && panel.includes('清除目標') && !panel.includes('只能往下調') && !/placeholder="\d/.test(panel), 'coach panel: free 目標跑量 inputs + read-only 預計跑量, no ceiling text or plan placeholders');
  const card = fn('renderWeekVolumeCard')(vol, { heading: '本週訓練目標', title: '跑量' });
  assert(card.includes(`目標跑量 ${auto.max + 10}–${auto.max + 15} km`) && card.includes(`/ ${auto.min === auto.max ? auto.min : `${auto.min}–${auto.max}`} km`), 'week card: bar still actual / 預計, plus a 目標跑量 line');
  App.clearWeeklyVolume(W);
  assert(Store.weekVolume(W, 'mick').goal === null, 'clear removes the goal');
  const nA = sandbox.__alerts.length;
  App.setWeeklyVolume(W, '-1', '5');
  assert(sandbox.__alerts.length === nA + 1 && Store.weekVolume(W, 'mick').goal === null, 'negative goal refused');

  // ── 第 51 條：登入後身分固定 ──
  Sync.user = { email: 'x@example.com' };
  Sync.detectedUserId = 'mick';
  const nB = sandbox.__alerts.length;
  App.switchIdentity('Annlin');
  assert(Store.activeUserId === 'mick' && sandbox.__alerts.length === nB + 1 && sandbox.__alerts[nB].includes('查看別人的進度'), 'signed in: cannot switch the identity to someone else (explains where to look instead)');
  const settings = fn('renderSettingsPage')({});
  const annRow = settings.split('user-opt').find((x) => x.includes('>Annlin'));
  assert(annRow && annRow.includes('locked') && settings.includes('登入之後固定是登入的帳號'), 'settings shows the others as locked with the reason');
  Sync.detectedUserId = null; // 判斷不出來（離線）：照舊可以切
  Sync.resubscribe = () => {};
  App.switchIdentity('Annlin');
  assert(Store.activeUserId === 'Annlin', 'identity not detected (offline): switching still works');
  Sync.user = null;
  App.switchIdentity('mick');
  assert(Store.activeUserId === 'mick', 'signed out: switching works');

  // ── 第 51 條：上一個身分的寫入結果晚回來，不蓋現在的狀態 ──
  Sync.user = { email: 'x@example.com' };
  let rejectLater;
  vm.runInContext('fbDb = { collection: () => ({ doc: () => ({ set: () => new Promise((res, rej) => { globalThis.__rej = rej; globalThis.__res = res; }) }) }) }', sandbox);
  Sync.state = 'done'; Sync.failedWrites.clear();
  Sync.pushDoc('entries', '2026-09-20', { status: null }); // 寫的時候是某個身分
  Sync._identitySeq++;                                      // 然後切了身分
  sandbox.__rej({ code: 'permission-denied' });
  await tick();
  assert(Sync.state === 'done' && Sync.failedWrites.size === 0, 'late rejection from the previous identity is ignored (no stuck 寫入被拒)');
  Sync.pushDoc('entries', '2026-09-21', { status: null }); // 同一個身分被拒：照舊顯示
  sandbox.__rej({ code: 'permission-denied' });
  await tick();
  assert(Sync.state === 'write-denied' && Sync.failedWrites.has('entries:2026-09-21'), 'rejection for the current identity still shows 寫入被拒');
  Sync.state = 'done'; Sync.failedWrites.clear();
  Sync.pushDoc('profile', 'goals', { a: 1 }, 'Annlin'); // 幫別人寫（教練）：不受身分切換影響
  Sync._identitySeq++;
  sandbox.__rej({ code: 'permission-denied' });
  await tick();
  assert(Sync.state === 'write-denied', 'writes for someone else (coach) are still reported after an identity change');
})();

// ── 本週訓練目標前面放名字 ──
(async () => {
  await new Promise((r) => setTimeout(r, 300));
  const { Store, App, PlanData } = sandbox;
  Store.activeUserId = 'mick'; Store.coachMode = false;
  App.state.page = 'week'; App.state.weekViewNumber = PlanData.locateToday().weekNumber;
  const page = vm.runInContext('renderWeekPage', sandbox)(App.state);
  assert(/class="vol-who[^"]*"[^>]*>Mick(<svg[^]*?<\/svg>)?<\/(span|button)>本週訓練目標/.test(page), 'week target heading starts with the current person (Mick)');
  Store.activeUserId = 'Annlin';
  assert(/class="vol-who[^"]*"[^>]*>Annlin(<svg[^]*?<\/svg>)?<\/(span|button)>本週訓練目標/.test(vm.runInContext('renderWeekPage', sandbox)(App.state)), 'shows Annlin when the identity is Annlin');
  Store.activeUserId = 'mick';
  const ov = vm.runInContext('renderVolumeOverview', sandbox)(App.state.weekViewNumber, 'mick');
  assert(!ov.includes('vol-who'), 'overview volume card has no name chip');
})();
