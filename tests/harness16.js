// 決策紀錄第 45 條：課表項目卡——名稱是項目庫選單、時間直接改、存成常用只在跟項目庫不同時出現、今天以前唯讀
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
vm.runInContext('this.PlanData = PlanData; this.Store = Store; this.App = App; globalThis.render = () => {};', sandbox);
function assert(c, m) { console.log((c ? 'PASS' : 'FAIL') + ': ' + m); if (!c) process.exitCode = 1; }
const fn = (name) => vm.runInContext(name, sandbox);
const J = (x) => JSON.stringify(x);
(async () => {
  await sandbox.PlanData.load();
  const { PlanData, Store, App } = sandbox;
  Store.activeUserId = 'mick'; Store.init(); Store._cloudPush = () => {}; Store._cloudPushLibrary = () => {};
  const pushes = []; Store._cloudPushPlanWeek = (uid, wn, doc) => pushes.push(wn);
  Store.coachMode = true;
  const W = PlanData.locateToday().weekNumber + 3;
  const dayIdx = Store.effectiveWeek(W).days.findIndex((d) => !d.selectOne && d.items.some((it) => it.type === 'run' && it.duration));
  const D = dayIdx;
  const card = (wn, di, id) => { const d = Store.effectiveWeek(wn).days[di]; const i = d.items.findIndex((x) => x.id === id); return fn('renderItemCard')(wn, di, d.items[i], i, d.items.length, null, !!d.selectOne, false); };
  const run = Store.effectiveWeek(W).days[D].items.find((it) => it.type === 'run' && it.duration);

  // ── 未來的日子：名稱是選單、時間可以改、沒有編輯表單 ──
  let html = card(W, D, run.id);
  assert(html.includes(`A.toggleItemPicker(${W},${D},'${run.id}')`) && html.includes('class="item-pick"'), 'future card: title is a library picker button');
  assert(!html.includes('startEditItem') && !html.includes('編輯</button>') && !html.includes('name="durationMin"'), 'no edit form / 編輯 button left on the plan card');
  assert(html.includes(`A.amountTap(${W},${D},'${run.id}')`) && !html.includes('A.setItemAmount('), 'duration shown as text until double-tapped');
  App.state.amountEdit = { weekNumber: W, dayIndex: D, itemId: run.id };
  const htmlEd = card(W, D, run.id);
  assert((htmlEd.match(/A\.setItemAmount\(/g) || []).length === 2 && htmlEd.includes(`value="${run.duration.min}"`) && htmlEd.includes('>分<'), 'double-tapped: two editable inputs');
  App.state.amountEdit = null;
  const lr = PlanData.plan.weeks.flatMap((w) => w.days.flatMap((d, di) => d.items.map((it) => ({ w: w.weekNumber, di, it })))).find((x) => x.it.type === 'long-run' && x.it.distanceKm && !x.it.duration && x.w >= W);
  App.state.amountEdit = { weekNumber: lr.w, dayIndex: lr.di, itemId: lr.it.id };
  const lrHtml = card(lr.w, lr.di, lr.it.id);
  App.state.amountEdit = null;
  assert(lrHtml.includes('data-amt="distanceKm"') && !lrHtml.includes('data-amt="duration"') && lrHtml.includes('>K<'), 'distance-only long run: the distance is the editable number');
  const rest = PlanData.plan.weeks.flatMap((w) => w.days.flatMap((d, di) => d.items.map((it) => ({ w: w.weekNumber, di, it })))).find((x) => x.it.type === 'rest' && x.w >= W);
  assert(!card(rest.w, rest.di, rest.it.id).includes('amt-edit'), 'rest item has no number inputs');

  // 存成常用：項目庫沒有 → 有按鈕
  assert(html.includes(`A.saveItemAsTemplate(${W},${D},'${run.id}')`), 'factory item not in library: 存成常用 shown');

  // ── 打開選單：庫是空的 ──
  App.toggleItemPicker(W, D, run.id);
  assert(J(App.state.itemPicker) === J({ weekNumber: W, dayIndex: D, itemId: run.id }), 'toggleItemPicker opens the list for that item');
  html = card(W, D, run.id);
  assert(html.includes('pick-list') && html.includes('項目庫還沒有項目') && html.includes("A.goTo('settings')"), 'empty library: hint + link to the library');
  App.toggleItemPicker(W, D, run.id);
  assert(App.state.itemPicker === null, 'tapping the name again closes the list');

  // ── 存成常用 → 按鈕消失、顯示已存進項目庫 ──
  App.saveItemAsTemplate(W, D, run.id);
  const t0 = Store.libraryList('item')[0];
  assert(Store.libraryList('item').length === 1 && t0.name === run.title && t0.item.duration.min === run.duration.min, 'save as template: one library item named after the title');
  html = card(W, D, run.id);
  assert(!html.includes('A.saveItemAsTemplate(') && html.includes('已存進項目庫') && sandbox.__alerts.length === 0, 'after saving: button gone, inline 已存進項目庫, no alert dialog');
  App.saveItemAsTemplate(W, D, run.id);
  assert(Store.libraryList('item').length === 1, 'saving an identical item again creates nothing');

  // ── 改時間 → 跟項目庫不同 → 存成常用又出現 ──
  // idx：改的是第幾格（0 下限、1 上限）
  const fakeEl = (key, a, b, idx) => { const ins = [{ value: a }, { value: b }]; const el = { closest: () => ({ dataset: { amt: key }, querySelectorAll: () => ins }) }; ins[idx || 0] = Object.assign(el, ins[idx || 0]); return el; };
  const n0 = pushes.length;
  App.setItemAmount(W, D, run.id, fakeEl('duration', '45', '50'));
  let now = Store.effectiveWeek(W).days[D].items.find((x) => x.id === run.id);
  assert(J(now.duration) === J({ min: 45, max: 50 }) && pushes.length === n0 + 1 && now.derived === false, 'duration edit saved to the week');
  html = card(W, D, run.id);
  assert(html.includes(`A.saveItemAsTemplate(${W},${D},'${run.id}')`) && !html.includes('已存進項目庫'), 'changed from the template: 存成常用 comes back');
  App.setItemAmount(W, D, run.id, fakeEl('duration', '60', '50', 0));
  assert(J(Store.effectiveWeek(W).days[D].items.find((x) => x.id === run.id).duration) === J({ min: 60, max: 60 }), 'lower bound above upper: upper follows (60–60), not swapped');
  App.setItemAmount(W, D, run.id, fakeEl('duration', '60', '40', 1));
  assert(J(Store.effectiveWeek(W).days[D].items.find((x) => x.id === run.id).duration) === J({ min: 40, max: 40 }), 'upper bound below lower: lower follows (40–40)');
  App.setItemAmount(W, D, run.id, fakeEl('duration', '45', '50', 1));
  const nSame = pushes.length;
  App.setItemAmount(W, D, run.id, fakeEl('duration', '45', '50', 0));
  assert(pushes.length === nSame, 'same range is not saved again');
  App.setItemAmount(W, D, run.id, fakeEl('duration', '40', ''));
  now = Store.effectiveWeek(W).days[D].items.find((x) => x.id === run.id);
  assert(J(now.duration) === J({ min: 40, max: 40 }), 'one box filled = exact value');
  const nA = sandbox.__alerts.length;
  App.setItemAmount(W, D, run.id, fakeEl('duration', '400', ''));
  assert(sandbox.__alerts.length === nA + 1 && J(Store.effectiveWeek(W).days[D].items.find((x) => x.id === run.id).duration) === J({ min: 40, max: 40 }), 'out of range time refused with a message');
  App.setItemAmount(W, D, run.id, fakeEl('duration', '', ''));
  assert(Store.effectiveWeek(W).days[D].items.find((x) => x.id === run.id).duration === null, 'both empty = no time');

  // ── 從項目庫換 ──
  const segs = [{ kind: 'repeat', times: 4, steps: [{ kind: 'main', amount: { unit: 'm', min: 300, max: 300 }, zone: 'Zone 4', note: '5K 跑速' }] }];
  const tInt = Store.saveLibraryDoc(null, 'item', { name: '間歇 300 x 4 <img src=x>', item: { type: 'interval', title: '間歇 300 x 4', duration: { min: 35, max: 40 }, heartRateZone: 'Zone 4', segments: segs, notes: '跑不動就停' } });
  App.toggleItemPicker(W, D, run.id);
  html = card(W, D, run.id);
  assert(html.includes(`A.swapItemFromLibrary(${W},${D},'${run.id}','${tInt.id}')`) && html.includes(`A.swapItemFromLibrary(${W},${D},'${run.id}','${t0.id}')`), 'list offers every library item');
  assert(!html.includes('<img src=x') && html.includes('&lt;img'), 'template names escaped in the list');
  App.swapItemFromLibrary(W, D, run.id, tInt.id);
  now = Store.effectiveWeek(W).days[D].items.find((x) => x.id === run.id);
  assert(now && now.type === 'interval' && now.title === '間歇 300 x 4' && now.segments[0].times === 4 && now.notes === '跑不動就停' && App.state.itemPicker === null, 'swap replaces the content, keeps the id, closes the list');
  now.segments[0].times = 9;
  assert(Store.libraryDoc(tInt.id).item.segments[0].times === 4, 'swap copies (template untouched)');
  now.segments[0].times = 4;
  App.toggleItemPicker(W, D, run.id);
  html = card(W, D, run.id);
  assert(/pick-row on"[^>]*swapItemFromLibrary\([^)]*'[^']*','[^']*'\)/.test(html) && html.split('pick-row on')[1].includes(tInt.id), 'current template is ticked in the list');
  App.state.itemPicker = null;

  // ── 從項目庫加一個 ──
  const before = Store.effectiveWeek(W).days[D].items.length;
  let body = fn('renderDayBody')(W, D);
  assert(body.includes(`A.toggleItemPicker(${W},${D},'add')`) && body.includes('從項目庫加一個') && !body.includes('startAddItem'), 'day has ＋ 從項目庫加一個');
  App.toggleItemPicker(W, D, 'add');
  body = fn('renderDayBody')(W, D);
  assert(body.includes(`A.addItemFromLibrary(${W},${D},'${t0.id}')`), 'add list uses addItemFromLibrary');
  App.addItemFromLibrary(W, D, t0.id);
  const items = Store.effectiveWeek(W).days[D].items;
  assert(items.length === before + 1 && items[items.length - 1].id.startsWith('c-') && items[items.length - 1].title === t0.item.title, 'add appends a copy with a new id');

  // 刪掉的常用項目
  Store.deleteLibraryDoc(tInt.id);
  const nA2 = sandbox.__alerts.length;
  App.swapItemFromLibrary(W, D, run.id, tInt.id);
  assert(sandbox.__alerts.length === nA2 + 1 && Store.effectiveWeek(W).days[D].items.find((x) => x.id === run.id).type === 'interval', 'swapping to a deleted template is refused');

  // 二擇一：換其中一個，整組清掉推導值
  const so = PlanData.plan.weeks.flatMap((w) => w.days.map((d, di) => ({ w: w.weekNumber, di, d }))).find((x) => x.w >= W && x.d.selectOne && x.d.items.some((it) => it.derived));
  if (so) {
    App.swapItemFromLibrary(so.w, so.di, so.d.items[0].id, t0.id);
    assert(Store.effectiveWeek(so.w).days[so.di].items.every((it) => !it.derived), 'select-one day: swap clears derived on both options');
  }

  // ── 今天以前的日子：唯讀 ──
  const todayKey = PlanData.dayKey(PlanData.today());
  const past = PlanData.plan.weeks.flatMap((w) => w.days.map((d, di) => ({ w: w.weekNumber, di, d }))).find((x) => PlanData.keyForWeekDay(x.w, x.di) < todayKey && !x.d.selectOne && x.d.items.some((it) => it.type === 'run'));
  if (past) {
    const pit = past.d.items.find((it) => it.type === 'run');
    const ph = card(past.w, past.di, pit.id);
    assert(!ph.includes('item-pick') && !ph.includes('amt-edit') && !ph.includes('A.moveItem(') && !ph.includes('A.deleteItem(') && (ph.includes('A.saveItemAsTemplate(') === !Store.libraryItemMatching(pit)), 'past card: read-only, only 存成常用 (when not already in the library)');
    const pb = fn('renderDayBody')(past.w, past.di);
    assert(pb.includes('今天以前的日子不能改') && !pb.includes("'add')"), 'past day: no add, says why');
    const pushN = pushes.length, al = sandbox.__alerts.length;
    App.swapItemFromLibrary(past.w, past.di, pit.id, t0.id);
    App.addItemFromLibrary(past.w, past.di, t0.id);
    App.setItemAmount(past.w, past.di, pit.id, fakeEl('duration', '10', '10'));
    App.deleteItem(past.w, past.di, pit.id);
    App.moveItem(past.w, past.di, pit.id, 1);
    assert(pushes.length === pushN && sandbox.__alerts.length === al + 5, 'past day: swap / add / time / delete / move all refused');
  } else console.log('SKIP: no past run day yet');

  // ── 常用項目庫的表單：一個名稱、沒有強度說明、沒有長說明 ──
  const form = fn('renderTemplateForm')({ id: 'c-x', name: 'Zone 2 跑（Phase 2）', item: { type: 'run', title: 'Zone 2 跑', duration: { min: 30, max: 40 }, intensityNote: '輕鬆對話', segments: segs } });
  assert(form.includes('name="title"') && form.includes('value="Zone 2 跑（Phase 2）"') && !form.includes('templateName') && !form.includes('範本名稱'), 'library form: one 名稱 field (shows the library name)');
  assert(!form.includes('name="intensityNote"') && !form.includes('強度說明') && !form.includes('seg-hint') && !form.includes('把當天怎麼跑拆開寫'), 'library form: no 強度說明, no long segment hint');
  assert(form.includes('name="durationMin"') && form.includes('name="rpeMax"') && form.includes('seg-editor') && form.includes('name="videoRefs"') && form.includes('name="workoutRef"') && form.includes('name="notes"'), 'library form keeps the definition fields');
  // ── 動作清單的份量：一行「5 組 × 30 秒」、換單位清掉數字、新動作不預填 ──
  App.startLibraryEdit('workout', 'new');
  const ex0 = App.state.libraryEdit.draft.exercises[0];
  assert(ex0.min === '' && ex0.max === '' && ex0.qty === 'reps', 'new exercise: amount not prefilled (no leftover 8–10)');
  ex0.min = 8; ex0.max = 10;
  App.libDraftExercise(0, 'qty', 'hold', true);
  assert(ex0.qty === 'hold' && ex0.min === '' && ex0.max === '', 'switching 次 → 秒 clears the numbers');
  App.libDraftExercise(0, 'min', '30');
  App.libDraftExercise(0, 'qty', 'hold', true);
  assert(ex0.min === '30', 'choosing the same unit again keeps the number');
  const wEd = fn('renderWorkoutEditor')(App.state.libraryEdit);
  assert(wEd.includes('class="ex-qty"') && wEd.includes('組 ×') && /<option value="hold" selected>秒<\/option>/.test(wEd) && !wEd.includes('算法') && !wEd.includes('下限'), 'workout editor: one amount line 「組 × … 秒」, no 算法／下限 labels');
  Object.assign(ex0, { name: '單腳站立', sets: '5', max: '', perSide: true });
  App.state.libraryEdit.draft.name = '單腳站立訓練';
  App.saveLibraryWorkout();
  const ws = Store.libraryList('workout').find((x) => x.name === '單腳站立訓練');
  assert(ws && ws.exercises[0].sets === 5 && J(ws.exercises[0].holdSeconds) === J({ min: 30, max: 30 }) && ws.exercises[0].reps === null && ws.exercises[0].perSide === true, 'saves 5 組 × 30 秒（每邊）');
  assert(fn('itemPlanParts')({ id: 'z', type: 'recovery', title: 'x', workoutRef: ws.id }, {}).workoutBlock.includes('單腳站立 · 5 組 × 30 秒（每邊）'), 'card shows 5 組 × 30 秒（每邊）');

  assert(typeof App.saveItemEdit === 'undefined' && typeof App.startEditItem === 'undefined' && typeof App.startAddItem === 'undefined' && typeof fn('typeof renderItemEditForm') === 'string' && fn('typeof renderItemEditForm') === 'undefined', 'old plan edit form code removed');
})();

// ── 決策紀錄第 46 條 ──
(async () => {
  await new Promise((r) => setTimeout(r, 200));
  const { PlanData, Store, App } = sandbox;
  const fn = (name) => vm.runInContext(name, sandbox);
  Store.coachMode = true;
  const W = PlanData.locateToday().weekNumber + 4;
  const D = Store.effectiveWeek(W).days.findIndex((d) => !d.selectOne && d.items.some((it) => it.type === 'run' && it.duration));
  const it = Store.effectiveWeek(W).days[D].items.find((x) => x.type === 'run' && x.duration);
  // 1. 點兩下才改
  App.state.amountEdit = null; App._lastTap = null;
  App.amountTap(W, D, it.id);
  assert(App.state.amountEdit === null, '46-1: one tap does not open the time inputs');
  App.amountTap(W, D, it.id);
  assert(App.state.amountEdit && App.state.amountEdit.itemId === it.id && App._focusAmount === it.id, '46-1: second tap within 400ms opens them (and focuses)');
  App.state.amountEdit = null;
  App._lastTap = { key: `amt:${W}-${D}-${it.id}`, t: Date.now() - 1000 };
  App.amountTap(W, D, it.id);
  assert(App.state.amountEdit === null, '46-1: two slow taps do not open');
  App._lastTap = { key: `amt:${W}-${D}-other`, t: Date.now() };
  App.amountTap(W, D, it.id);
  assert(App.state.amountEdit === null, '46-1: taps on two different items do not open');
  App.state.amountEdit = { weekNumber: W, dayIndex: D, itemId: it.id };
  const inside = {}; const group = { contains: (x) => x === inside };
  App.amountFocusOut({ relatedTarget: inside }, group);
  assert(App.state.amountEdit !== null, '46-1: moving to the other box keeps editing');
  App.amountFocusOut({ relatedTarget: null }, group);
  assert(App.state.amountEdit === null, '46-1: leaving the boxes closes editing');
  const todayKey = PlanData.dayKey(PlanData.today());
  const past = PlanData.plan.weeks.flatMap((w) => w.days.map((d, di) => ({ w: w.weekNumber, di, d }))).find((x) => PlanData.keyForWeekDay(x.w, x.di) < todayKey && x.d.items.some((y) => y.type === 'run'));
  if (past) {
    const pit = past.d.items.find((y) => y.type === 'run');
    const nA = sandbox.__alerts.length;
    App.amountTap(past.w, past.di, pit.id); App.amountTap(past.w, past.di, pit.id);
    assert(App.state.amountEdit === null && sandbox.__alerts.length === nA + 1, '46-1: past day cannot open the time inputs');
  }

  // 2. 教練模式不畫當天紀錄卡
  const coachBody = fn('renderDayBody')(W, D);
  assert(!coachBody.includes('體感強度') && !coachBody.includes('實際時間') && !coachBody.includes('身體狀況') && !coachBody.includes('rec-card') && !coachBody.includes('沒照表'), '46-2: coach mode hides actual time / effort / notes / body status');
  Store.coachMode = false;
  const userBody = fn('renderDayBody')(W, D);
  assert(userBody.includes('rec-card') && userBody.includes('實際時間') && userBody.includes('身體狀況') && userBody.includes('附註'), '46-2: normal mode still shows the record card (體感強度 only from the day itself, as before)');
  assert(!userBody.includes('實際分鐘'), '46-2: 實際分鐘 renamed to 實際時間');
  Store.coachMode = true;

  // 3. 第 X 週 點一下切換
  App.state.weekViewNumber = W; App.state.page = 'week';
  const page = fn('renderWeekPage')(App.state);
  assert(/class="week-title-btn"[^>]*onclick="A\.weekTitleTap\(\)"[^>]*aria-pressed="true">第 \d+ 週<\/button>/.test(page), '46-3: week title is the coach mode shortcut');
  App._lastTap = null;
  const before46 = Store.coachMode;
  App.weekTitleTap();
  assert(Store.coachMode === before46, '46-3: one tap on the week title does nothing (avoid accidental toggles)');
  App.weekTitleTap();
  assert(Store.coachMode === !before46, '46-3: double tap toggles coach mode');
  App._lastTap = { key: 'week-title', t: Date.now() - 1000 };
  App.weekTitleTap();
  assert(Store.coachMode === !before46, '46-3: two slow taps do not toggle');
  App._lastTap = { key: 'amt:1-1-x', t: Date.now() };
  App.weekTitleTap();
  assert(Store.coachMode === !before46, '46-3: a tap on a time then the title does not count as a double tap');
  Store.coachMode = before46;
  assert(!page.includes('wt-coach') && !page.includes('切換教練模式'), '46-3: hidden shortcut — no visible 教練 chip or hint text');
  Store.coachMode = false;
  assert(/class="week-title-btn"[^>]*aria-pressed="false">第 \d+ 週<\/button>/.test(fn('renderWeekPage')(App.state)), '46-3: same plain title when off');
  Store.coachMode = true;

  // 4. 間歇跑（只有段落、沒有總時長）也有實際時間
  const card = fn('renderDayRecordCard')(W, D, { selectOne: false, items: [{ id: 'c-int', type: 'interval', title: '間歇 300 x 4', duration: null, segments: [{ kind: 'repeat', times: 4, steps: [{ kind: 'main', amount: { unit: 'm', min: 300, max: 300 }, zone: null, note: '' }] }] }] }, null, true);
  assert(card.includes('實際公里') && card.includes('實際時間') && card.includes('placeholder="分鐘"'), '46-4: interval without total duration shows actual km and actual time');
  const lr = fn('renderDayRecordCard')(W, D, { selectOne: false, items: [{ id: 'c-lr', type: 'long-run', title: '長跑', distanceKm: { min: 10, max: 12 } }] }, null, true);
  assert(lr.includes('實際公里') && lr.includes('實際時間'), '46-4: distance-only long run also gets actual time');
  const rest = fn('renderDayRecordCard')(W, D, { selectOne: false, items: [{ id: 'c-r', type: 'rest', title: '完全休息' }] }, null, true);
  assert(!rest.includes('實際時間') && !rest.includes('實際公里'), '46-4: rest day has no number fields');
})();

// ── 決策紀錄第 47 條：肌力訓練類型 ──
(async () => {
  await new Promise((r) => setTimeout(r, 400));
  const { Store, App } = sandbox;
  const fn = (name) => vm.runInContext(name, sandbox);
  const VT = fn('VALID_TYPES'), TL = fn('TYPE_LABELS');
  assert(VT.includes('muscle') && TL.muscle === '肌力訓練' && VT.indexOf('muscle') === VT.indexOf('strength') - 1, '47: 肌力訓練 is a valid type, listed right before 重量訓練');
  const form = fn('renderTemplateForm')({ id: 'c-m', name: '腿、跨、臀肌力訓練', item: { type: 'muscle', title: '腿、跨、臀肌力訓練', duration: { min: 20, max: 20 } } });
  assert(/<option value="muscle" selected>肌力訓練<\/option>/.test(form) && form.includes('<option value="strength" >重量訓練</option>'), '47: library form offers 肌力訓練 and keeps it selected');
  assert(App._validateItemFields({ title: 'x', type: 'muscle' }) === null, '47: muscle passes validation');
  const saved = Store.saveLibraryDoc(null, 'item', { name: '腿、跨、臀肌力訓練', item: { type: 'muscle', title: '腿、跨、臀肌力訓練', duration: { min: 20, max: 20 } } });
  assert(saved && saved.item.type === 'muscle' && fn('templateMetaText')(saved.item).startsWith('肌力訓練'), '47: saved template shows 肌力訓練 in the list');
  assert(!fn("isRunType('muscle')"), '47: 肌力訓練 does not count toward weekly running volume');
})();
