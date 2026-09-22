// 決策紀錄第 53 條：看別人每天的紀錄（唯讀），本週頁跟總覽都有入口；看別人時改課表的工具收起來。
// 第 56 條之後：教練（Mick）開教練模式選別人＝排她的課表（harness22 測）；這裡測唯讀——教練模式關著，或不是教練的人。
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
  const subs = [];
  Sync.user = { email: 'x@example.com' }; Sync.detectedUserId = 'mick';
  Sync.subscribeOtherEntries = (u) => subs.push('e:' + u); Sync.subscribeOtherWeekAdjustments = (u) => subs.push('w:' + u); Sync.subscribeOtherProfile = () => {};
  const loc = PlanData.locateToday();
  const W = loc.weekNumber, TD = loc.dayIndex;
  const today = PlanData.keyForWeekDay(W, TD);
  // Annlin 今天做了第一項、填了數字跟附註；她自己把週一週三對調過
  const d0 = Store.effectiveWeek(W).days;
  Store.weekAdjustments.Annlin = { [W]: { dayOrder: [2, 1, 0, 3, 4, 5, 6] } };
  const annOrder = Store.effectiveDayOrder(W, 'Annlin');
  const shown = d0[annOrder[TD]];
  Store.mergeRemoteEntry('Annlin', today, { done: { [shown.items[0].id]: true }, actualDistanceKm: 5.2, actualDurationMinutes: 33, effort: 4, actualNote: '後半段有點喘 <b>x</b>', status: null, selectedItemId: null, updatedAt: '2026-09-15T10:00:00.000Z', fieldAt: {} });
  // 自己今天標了身體狀況（不能出現在看別人的畫面）
  Store.setFlag && Store.setFlag(today, 'pain', true);

  Store.coachMode = false;
  App.state.page = 'week'; App.state.weekViewNumber = W; App.state.expandedDay = { weekNumber: W, dayIndex: TD };
  App.viewWeekOf('Annlin');
  assert(App.state.viewingUserId === 'Annlin', 'viewWeekOf sets who we are looking at');
  const page = fn('renderWeekPage')(App.state);
  assert(subs.includes('e:Annlin') && subs.includes('w:Annlin'), 'subscribes to Annlin entries and day order');
  assert(!page.includes('view-banner') && /class="vol-who pick viewing"[^>]*>正在看 Annlin・唯讀/.test(page), 'no separate banner: the name chip itself says 正在看 Annlin・唯讀');
  assert(!page.includes('class="drag-handle"') && !page.includes('本週課表設定') && !page.includes('A.toggleItemPicker(') && !page.includes('A.amountTap('), 'no drag handles or plan tools while viewing someone else');
  Store.coachMode = true;
  assert(Store.effectiveDayOrder(W, 'Annlin')[0] === 2 && Store.effectiveDayOrder(W, 'mick')[0] === 0, 'coach mode: identity order only for self; Annlin keeps her own swap');
  Store.coachMode = false;
  const body = fn('renderDayBody')(W, TD, 'Annlin');
  assert(body.includes('ro-card') && body.includes('實際時間 33 分') && body.includes('實際公里 5.2 km') && body.includes('體感 4') && body.includes('後半段有點喘 &lt;b&gt;x&lt;/b&gt;'), 'her day shows actual time, km, effort and 附註 (escaped)');
  assert(body.includes('ro-item done') && body.includes(shown.items[0].title), 'her tick shows on the item she actually saw (her swapped day)');
  assert(!/<input|<textarea|A\.toggleItem\(|A\.selectChoice\(|A\.setActualStats\(|A\.setEffort\(|A\.setNote\(|A\.toggleFlag\(|A\.setDayStatus\(/.test(body), 'nothing on her day can write data');
  assert(body.includes('身體狀況只有本人看得到') && !body.includes('這天記錄了異常'), 'body status stays private (own flags not shown either)');
  const review = fn('renderWeeklyReviewCard')(W, 'Annlin');
  assert(!review.includes('A.markWeekReduced('), 'weekly review for her has no 標記本週已降量 button');
  Store.weekViewMode = 'table';
  const table = fn('renderWeekPage')(App.state);
  assert(table.includes('33 分') && table.includes('5.2 km') && table.includes('後半段有點喘'), 'table view shows her records');
  Store.weekViewMode = 'cards';

  // 第 56 條：不是教練的人（Phoebe）開教練模式看別人 → 還是唯讀，教練工具、橫幅都不出現
  Store.activeUserId = 'Phoebe'; Store.coachMode = true;
  const pPage = fn('renderWeekPage')(App.state);
  assert(!pPage.includes('class="drag-handle"') && !pPage.includes('本週課表設定') && !pPage.includes('A.toggleItemPicker(') && !pPage.includes('A.amountTap(') && /正在看 Annlin・唯讀/.test(pPage), 'non-coach in coach mode viewing someone else: read-only, plan tools hidden');
  assert(fn('renderDayBody')(W, TD, 'Annlin').includes('ro-card'), 'non-coach in coach mode: her day is the read-only card');
  assert(!fn('renderApp')(App.state).includes('coach-banner'), 'coach banner hidden on the week page while viewing someone else');
  Store.activeUserId = 'mick'; Store.coachMode = false;

  // 名字選單
  App.toggleViewMenu();
  const menuPage = fn('renderWeekPage')(App.state);
  assert(menuPage.includes('view-pick') && menuPage.includes('Mick（自己）') && menuPage.includes('回到自己：可以打勾、改課表') && menuPage.includes(`A.viewWeekOf('Phoebe')`) && menuPage.includes('A.viewWeekOf(null)'), 'picker lists self (回到自己) and the others');
  App.viewWeekOf(null);
  assert(App.state.viewingUserId === null && !App.state.viewMenuOpen, 'back to self closes the menu');
  Store.coachMode = true;
  const selfPage = fn('renderWeekPage')(App.state);
  assert(!selfPage.includes('正在看') && !selfPage.includes('vol-who pick viewing') && selfPage.includes('本週課表設定'), 'self again: plain name chip, coach tools back');

  // 總覽的入口
  App.state.page = 'overview';
  App.viewProgress('Annlin');
  const ov = fn('renderOverviewPage')(App.state);
  assert(ov.includes(`A.viewWeekOf('Annlin', true)`) && ov.includes('看 Annlin 每天的紀錄'), 'overview has 看 Annlin 每天的紀錄');
  App.viewWeekOf('Annlin', true);
  assert(App.state.page === 'week' && App.state.viewingUserId === 'Annlin', 'overview button opens her week');
  App.viewProgress(Store.activeUserId);
  assert(!fn('renderOverviewPage')(App.state).includes('每天的紀錄 ›'), 'no button when looking at yourself');
})();
