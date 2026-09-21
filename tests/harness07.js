// 決策紀錄第 26 條：常用項目庫（Store 層）
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
vm.runInContext('this.PlanData = PlanData; this.Store = Store; this.Sync = Sync;', sandbox);
function assert(c, m) { console.log((c ? 'PASS' : 'FAIL') + ': ' + m); if (!c) process.exitCode = 1; }
(async () => {
  await sandbox.PlanData.load();
  const { Store, PlanData } = sandbox;
  Store.activeUserId = 'mick'; Store.init();
  const pushed = [];
  Store._cloudPush = () => {};
  Store._cloudPushLibrary = (id, data) => pushed.push({ id, data });

  // ── 常用項目：從課表項目存一份 ──
  const src = PlanData.plan.weeks[0].days[1].items[0]; // W1 週二 Zone 2 跑
  const tpl = Store.saveLibraryDoc(null, 'item', { name: src.title, item: src });
  assert(tpl && tpl.id.startsWith('c-'), 'item template saved with c- id, got ' + (tpl && tpl.id));
  assert(tpl.item.title === src.title && tpl.item.duration.min === src.duration.min, 'template copies item fields');
  assert(!('id' in tpl.item) && !('derived' in tpl.item), 'template item carries no id/derived');
  assert(pushed.length === 1 && pushed[0].id === tpl.id && pushed[0].data.kind === 'item', 'save pushes to cloud with kind');
  assert(Store.libraryList('item').length === 1, 'libraryList(item) lists it');
  // 複製式：改範本本身不會回頭改到課表來源
  Store.saveLibraryDoc(tpl.id, 'item', { name: '改名', item: { ...src, title: '改過的標題' } });
  assert(PlanData.plan.weeks[0].days[1].items[0].title === src.title, 'editing template does not touch the plan item');
  assert(Store.libraryDoc(tpl.id).name === '改名', 'template renamed');

  // ── 自訂動作清單 ──
  const wo = Store.saveLibraryDoc(null, 'workout', {
    name: '產後核心（Phase 2 版）', loadGuidance: '徒手',
    exercises: [
      { name: '死蟲式', sets: 2, reps: { min: 12, max: 8 }, perSide: true, notes: '' }, // min/max 打反
      { name: '棒式', sets: 3, holdSeconds: { min: 20, max: 30 } },
      { name: '', sets: 2, reps: { min: 5, max: 5 } }, // 名稱空白：略過
    ],
  });
  assert(wo && wo.exercises.length === 2, 'workout saved, blank-name row dropped, got ' + (wo && wo.exercises.length));
  assert(wo.exercises[0].reps.min === 8 && wo.exercises[0].reps.max === 12, 'reversed reps range normalized');
  assert(wo.exercises[1].reps === null && wo.exercises[1].holdSeconds.max === 30, 'hold-seconds exercise kept as hold');
  assert(Store.workoutById(wo.id) && Store.workoutById(wo.id).name === wo.name, 'workoutById resolves custom workout');
  assert(Store.workoutById('pelvic-core-basic').name === '產後核心／骨盆底啟動', 'workoutById still resolves built-in');
  assert(Store.allWorkouts().length === PlanData.workouts.length + 1, 'allWorkouts = built-in + custom');
  assert(Store.saveLibraryDoc(null, 'workout', { name: 'x', exercises: [{ name: 'a', sets: 0, reps: { min: 1, max: 2 } }] }) === null, 'sets 0 rejected');
  assert(Store.saveLibraryDoc(null, 'workout', { name: '', exercises: [{ name: 'a', sets: 1, reps: { min: 1, max: 2 } }] }) === null, 'empty workout name rejected');

  // ── 自訂影片 ──
  const vs = Store.saveLibraryDoc(null, 'video', { title: '骨盆底放鬆', linkType: 'search', searchQuery: 'pelvic floor relax', url: 'https://ignored' });
  assert(vs && vs.url === null && vs.searchQuery === 'pelvic floor relax', 'search video stores keyword, drops url');
  const vu = Store.saveLibraryDoc(null, 'video', { title: '貼網址', linkType: 'video', url: 'https://www.youtube.com/watch?v=abc' });
  assert(vu && vu.url.startsWith('https://') && vu.searchQuery === null, 'url video stores https url');
  assert(Store.saveLibraryDoc(null, 'video', { title: 'bad', linkType: 'video', url: 'javascript:alert(1)' }) === null, 'javascript: url rejected');
  assert(Store.saveLibraryDoc(null, 'video', { title: 'bad', linkType: 'video', url: 'http://example.com' }) === null, 'plain http url rejected');
  assert(Store.saveLibraryDoc(null, 'video', { title: '', linkType: 'search', searchQuery: 'x' }) === null, 'empty title rejected');
  assert(Store.videoById('fitnessblender-postpartum').creator === 'Fitness Blender', 'videoById still resolves built-in');
  assert(Store.allVideos().length === PlanData.videos.length + 2, 'allVideos = built-in + 2 custom');

  // ── 軟刪除：從清單拿掉，但被引用的照樣查得到 ──
  Store.deleteLibraryDoc(wo.id);
  assert(Store.libraryList('workout').length === 0, 'deleted workout hidden from list');
  assert(Store.workoutById(wo.id) && Store.workoutById(wo.id).exercises.length === 2, 'deleted workout still resolvable for existing references');
  assert(Store.allWorkouts().length === PlanData.workouts.length, 'deleted workout not offered in pickers');
  const lastPush = pushed[pushed.length - 1];
  assert(lastPush.id === wo.id && lastPush.data.deleted === true, 'delete pushes deleted:true (applyPatch would have forced false)');

  // ── kind 不能被改掉 ──
  assert(Store.saveLibraryDoc(vs.id, 'workout', { name: 'x', exercises: [{ name: 'a', sets: 1, reps: { min: 1, max: 1 } }] }) === null, 'cannot overwrite a video doc as a workout');

  // ── 遠端合併：逐欄位，較新的贏 ──
  const later = new Date(Date.now() + 60000).toISOString();
  Store.mergeRemoteLibrary(vs.id, { title: '遠端改過', updatedAt: later, fieldAt: { title: later } });
  assert(Store.libraryDoc(vs.id).title === '遠端改過' && Store.libraryDoc(vs.id).searchQuery === 'pelvic floor relax', 'remote merge takes newer field, keeps others');
  Store.mergeRemoteLibrary('c-from-other-device', { kind: 'item', name: '別台存的', item: { type: 'run', title: 'X' }, updatedAt: later, fieldAt: {} });
  assert(Store.libraryList('item').some((t) => t.name === '別台存的'), 'remote-only doc appears');

  // ── 審查修正 1：deleted 時間戳 ──
  const fresh = Store.saveLibraryDoc(null, 'video', { title: '新影片', linkType: 'search', searchQuery: 'q' });
  const pFresh = pushed[pushed.length - 1].data;
  assert(pFresh.deleted === false && pFresh.fieldAt && pFresh.fieldAt.deleted, 'new doc pushes deleted:false WITH a fieldAt stamp');
  Store.saveLibraryDoc(fresh.id, 'video', { title: '新影片改名', linkType: 'search', searchQuery: 'q' });
  const pEdit = pushed[pushed.length - 1].data;
  assert(!('deleted' in pEdit), 'editing an existing doc does not send deleted at all, got ' + JSON.stringify(Object.keys(pEdit)));
  Store.deleteLibraryDoc(fresh.id);
  assert(Store.saveLibraryDoc(fresh.id, 'video', { title: '復活', linkType: 'search', searchQuery: 'q' }) === null, 'saving onto a deleted doc is refused');
  assert(Store.libraryDoc(fresh.id).deleted === true, 'deleted doc stays deleted');
  // 模擬：別台刪除（t2）之後，這台才收到自己更早的編輯回音——刪除要贏
  const t1 = new Date(Date.now() + 1000).toISOString(), t2 = new Date(Date.now() + 2000).toISOString();
  const racy = Store.saveLibraryDoc(null, 'workout', { name: 'R', exercises: [{ name: 'a', sets: 1, reps: { min: 1, max: 1 } }] });
  Store.mergeRemoteLibrary(racy.id, { deleted: true, updatedAt: t2, fieldAt: { deleted: t2 } });
  Store.mergeRemoteLibrary(racy.id, { name: 'R2', updatedAt: t1, fieldAt: { name: t1 } });
  assert(Store.libraryDoc(racy.id).deleted === true && Store.libraryList('workout').every((w) => w.id !== racy.id), 'later delete beats an earlier edit echo');

  // ── 審查修正 3：壞掉的遠端文件不會讓畫面炸掉 ──
  Store.mergeRemoteLibrary('c-bad-workout', { kind: 'workout', name: 'x', updatedAt: t1 });
  Store.mergeRemoteLibrary('c-bad-item', { kind: 'item', name: 'y', updatedAt: t1 });
  Store.mergeRemoteLibrary('c-bad-video', { kind: 'video', title: 'z', linkType: 'video', updatedAt: t1 });
  assert(!Store.libraryList('workout').some((w) => w.id === 'c-bad-workout'), 'workout without exercises filtered out');
  assert(!Store.libraryList('item').some((t) => t.id === 'c-bad-item'), 'item template without item filtered out');
  assert(!Store.libraryList('video').some((v) => v.id === 'c-bad-video'), 'url video without url filtered out');
  assert(Store.workoutById('c-bad-workout') === null && Store.videoById('c-bad-video') === null, 'lookups return null for malformed docs');

  // ── 審查修正 2：沒登入時存的，第一次伺服器快照補推 ──
  const Sync = sandbox.Sync;
  const bfPushed = [];
  const origPush = Sync.pushLibrary;
  Sync.pushLibrary = (id, data) => bfPushed.push({ id, data });
  const offlineOnly = Store.saveLibraryDoc(null, 'video', { title: '離線存的', linkType: 'search', searchQuery: 'k' });
  // 雲端有 vs（遠端版本 title 比本機新），本機的 notes 比雲端新
  const vsLocal = Store.library[vs.id];
  const remoteVs = { ...vsLocal, title: '雲端更新', fieldAt: { ...vsLocal.fieldAt, title: new Date(Date.now() + 90000).toISOString() } };
  Store.mergeRemoteLibrary(vs.id, remoteVs);
  Store.library[vs.id].notes = '本機離線補的備註';
  Store.library[vs.id].fieldAt = { ...Store.library[vs.id].fieldAt, notes: new Date(Date.now() + 120000).toISOString() };
  const snap = { forEach: (fn) => [{ id: vs.id, data: () => remoteVs }].forEach(fn) };
  bfPushed.length = 0;
  Sync._backfillLibrary(snap);
  const pOffline = bfPushed.find((p) => p.id === offlineOnly.id);
  const pVs = bfPushed.find((p) => p.id === vs.id);
  assert(pOffline && pOffline.data.title === '離線存的' && pOffline.data.kind === 'video', 'doc missing from cloud is pushed whole');
  assert(pVs && pVs.data.notes === '本機離線補的備註' && !('title' in pVs.data), 'doc present in cloud: only locally-newer fields pushed, got ' + JSON.stringify(pVs && Object.keys(pVs.data)));
  Sync.pushLibrary = origPush;

  // ── 審查修正 5：重試會重掛庫的訂閱 ──
  let attached = 0;
  const saved = { isSignedIn: Sync.isSignedIn, _detachListeners: Sync._detachListeners, _attachListeners: Sync._attachListeners, _backfillLocal: Sync._backfillLocal, _attachLibrary: Sync._attachLibrary, _detachLibrary: Sync._detachLibrary };
  Object.assign(Sync, { isSignedIn: () => true, _detachListeners: () => {}, _attachListeners: () => {}, _backfillLocal: () => {}, _detachLibrary: () => {}, _attachLibrary: () => { attached++; } });
  Sync.libraryDenied = true;
  Sync.resubscribe();
  assert(attached === 1 && Sync.libraryDenied === false, 'resubscribe re-attaches library and clears libraryDenied');
  Object.assign(Sync, saved);

  console.log('done');
})();
