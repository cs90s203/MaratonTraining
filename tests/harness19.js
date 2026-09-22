// 決策紀錄第 52 條：改常用項目 → 今天以後用到它的課表跟著改（只套改了的欄位、影片補上、單獨改過的時間不動、今天以前不動）
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
  const pushed = []; Store._cloudPushPlanWeek = (uid, wn) => pushed.push(wn);
  Store.coachMode = true;
  const today = PlanData.dayKey(PlanData.today());
  const z2 = () => { const out = []; PlanData.plan.weeks.forEach((w) => Store.effectiveWeek(w.weekNumber).days.forEach((d, di) => d.items.forEach((it) => { if (it.title === 'Zone 2 跑') out.push({ wn: w.weekNumber, di, key: PlanData.keyForWeekDay(w.weekNumber, di), it }); }))); return out; };
  const factory = z2();
  const past = factory.filter((x) => x.key < today), future = factory.filter((x) => x.key >= today);
  const vid = 'deadbug-birddog';

  // 範本：從某個 Zone 2 跑存成常用（跟她的做法一樣），之後加熱身影片
  const src = future[0].it;
  const t = Store.saveLibraryDoc(null, 'item', { name: 'Zone 2 跑', item: src });
  const oldItem = JSON.parse(JSON.stringify(t.item));
  // 第 56 條：三個人的課表都算；畫面上講的天數同一天只算一次
  assert(Store.templateUsageDays(t.id, t.item) === future.length && Store.templateUsage(t.id, t.item).length === future.length * PlanData.users.length, `usage counts every Zone 2 跑 from today on (${future.length} days, in all ${PlanData.users.length} plans)`);
  const edited = Store.saveLibraryDoc(t.id, 'item', { name: 'Zone 2 跑', item: { ...t.item, videoRefs: [vid], videoRef: vid } });
  const n = App._applyTemplateToPlan(t.id, oldItem, edited.item);
  const after = z2();
  const fut2 = after.filter((x) => x.key >= today), past2 = after.filter((x) => x.key < today);
  assert(n === future.length && fut2.every((x) => PlanData.itemVideoRefs(x.it).includes(vid) && x.it.templateId === t.id), `added video applied to all ${n} Zone 2 跑 days from today`);
  assert(past2.every((x) => !PlanData.itemVideoRefs(x.it).includes(vid) && !x.it.templateId), 'days before today untouched');
  const inPlan = (uid) => { const x = future[0]; return Store.effectiveWeek(x.wn, uid).days[x.di].items.find((it) => it.id === x.it.id); };
  assert(['Annlin', 'Phoebe'].every((uid) => PlanData.itemVideoRefs(inPlan(uid)).includes(vid) && inPlan(uid).templateId === t.id), 'library change reaches Annlin and Phoebe too (each in her own plan)');
  const notesBefore = J(future.map((x) => [x.it.notes, x.it.duration]));
  assert(J(fut2.map((x) => [x.it.notes, x.it.duration])) === notesBefore, 'each day keeps its own notes and time (only the changed field was applied)');

  // 再按一次儲存（沒改東西）：不重複加、影片還在
  const nAgain = App._applyTemplateToPlan(t.id, edited.item, edited.item);
  assert(nAgain === 0 && z2().filter((x) => x.key >= today).every((x) => PlanData.itemVideoRefs(x.it).filter((r) => r === vid).length === 1), 're-saving without changes changes nothing (no duplicate videos)');

  // 已經存過、當時沒套上的影片：再按一次儲存就補上（舊的課表項目還沒有 templateId）
  const t2 = Store.saveLibraryDoc(null, 'item', { name: '輕鬆跑', item: { type: 'run', title: '輕鬆跑', videoRefs: [vid], videoRef: vid } });
  const easyFuture = () => { const out = []; PlanData.plan.weeks.forEach((w) => Store.effectiveWeek(w.weekNumber).days.forEach((d, di) => d.items.forEach((it) => { if (it.title === '輕鬆跑' && PlanData.keyForWeekDay(w.weekNumber, di) >= today) out.push(it); }))); return out; };
  const nEasy = App._applyTemplateToPlan(t2.id, t2.item, t2.item);
  assert(nEasy === easyFuture().length && easyFuture().every((it) => PlanData.itemVideoRefs(it).includes(vid)), `saving again fills in videos that were added before (${nEasy} 輕鬆跑 days)`);

  // 改時間：還是舊時間的跟著改，單獨改過的不動
  const tA = Store.saveLibraryDoc(null, 'item', { name: '間歇 300 x 4', item: { type: 'interval', title: '間歇 300 x 4', duration: { min: 35, max: 40 } } });
  const W = PlanData.locateToday().weekNumber + 2;
  const pick = (d) => d.items.find((it) => it.type !== 'rest' && it.title !== 'Zone 2 跑' && !it.templateId);
  const runDays = Store.effectiveWeek(W).days.map((d, di) => di).filter((di) => !Store.effectiveWeek(W).days[di].selectOne && pick(Store.effectiveWeek(W).days[di])).slice(0, 2);
  assert(runDays.length === 2, 'test setup: two days to swap to the interval template');
  if (runDays.length === 2) {
    runDays.forEach((di) => App.swapItemFromLibrary(W, di, pick(Store.effectiveWeek(W).days[di]).id, tA.id));
    const linked = () => runDays.map((di) => Store.effectiveWeek(W).days[di].items.find((it) => it.templateId === tA.id));
    assert(linked().every((it) => it && it.templateId === tA.id), 'swapping from the library links the item (templateId)');
    const custom = linked()[1];
    const amtEl = { closest: () => ({ dataset: { amt: 'duration' }, querySelectorAll: () => [{ value: '50' }, { value: '55' }] }) };
    App.setItemAmount(W, runDays[1], custom.id, amtEl);
    const newT = Store.saveLibraryDoc(tA.id, 'item', { name: '間歇 300 x 4', item: { ...tA.item, duration: { min: 45, max: 45 }, notes: '跑不動就停' } });
    App._applyTemplateToPlan(tA.id, tA.item, newT.item);
    const [a, b] = linked();
    assert(J(a.duration) === J({ min: 45, max: 45 }) && a.notes === '跑不動就停', 'item still on the old template time follows the new time and notes');
    assert(J(b.duration) === J({ min: 50, max: 55 }) && b.notes === '跑不動就停', 'item whose time was changed that day keeps its time (notes still follow)');
    // 改名：連著的照樣對得到
    const renamed = Store.saveLibraryDoc(tA.id, 'item', { name: '間歇 400 x 4', item: { ...newT.item, title: '間歇 400 x 4' } });
    App._applyTemplateToPlan(tA.id, newT.item, renamed.item);
    assert(linked().every((it) => it.title === '間歇 400 x 4'), 'rename reaches linked items by templateId');
    // 拿掉影片
    const withV = Store.saveLibraryDoc(tA.id, 'item', { name: '間歇 400 x 4', item: { ...renamed.item, videoRefs: [vid], videoRef: vid } });
    App._applyTemplateToPlan(tA.id, renamed.item, withV.item);
    const noV = Store.saveLibraryDoc(tA.id, 'item', { name: '間歇 400 x 4', item: { ...withV.item, videoRefs: [], videoRef: null } });
    App._applyTemplateToPlan(tA.id, withV.item, noV.item);
    assert(linked().every((it) => !PlanData.itemVideoRefs(it).includes(vid)), 'removing a video from the template removes it from the days');
  }

  // 連著別的常用項目的，同名也不動
  const other = Store.saveLibraryDoc(null, 'item', { name: 'Zone 2 跑', item: { type: 'run', title: 'Zone 2 跑', duration: { min: 60, max: 60 } } });
  const linkedToFirst = z2().filter((x) => x.key >= today)[0];
  const beforeOther = J(linkedToFirst.it);
  App._applyTemplateToPlan(other.id, other.item, { ...other.item, notes: '別的範本' });
  assert(J(z2().filter((x) => x.key >= today)[0].it) === beforeOther, 'items linked to another template are not touched even with the same title');

  // 表單上講清楚範圍
  const form = vm.runInContext('renderTemplateForm', sandbox)({ id: t.id, name: 'Zone 2 跑', item: edited.item });
  assert(form.includes('存檔後，三個人課表裡今天起用到這個項目的') && form.includes(`<b>${future.length}</b>`), 'library form tells how many days from today will follow (all three plans, each day once)');
})();
