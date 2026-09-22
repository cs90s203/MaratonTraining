// 決策紀錄第 56 條：每個人一份課表。教練（Mick）排三個人的、其他人只能改自己的；複製課表；
// 常用項目庫、別人的目標只有教練能改；規則裡的教練要跟 data/users.json 同一個人。
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
  alert: (m) => sandbox.__alerts.push(m), confirm: (m) => { sandbox.__confirms.push(m); return true; }, __alerts: [], __confirms: [],
  APP_VERSION: 't', Sortable: function () {},
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['js/plan-data.js', 'js/firebase-sync.js', 'js/store.js', 'js/views.js', 'js/app.js']) vm.runInContext(fs.readFileSync(path + '/' + f, 'utf8'), sandbox, { filename: f });
vm.runInContext('this.PlanData = PlanData; this.Store = Store; this.App = App; this.Sync = Sync; globalThis.render = () => {};', sandbox);
function assert(c, m) { console.log((c ? 'PASS' : 'FAIL') + ': ' + m); if (!c) process.exitCode = 1; }
const fn = (name) => vm.runInContext(name, sandbox);
const tick = () => new Promise((r) => setTimeout(r, 0));
(async () => {
  await sandbox.PlanData.load();
  const { PlanData, Store, App, Sync } = sandbox;
  const realPlanWeeksLoaded = Sync.planWeeksLoaded; // 複製課表的測試會先換成假的，後面測它本身時要換回來
  Store.activeUserId = 'mick'; Store.init(); Store._cloudPush = () => {}; Store._cloudPushLibrary = () => {};
  const pushes = [];
  // 假的存檔當作雲端馬上確認（真的 App 是 Sync 寫成功之後記）；不記的話每一週都算「還沒存進雲端」，複製會被擋下
  const fakePush = (uid, wn, doc, base, onFail) => { pushes.push({ uid, wn, doc, base, onFail }); Store._planCloudAt[`${uid}:${wn}`] = doc.updatedAt; };
  Store._cloudPushPlanWeek = fakePush;
  const title = (uid, wn, di) => Store.effectiveWeek(wn, uid).days[di].items[0].title;
  const loc = PlanData.locateToday();
  const TW = loc.weekNumber, TD = loc.dayIndex;
  const F1 = TW + 1, W = TW + 2, F3 = TW + 3;

  // ── 誰是教練 ──
  assert(Store.isCoach('mick') && !Store.isCoach('Annlin') && !Store.isCoach('Phoebe') && Store.coachUser().userId === 'mick', 'Mick is the coach (users.json coach:true)');
  assert(Store.canEditPlanOf('Annlin') && Store.canEditPlanOf('mick') && Store.canEditLibrary() && Store.canEditGoalsOf('Phoebe'), 'coach: every plan, the library, everyone\'s goals');
  const sj = fn('stableJson');
  assert(sj({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } }) === sj({ a: { c: [3, { e: 2, f: 1 }], d: 2 }, b: 1 }), 'comparison ignores key order (Firestore returns keys in a different order)');

  // ── 讀取順序：自己那份 → 舊的共用課表 → 出廠 ──
  const factory = PlanData.week(W);
  assert(['mick', 'Annlin', 'Phoebe'].every((u) => Store.planSource(W, u) === 'factory' && Store.effectiveWeek(W, u) === factory), 'nothing saved: everyone reads the factory plan');
  const legacy = JSON.parse(JSON.stringify(factory));
  legacy.days[1].items[0].title = '舊共用課表改過';
  Store.mergeRemoteWeekOverride(W, { ...legacy, weekNumber: W, updatedAt: '2026-09-10T00:00:00.000Z' });
  assert(['mick', 'Annlin', 'Phoebe'].every((u) => Store.planSource(W, u) === 'legacy' && title(u, W, 1) === '舊共用課表改過'), 'right after release everyone still sees the old shared plan');
  Store.mergeRemotePlanWeek('Phoebe', F3, { weekNumber: F3, days: [] }); // 壞掉的文件
  assert(Store.planSource(F3, 'Phoebe') === 'factory' && Store.effectiveWeek(F3, 'Phoebe') === PlanData.week(F3), 'a malformed own doc is ignored (falls back instead of crashing)');
  Store.clearRemotePlanWeek('Phoebe', F3);

  // ── 教練排 Annlin 的課表：只變 Annlin ──
  Store.coachMode = true;
  App.state.page = 'week'; App.state.weekViewNumber = W; App.state.expandedDay = null;
  App.viewWeekOf('Annlin');
  assert(App.planUserId() === 'Annlin' && App._canEditPlan(), 'coach mode + Annlin picked in the name menu = planning Annlin');
  const wk = App._cloneEffectiveWeek(W);
  assert(wk.__baseUpdatedAt === null, 'her first own copy: version base is null (the old shared doc is not her doc)');
  wk.days[2].items[0].title = '只給 Annlin';
  const saved = Store.savePlanWeek('Annlin', W, wk);
  assert(saved && pushes.length === 1 && pushes[0].uid === 'Annlin' && pushes[0].wn === W && pushes[0].base === null, 'saved into Annlin\'s plan (pushed with her id)');
  assert(title('Annlin', W, 2) === '只給 Annlin' && title('Annlin', W, 1) === '舊共用課表改過' && Store.planSource(W, 'Annlin') === 'own', 'her copy = what she saw (old shared plan) + the change');
  assert(title('mick', W, 2) !== '只給 Annlin' && title('Phoebe', W, 2) !== '只給 Annlin', 'Mick and Phoebe unchanged');
  assert(saved.editedBy[2] === 'mick' && !saved.editedBy[1] && saved.userId === 'Annlin' && saved.updatedBy === 'mick', 'each changed day remembers who changed it');
  pushes.length = 0;
  App.swapPlanWeekDays(W, 3, 4);
  assert(pushes.length === 1 && pushes[0].uid === 'Annlin', 'coach drag-swap while planning Annlin changes Annlin');
  App.setWeeklyVolume(W, '20', '25');
  assert(Store.weekVolume(W, 'Annlin').goal.min === 20 && !Store.weekVolume(W, 'mick').goal, '目標跑量 is per person');
  const runDay = Store.effectiveWeek(W, 'Annlin').days.findIndex((d) => !d.selectOne && d.items.some((it) => fn('isRunType')(it.type)));
  const wk3 = App._cloneEffectiveWeek(W, 'Annlin');
  wk3.days[runDay].items = [{ id: 'x-rest', type: 'rest', title: '完全休息' }];
  Store.savePlanWeek('Annlin', W, wk3);
  assert(Store.weekTargetAuto(W, 'Annlin', { planOnly: true }).max < Store.weekTargetAuto(W, 'mick', { planOnly: true }).max, 'planned volume follows her own plan');

  // ── 還原：只還原她這一週，回到出廠（不是舊的共用課表）──
  pushes.length = 0;
  sandbox.confirm = (m) => { sandbox.__confirms.push(m); return true; };
  App.resetPlanWeek(W);
  assert(Store.planSource(W, 'Annlin') === 'reset' && title('Annlin', W, 1) === factory.days[1].items[0].title, 'reset goes back to the factory plan, not the old shared one');
  assert(Store.planSource(W, 'mick') === 'legacy' && pushes.length === 1 && pushes[0].uid === 'Annlin' && pushes[0].doc.isFactory === true, 'reset only touches her (writes a factory marker)');
  pushes[0].onFail();
  assert(Store.planSource(W, 'Annlin') === 'own' && title('Annlin', W, 2) === '只給 Annlin', 'a reset that could not be saved is rolled back');
  App.resetPlanWeek(W);
  const wk4 = App._cloneEffectiveWeek(W, 'Annlin');
  assert(wk4.__baseUpdatedAt === Store.planWeeks.Annlin[W].updatedAt, 'editing after a reset compares against the reset marker');
  const saved4 = Store.savePlanWeek('Annlin', W, wk4);
  assert(saved4 && !saved4.isFactory && Store.planSource(W, 'Annlin') === 'own' && Object.keys(saved4.editedBy).length === 0, 'saving after a reset: a normal copy again, nobody has edited any day');

  // ── 不是教練：只能改自己的 ──
  Store.activeUserId = 'Annlin';
  sandbox.__alerts.length = 0; pushes.length = 0;
  const mw = JSON.parse(JSON.stringify(Store.effectiveWeek(W, 'mick')));
  mw.days[0].items[0].title = 'Annlin 改 Mick';
  assert(Store.savePlanWeek('mick', W, mw) === null && pushes.length === 0 && sandbox.__alerts.some((m) => m.includes('只能改自己的課表')), 'non-coach cannot save someone else\'s plan');
  App.state.viewingUserId = 'mick';
  assert(App.planUserId() === 'mick' && !App._canEditPlan(), 'non-coach picking Mick in coach mode: read-only');
  App.swapPlanWeekDays(W, 3, 4);
  App.setWeeklyVolume(W, '1', '2');
  assert(pushes.length === 0, 'non-coach: drag-swap / 目標跑量 on someone else do nothing');
  App.state.viewingUserId = null;
  const own = App._cloneEffectiveWeek(W, 'Annlin');
  own.days[5].items[0].title = 'Annlin 自己改';
  assert(Store.savePlanWeek('Annlin', W, own) && pushes.length === 1 && pushes[0].uid === 'Annlin' && Store.planWeeks.Annlin[W].editedBy[5] === 'Annlin', 'non-coach saves her own plan (the day is stamped with her id)');
  assert(Store.saveLibraryDoc(null, 'item', { name: 'x', item: { type: 'run', title: 'x' } }) === null && !Store.canEditLibrary(), 'non-coach cannot add to the library');
  sandbox.__alerts.length = 0;
  App.startLibraryEdit('item', 'new');
  assert(App.state.libraryEdit === null && sandbox.__alerts.some((m) => m.includes('只有 Mick 能改')), 'non-coach: library editor does not open');
  Store.addGoal('幫 Mick 設', 'mick');
  assert(!(Store.goalsFor('mick') || { items: [] }).items.some((g) => g.text === '幫 Mick 設') && Store.canEditGoalsOf('Annlin'), 'non-coach cannot write someone else\'s goals (own still fine)');
  assert(Store.applyCopyPlan({ from: 'mick', to: 'Annlin', weeks: [{ weekNumber: W, days: [6], fields: [] }] }).weeks.length === 0, 'non-coach cannot copy plans');
  Store.activeUserId = 'mick';
  Store.addGoal('教練幫 Annlin 設', 'Annlin');
  assert(Store.goalsFor('Annlin').items.some((g) => g.text === '教練幫 Annlin 設'), 'coach can set Annlin\'s goals');

  // ── 複製：預覽（第 64 條：整週都複製，包含今天跟已經過去的日子；她自己對調過的週跳過、她自己改過的天）→ 確認 → 存 ──
  const edit = (uid, wn, fnEdit) => { const x = App._cloneEffectiveWeek(wn, uid); fnEdit(x); return Store.savePlanWeek(uid, wn, x); };
  edit('mick', TW, (x) => { x.days[TD].items[0].title = '今天 Mick'; if (TD < 6) x.days[TD + 1].items[0].title = '明天 Mick'; });
  edit('mick', F1, (x) => { x.days[0].items[0].title = 'F1 Mick'; });
  edit('mick', F3, (x) => { x.days[2].items[0].title = 'F3 Mick'; x.weeklyVolumeKm = { min: 30, max: 32 }; });
  Store.weekAdjustments.Annlin = { ...(Store.weekAdjustments.Annlin || {}), [F1]: { dayOrder: [1, 0, 2, 3, 4, 5, 6] } };
  const p = Store.copyPlanPreview('mick', 'Annlin', 'future', TW);
  const wTW = p.weeks.find((x) => x.weekNumber === TW), wW = p.weeks.find((x) => x.weekNumber === W), wF3 = p.weeks.find((x) => x.weekNumber === F3);
  assert(p.weeks.every((x) => x.weekNumber >= TW) && wTW && wTW.days.includes(TD), '「這週以後」starts at this week, and today is copied too (whole week, decision 64)');
  assert(TD === 6 || (wTW && wTW.days.includes(TD + 1)), 'tomorrow is copied');
  assert(p.skipped.includes(F1) && !p.weeks.some((x) => x.weekNumber === F1), 'her self-swapped week is skipped');
  assert(wW && wW.days.includes(1) && wW.days.includes(5) && p.ownEdited === 1, 'her own edit counts as 自己改過 (1 day)');
  assert(wF3 && wF3.days.includes(2) && wF3.fields.includes('weeklyVolumeKm') && p.goalChanged, '目標跑量 comes along');
  const expected = 1 + (TD < 6 ? 1 : 0) + 2 + 1; // 今天＋明天＋W 的兩天＋F3 的一天
  assert(p.changedDays === expected, `changed days counted (${p.changedDays} = ${expected})`);

  Sync.isSignedIn = () => true;
  Sync.planWeeksLoaded = () => true;
  let fetched = null;
  Sync.fetchCopyGuards = async (uid) => { fetched = uid; return true; };
  let msg = '';
  sandbox.confirm = (m) => { msg = m; return true; };
  App.state.viewingUserId = 'Annlin'; App.state.weekViewNumber = TW;
  const todayBefore = title('Annlin', TW, TD);
  await App.copyPlanFrom('mick', 'future');
  assert(fetched === 'Annlin', 'asks the server for her day swaps and records before copying');
  assert(msg.includes('把 Mick 的課表複製到 Annlin？') && msg.includes('整週都換（包含已經過去的日子跟今天）') && msg.includes(`會改 ${expected} 天；同一天名稱一樣的項目，打過的勾會留著。`), 'confirm says who → who, whole weeks, how many days');
  assert(msg.includes('Annlin 自己改過的 1 天會被蓋掉。') && msg.includes(`第 ${F1} 週 Annlin 自己對調過順序，這週跳過。`) && msg.includes('目標跑量也會換成 Mick 的。'), 'confirm warns about her own edits, skipped weeks and the goal');
  assert(title('Annlin', F3, 2) === 'F3 Mick' && Store.weekVolume(F3, 'Annlin').goal.min === 30 && title('Annlin', W, 5) === title('mick', W, 5) && title('Annlin', W, 1) === '舊共用課表改過', 'copied into her plan');
  assert(title('Annlin', TW, TD) === '今天 Mick' && todayBefore !== '今天 Mick' && (TD === 6 || title('Annlin', TW, TD + 1) === '明天 Mick'), 'today and tomorrow both copied');
  assert(title('Annlin', F1, 0) !== 'F1 Mick', 'skipped week untouched');
  assert(!!Store.planWeeks.Annlin[F3].layoutAt && Store.planWeeks.Annlin[F3].editedBy[2] === 'mick', 'copied weeks get a new layout stamp and the days are stamped as Mick\'s');
  assert(title('mick', F3, 2) === 'F3 Mick' && title('Phoebe', F3, 2) !== 'F3 Mick', 'source and third person untouched');
  const p2 = Store.copyPlanPreview('mick', 'Annlin', 'future', TW);
  assert(p2.weeks.length === 0 && p2.skipped.includes(F1), 'after copying there is nothing left to copy (except the skipped week)');
  sandbox.__alerts.length = 0;
  await App.copyPlanFrom('mick', 'future');
  assert(sandbox.__alerts.some((m) => m.includes('其他日子已經跟 Mick 一樣了') && m.includes(`第 ${F1} 週 Annlin 自己對調過順序`)), 'nothing to copy: says so (no confirm), and never calls the skipped week "the same"');
  // 只有跳過的那週不一樣（「這一週」選到她對調過的週）：只講跳過，不說「一樣了」
  edit('mick', F1, (x) => { x.days[6].items[0].title = 'F1 週日 Mick'; });
  App.state.weekViewNumber = F1;
  sandbox.__alerts.length = 0;
  await App.copyPlanFrom('mick', 'week');
  assert(sandbox.__alerts.length === 1 && sandbox.__alerts[0].includes('這週跳過，這次沒有複製') && !sandbox.__alerts[0].includes('一樣了') && title('Annlin', F1, 6) !== 'F1 週日 Mick', 'only the skipped week differs: says it was skipped, copies nothing');
  App.state.weekViewNumber = TW;
  edit('mick', F3, (x) => { x.days[3].items[0].title = '不要複製'; });
  sandbox.confirm = (m) => { sandbox.__confirms.push(m); return false; };
  await App.copyPlanFrom('mick', 'future');
  assert(title('Annlin', F3, 3) !== '不要複製', 'declined confirm copies nothing');
  sandbox.confirm = (m) => { sandbox.__confirms.push(m); return true; };
  // 已經過去的一週也複製得了（第 64 條：整週；以前「明天起」等於整週都不動）——真的複製一次，不是只看沒出現「明天」
  App.state.weekViewNumber = 1;
  edit('mick', 1, (x) => { x.days[2].items[0].title = '第一週週三 Mick'; });
  sandbox.__alerts.length = 0;
  sandbox.__confirms.length = 0;
  const beforePast = title('Annlin', 1, 2);
  await App.copyPlanFrom('mick', 'week');
  assert(beforePast !== '第一週週三 Mick' && title('Annlin', 1, 2) === '第一週週三 Mick', 'a past week is really copied, day by day (decision 64: whole week)');
  assert(sandbox.__confirms.slice(-1)[0].includes('整週都換（包含已經過去的日子）') && !sandbox.__confirms.slice(-1)[0].includes('明天'), 'and the confirm says the range as it really is');
  Sync.isSignedIn = () => false;
  sandbox.__alerts.length = 0;
  await App.copyPlanFrom('mick', 'future');
  assert(sandbox.__alerts.some((m) => m.includes('要先登入')), 'copy needs sign-in');
  Sync.isSignedIn = () => true;
  Sync.fetchCopyGuards = async () => false;
  sandbox.__alerts.length = 0;
  await App.copyPlanFrom('mick', 'future');
  assert(sandbox.__alerts.some((m) => m.includes('沒有連上網路')) && title('Annlin', F3, 3) !== '不要複製', 'offline: no copy (her swaps could not be checked)');
  Sync.fetchCopyGuards = async () => true;

  // ── 畫面：教練排 Annlin ──
  Sync.user = { email: 'x@example.com' }; Sync.detectedUserId = 'mick';
  Sync.subscribeOtherEntries = () => {}; Sync.subscribeOtherWeekAdjustments = () => {}; Sync.subscribeOtherProfile = () => {};
  App.state.viewingUserId = 'Annlin'; App.state.weekViewNumber = F1; App.state.viewMenuOpen = false;
  const page = fn('renderWeekPage')(App.state);
  assert(page.includes('本週課表設定') && page.includes('class="drag-handle"') && page.includes('data-coach="1"') && !page.includes('正在看 Annlin・唯讀'), 'coach planning Annlin: plan tools and drag handles, not the read-only view');
  assert(page.includes('Annlin 的課表</b>') && page.includes('Annlin 這週自己換過順序') && page.includes('週一做週二的課'), 'hint names her plan and mentions her own swap');
  assert(fn('renderApp')(App.state).includes('這裡改的是 Annlin 的課表'), 'banner: 這裡改的是 Annlin 的課表');
  App.state.viewMenuOpen = true;
  const menu = fn('renderWeekPage')(App.state);
  assert(menu.includes('排 Annlin 的課表') && menu.includes('排自己的課表') && menu.includes('把別人的課表複製給 Annlin（整週）') && /第 \d+ 週以後/.test(menu), 'name menu = whose plan; copy section for Annlin (the 「以後」 button says which week it starts at)');
  assert(menu.includes(`A.copyPlanFrom('mick','week')`) && menu.includes(`A.copyPlanFrom('Phoebe','future')`) && !menu.includes(`A.copyPlanFrom('Annlin'`), 'copy from Mick or Phoebe (never from herself)');
  App.state.viewMenuOpen = false;
  App.state.expandedDay = { weekNumber: F1, dayIndex: 6 };
  const body = fn('renderDayBody')(F1, 6, 'Annlin');
  assert(body.includes('A.toggleItemPicker(') && !/<button type="button" class="item-check"[^>]*onclick=/.test(body), 'her day: coach tools, but her ticks are not clickable here');
  const goalsA = fn('renderGoalsCard')('Annlin', false, PlanData.userById.Annlin);
  assert(goalsA.includes('goal-input'), 'coach mode: Mick can edit Annlin\'s goals');

  // ── 畫面：Annlin 自己（不是教練）──
  Store.activeUserId = 'Annlin'; Sync.detectedUserId = 'Annlin';
  App.state.viewingUserId = null; App.state.weekViewNumber = W; App.state.viewMenuOpen = true;
  App.state.expandedDay = { weekNumber: W, dayIndex: 6 };
  const aPage = fn('renderWeekPage')(App.state);
  assert(aPage.includes('本週課表設定') && aPage.includes('排自己的課表') && aPage.includes('看每天的紀錄（唯讀）') && !aPage.includes('copy-sec'), 'non-coach in coach mode: plans herself; others read-only; no copy');
  assert(fn('renderApp')(App.state).includes('這裡改的是 Annlin 的課表'), 'her banner says her own plan');
  const aBody = fn('renderDayBody')(W, 6, 'Annlin');
  App.state.itemPicker = { weekNumber: W, dayIndex: 6, itemId: 'add' };
  const aPick = fn('renderDayBody')(W, 6, 'Annlin');
  App.state.itemPicker = null;
  assert(!aBody.includes('存成常用') && !aPick.includes('到項目庫新增或修改') && !aBody.includes('編輯這份動作清單'), 'non-coach: no 存成常用 / library editing links');
  const aSettings = fn('renderSettingsPage')(App.state);
  assert(!aSettings.includes('常用項目庫 <span') && aSettings.includes('直接調整你自己的課表'), 'non-coach settings: no library panel');
  const goalsM = fn('renderGoalsCard')('mick', false, PlanData.userById.mick);
  assert(!goalsM.includes('goal-input'), 'non-coach in coach mode cannot edit Mick\'s goals');
  const ptM = fn('renderPhaseTargetsCard')(PlanData.phaseForWeek(TW), 'mick', false, PlanData.userById.mick, App.state);
  assert(!ptM.includes('savePhaseTargets'), 'non-coach cannot edit Mick\'s phase targets');
  App.state.viewMenuOpen = false;
  Store.activeUserId = 'mick'; Sync.detectedUserId = 'mick';

  // ── Sync：存到 users/{userId}/planWeeks/{週}，版本比對；規則還沒發布時不登出 ──
  sandbox.__remote = {};
  vm.runInContext(`fbDb = {
    collection: (p) => ({ doc: (id) => ({ path: p + '/' + id, get: () => Promise.resolve(globalThis.__remote[p + '/' + id] ? { exists: true, data: () => globalThis.__remote[p + '/' + id] } : { exists: false }) }) }),
    runTransaction: (f) => f({ get: (ref) => ref.get(), set: (ref, data) => { globalThis.__remote[ref.path] = data; } }),
  }`, sandbox);
  Sync.state = 'done';
  Sync.pushPlanWeek('Annlin', 9, { weekNumber: 9, updatedAt: 'A' }, null);
  await tick(); await tick();
  assert(sandbox.__remote['users/Annlin/planWeeks/9'] && sandbox.__remote['users/Annlin/planWeeks/9'].updatedAt === 'A', 'writes users/Annlin/planWeeks/9');
  assert(Store._planCloudAt['Annlin:9'] === 'A', 'a successful write becomes the cloud-confirmed version (decision 64)');
  // 別人（別台）先存了 X，這台還不知道：比對基準是雲端確認過的 A，雲端卻是 X → 擋下
  sandbox.__remote['users/Annlin/planWeeks/9'] = { weekNumber: 9, updatedAt: 'X' };
  sandbox.__alerts.length = 0;
  Sync.pushPlanWeek('Annlin', 9, { weekNumber: 9, updatedAt: 'B' }, 'A');
  await tick(); await tick(); await tick();
  assert(sandbox.__remote['users/Annlin/planWeeks/9'].updatedAt === 'X' && sandbox.__alerts.some((m) => m.includes('Annlin 的第 9 週剛被別人改過')), 'someone else saved first: refused, and a pop-up says whose week (decision 64)');
  let signedOut = false;
  vm.runInContext('fbAuth = { signOut: () => { globalThis.__signedOut = true; } }', sandbox);
  Sync.state = 'done';
  Sync._handleSnapErr({ code: 'permission-denied' }, 'planWeeks', 'Annlin');
  signedOut = !!sandbox.__signedOut;
  assert(Sync.planWeeksDenied && !signedOut && Sync.state === 'done', 'plan rules not published yet: flag it, do not sign out');
  assert(!!Sync._planRetryTimer, 'and try again by itself a minute later');
  clearTimeout(Sync._planRetryTimer); Sync._planRetryTimer = null; // 測試不等那一分鐘
  Store.coachMode = true; App.state.viewingUserId = null; App.state.weekViewNumber = W;
  assert(fn('renderWeekPage')(App.state).includes('課表的新規則還沒發布'), 'coach sees the publish-the-rules banner');
  assert(Sync._planDeniedMsg('Annlin').includes('firestore.rules.local'), 'write denied (coach): tells her to republish the rules');
  Sync.planWeeksDenied = false;
  // 第一個快照一次送來好幾週：全部收完只重畫一次（不是一週一次）
  Sync.planWeeksLoaded = realPlanWeeksLoaded;
  let notifies = 0;
  const origNotify = Store._notify;
  Store._notify = () => { notifies++; };
  vm.runInContext(`fbDb = { collection: (p) => ({ onSnapshot: (a, b) => { (globalThis.__snapCbs = globalThis.__snapCbs || {})[p] = typeof a === 'function' ? a : b; return () => {}; } }) }`, sandbox);
  Sync._attachPlanWeeks();
  const snapFor = (ids, fromCache) => ({ metadata: { fromCache: !!fromCache }, docChanges: () => ids.map((id) => ({ type: 'added', doc: { id: String(id), data: () => ({ weekNumber: id, userId: 'Phoebe', updatedAt: 'x' }) } })) });
  sandbox.__snapCbs['users/Phoebe/planWeeks'](snapFor([20, 21, 22], true));
  assert(notifies === 1 && ['mick', 'Annlin', 'Phoebe'].every((u) => sandbox.__snapCbs[`users/${u}/planWeeks`]) && Store.planWeeks.Phoebe[20] && Store.planWeeks.Phoebe[22], 'listens to all three plans; a snapshot with several weeks re-draws once');
  // 複製課表拿「讀到了沒」判斷來源是不是最新的：離線快取那份不算，伺服器確認過才算；訂閱斷了就不算（審查抓到）
  assert(!Sync.planWeeksLoaded('Phoebe'), 'a cached snapshot does not count as loaded');
  sandbox.__snapCbs['users/Phoebe/planWeeks'](snapFor([], false));
  assert(Sync.planWeeksLoaded('Phoebe'), 'the server-confirmed snapshot does');
  Sync._handleSnapErr({ code: 'unavailable', message: 'x' }, 'planWeeks', 'Phoebe');
  assert(!Sync.planWeeksLoaded('Phoebe') && Sync.state === 'fail', 'after a listener error it no longer counts as loaded, and the error is visible');
  clearTimeout(Sync._planRetryTimer); Sync._planRetryTimer = null; Sync.state = 'done';
  Store._notify = origNotify;
  Sync._detachPlanWeeks();

  // ── 她已經先記了東西的日子（例如預先選了休息）：照教練的課表換，但確認畫面一天一天點名
  //   （以前是整天不動，結果她那邊還是舊的「或」——使用者：「你怎麼沒有照我排的課表排？」）──
  Store.activeUserId = 'mick'; Store.coachMode = true;
  Sync.planWeeksLoaded = () => true; // 這段假設兩邊的課表都讀到了（讀到了沒的判斷上面測過）
  const sel = (() => {
    for (let wn = TW + 4; wn <= PlanData.plan.totalWeeks; wn++) {
      const di = Store.effectiveWeek(wn, 'Annlin').days.findIndex((d) => d.selectOne && d.items.some((it) => it.type === 'rest'));
      if (di >= 0) return { wn, di };
    }
    return null;
  })();
  assert(!!sel, 'test setup: a future 二擇一 day with a rest option');
  if (sel) {
    const restId = Store.effectiveWeek(sel.wn, 'Annlin').days[sel.di].items.find((it) => it.type === 'rest').id;
    const key = PlanData.keyForWeekDay(sel.wn, sel.di);
    Store.mergeRemoteEntry('Annlin', key, { done: { [restId]: true }, selectedItemId: restId, status: null, updatedAt: '2026-09-22T08:00:00.000Z', fieldAt: {} });
    assert(Store.dayStatus(sel.wn, sel.di, 'Annlin') === 'done', 'test setup: she pre-picked rest on that day');
    edit('mick', sel.wn, (x) => { x.days[sel.di] = { ...x.days[sel.di], selectOne: false, items: [{ id: 'x-run', type: 'run', title: '輕鬆跑', duration: { min: 30, max: 30 } }] }; });
    const pk = Store.copyPlanPreview('mick', 'Annlin', 'week', sel.wn);
    const wk = pk.weeks.find((x) => x.weekNumber === sel.wn);
    assert(pk.lost.length === 1 && pk.lost[0].dayIndex === sel.di && pk.lost[0].picked.length === 1 && wk && wk.days.includes(sel.di), 'her pre-picked day is copied too, and her lost pick is named');
    msg = '';
    sandbox.confirm = (m) => { msg = m; return false; };
    App.state.viewingUserId = 'Annlin'; App.state.weekViewNumber = sel.wn;
    await App.copyPlanFrom('mick', 'week');
    assert(msg.includes(`第 ${sel.wn} 週週${PlanData.weekdayLabel(sel.di)}`) && msg.includes('Annlin 先選的「') && msg.includes('不在 Mick 的課表裡，會換成 Mick 的內容'), 'the confirm names that day (week and weekday) and what she had picked, before copying');
    assert(Store.effectiveWeek(sel.wn, 'Annlin').days[sel.di].selectOne && Store.dayStatus(sel.wn, sel.di, 'Annlin') === 'done', 'declined: her day stays as it was');
    sandbox.confirm = (m) => { sandbox.__confirms.push(m); return true; };
    await App.copyPlanFrom('mick', 'week');
    const after = Store.effectiveWeek(sel.wn, 'Annlin').days[sel.di];
    assert(!after.selectOne && after.items[0].title === '輕鬆跑', "confirmed: the day follows the coach's plan (no leftover 「或」)");
  }
  // 第 64 條：整週複製時，同一天名稱＋類型一樣的項目沿用她原本的 id——打過的勾留著；對不上的換新 id（勾不會套到別的項目上）
  {
    const dKey = PlanData.keyForWeekDay(TW, TD);
    const aItem = Store.effectiveWeek(TW, 'Annlin').days[TD].items[0];
    Store.mergeRemoteEntry('Annlin', dKey, { done: { [aItem.id]: true }, selectedItemId: null, status: null, updatedAt: '2026-09-22T09:00:00.000Z', fieldAt: {} });
    edit('mick', TW, (x) => { x.days[TD].items[0] = { ...x.days[TD].items[0], title: aItem.title, type: aItem.type, coachNote: 'Mick 改了時間' }; });
    const pk = Store.copyPlanPreview('mick', 'Annlin', 'week', TW);
    assert(!pk.lost.some((x) => x.weekNumber === TW && x.dayIndex === TD), 'same name and type: her tick is not listed as lost');
    Store.applyCopyPlan(pk);
    const nowItem = Store.effectiveWeek(TW, 'Annlin').days[TD].items[0];
    assert(nowItem.id === aItem.id && nowItem.coachNote === 'Mick 改了時間' && Store.entryFor('Annlin', dKey).done[aItem.id] === true, 'copied today: same item keeps her id, so her tick stays; the coach note comes from Mick');
    edit('mick', TW, (x) => { x.days[TD].items[0] = { ...x.days[TD].items[0], title: '別的項目', type: 'recovery' }; });
    const pk2 = Store.copyPlanPreview('mick', 'Annlin', 'week', TW);
    assert(pk2.lost.some((x) => x.dayIndex === TD && x.ticked.includes(aItem.title)), 'a different item: her tick is named as lost in the confirm');
    Store.applyCopyPlan(pk2);
    assert(Store.effectiveWeek(TW, 'Annlin').days[TD].items[0].id !== aItem.id, 'and the new item gets a new id (her old tick does not jump onto it)');
  }
  // 兩邊的課表還沒讀到（或規則還沒發布）：不複製
  Sync.planWeeksLoaded = (uid) => uid !== 'mick';
  sandbox.__alerts.length = 0;
  App.state.weekViewNumber = F3;
  await App.copyPlanFrom('mick', 'future');
  assert(sandbox.__alerts.some((m) => m.includes('課表還沒讀完')), 'source plan not loaded yet: no copy');
  Sync.planWeeksLoaded = () => true;
  Sync.planWeeksDenied = true;
  sandbox.__alerts.length = 0;
  await App.copyPlanFrom('mick', 'future');
  assert(sandbox.__alerts.some((m) => m.includes('課表還沒讀完')), 'new rules not published: no copy');
  Sync.planWeeksDenied = false;

  // ── 審查 2：連續存同一週要排隊（第二筆不能被誤判成「別人改過」），寫進去之前雲端的舊版不蓋掉畫面 ──
  const W2 = F3 + 1;
  sandbox.__remote2 = {};
  vm.runInContext(`fbDb = {
    collection: (p) => ({ doc: (id) => ({ path: p + '/' + id, get: () => new Promise((r) => setTimeout(() => r(globalThis.__remote2[p + '/' + id] ? { exists: true, data: () => globalThis.__remote2[p + '/' + id] } : { exists: false }), 5)) }) }),
    runTransaction: (f) => { const w = []; return f({ get: (ref) => ref.get(), set: (ref, d) => w.push([ref.path, d]) }).then(() => new Promise((r) => setTimeout(() => { w.forEach(([p, d]) => { globalThis.__remote2[p] = d; }); r(); }, 25))); },
  }`, sandbox);
  const v0 = { ...JSON.parse(JSON.stringify(PlanData.week(W2))), weekNumber: W2, userId: 'Phoebe', updatedAt: '2026-09-20T00:00:00.000Z', editedBy: {} };
  sandbox.__remote2[`users/Phoebe/planWeeks/${W2}`] = JSON.parse(JSON.stringify(v0));
  Store.planWeeks.Phoebe = { ...(Store.planWeeks.Phoebe || {}), [W2]: JSON.parse(JSON.stringify(v0)) };
  Sync.isSignedIn = () => true; Sync.state = 'done'; Sync.failedWrites.clear();
  Store._cloudPushPlanWeek = Sync.pushPlanWeek.bind(Sync);
  App.state.viewingUserId = 'Phoebe'; App.state.weekViewNumber = W2;
  const a1 = App._cloneEffectiveWeek(W2, 'Phoebe'); a1.days[3].items[0].title = '第一下';
  Store.savePlanWeek('Phoebe', W2, a1);
  const a2 = App._cloneEffectiveWeek(W2, 'Phoebe'); a2.days[4].items[0].title = '第二下';
  const s2 = Store.savePlanWeek('Phoebe', W2, a2);
  Store.mergeRemotePlanWeek('Phoebe', W2, JSON.parse(JSON.stringify(v0))); // 第一筆還沒寫完，雲端送來舊的那份
  assert(title('Phoebe', W2, 3) === '第一下' && title('Phoebe', W2, 4) === '第二下', 'an older cloud copy does not overwrite what she just changed');
  await new Promise((r) => setTimeout(r, 200));
  const remoteNow = sandbox.__remote2[`users/Phoebe/planWeeks/${W2}`];
  assert(remoteNow.updatedAt === s2.updatedAt && remoteNow.days[3].items[0].title === '第一下' && remoteNow.days[4].items[0].title === '第二下', 'two quick saves both reach the cloud, in order');
  assert(!sandbox.__alerts.some((m) => m.includes('剛被別人改過')) && !Store.planDirty('Phoebe', W2) && !Store.planSyncing(), 'no false "someone else changed it"; nothing left unsaved or in flight');
  Store.mergeRemotePlanWeek('Phoebe', W2, JSON.parse(JSON.stringify(remoteNow)));
  assert(title('Phoebe', W2, 4) === '第二下', 'after it landed, the cloud copy is accepted again');
  Store._cloudPushPlanWeek = fakePush;

  // ── 審查 4：不是教練的人被拒時，請教練發布規則（不是叫她去貼只在教練電腦上的檔案）──
  Store.activeUserId = 'Annlin';
  const nonCoachMsg = Sync._planDeniedMsg('Annlin');
  assert(nonCoachMsg.includes('請 Mick 重新發布') && !nonCoachMsg.includes('firestore.rules.local') && !nonCoachMsg.includes('再改一次'), 'non-coach denied: asks Mick to publish the rules (and does not tell her to redo the edit — it auto-retries now)');
  Store.activeUserId = 'mick';
  Sync.state = 'done'; Sync.failedWrites.clear();

  // ── 規則裡的教練＝users.json 的教練；新規則的三段 ──
  const coaches = map['users.json'].users.filter((u) => u.coach);
  assert(coaches.length === 1, 'exactly one coach in users.json');
  const blockOf = (src, head) => {
    const m = src.match(new RegExp(head.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
    return m ? m[1] : '';
  };
  ['firestore.rules', 'firestore.rules.local'].forEach((f) => {
    if (!fs.existsSync(path + '/' + f)) { console.log(`SKIP: ${f} 不在這台（本機限定檔）`); return; }
    const r = fs.readFileSync(path + '/' + f, 'utf8');
    const m = r.match(/function isCoach\(\)\s*\{\s*return isSelf\('([^']+)'\);\s*\}/);
    assert(!!m && m[1] === coaches[0].userId, `${f}: isCoach() is '${coaches[0].userId}', same as users.json`);
    assert(/allow write: if isSelf\(userId\) \|\| isCoach\(\);/.test(blockOf(r, 'match /users/{userId}/planWeeks/{week}')), `${f}: plans — self or coach`);
    assert(/allow write: if false;/.test(blockOf(r, 'match /planOverrides/{weekNumber}')) && /allow read:\s+if isMember\(\);/.test(blockOf(r, 'match /planOverrides/{weekNumber}')), `${f}: old shared plan read-only`);
    assert(/allow write: if isCoach\(\);/.test(blockOf(r, 'match /library/{docId}')), `${f}: library — coach only`);
    assert(/allow write: if isSelf\(userId\) \|\| isCoach\(\);/.test(blockOf(r, 'match /users/{userId}/profile/{doc}')), `${f}: goals — self or coach`);
  });
})();
