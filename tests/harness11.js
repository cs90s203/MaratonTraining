// 決策紀錄第 39 條（內建動作清單／影片可以刪除、恢復）＋第 40 條（間歇跑類型）
const fs = require('fs');
const vm = require('vm');
const path = require('path').resolve(__dirname, '..'); // repo 根目錄
const load = (f) => JSON.parse(fs.readFileSync(path + '/data/' + f));
const map = { 'plan.json': load('plan.json'), 'videos.json': load('videos.json'), 'workouts.json': load('workouts.json'), 'users.json': load('users.json') };
const store = {};
const sandbox = {
  console, window: {}, crypto: require('crypto').webcrypto,
  document: { getElementById: () => null, addEventListener: () => {}, querySelector: () => null },
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: () => {} },
  fetch: async (u) => ({ json: async () => map[Object.keys(map).find((k) => u.includes(k))] }),
  alert: (m) => sandbox.__alerts.push(m), confirm: (m) => { sandbox.__confirms.push(m); return true; }, __alerts: [], __confirms: [],
  APP_VERSION: 't',
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['js/plan-data.js', 'js/firebase-sync.js', 'js/store.js', 'js/views.js', 'js/app.js']) vm.runInContext(fs.readFileSync(path + '/' + f, 'utf8'), sandbox, { filename: f });
vm.runInContext('this.PlanData = PlanData; this.Store = Store; this.Sync = Sync; this.App = App; globalThis.render = () => {};', sandbox);
function assert(c, m) { console.log((c ? 'PASS' : 'FAIL') + ': ' + m); if (!c) process.exitCode = 1; }
(async () => {
  await sandbox.PlanData.load();
  const { Store, PlanData, Sync, App } = sandbox;
  Store.activeUserId = 'mick'; Store.init(); Store._cloudPush = () => {};
  const pushes = [];
  Store._cloudPushLibraryOverride = (id, doc, base, cb) => pushes.push({ id, doc, base,
    cb: (ok, msg) => { if (ok) Store._libraryServer[id] = JSON.parse(JSON.stringify(doc)); cb(ok, msg); } });
  const ack = () => pushes[pushes.length - 1].cb(true, '');
  let today = '2026-09-14';
  Store.todayKey = () => today;
  Store.coachMode = true;
  Sync.isSignedIn = () => true;

  // ── 刪除內建動作清單 ──
  const SA = 'strength-a';
  assert(Store.allWorkouts().some((w) => w.id === SA) && !Store.builtinRemoved('workout', SA), 'built-in listed before delete');
  App.deleteBuiltin('workout', SA); ack();
  assert(sandbox.__confirms[sandbox.__confirms.length - 1].includes('照樣顯示') && sandbox.__confirms[sandbox.__confirms.length - 1].includes('25'), 'delete confirm explains scheduled days keep showing (25 days)');
  assert(Store.builtinRemoved('workout', SA), 'builtinRemoved true after delete');
  const doc = Store.library[SA];
  assert(doc.kind === 'workoutOverride' && doc.content === null && Array.isArray(doc.history) && doc.history.length === 0 && doc.removed === true, 'delete without prior override creates content:null doc with removed');
  assert(!Store.allWorkouts().some((w) => w.id === SA), 'deleted built-in not offered in dropdown');
  const w = Store.workoutFor(SA, '2026-10-01');
  assert(w && w.exercises.length === PlanData.workoutById[SA].exercises.length && !w.modified, 'scheduled days still resolve the deleted built-in (JSON content)');
  const itemParts = vm.runInContext('itemPlanParts', sandbox);
  assert(itemParts({ id: '3-2-0', type: 'strength', title: 'A', workoutRef: SA }, { dateKey: '2026-09-23' }).workoutBlock.includes('查看動作'), 'card still shows 查看動作 for deleted built-in');
  // 設定頁
  let panel = vm.runInContext('renderLibraryPanel', sandbox)(App.state);
  assert(!panel.includes(`A.startLibraryEdit('workout','${SA}')`) && panel.includes('已刪除的內建') && panel.includes(`A.undeleteBuiltin('workout','${SA}')`), 'panel hides deleted built-in row and offers 恢復');
  assert(panel.includes(`A.deleteBuiltin('workout','pelvic-core-basic')`) && panel.includes(`A.deleteBuiltin('video','fitnessblender-postpartum')`), 'every built-in row has 刪除 (including safety-related ones)');
  // 編輯表單：已經選了它的項目保留選項
  const form = vm.runInContext('renderTemplateForm', sandbox)({ id: 'c-a', name: 'A', item: { type: 'strength', title: 'A', workoutRef: SA } });
  assert(form.includes(`value="${SA}" selected`) && form.includes('（已從庫中刪除）'), 'edit form keeps the deleted built-in as selected option');

  // ── 改過內容的內建，刪除再恢復，內容還在 ──
  const PB = 'pelvic-core-basic';
  Store.saveBuiltinOverride('workout', PB, { name: '教練版', loadGuidance: '', exercises: [{ name: '橋式', sets: 2, reps: { min: 8, max: 10 } }] }, null); ack();
  App.deleteBuiltin('workout', PB); ack();
  assert(Store.builtinRemoved('workout', PB) && Store.workoutFor(PB).name === '教練版', 'deleting a modified built-in keeps its edited content');
  App.undeleteBuiltin('workout', PB); ack();
  assert(!Store.builtinRemoved('workout', PB) && Store.workoutFor(PB).name === '教練版' && Store.allWorkouts().some((x) => x.id === PB), 'undelete restores it with edited content');
  // 刪除後再編輯內容（例如從卡片打開）：removed 保留
  App.deleteBuiltin('workout', PB); ack();
  Store.saveBuiltinOverride('workout', PB, { name: '教練版2', loadGuidance: '', exercises: [{ name: '橋式', sets: 3, reps: { min: 8, max: 10 } }] }, Store.libraryServerUpdatedAt(PB)); ack();
  assert(Store.builtinRemoved('workout', PB) && Store.workoutFor(PB).name === '教練版2', 'editing a deleted built-in keeps it deleted');
  // 還原內建也保留 removed
  Store.saveBuiltinOverride('workout', PB, null, Store.libraryServerUpdatedAt(PB)); ack();
  assert(Store.builtinRemoved('workout', PB) && !Store.workoutFor(PB).modified, 'restoring content keeps deleted flag');

  // ── 失敗退回、同一份存檔中不能再刪 ──
  const VID = 'pamela-abs-yoga';
  App.deleteBuiltin('video', VID);
  const pending = pushes[pushes.length - 1];
  assert(Store.builtinRemoved('video', VID), 'optimistic delete visible');
  const again = Store.setBuiltinRemoved('video', VID, false, null);
  assert(!again.ok && /還在儲存/.test(again.reason), 'cannot toggle while the delete is in flight');
  pending.cb(false, '沒有連上網路');
  assert(!Store.builtinRemoved('video', VID) && !(VID in Store.library) && sandbox.__alerts.some((m) => m.includes('沒有刪除')), 'failed delete rolls back and explains');
  assert(!Store.allVideos().every((v) => v.id !== VID), 'video back in dropdown after failed delete');
  // 沒登入不能刪
  Sync.isSignedIn = () => false;
  const nAlerts = sandbox.__alerts.length;
  App.deleteBuiltin('video', VID);
  assert(!Store.builtinRemoved('video', VID) && sandbox.__alerts.length === nAlerts + 1 && sandbox.__alerts[nAlerts].includes('要先登入'), 'signed out: delete refused with reason');
  Sync.isSignedIn = () => true;
  // 已經是刪除狀態再刪：不寫
  const n0 = pushes.length;
  assert(Store.setBuiltinRemoved('workout', SA, true, Store.libraryServerUpdatedAt(SA)).unchanged && pushes.length === n0, 'delete of already-deleted is a no-op');
  // 舊版網頁（不認得的 kind）：這份文件照樣被忽略——新版自己的讀取檢查接受 removed 欄位
  assert(Store._libraryDocOk(Store.library[SA], SA), 'override doc with removed still passes read validation');

  // ── 間歇跑類型 ──
  const VALID_TYPES = vm.runInContext('VALID_TYPES', sandbox), TYPE_LABELS = vm.runInContext('TYPE_LABELS', sandbox);
  assert(VALID_TYPES.includes('interval') && TYPE_LABELS.interval === '間歇跑', 'interval is a valid type labelled 間歇跑');
  assert(vm.runInContext("isRunType('interval')", sandbox), 'interval counts as a run type');
  const newForm = vm.runInContext('renderTemplateForm', sandbox)({ id: 'new', name: '', item: { type: 'run', title: '' } });
  assert(newForm.includes('<option value="interval" >間歇跑</option>') || newForm.includes('<option value="interval">間歇跑</option>') || /value="interval"[^>]*>間歇跑</.test(newForm), 'type dropdown offers 間歇跑');
  assert(App._validateItemFields({ title: '間歇', type: 'interval', duration: { min: 30, max: 40 } }) === null, 'interval item passes validation');
  // 週跑量目標把間歇跑算進去（用一個教練改過的週）
  const W = 10;
  const before = Store.weekTargetAuto(W, 'mick', { planOnly: true });
  const week = JSON.parse(JSON.stringify(Store.effectiveWeek(W)));
  const restDay = week.days.findIndex((d) => d.items.length === 1 && d.items[0].type === 'strength');
  week.days[restDay].items.push({ id: 'c-int', type: 'interval', title: '間歇跑', distanceKm: { min: 5, max: 6 }, duration: null });
  Store.planOverrides[W] = { ...week, weekNumber: W };
  const after = Store.weekTargetAuto(W, 'mick', { planOnly: true });
  assert(Math.abs((after.max - before.max) - 6) < 0.01 && Math.abs((after.min - before.min) - 5) < 0.01, `weekly target adds interval km (before ${JSON.stringify(before)}, after ${JSON.stringify(after)})`);
  delete Store.planOverrides[W];
  // 紀錄卡：間歇跑的日子有實際公里
  const card = vm.runInContext('renderDayRecordCard', sandbox)(3, 1, { selectOne: false, items: [{ id: 'c-i2', type: 'interval', title: '間歇跑', duration: { min: 30, max: 30 } }] }, null, true);
  assert(card.includes('實際公里') && card.includes('實際時間'), 'interval day shows km and time inputs');
})();
