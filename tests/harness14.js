// 決策紀錄第 43 條：教練模式拖曳改課表、項目庫新增常用項目、複製（第 56 條之後改的是 planUserId 那個人的課表）
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
const J = (x) => JSON.stringify(x);
(async () => {
  await sandbox.PlanData.load();
  const { PlanData, Store, App } = sandbox;
  Store.activeUserId = 'mick'; Store.init(); Store._cloudPush = () => {}; Store._cloudPushLibrary = () => {};
  const pushedWeeks = [];
  Store._cloudPushPlanWeek = (uid, wn, doc) => pushedWeeks.push({ uid, wn, doc });
  Store.coachMode = true;

  // 決策紀錄第 50 條：教練拖曳＝兩天對調；這週也可以，今天以前的日子不行
  const W = PlanData.locateToday().weekNumber + 1;
  const before = Store.effectiveWeek(W).days.map((d) => d.items.map((it) => it.id).join('+'));
  App.state.expandedDay = { weekNumber: W, dayIndex: 5 };
  App.swapPlanWeekDays(W, 5, 1); // 週六跟週二對調
  const after = Store.effectiveWeek(W);
  assert(after.days[1].items.map((it) => it.id).join('+') === before[5] && after.days[5].items.map((it) => it.id).join('+') === before[1], 'Saturday and Tuesday exchanged');
  assert([0, 2, 3, 4, 6].every((i) => after.days[i].items.map((it) => it.id).join('+') === before[i]), 'other days untouched (swap, not insert)');
  assert(after.days.every((d, i) => d.dayIndex === i) && !!after.layoutAt, 'dayIndex renumbered, layoutAt stamped');
  assert(pushedWeeks.length === 1 && pushedWeeks[0].wn === W && pushedWeeks[0].uid === 'mick', "Mick's own week saved (pushed to cloud)");
  assert(J(App.state.expandedDay) === J({ weekNumber: W, dayIndex: 1 }), 'expanded row follows its content');

  // 這週（已經開始）：今天以後的日子可以換；牽涉到今天要確認；今天以前不行
  const TW = PlanData.locateToday().weekNumber, TD = PlanData.locateToday().dayIndex;
  const todayKey = PlanData.dayKey(PlanData.today());
  const futureA = [0, 1, 2, 3, 4, 5, 6].filter((i) => PlanData.keyForWeekDay(TW, i) > todayKey);
  if (futureA.length >= 2) {
    const b0 = Store.effectiveWeek(TW).days.map((d) => d.items.map((it) => it.id).join('+'));
    const n0 = pushedWeeks.length;
    App.swapPlanWeekDays(TW, futureA[0], futureA[1]);
    const a0 = Store.effectiveWeek(TW).days.map((d) => d.items.map((it) => it.id).join('+'));
    assert(pushedWeeks.length === n0 + 1 && a0[futureA[0]] === b0[futureA[1]] && a0[futureA[1]] === b0[futureA[0]], 'current week: two future days can be exchanged');
  }
  if (futureA.length >= 1) {
    sandbox.confirm = (m) => { sandbox.__confirmMsg = m; return false; };
    const b1 = J(Store.effectiveWeek(TW).days.map((d) => d.items.map((it) => it.id)));
    App.swapPlanWeekDays(TW, TD, futureA[0]);
    assert(J(Store.effectiveWeek(TW).days.map((d) => d.items.map((it) => it.id))) === b1 && /不要再做一次/.test(sandbox.__confirmMsg || ''), 'swap involving today asks first (declined = nothing changes)');
    sandbox.confirm = () => true;
    App.swapPlanWeekDays(TW, TD, futureA[0]);
    assert(J(Store.effectiveWeek(TW).days.map((d) => d.items.map((it) => it.id))) !== b1, 'confirmed: today can be exchanged');
  }
  const b2 = J(Store.effectiveWeek(1).days.map((d) => d.items.map((it) => it.id)));
  const nA = sandbox.__alerts.length;
  App.swapPlanWeekDays(1, 5, 3);
  assert(J(Store.effectiveWeek(1).days.map((d) => d.items.map((it) => it.id))) === b2 && sandbox.__alerts.length === nA + 1 && sandbox.__alerts[nA].includes('今天以前'), 'past days cannot be exchanged');

  // 畫面：過去的日子鎖住、沒有把手；今天以後有把手；說明是「對調」
  App.state.page = 'week';
  App.state.weekViewNumber = 1;
  const html1 = vm.runInContext('renderWeekPage', sandbox)(App.state);
  assert(html1.includes('data-coach="1"') && (html1.match(/weekday-acc[^"]*locked/g) || []).length === 7 && !html1.includes('class="drag-handle"'), 'coach mode past week: all rows locked, no handles');
  App.state.weekViewNumber = TW;
  const htmlT = vm.runInContext('renderWeekPage', sandbox)(App.state);
  const lockedT = [0, 1, 2, 3, 4, 5, 6].filter((i) => PlanData.keyForWeekDay(TW, i) < todayKey).length;
  assert((htmlT.match(/weekday-acc[^"]*locked/g) || []).length === lockedT && (htmlT.match(/class="drag-handle"/g) || []).length === 7 - lockedT, 'coach mode current week: handles on today and later only');
  App.state.weekViewNumber = W;
  const html3 = vm.runInContext('renderWeekPage', sandbox)(App.state);
  assert((html3.match(/class="drag-handle"/g) || []).length === 7 && html3.includes('兩天的課表直接對調') && html3.includes('Mick 的課表'), 'coach mode future week: 7 handles and the swap hint');
  Store.coachMode = false;
  App.state.weekViewNumber = W - 1;
  const htmlUser = vm.runInContext('renderWeekPage', sandbox)(App.state);
  assert(htmlUser.includes('data-coach="0"') && (htmlUser.match(/class="drag-handle"/g) || []).length === 7 && !htmlUser.includes('這週已經開始'), 'normal mode: this week still has personal drag handles');
  Store.coachMode = true;

  // ── 複製：打開預填好的新內容，按存檔才建立 ──
  const tpl = Store.saveLibraryDoc(null, 'item', { name: '間歇 400', item: { type: 'interval', title: '間歇跑', duration: { min: 40, max: 40 }, segments: [{ kind: 'repeat', times: 4, steps: [{ kind: 'main', amount: { unit: 'm', min: 400, max: 400 }, zone: null, note: '' }] }] } });
  const nItems = Store.libraryList('item').length;
  App.duplicateLibraryDoc('item', tpl.id);
  const le = App.state.libraryEdit;
  assert(le && le.kind === 'item' && le.id === 'new' && le.prefill.name === '間歇 400（複本）' && le.prefill.item.segments[0].times === 4 && le.scrollOnce, 'duplicate item opens an unsaved prefilled form (scrolls into view)');
  assert(Store.libraryList('item').length === nItems, 'nothing is saved until 存檔');
  le.prefill.item.segments[0].times = 99;
  assert(Store.libraryDoc(tpl.id).item.segments[0].times === 4, 'prefill is a deep copy');
  le.prefill.item.segments[0].times = 4;
  const dupPanel = vm.runInContext('renderLibraryPanel', sandbox)(App.state);
  assert(dupPanel.includes('id="tpl-edit-new"') && dupPanel.includes('value="間歇 400（複本）"') && dupPanel.includes('data-seg="repeat"'), 'library panel renders the copy form prefilled');
  App.cancelLibraryEdit();
  assert(Store.libraryList('item').length === nItems && !App.state.libraryEdit, 'cancel leaves no copy behind');

  const nW = Store.libraryList('workout').length;
  App.duplicateLibraryDoc('workout', 'strength-a');
  assert(App.state.libraryEdit.draft.name.endsWith('（複本）') && App.state.libraryEdit.draft.exercises.length === PlanData.workoutById['strength-a'].exercises.length && !App.state.libraryEdit.builtin && Store.libraryList('workout').length === nW, 'duplicate built-in workout: unsaved custom draft');
  App.saveLibraryWorkout();
  const wcopy = Store.libraryList('workout').find((w) => w.name.endsWith('（複本）'));
  assert(wcopy && Store.libraryList('workout').length === nW + 1 && !Store.builtinModified('workout', 'strength-a'), 'save creates exactly one custom copy; built-in untouched');

  const PB = 'pelvic-core-basic';
  App.duplicateLibraryDoc('workout', PB);
  assert(App.state.libraryEdit.safetyNote === PlanData.workoutById[PB].safetyNote && App.state.libraryEdit.copiedFrom === PB, 'copy editor shows the locked safety note');
  App.saveLibraryWorkout();
  const pcopy = Store.libraryList('workout').find((w) => w.name === Store.workoutFor(PB).name + '（複本）');
  assert(pcopy && Store.workoutFor(pcopy.id).safetyNote === PlanData.workoutById[PB].safetyNote, 'saved copy of a built-in workout keeps the fixed safety note');
  App.startLibraryEdit('workout', pcopy.id);
  App.state.libraryEdit.draft.name = '改名';
  App.saveLibraryWorkout();
  assert(Store.workoutFor(pcopy.id).name === '改名' && Store.workoutFor(pcopy.id).safetyNote === PlanData.workoutById[PB].safetyNote, 'editing the copy cannot remove the safety note');
  Store.saveLibraryDoc(pcopy.id, 'workout', { name: '改名2', loadGuidance: '', exercises: [{ name: '橋式', sets: 2, reps: { min: 8, max: 10 } }], copiedFrom: null });
  assert(Store.workoutFor(pcopy.id).safetyNote === PlanData.workoutById[PB].safetyNote, 'a later save with copiedFrom:null does not clear it');
  App.duplicateLibraryDoc('workout', pcopy.id);
  assert(App.state.libraryEdit.copiedFrom === PB, 'copy of the copy carries copiedFrom');
  App.saveLibraryWorkout();
  const pcopy2 = Store.libraryList('workout').find((w) => w.name === '改名2（複本）');
  assert(pcopy2 && Store.workoutFor(pcopy2.id).safetyNote === PlanData.workoutById[PB].safetyNote, 'copy of the copy keeps the safety note');
  const plain = Store.saveLibraryDoc(null, 'workout', { name: '自己的', loadGuidance: '', exercises: [{ name: 'x', sets: 1, reps: { min: 1, max: 1 } }], copiedFrom: 'nope' });
  assert(!Store.workoutFor(plain.id).safetyNote && !Store.library[plain.id].copiedFrom, 'unknown copiedFrom is ignored');

  App.duplicateLibraryDoc('video', 'deadbug-birddog');
  assert(App.state.libraryEdit.draft.title.endsWith('（複本）') && App.state.libraryEdit.draft.linkType === 'none', 'duplicate built-in video: draft keeps linkType none');
  App.saveLibraryVideo();
  const vcopy = Store.libraryList('video').find((v) => v.title.endsWith('（複本）'));
  assert(vcopy && vcopy.linkType === 'none', 'saved video copy keeps linkType none');

  // ── 畫面停在舊排列時，別人搬過天：不照位置存 ──
  const W4 = W + 1;
  Store.markPlanSeen(); // 畫面畫好
  const remote = JSON.parse(JSON.stringify(Store.effectiveWeek(W4)));
  const [mv] = remote.days.splice(5, 1); remote.days.splice(2, 0, mv);
  remote.days = remote.days.map((d, i) => ({ ...d, dayIndex: i }));
  Store.mergeRemotePlanWeek('mick', W4, { ...remote, weekNumber: W4, updatedAt: '2026-09-14T12:00:00.000Z', layoutAt: '2026-09-14T12:00:00.000Z' }); // 另一台裝置搬了天，這台表單開著，沒重畫
  const nPush2 = pushedWeeks.length, nAlert2 = sandbox.__alerts.length;
  App.swapPlanWeekDays(W4, 3, 4);
  assert(pushedWeeks.length === nPush2 && sandbox.__alerts.length === nAlert2 + 1 && sandbox.__alerts[nAlert2].includes('剛被別人搬動過'), 'stale screen: swap after someone else moved days is refused');
  const noteBefore = J(Store.effectiveWeek(W4));
  const wk = App._cloneEffectiveWeek(W4); wk.days[2].items[0].title = '改到錯的那天';
  assert(Store.savePlanWeek('mick', W4, wk) === null && J(Store.effectiveWeek(W4)) === noteBefore, 'stale screen: any positional save is refused');
  Store.markPlanSeen(); // 重畫之後
  App.swapPlanWeekDays(W4, 3, 4);
  assert(pushedWeeks.length === nPush2 + 1, 'after re-render the swap goes through');
  const wk2 = App._cloneEffectiveWeek(W4); wk2.days[0].items[0].title = Store.effectiveWeek(W4).days[0].items[0].title;
  assert(Store.savePlanWeek('mick', W4, wk2, { silent: true }) !== null, 'own consecutive save without re-render is not refused');
  Store.resetPlanWeek('mick', W4);
  assert(Store.savePlanWeek('mick', W4, App._cloneEffectiveWeek(W4)) !== null, 'own reset then save is not refused');

  // ── 項目庫：新增常用項目的表單 ──
  App.state.libraryEdit = { kind: 'item', id: 'new', draft: null };
  const panel = vm.runInContext('renderLibraryPanel', sandbox)(App.state);
  assert(panel.includes('id="tpl-edit-new"') && panel.includes("A.saveTemplateEdit('new')") && panel.includes('seg-editor') && panel.includes('套用間歇範本'), 'new item template form (with segment editor and interval template) in the library');
  App.state.libraryEdit = null;
  const panel2 = vm.runInContext('renderLibraryPanel', sandbox)(App.state);
  assert(panel2.includes("A.startLibraryEdit('item','new')") && (panel2.match(/A\.duplicateLibraryDoc\(/g) || []).length === Store.libraryList('item').length + Store.allWorkouts().length + Store.allVideos().length, 'library has ＋新增常用項目 and 複製 on every row');
})();
