// 決策紀錄第 33 條：內建／自訂動作清單與影片可以改，改動只從今天起生效
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
  document: { getElementById: () => null, addEventListener: () => {}, querySelector: () => null },
  fetch: async (url) => { const map = { 'plan.json': plan, 'videos.json': videos, 'workouts.json': workouts, 'users.json': users }; const key = Object.keys(map).find((k) => url.includes(k)); return { json: async () => map[key] }; },
  alert: (m) => { sandbox.__alerts.push(m); }, confirm: () => true, __alerts: [],
  APP_VERSION: 'test',
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['js/plan-data.js', 'js/firebase-sync.js', 'js/store.js', 'js/views.js', 'js/app.js']) vm.runInContext(fs.readFileSync(path + '/' + f, 'utf8'), sandbox, { filename: f });
vm.runInContext('this.PlanData = PlanData; this.Store = Store; this.Sync = Sync; this.App = App; this.A = App; globalThis.render = () => {};', sandbox);
function assert(c, m) { console.log((c ? 'PASS' : 'FAIL') + ': ' + m); if (!c) process.exitCode = 1; }
const J = (x) => JSON.stringify(x);
(async () => {
  await sandbox.PlanData.load();
  const { Store, PlanData, Sync, App } = sandbox;
  Store.activeUserId = 'mick'; Store.init();
  Store._cloudPush = () => {};
  const pushed = [], overridePushes = [];
  Store._cloudPushLibrary = (id, data) => pushed.push({ id, data });
  // 假的雲端：先記下來，測試自己決定成功（ack）或失敗；成功時跟 Sync 一樣記下雲端確認過的那份
  Store._cloudPushLibraryOverride = (id, doc, base, cb) => overridePushes.push({ id, doc, base,
    cb: (ok, msg) => { if (ok) Store._libraryServer[id] = JSON.parse(JSON.stringify(doc)); cb(ok, msg); } });
  const ack = () => overridePushes[overridePushes.length - 1].cb(true, '');

  // 可以控制的「今天」
  let today = '2026-09-14';
  Store.todayKey = () => today;
  const BASIC = 'pelvic-core-basic';
  const base = PlanData.workoutById[BASIC];

  // ── 沒改過：照 JSON ──
  let w = Store.workoutFor(BASIC, '2026-09-07');
  assert(w.builtin && !w.modified && w.exercises.length === base.exercises.length && w.derived === true, 'unmodified built-in resolves to JSON (derived kept)');
  assert(w.safetyNote && w.safetyNote.includes('漏尿'), 'built-in carries its fixed safetyNote');
  assert(!Store.builtinModified('workout', BASIC), 'builtinModified false before any edit');

  // ── 9/14 改：9/14 起新版，之前維持 JSON ──
  const v1 = { name: '產後核心（教練版）', loadGuidance: '慢慢來', exercises: [{ name: '死蟲式', sets: 3, reps: { min: 6, max: 8 }, perSide: true, notes: '' }] };
  const r1 = Store.saveBuiltinOverride('workout', BASIC, v1, null); ack();
  assert(r1.ok && overridePushes.length === 1 && overridePushes[0].base === null, 'first override saves and pushes with base null');
  const doc1 = Store.library[BASIC];
  assert(doc1.kind === 'workoutOverride' && doc1.from === '2026-09-14' && J(doc1.history) === J([{ until: '2026-09-13', content: null }]), 'override doc: from today, history says JSON until yesterday');
  assert(Store.workoutFor(BASIC, '2026-09-13').exercises.length === base.exercises.length, 'day before edit still shows JSON');
  assert(Store.workoutFor(BASIC, '2026-09-07').derived === true, 'past day keeps derived label from JSON');
  w = Store.workoutFor(BASIC, '2026-09-14');
  assert(w.name === '產後核心（教練版）' && w.exercises.length === 1 && w.modified && w.derived === false, 'edit day shows new version, no derived label');
  assert(Store.workoutFor(BASIC, '2026-10-26').exercises[0].sets === 3, 'future day shows new version');
  assert(w.safetyNote === base.safetyNote, 'safetyNote cannot be edited away (comes from JSON)');
  assert(Store.workoutFor(BASIC).name === '產後核心（教練版）', 'no dateKey = today');
  assert(Store.builtinModified('workout', BASIC), 'builtinModified true');
  assert(Store.allWorkouts().filter((x) => x.id === BASIC).length === 1 && Store.allWorkouts().find((x) => x.id === BASIC).name === '產後核心（教練版）', 'dropdown lists built-in once with edited name');
  assert(Store.libraryList('workout').every((x) => x.id !== BASIC), 'override is not listed as a custom workout');

  // ── 同一天再改：取代，不多一個版本 ──
  const v1b = { ...v1, exercises: [{ ...v1.exercises[0], sets: 2 }] };
  const inflight = Store.saveBuiltinOverride('workout', BASIC, v1b, doc1.updatedAt);
  const blocked = Store.saveBuiltinOverride('workout', BASIC, v1, doc1.updatedAt);
  assert(inflight.ok && !blocked.ok && /還在儲存/.test(blocked.reason), 'second save of the same built-in is refused while the first is in flight');
  ack();
  const doc1b = Store.library[BASIC];
  assert(doc1b.history.length === 1 && doc1b.from === '2026-09-14' && Store.workoutFor(BASIC, '2026-09-14').exercises[0].sets === 2, 'same-day re-edit replaces current version');
  assert(overridePushes[1].base === doc1.updatedAt, 'second push carries the base version from editor open');

  // ── 內容沒變：不寫 ──
  const n0 = overridePushes.length;
  const r0 = Store.saveBuiltinOverride('workout', BASIC, v1b, doc1b.updatedAt);
  assert(r0.ok && r0.unchanged && overridePushes.length === n0, 'unchanged save does not push');

  // ── 9/21 再改：9/14–9/20 保留 v1b ──
  today = '2026-09-21';
  const v2 = { ...v1, name: '產後核心 v2', exercises: [{ name: '橋式', sets: 2, reps: { min: 10, max: 12 }, perSide: false, notes: '' }] };
  Store.saveBuiltinOverride('workout', BASIC, v2, doc1b.updatedAt); ack();
  const doc2 = Store.library[BASIC];
  assert(doc2.history.length === 2 && doc2.history[1].until === '2026-09-20' && doc2.from === '2026-09-21', 'next-week edit archives previous version until yesterday');
  assert(Store.workoutFor(BASIC, '2026-09-13').exercises.length === base.exercises.length, 'before first edit: JSON');
  assert(Store.workoutFor(BASIC, '2026-09-16').exercises[0].name === '死蟲式', 'between edits: v1b');
  assert(Store.workoutFor(BASIC, '2026-09-21').exercises[0].name === '橋式', 'from second edit: v2');

  // ── 9/28 還原內建：9/28 起 JSON，之前各自維持 ──
  today = '2026-09-28';
  Store.saveBuiltinOverride('workout', BASIC, null, doc2.updatedAt); ack();
  const doc3 = Store.library[BASIC];
  assert(doc3.content === null && doc3.history.length === 3, 'restore writes content null and archives v2');
  assert(Store.workoutFor(BASIC, '2026-09-28').exercises.length === base.exercises.length && !Store.workoutFor(BASIC, '2026-09-28').modified, 'after restore: JSON from today');
  assert(Store.workoutFor(BASIC, '2026-09-22').exercises[0].name === '橋式', 'restore keeps past v2 days');
  assert(!Store.builtinModified('workout', BASIC), 'builtinModified false after restore');
  // 還原之後再改（第一版計畫用軟刪除會卡死的情境）
  today = '2026-10-05';
  const r4 = Store.saveBuiltinOverride('workout', BASIC, v1, doc3.updatedAt); ack();
  assert(r4.ok && Store.workoutFor(BASIC, '2026-10-05').name === '產後核心（教練版）' && Store.workoutFor(BASIC, '2026-09-30').exercises.length === base.exercises.length, 'editing again after restore works; restore period stays JSON');

  // ── 寫入失敗：退回雲端確認過的那份 ──
  const before = J(Store._libraryServer[BASIC]);
  today = '2026-10-12';
  let resultMsg = null;
  Store.saveBuiltinOverride('workout', BASIC, v2, Store.libraryServerUpdatedAt(BASIC), (ok, msg) => { resultMsg = [ok, msg]; });
  assert(Store.workoutFor(BASIC, '2026-10-12').name === '產後核心 v2', 'optimistic local update visible');
  overridePushes[overridePushes.length - 1].cb(false, '沒有網路');
  assert(J(Store.library[BASIC]) === before, 'failure rolls back to the server-confirmed doc');
  assert(resultMsg && resultMsg[0] === false && resultMsg[1] === '沒有網路', 'onResult receives failure + message');
  assert(!Store._overrideInFlight[BASIC], 'in-flight flag cleared after failure');
  // 第一次修改就失敗：整份拿掉
  const B2 = 'strength-a';
  Store.saveBuiltinOverride('workout', B2, v1, null);
  overridePushes[overridePushes.length - 1].cb(false, 'x');
  assert(!(B2 in Store.library) && !Store.workoutFor(B2).modified, 'failed first override is removed entirely');
  // 審查情境 (a)：從沒存進雲端的樂觀寫入，不能在失敗時被「退回」成本機的樣子
  Store.saveBuiltinOverride('workout', B2, v1, null);
  const p1 = overridePushes[overridePushes.length - 1];
  p1.cb(false, 'offline');
  Store.saveBuiltinOverride('workout', B2, v2, Store.libraryServerUpdatedAt(B2));
  overridePushes[overridePushes.length - 1].cb(false, 'offline');
  assert(!(B2 in Store.library), 'two failed saves in a row leave no phantom local version');
  assert(Store.libraryServerUpdatedAt(B2) === null, 'base for the next save is still null (server has nothing)');
  // 審查情境 (b)：存檔期間收到別人的新版本，失敗時不能退回更舊的
  Store.saveBuiltinOverride('workout', B2, v1, null);
  const pending = overridePushes[overridePushes.length - 1];
  const otherCoach = { kind: 'workoutOverride', content: v2, from: today, history: [{ until: Store._dayBefore(today), content: null }], updatedAt: '2026-10-12T09:00:00.000Z' };
  Store.replaceRemoteLibrary(B2, otherCoach);
  pending.cb(false, 'conflict');
  assert(Store.library[B2] && Store.library[B2].updatedAt === otherCoach.updatedAt, 'rollback keeps the newer version another coach saved');
  Store.replaceRemoteLibrary(B2, null);
  // 沒改內容就存：不建修改版、不標已修改
  const untouched = Store.saveBuiltinOverride('workout', 'strength-b', { name: PlanData.workoutById['strength-b'].name, loadGuidance: PlanData.workoutById['strength-b'].loadGuidance, exercises: PlanData.workoutById['strength-b'].exercises }, null);
  assert(untouched.ok && untouched.unchanged && !Store.library['strength-b'], 'saving an untouched built-in does not create an override');

  // ── 讀取時的形狀檢查 ──
  Store.library['strength-b'] = { kind: 'workoutOverride', content: { name: 'x', exercises: [] }, history: [], from: today };
  assert(!Store.workoutFor('strength-b').modified, 'malformed override (no exercises) falls back to JSON');
  Store.library['not-a-builtin'] = { kind: 'workoutOverride', content: v1, history: [], from: today };
  assert(Store.workoutFor('not-a-builtin') === null, 'override on unknown id is ignored');
  Store.library['strength-b'] = { kind: 'workoutOverride', content: v1, history: [{ until: 5, content: null }], from: today };
  assert(!Store.workoutFor('strength-b').modified, 'bad history entry invalidates the override');
  delete Store.library['strength-b']; delete Store.library['not-a-builtin'];
  // 舊版網頁的 _libraryDocOk（v0.12.x）不認得新 kind：用新 kind 就不會被列成自訂清單
  assert(Store.libraryList('workout').length === 0 && Store.libraryList('video').length === 0, 'no override leaks into custom lists');

  // ── 內建影片 ──
  const VID = 'deadbug-birddog';
  today = '2026-09-14';
  assert(Store.videoFor(VID).linkType === 'none', 'built-in none video resolves');
  const rv = Store.saveBuiltinOverride('video', VID, { title: '死蟲式示範', creator: '', linkType: 'video', url: 'https://www.youtube.com/watch?v=x', searchQuery: '', notes: '' }, null); ack();
  assert(rv.ok && Store.videoFor(VID, '2026-09-14').linkType === 'video' && Store.videoFor(VID, '2026-09-13').linkType === 'none', 'built-in video override from today only');
  const rbad = Store.saveBuiltinOverride('video', VID, { title: 'x', linkType: 'video', url: 'javascript:alert(1)' }, Store.library[VID].updatedAt);
  assert(!rbad.ok, 'built-in video override rejects non-https url');
  const rnone = Store.saveBuiltinOverride('video', 'pamela-daily-stretch', { title: '只寫說明', linkType: 'none' }, null); ack();
  const noneLinks = vm.runInContext('itemPlanParts', sandbox)({ id: 'nv', type: 'recovery', title: 'x', videoRef: 'pamela-daily-stretch' }, {}).body;
  assert(noneLinks.includes('class="item-link plain">只寫說明<') && !noneLinks.includes('play-circle'), 'linkType none renders plain text without play icon');
  assert(rnone.ok && Store.videoFor('pamela-daily-stretch').linkType === 'none', 'linkType none is accepted for built-in videos');

  // ── 自訂動作清單：改動也只從今天起 ──
  today = '2026-09-14';
  const c = Store.saveLibraryDoc(null, 'workout', { name: '自訂A', loadGuidance: '', exercises: [{ name: '棒式', sets: 2, holdSeconds: { min: 20, max: 30 } }] });
  assert(c.from === '2026-09-14' && J(c.history) === '[]', 'new custom workout starts with from today and empty history');
  Store.saveLibraryDoc(c.id, 'workout', { name: '自訂A', loadGuidance: '', exercises: [{ name: '棒式', sets: 3, holdSeconds: { min: 20, max: 30 } }] });
  assert(Store.library[c.id].history.length === 0 && Store.workoutFor(c.id).exercises[0].sets === 3, 'same-day custom edit replaces');
  today = '2026-09-20';
  Store.saveLibraryDoc(c.id, 'workout', { name: '自訂A', loadGuidance: '', exercises: [{ name: '側棒式', sets: 2, holdSeconds: { min: 20, max: 30 } }] });
  const cd = Store.library[c.id];
  assert(cd.history.length === 1 && cd.history[0].until === '2026-09-19' && cd.exercises[0].name === '側棒式', 'later custom edit archives previous content; top level is latest (old clients)');
  assert(Store.workoutFor(c.id, '2026-09-15').exercises[0].name === '棒式' && Store.workoutFor(c.id, '2026-09-20').exercises[0].name === '側棒式', 'custom workout resolves by date');
  const lastPush = pushed[pushed.length - 1].data;
  assert(Array.isArray(lastPush.history) && lastPush.from === '2026-09-20', 'custom edit pushes history and from');
  // 只改名稱以外沒變的欄位？內容沒變就不開新版本
  today = '2026-09-27';
  Store.saveLibraryDoc(c.id, 'workout', { name: '自訂A', loadGuidance: '', exercises: [{ name: '側棒式', sets: 2, holdSeconds: { min: 20, max: 30 } }] });
  assert(Store.library[c.id].history.length === 1, 'saving identical content on a later day does not add a version');
  // 舊的自訂文件（v0.12 以前，沒有 from/history）第一次改
  Store.library['c-old'] = { kind: 'workout', name: '舊清單', loadGuidance: '', exercises: [{ name: 'a', sets: 1, reps: { min: 1, max: 2 } }], deleted: false, updatedAt: '2026-09-10T00:00:00.000Z', fieldAt: {} };
  Store.saveLibraryDoc('c-old', 'workout', { name: '舊清單', loadGuidance: '', exercises: [{ name: 'b', sets: 1, reps: { min: 1, max: 2 } }] });
  assert(Store.workoutFor('c-old', '2026-09-26').exercises[0].name === 'a' && Store.workoutFor('c-old', '2026-09-27').exercises[0].name === 'b', 'pre-v0.13 custom doc gets history on first edit');

  // ── 用在幾天 ──
  today = '2026-09-14';
  const u = Store.libraryUsage('workout', BASIC);
  assert(u.total === 9 && u.upcoming === 8, 'usage counts pelvic-core-basic: 9 days, 8 from 9/14 on, got ' + J(u));
  const uv = Store.libraryUsage('video', 'fitnessblender-postpartum');
  assert(uv.total === 8, 'usage counts built-in video references, got ' + J(uv));

  // ── 畫面：卡片照日期挑版本、固定安全提醒、編輯按鈕只在教練卡 ──
  today = '2026-10-05'; // 這天 BASIC 是 v1（教練版）
  const itemParts = vm.runInContext('itemPlanParts', sandbox);
  const it = { id: '1-0-0', type: 'recovery', title: 'core', workoutRef: BASIC };
  App.setDetailsOpen('wo:1-0-0', true);
  const oldDay = itemParts(it, { dateKey: '2026-09-07' }).workoutBlock;
  const newDay = itemParts(it, { dateKey: '2026-10-05' }).workoutBlock;
  assert(oldDay.includes('組數次數依身體感覺調整即可') && !oldDay.includes('推導值') && oldDay.includes('骨盆底啟動呼吸'), 'past card shows JSON version with derived note');
  assert(newDay.includes('死蟲式') && !newDay.includes('推導值') && newDay.includes('慢慢來'), 'current card shows coach version with load guidance');
  assert(oldDay.includes('漏尿') && newDay.includes('漏尿'), 'safety note shown on both versions');
  assert(!newDay.includes('編輯這份動作清單'), 'no edit button without coachEdit');
  assert(itemParts(it, { dateKey: '2026-10-05', coachEdit: { weekNumber: 5, dayIndex: 0 } }).workoutBlock.includes(`A.startLibraryEditFromCard(5,0,'1-0-0','${BASIC}')`), 'coach card has edit button');
  const vidLink = itemParts({ id: 'v', type: 'recovery', title: 'v', videoRef: 'fitnessblender-postpartum' }, {}).body;
  assert(vidLink.includes('class="play-circle"') && vidLink.includes('pc-fg'), 'video link uses the circle play icon');

  // ── 編輯器：內建預填今天的版本、沒登入不能存、從卡片打開畫在卡上 ──
  Store.coachMode = true;
  App.startLibraryEdit('workout', 'strength-b');
  let le = App.state.libraryEdit;
  assert(le && le.builtin && le.baseUpdatedAt === null && le.draft.exercises.length === PlanData.workoutById['strength-b'].exercises.length, 'opening an unmodified built-in pre-fills JSON (used to silently do nothing)');
  const editorHtml = vm.runInContext('renderWorkoutEditor', sandbox)(le);
  assert(editorHtml.includes('固定的安全提醒（不能改）') && /儲存動作清單/.test(editorHtml) && /disabled onclick="A\.saveLibraryWorkout/.test(editorHtml), 'built-in editor: locked safety note, save disabled when signed out');
  assert(editorHtml.includes('A.moveLibExercise(1,-1)') && editorHtml.includes('maxlength="200"'), 'editor has reorder buttons and length limits');
  App.moveLibExercise(0, 1);
  assert(App.state.libraryEdit.draft.exercises[0].name === PlanData.workoutById['strength-b'].exercises[1].name, 'moveLibExercise swaps rows');
  App.startLibraryEditFromCard(5, 0, '1-0-0', BASIC);
  le = App.state.libraryEdit;
  assert(le.origin && le.origin.itemId === '1-0-0' && le.draft.name === '產後核心（教練版）' && le.baseUpdatedAt === Store.library[BASIC].updatedAt, 'from card: origin recorded, draft = today version, base = current updatedAt');
  const card = vm.runInContext('renderItemCard', sandbox)(5, 0, it, 0, 1, null, false, false);
  assert(card.includes('編輯動作清單') && card.includes('A.saveLibraryWorkout()'), 'item card is replaced by the editor for its origin');
  const otherCard = vm.runInContext('renderItemCard', sandbox)(5, 1, { ...it, id: '1-1-0' }, 0, 1, null, false, false);
  assert(!otherCard.includes('A.saveLibraryWorkout()'), 'other cards stay normal');
  App.openDay(5, 1);
  assert(App.state.libraryEdit === null, 'openDay closes the card editor');
  App.startLibraryEdit('workout', BASIC); App.toggleItemPicker(5, 0, '1-0-0');
  App.startLibraryEdit('workout', BASIC);
  assert(App.state.itemPicker === null, 'opening list editor closes the item picker');

  // 存檔走修改版路徑（假裝已登入）
  Sync.isSignedIn = () => true;
  today = '2026-10-19';
  App.state.libraryEdit.draft.name = '從編輯器存';
  const pushesBefore = overridePushes.length;
  App.saveLibraryWorkout(); ack();
  assert(overridePushes.length === pushesBefore + 1 && Store.workoutFor(BASIC, '2026-10-19').name === '從編輯器存' && App.state.libraryEdit === null, 'saveLibraryWorkout routes built-in edits through saveBuiltinOverride');
  // 設定頁：內建列、標籤、還原鈕
  const panel = vm.runInContext('renderLibraryPanel', sandbox)(App.state);
  assert(panel.includes('內建·已修改') && panel.includes(`A.restoreBuiltin('workout','${BASIC}')`) && panel.includes(`A.startLibraryEdit('workout','strength-a')`), 'settings panel lists built-ins with tags and restore');
  assert(panel.includes(`A.startLibraryEdit('video','fitnessblender-postpartum')`), 'settings panel lists built-in videos');
  App.restoreBuiltin('workout', BASIC); ack();
  assert(!Store.workoutFor(BASIC).modified && Store.workoutFor(BASIC, '2026-10-19').modified === false, 'restoreBuiltin reverts from today');

  // ── 存不進去時：編輯器連同草稿打開回來 ──
  App.startLibraryEdit('workout', 'strength-a');
  App.state.libraryEdit.draft.name = '改到一半的名字';
  App.saveLibraryWorkout();
  assert(App.state.libraryEdit === null, 'editor closes on save (optimistic)');
  overridePushes[overridePushes.length - 1].cb(false, '這份內容剛被別人改過，你這次的修改沒有存進去。');
  assert(App.state.libraryEdit && App.state.libraryEdit.draft.name === '改到一半的名字' && sandbox.__alerts.some((m) => m.includes('還在編輯器裡')), 'failed built-in save reopens editor with the draft and explains');
  App.cancelLibraryEdit();
  // 已刪除的自訂清單：卡片沒有編輯鈕，存檔講清楚原因
  const dc = Store.saveLibraryDoc(null, 'workout', { name: '要刪的', loadGuidance: '', exercises: [{ name: 'a', sets: 1, reps: { min: 1, max: 2 } }] });
  Store.deleteLibraryDoc(dc.id);
  assert(!itemParts({ id: 'dd', type: 'recovery', title: 'x', workoutRef: dc.id }, { dateKey: today, coachEdit: { weekNumber: 5, dayIndex: 0 } }).workoutBlock.includes('編輯這份動作清單'), 'deleted custom workout has no card edit button');
  App.state.libraryEdit = { kind: 'workout', id: dc.id, builtin: false, draft: { name: '要刪的', loadGuidance: '', exercises: [{ name: 'a', sets: 1, qty: 'reps', min: 1, max: 2, perSide: false, notes: '' }] } };
  App.saveLibraryWorkout();
  assert(sandbox.__alerts[sandbox.__alerts.length - 1].includes('已經從常用項目庫刪掉'), 'saving a deleted custom workout explains why');
  App.state.libraryEdit = null;
  // 讀取被拒：講規則沒發布，不是講要登入
  Sync.libraryDenied = true;
  const deniedHead = vm.runInContext('libraryEditorHead', sandbox)({ id: 'strength-a', builtin: true }, 'workout').head;
  assert(deniedHead.includes('規則還沒加上常用項目庫') && !deniedHead.includes('要先登入'), 'library denied shows the rules message');
  Sync.libraryDenied = false;

  // ── 沒登入的提示 ──
  Sync.isSignedIn = () => false; Sync.state = 'idle';
  App.state.page = 'week';
  Sync.authResolved = false;
  assert(!vm.runInContext('renderWeekPage', sandbox)(App.state).includes('還沒登入'), 'no signed-out banner before auth state is known (no flash on launch)');
  Sync.authResolved = true;
  const week = vm.runInContext('renderWeekPage', sandbox)(App.state);
  assert(week.includes('還沒登入，看到的課表可能不是最新的'), 'signed out with shared data in memory: says may be outdated');
  const savedLib = Store.library, savedOv = Store.planOverrides;
  Store.library = {}; Store.planOverrides = {};
  assert(vm.runInContext('renderWeekPage', sandbox)(App.state).includes('還沒登入，看到的是出廠課表'), 'signed out with nothing shared in memory: says factory plan');
  Store.library = savedLib; Store.planOverrides = savedOv;
  Sync.isSignedIn = () => true;
  assert(!vm.runInContext('renderWeekPage', sandbox)(App.state).includes('還沒登入，看到的是出廠課表'), 'no warning when signed in');
})();
