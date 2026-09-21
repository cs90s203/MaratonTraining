// 決策紀錄第 54 條（教練備註）＋第 55 條（休息日可以排選做的恢復運動）
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
(async () => {
  await sandbox.PlanData.load();
  const { PlanData, Store, App } = sandbox;
  Store.activeUserId = 'mick'; Store.init(); Store._cloudPush = () => {}; Store._cloudPushLibrary = () => {};
  const pushes = []; Store._cloudPushPlanOverride = (wn) => pushes.push(wn);
  Store.coachMode = true;
  const W = PlanData.locateToday().weekNumber + 1;
  const D = Store.effectiveWeek(W).days.findIndex((d) => !d.selectOne && d.items.some((it) => it.type === 'run'));
  const it = Store.effectiveWeek(W).days[D].items.find((x) => x.type === 'run');
  const card = () => { const d = Store.effectiveWeek(W).days[D]; const i = d.items.findIndex((x) => x.id === it.id); return fn('renderItemCard')(W, D, d.items[i], i, d.items.length, null, false, false, fn('isRestDay')(d)); };

  // ── 第 54 條：教練備註 ──
  let html = card();
  assert(html.includes(`A.startItemNote(${W},${D},'${it.id}')`) && html.includes('＋ 備註') && !html.includes('item-coach-note') && !html.includes('coach-note-edit'), 'no note: only a small ＋ 備註 button, no empty box');
  App.startItemNote(W, D, it.id);
  html = card();
  assert(html.includes('coach-note-edit') && html.includes(`data-note-item="${it.id}"`) && !html.includes('＋ 備註'), '＋ 備註 opens a text box in the card');
  App.saveItemNote(W, D, it.id, { value: '  今天改跑步機，心率照舊 <b>x</b>  ' });
  const saved = Store.effectiveWeek(W).days[D].items.find((x) => x.id === it.id);
  assert(saved.coachNote === '今天改跑步機，心率照舊 <b>x</b>' && App.state.noteEdit === null && pushes.length === 1, 'leaving the box saves the (trimmed) note to the plan');
  html = card();
  assert(html.includes('item-coach-note') && html.includes('今天改跑步機，心率照舊 &lt;b&gt;x&lt;/b&gt;') && html.includes('改備註'), 'saved note shows on the card (escaped), button says 改備註');
  const rec = fn('renderDayRecordCard')(W, D, Store.effectiveWeek(W).days[D], null, true);
  assert(rec.includes('item-coach-note') && rec.includes('今天改跑步機'), 'runners see the note on their record card');
  const n0 = pushes.length;
  App.saveItemNote(W, D, it.id, { value: '今天改跑步機，心率照舊 <b>x</b>' });
  assert(pushes.length === n0, 'unchanged note is not saved again');
  App.saveItemNote(W, D, it.id, { value: '   ' });
  assert(!('coachNote' in Store.effectiveWeek(W).days[D].items.find((x) => x.id === it.id)) && !card().includes('item-coach-note'), 'clearing the text removes the note (no empty space)');
  App.saveItemNote(W, D, it.id, { value: 'x'.repeat(300) });
  assert(Store.effectiveWeek(W).days[D].items.find((x) => x.id === it.id).coachNote.length === 200, 'note capped at 200 characters');
  // 換項目：備註留著；存成常用：不帶備註
  const tpl = Store.saveLibraryDoc(null, 'item', { name: '間歇 300 x 4', item: { type: 'interval', title: '間歇 300 x 4' } });
  App.swapItemFromLibrary(W, D, it.id, tpl.id);
  assert(Store.effectiveWeek(W).days[D].items.find((x) => x.id === it.id).coachNote.length === 200, 'swapping the item keeps the note (it belongs to the day)');
  App.saveItemAsTemplate(W, D, it.id);
  assert(Store.libraryList('item').every((t) => !('coachNote' in t.item)), 'saving as a template does not copy the note into the library');
  // 過去的日子不能寫
  const past = PlanData.plan.weeks.flatMap((w) => w.days.map((d, di) => ({ w: w.weekNumber, di, d }))).find((x) => PlanData.keyForWeekDay(x.w, x.di) < PlanData.dayKey(PlanData.today()));
  if (past) {
    const nA = sandbox.__alerts.length;
    App.startItemNote(past.w, past.di, past.d.items[0].id);
    assert(App.state.noteEdit === null && sandbox.__alerts.length === nA + 1, 'past days: note cannot be written');
  }

  // ── 第 55 條：休息日排恢復運動 ──
  const isRestDay = fn('isRestDay');
  const restRef = PlanData.plan.weeks.flatMap((w) => w.days.map((d, di) => ({ w: w.weekNumber, di, d }))).find((x) => x.w >= W && !x.d.selectOne && x.d.items.length === 1 && x.d.items[0].type === 'rest');
  const RW = restRef.w, RD = restRef.di;
  const stretch = Store.saveLibraryDoc(null, 'item', { name: '伸展', item: { type: 'recovery', title: '伸展', duration: { min: 10, max: 15 } } });
  const beforeRate = Store.weekCompletionRate(RW, 'mick');
  App.addItemFromLibrary(RW, RD, stretch.id);
  const rd = Store.effectiveWeek(RW).days[RD];
  assert(rd.items.length === 2 && isRestDay(rd), 'rest day + 伸展 is still a rest day');
  assert(Store.weekCompletionRate(RW, 'mick') === beforeRate, 'optional recovery on a rest day does not change the completion rate');
  const key = PlanData.keyForWeekDay(RW, RD);
  assert(Store.dayStatus(RW, RD, 'mick') === 'pending', 'rest day with nothing ticked is pending');
  const rowText = fn('dayStatusText')('pending', null, key, true);
  assert(rowText === '休息日', 'week row says 休息日 (not 待完成／未完成)');
  const recCard = fn('renderDayRecordCard')(RW, RD, rd, null, true);
  const restItem = rd.items.find((x) => x.type === 'rest'), strItem = rd.items.find((x) => x.type === 'recovery');
  assert(recCard.includes('選做') && !recCard.includes(`A.toggleItem(${RW},${RD},'${restItem.id}')`) && recCard.includes('伸展'), 'record card: 伸展 marked 選做, the rest item has no tick');
  assert(!recCard.includes('更換項目') && !recCard.includes('自主休息'), 'no 更換項目／自主休息 chips on a rest day');
  const coachCard = fn('renderItemCard')(RW, RD, strItem, 1, 2, null, false, false, true);
  assert(coachCard.includes('選做'), 'coach card also marks 選做');
  // 真的做了伸展（當天打勾）→ 已完成，但完成率還是不算這天
  Store.isFutureKey = () => false;
  Store.toggleItemDone(key, strItem.id);
  assert(Store.dayStatus(RW, RD, 'mick') === 'done' && Store.weekCompletionRate(RW, 'mick') === beforeRate, 'ticking 伸展 shows done; completion rate unaffected');
  // 休息日加了非恢復類（例如跑步）就不是休息日了
  const runTpl = Store.saveLibraryDoc(null, 'item', { name: '輕鬆跑', item: { type: 'run', title: '輕鬆跑', duration: { min: 20, max: 20 } } });
  App.addItemFromLibrary(RW, RD, runTpl.id);
  assert(!isRestDay(Store.effectiveWeek(RW).days[RD]), 'adding a run turns it into a normal training day');
  assert(!isRestDay({ selectOne: true, items: [{ type: 'rest' }, { type: 'recovery' }] }), 'rest-or-walk (二擇一) days keep their own rules');
})();
