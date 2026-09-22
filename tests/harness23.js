// 決策紀錄第 57 條：教練在對話裡給的整週課表（data/week-presets.json）一鍵排進某個人的那一週
const fs = require('fs');
const vm = require('vm');
const path = require('path').resolve(__dirname, '..'); // repo 根目錄
const load = (f) => JSON.parse(fs.readFileSync(path + '/data/' + f));
const map = { 'plan.json': load('plan.json'), 'videos.json': load('videos.json'), 'workouts.json': load('workouts.json'), 'users.json': load('users.json'), 'week-presets.json': load('week-presets.json') };
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
  Store.activeUserId = 'mick'; Store.init(); Store._cloudPush = () => {}; Store._cloudPushLibrary = () => {};
  const pushes = [];
  Store._cloudPushPlanWeek = (uid, wn, doc) => pushes.push({ uid, wn, doc });
  Sync.user = { email: 'x@example.com' }; Sync.detectedUserId = 'mick';
  Sync.subscribeOtherEntries = () => {}; Sync.subscribeOtherWeekAdjustments = () => {}; Sync.subscribeOtherProfile = () => {};
  const preset = PlanData.weekPresets.find((p) => p.id === '2026-09-21');
  assert(!!preset && preset.weekNumber === 3 && preset.days.length === 7 && preset.users == null, 'the 9/21 week loads from data/week-presets.json (no users restriction: she wants it for herself too, not just Annlin/Phoebe)');
  const WN = preset.weekNumber;
  const titles = (uid, di) => Store.effectiveWeek(WN, uid).days[di].items.map((it) => it.title).join('+');
  const expected = preset.days.map((keys) => keys.map((k) => preset.items[k].title).join('+'));

  // 她庫裡原本就有自己的「Zone 2 跑」（帶熱身影片）——要沿用那份
  const myZ2 = Store.saveLibraryDoc(null, 'item', { name: 'Zone 2 跑', item: { type: 'run', title: 'Zone 2 跑', duration: { min: 25, max: 30 }, heartRateZone: 'Zone 2', videoRefs: ['pamela-daily-stretch'], videoRef: 'pamela-daily-stretch' } });
  const libBefore = Store.libraryList('item').length;
  // 這份整週給誰都能排（第一次她只給 Annlin、Phoebe；後來看了自己的畫面說「完全忠實呈現我排的課表」，三個人共用同一份）。Annlin 週一做了原本的課、週二的 Zone 2 跑也打了勾
  const monKey = PlanData.keyForWeekDay(WN, 0), tueKey = PlanData.keyForWeekDay(WN, 1);
  const monOld = Store.effectiveWeek(WN, 'Annlin').days[0].items[0], tueOld = Store.effectiveWeek(WN, 'Annlin').days[1].items[0];
  Store.mergeRemoteEntry('Annlin', monKey, { done: { [monOld.id]: true }, status: null, selectedItemId: null, updatedAt: '2026-09-21T10:00:00.000Z', fieldAt: {} });
  Store.mergeRemoteEntry('Annlin', tueKey, { done: { [tueOld.id]: true }, status: null, selectedItemId: null, updatedAt: '2026-09-22T10:00:00.000Z', fieldAt: {} });
  const mickBefore = [0, 1, 2, 3, 4, 5, 6].map((di) => titles('mick', di));

  // ── 畫面：只有教練、只有那一週、只有排給的那個人有按鈕 ──
  Store.coachMode = true;
  App.state.page = 'week'; App.state.weekViewNumber = WN;
  App.viewWeekOf('Annlin');
  const panelA = fn('renderWeekCoachPanel')(WN, Store.effectiveWeek(WN, 'Annlin'), false, 'Annlin');
  assert(panelA.includes('9/21 那週') && panelA.includes(`A.applyWeekPreset('2026-09-21')`) && panelA.includes('排進 Annlin 這週'), 'planning Annlin: the whole-week button');
  // 沒有 users 限制：排 Mick 自己的課表時也看得到同一顆按鈕（她看了自己的畫面後說要「完全忠實呈現」）
  const panelM = fn('renderWeekCoachPanel')(WN, Store.effectiveWeek(WN, 'mick'), false, 'mick');
  assert(panelM.includes('9/21 那週') && panelM.includes(`A.applyWeekPreset('2026-09-21')`) && panelM.includes('排進 Mick 這週'), 'planning Mick: the same whole-week button (no users restriction)');
  assert(!fn('renderWeekCoachPanel')(WN + 1, Store.effectiveWeek(WN + 1, 'Annlin'), false, 'Annlin').includes('預先排好的課表'), 'other weeks: no button');

  // ── 不按確定：什麼都不變 ──
  sandbox.confirm = () => false;
  App.applyWeekPreset('2026-09-21');
  assert(titles('Annlin', 0) === monOld.title && Store.libraryList('item').length === libBefore && pushes.length === 0, 'declined: nothing changes, nothing added to the library');

  // ── 排進 Annlin ──
  let msg = '';
  sandbox.confirm = (m) => { msg = m; return true; };
  App.applyWeekPreset('2026-09-21');
  assert(msg.includes('把「9/21 那週」排進 Annlin 第 3 週？') && msg.includes('包含已經過去的日子跟今天'), 'confirm: whose week, and that past days are included');
  assert(msg.includes('常用項目庫會加上：完全休息、盆底肌內核呼吸練習、伸展') && msg.includes('用常用項目庫裡的：Zone 2 跑'), 'confirm: which items get added to the library, which come from it');
  assert(msg.includes(`打過勾的「${monOld.title}」不在新的課表裡`) && !msg.includes(`「${tueOld.title}」不在`), 'confirm: the Monday tick that disappears is named; the kept Zone 2 tick is not');
  assert(expected.every((t, di) => titles('Annlin', di) === t), 'all seven days are exactly as written (Monday included)');
  const w = Store.effectiveWeek(WN, 'Annlin');
  assert(w.days.every((d, di) => d.dayIndex === di && d.selectOne === false && d.dayNotes === null) && !!w.layoutAt, 'no 二擇一 (no 「或」), old day notes cleared, layout stamped');
  const tue = w.days[1].items.find((it) => it.title === 'Zone 2 跑');
  assert(tue.id === tueOld.id && Store.entryFor('Annlin', tueKey).done[tue.id] === true, 'Tuesday keeps the same Zone 2 item id, so her tick stays');
  assert(tue.templateId === myZ2.id && JSON.stringify(tue.duration) === JSON.stringify({ min: 25, max: 30 }) && PlanData.itemVideoRefs(tue).includes('pamela-daily-stretch'), 'Zone 2 uses the library version (time, warm-up video) and stays linked to it');
  const stretch = w.days[0].items.find((it) => it.title === '伸展');
  const v = Store.videoFor(PlanData.itemVideoRefs(stretch)[0]);
  assert(v && v.linkType === 'video' && v.url.startsWith('https://www.youtube.com/watch?v=g_tea8ZNk5A') && v.creator === 'Mady Morrison', 'stretch links to the video she sent');
  // 「+ 就是一起、和的意思，不是二選一，也不是或」：週一休息＋呼吸＋伸展，呼吸跟伸展是要做的
  const monCard = fn('renderReadOnlyDay')(WN, 0, w.days[0], null, 'Annlin');
  assert(!fn('isRestOnlyDay')(w.days[0]) && !monCard.includes('選做') && !monCard.includes('或'), 'Monday is rest + breathing + stretch, all together (no 選做, no 或)');
  const lib = Store.libraryList('item');
  const addedTitles = ['完全休息', '盆底肌內核呼吸練習', '伸展', '腿臀', '胸背', '臀核心', '核心', '背', '間歇跑'];
  assert(lib.length === libBefore + addedTitles.length && addedTitles.every((t) => lib.filter((x) => x.item.title === t).length === 1) && lib.filter((x) => x.item.title === 'Zone 2 跑').length === 1, 'library gains exactly the new items once each; Zone 2 not duplicated');
  assert(w.days.every((d) => d.items.every((it) => !!it.templateId)), 'every item is linked to its library item (later library edits follow)');
  assert(pushes.length === 1 && pushes[0].uid === 'Annlin' && pushes[0].wn === WN, "saved into Annlin's plan");
  assert([0, 1, 2, 3, 4, 5, 6].every((di) => titles('mick', di) === mickBefore[di]) && titles('Phoebe', 2) !== expected[2], 'Mick and Phoebe untouched');
  const html = fn('renderDayBody')(WN, 0, 'Annlin');
  assert(html.includes('https://www.youtube.com/watch?v=g_tea8ZNk5A') && html.includes('伸展'), 'the day renders with the stretch video link');

  // ── 再排進 Phoebe：庫裡都有了，全部沿用、不再新增 ──
  App.viewWeekOf('Phoebe');
  const libNow = Store.libraryList('item').length;
  msg = '';
  App.applyWeekPreset('2026-09-21');
  assert(!msg.includes('常用項目庫會加上') && msg.includes('排進 Phoebe 第 3 週') && Store.libraryList('item').length === libNow, 'second person: everything comes from the library, nothing added');
  assert(expected.every((t, di) => titles('Phoebe', di) === t) && pushes[pushes.length - 1].uid === 'Phoebe', "Phoebe's week is now the same, in her own plan");

  // ── Mick 自己那週：一開始她只說改週一，後來看了自己的畫面說「修改更新不正確……完全忠實呈現我排的課表」——
  //   跟 Annlin、Phoebe 同一份，七天全部照排，不是只改週一 ──
  App.viewWeekOf(null);
  const libBeforeMick = Store.libraryList('item').length;
  msg = '';
  App.applyWeekPreset('2026-09-21');
  assert(msg.includes('把「9/21 那週」排進 Mick 第 3 週？') && msg.includes('週一到週日七天全部照這份排，包含已經過去的日子跟今天'), 'confirm: all seven days, not just Monday');
  assert(!msg.includes('常用項目庫會加上') && Store.libraryList('item').length === libBeforeMick, "third person: everything's already in the library, nothing added");
  assert(expected.every((t, di) => titles('mick', di) === t) && pushes[pushes.length - 1].uid === 'mick', "Mick's own week now matches exactly what she wrote, replacing her old plan");
  // 週一是「休息＋呼吸＋伸展」，不是單獨的休息日：呼吸跟伸展要打勾、算完成率（第 55 條：「+」是一起做）
  const mickMon = Store.effectiveWeek(WN, 'mick').days[0];
  assert(!fn('isRestOnlyDay')(mickMon) && mickMon.items.length === 3, "her Monday is rest + breathing + stretch together, not a rest-only day");

  // ── 不是教練：沒有按鈕，也排不了 ──
  Store.activeUserId = 'Annlin';
  App.state.viewingUserId = null;
  assert(!fn('renderWeekCoachPanel')(WN, Store.effectiveWeek(WN, 'Annlin'), true, 'Annlin').includes('預先排好的課表'), 'non-coach: no button');
  sandbox.__alerts.length = 0;
  const before = pushes.length;
  App.applyWeekPreset('2026-09-21');
  assert(pushes.length === before && sandbox.__alerts.some((m) => m.includes('只有 Mick 能改')), 'non-coach: cannot apply');
  Store.activeUserId = 'mick';

  // ── 第二輪審查 ──
  const realFetchCopyGuards = Sync.fetchCopyGuards; // 下面第 5 段會先換成假的
  // 同一份課表放到兩週後（測試不管哪天跑，那週都在未來）
  const TW = PlanData.locateToday().weekNumber;
  const FW = Math.min(TW + 2, PlanData.plan.totalWeeks);
  const test = JSON.parse(JSON.stringify(preset));
  test.id = 'test-future'; test.weekNumber = FW; test.name = '測試週';
  PlanData.weekPresets.push(test);
  App.viewWeekOf('Phoebe');
  App.state.weekViewNumber = FW;
  const ftitles = (di) => Store.effectiveWeek(FW, 'Phoebe').days[di].items.map((it) => it.title).join('+');
  // 1. 沒登入：不排（庫是空的，會把她自己的項目當成沒有、另外新增）
  const syncUser = Sync.user;
  Sync.user = null;
  sandbox.__alerts.length = 0;
  const libN = Store.libraryList('item').length, pushN = pushes.length;
  App.applyWeekPreset('test-future');
  assert(sandbox.__alerts.some((m) => m.includes('要先登入')) && Store.libraryList('item').length === libN && pushes.length === pushN, 'signed out: refuses, adds nothing to the library');
  // 沒登入時存的課表只在這台：不能留下「還在路上」的記號，不然登入後雲端的這週一直被擋
  Store._cloudPushPlanWeek = Sync.pushPlanWeek.bind(Sync);
  const lw = App._cloneEffectiveWeek(FW, 'Phoebe'); lw.days[0].items[0].title = '沒登入時改的';
  Store.savePlanWeek('Phoebe', FW, lw);
  assert(!Store._planPending[`Phoebe:${FW}`], 'signed-out save leaves no pending mark');
  Store.mergeRemotePlanWeek('Phoebe', FW, { ...JSON.parse(JSON.stringify(PlanData.week(FW))), weekNumber: FW, userId: 'Phoebe', updatedAt: '2026-09-23T00:00:00.000Z' });
  assert(ftitles(0) === PlanData.week(FW).days[0].items.map((it) => it.title).join('+'), 'after signing in, the cloud copy of that week is accepted');
  Store._cloudPushPlanWeek = (uid, wn, doc) => pushes.push({ uid, wn, doc });
  Sync.user = syncUser;
  // 2. 名稱一樣、類型不一樣的庫存項目不能拿來用（週一的休息日不能變成要做肌力）
  const wrongStretch = Store.saveLibraryDoc(null, 'item', { name: '呼吸', item: { type: 'muscle', title: '盆底肌內核呼吸練習', duration: { min: 20, max: 20 } } });
  const tp = Store.presetTemplates(test);
  assert(tp.templates.breath && tp.templates.breath.item.type === 'recovery' && tp.templates.breath.id !== wrongStretch.id, 'library match needs the same name AND type');
  // 3. 明天以後她已經先記了東西的日子（例如先選了休息）也照排——以前整天不動，結果還是舊的「或」
  //   （使用者：「你怎麼沒有照我排的課表排？……不要擅自改成或」）；確認畫面照日期講會換掉什麼；本週已降量也講
  const sunOld = Store.effectiveWeek(FW, 'Phoebe').days[6];
  const restOpt = sunOld.items.find((it) => it.type === 'rest');
  const sunKey = PlanData.keyForWeekDay(FW, 6);
  if (restOpt) Store.mergeRemoteEntry('Phoebe', sunKey, { done: { [restOpt.id]: true }, selectedItemId: sunOld.selectOne ? restOpt.id : null, status: null, updatedAt: '2026-09-22T09:00:00.000Z', fieldAt: {} });
  else Store.mergeRemoteEntry('Phoebe', sunKey, { done: {}, selectedItemId: null, status: 'rested', updatedAt: '2026-09-22T09:00:00.000Z', fieldAt: {} });
  Store.weekAdjustments.Phoebe = { ...(Store.weekAdjustments.Phoebe || {}), [FW]: { reduced: true } };
  let m2 = '';
  sandbox.confirm = (m) => { m2 = m; return true; };
  App.applyWeekPreset('test-future');
  const sd = PlanData.dateForWeekDay(FW, 6);
  const sunLabel = `週日（${sd.getMonth() + 1}/${sd.getDate()}）`;
  assert(restOpt
    ? m2.includes(`${sunLabel}Phoebe ${sunOld.selectOne ? '先選的' : ''}`) && m2.includes(`「${restOpt.title}」不在新的課表裡，會換成這份排的內容`)
    : m2.includes(`${sunLabel}Phoebe 標了「自主休息」`), 'confirm names by date what she had arranged on that day');
  assert(ftitles(6) === expected[6] && !Store.effectiveWeek(FW, 'Phoebe').days[6].selectOne, 'that day is scheduled exactly as written too (no leftover 「或」)');
  assert(m2.includes(`Phoebe 標了第 ${FW} 週「本週已降量」`), 'confirm mentions 本週已降量');
  assert(ftitles(0) === expected[0] && ftitles(5) === expected[5], 'the other days are applied');
  // 3b. 她給了影片的項目照她講的：庫裡同名同類型但影片不一樣的不拿來用、也不動她的庫；只寫名字的（useLibrary）才用庫裡的
  const alt = JSON.parse(JSON.stringify(test));
  alt.items.stretch.videoRefs = ['pamela-leg-stretch'];
  const libStretch = Store.libraryList('item').find((x) => x.item.title === '伸展' && x.item.type === 'recovery');
  const tpa = Store.presetTemplates(alt);
  assert(tpa.differ.includes('stretch') && tpa.templates.stretch.id === null && PlanData.itemVideoRefs(tpa.templates.stretch.item).includes('pamela-leg-stretch'), 'an item she specified uses her video, not the library one with the same name');
  assert(JSON.stringify(Store.libraryDoc(libStretch.id).item.videoRefs) === JSON.stringify(libStretch.item.videoRefs), 'and her library item is left untouched');
  assert(tpa.templates.zone2.id === myZ2.id, 'items she only named (Zone 2 跑) come from her library');
  // 4. 間歇跑：庫裡原本有的就用庫裡的（上面已經加進庫了）；有時間，預計跑量算得到它
  const sunInterval = Store.effectiveWeek(WN, 'Annlin').days[6].items.find((it) => it.type === 'interval');
  assert(sunInterval && sunInterval.duration && sunInterval.duration.min === 35 && PlanData.itemSegments(sunInterval).length === 3, 'interval has a time and her 400 m × 4 example');
  // 5. 複製課表：長跑計量單位不一樣時確認畫面要講
  const W6 = Math.min(TW + 4, PlanData.plan.totalWeeks);
  const mk = App._cloneEffectiveWeek(W6, 'mick'); mk.longRunMetric = mk.longRunMetric === 'distance' ? 'time' : 'distance';
  Store.savePlanWeek('mick', W6, mk, { batch: true });
  const pm = Store.copyPlanPreview('mick', 'Phoebe', 'week', W6);
  assert(pm.metricChanged, 'copy preview notices the long-run unit change');
  Sync.planWeeksLoaded = () => true; Sync.fetchCopyGuards = async () => true;
  let m3 = '';
  sandbox.confirm = (m) => { m3 = m; return false; };
  App.state.weekViewNumber = W6;
  await App.copyPlanFrom('mick', 'week');
  assert(m3.includes('長跑計量單位（以時間／距離計）也會換成 Mick 的'), 'copy confirm says the long-run unit changes');
  // 6. 複製前問伺服器：一百多天的紀錄一次合併、只重畫一次（以前一份重畫一次）
  Sync.fetchCopyGuards = realFetchCopyGuards;
  sandbox.__docs = Array.from({ length: 150 }, (_, i) => ({ id: `2027-01-${String((i % 28) + 1).padStart(2, '0')}-${i}`, data: () => ({ done: {}, updatedAt: '2026-09-22T00:00:00.000Z', fieldAt: {} }) }));
  vm.runInContext('fbDb = { collection: () => ({ get: () => Promise.resolve({ forEach: (f) => globalThis.__docs.forEach(f) }) }) }', sandbox);
  let redraws = 0;
  const realNotify = Store._notify;
  Store._notify = () => { redraws++; };
  const fetched = await Sync.fetchCopyGuards('Phoebe');
  Store._notify = realNotify;
  assert(fetched === true && redraws <= 2 && Object.keys(Store.entries.Phoebe || {}).length >= 150, `150 fetched records merged with ${redraws} redraws (one per collection), not 150`);
})();
