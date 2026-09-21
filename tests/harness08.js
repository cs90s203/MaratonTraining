// 決策紀錄第 28 條（一個項目多部影片）＋第 29 條（查看動作被重繪收起、整張卡點了就打勾）
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
  APP_VERSION: 'test',
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['js/plan-data.js', 'js/firebase-sync.js', 'js/store.js', 'js/views.js', 'js/app.js']) vm.runInContext(fs.readFileSync(path + '/' + f, 'utf8'), sandbox, { filename: f });
vm.runInContext('this.PlanData = PlanData; this.Store = Store; this.Sync = Sync; this.App = App;', sandbox);
function assert(c, m) { console.log((c ? 'PASS' : 'FAIL') + ': ' + m); if (!c) process.exitCode = 1; }
const J = (x) => JSON.stringify(x);
(async () => {
  await sandbox.PlanData.load();
  const { Store, PlanData, Sync, App } = sandbox;
  Store.activeUserId = 'mick'; Store.init();
  Store._cloudPush = () => {};
  const pushed = [];
  Store._cloudPushLibrary = (id, data) => pushed.push({ id, data });

  // ── PlanData.itemVideoRefs ──
  const R = PlanData.itemVideoRefs;
  assert(J(R(null)) === '[]', 'null item → []');
  assert(J(R({ videoRef: null })) === '[]', 'no video → []');
  assert(J(R({ videoRef: 'a' })) === '["a"]', 'legacy videoRef only → [a]');
  assert(J(R({ videoRefs: ['a', 'b'], videoRef: 'a' })) === '["a","b"]', 'consistent new format keeps order');
  assert(J(R({ videoRefs: ['b', 'c'] })) === '["b","c"]', 'videoRefs without mirror');
  assert(J(R({ videoRefs: ['a', 'b'], videoRef: 'x' })) === '["x","a","b"]', 'mismatch → union, videoRef first, got ' + J(R({ videoRefs: ['a', 'b'], videoRef: 'x' })));
  assert(J(R({ videoRefs: ['a', 'a', '', null, 3, 'b'], videoRef: 'b' })) === '["b","a"]', 'dedupes and drops non-strings, got ' + J(R({ videoRefs: ['a', 'a', '', null, 3, 'b'], videoRef: 'b' })));
  assert(J(R({ videoRefs: [], videoRef: null })) === '[]', 'all removed → []');
  assert(J(R({ videoRefs: 'a' })) === '[]', 'non-array videoRefs ignored');

  // ── 常用項目：存檔寫兩個欄位、上限 10 ──
  const src = PlanData.plan.weeks[0].days[0].items[0];
  const legacy = Store.saveLibraryDoc(null, 'item', { name: 'legacy', item: { ...src, videoRef: 'fitnessblender-postpartum' } });
  assert(J(legacy.item.videoRefs) === '["fitnessblender-postpartum"]' && legacy.item.videoRef === 'fitnessblender-postpartum', 'legacy item template → videoRefs [x] + mirror');
  const many = Array.from({ length: 12 }, (_, i) => 'v' + i);
  const capped = Store.saveLibraryDoc(null, 'item', { name: 'many', item: { ...src, videoRefs: many, videoRef: 'v0' } });
  assert(capped.item.videoRefs.length === 10 && capped.item.videoRef === 'v0', 'template caps at 10 videos, mirror = first');
  const none = Store.saveLibraryDoc(null, 'item', { name: 'none', item: { ...src, videoRefs: [], videoRef: null } });
  assert(J(none.item.videoRefs) === '[]' && none.item.videoRef === null, 'template with no videos writes [] + null (explicit, so merge:true clears remote)');
  assert(J(pushed[pushed.length - 1].data.item.videoRefs) === '[]', 'push carries empty videoRefs');

  // ── 卡片：每部影片一個連結、寫影片名稱 ──
  const vu = Store.saveLibraryDoc(null, 'video', { title: '內核心呼吸', linkType: 'video', url: 'https://www.youtube.com/watch?v=abc' });
  const vs = Store.saveLibraryDoc(null, 'video', { title: '<b>骨盆</b>', linkType: 'search', searchQuery: 'pelvic' });
  const bad = Store.saveLibraryDoc(null, 'video', { title: 'x', linkType: 'video', url: 'https://ok' });
  Store.library[bad.id].url = 'javascript:alert(1)'; // Console 手改成危險網址
  const item = { id: 't-1', type: 'recovery', title: 'T', videoRefs: [vu.id, vs.id, 'missing-id', bad.id], videoRef: vu.id };
  const body = vm.runInContext('itemPlanParts', sandbox)(item).body;
  const linkCount = (body.match(/class="item-link"/g) || []).length;
  assert(linkCount === 2, 'two resolvable safe videos → two links (missing + javascript: skipped), got ' + linkCount);
  assert(body.includes('內核心呼吸') && !body.includes('看影片'), 'url link shows the video title instead of 看影片');
  assert(!body.includes('<b>骨盆</b>') && body.includes('&lt;b&gt;'), 'titles are escaped');
  assert(!body.includes('javascript:'), 'javascript: url never rendered');
  const legacyBody = vm.runInContext('itemPlanParts', sandbox)({ id: 't-2', type: 'run', title: 'L', videoRef: 'fitnessblender-postpartum' }).body;
  assert((legacyBody.match(/class="item-link"/g) || []).length === 1, 'legacy single videoRef still renders one link');

  // ── 查看動作的開關狀態跨重繪保留 ──
  const wItem = { id: 'w-1', type: 'recovery', title: 'W', workoutRef: 'pelvic-core-basic' };
  const parts = () => vm.runInContext('itemPlanParts', sandbox)(wItem).workoutBlock;
  assert(!/<details[^>]*\sopen[\s>]/.test(parts()), 'details closed by default');
  App.setDetailsOpen('wo:w-1', true);
  assert(/<details[^>]*\sopen[\s>]/.test(parts()), 'details re-rendered open after setDetailsOpen(true)');
  assert(parts().includes(`ontoggle="A.setDetailsOpen('wo:w-1', this.open)"`), 'details records its toggle');
  App.setDetailsOpen('wo:w-1', false);
  assert(!/<details[^>]*\sopen[\s>]/.test(parts()) && !('wo:w-1' in App.state.openDetails), 'closing removes the key');
  assert(!parts().includes('stopPropagation'), 'no stopPropagation needed any more');

  // ── 教練項目卡：只有圓圈能點 ──（用今天，不能用未來的日子——未來的圓圈是停用的，見第 31 條）
  const loc = PlanData.locateToday();
  assert(loc.status === 'in-plan', 'harness needs today inside the plan, got ' + loc.status);
  const TW = loc.weekNumber, TD = loc.dayIndex;
  const card = vm.runInContext('renderItemCard', sandbox)(TW, TD, { id: 'c-x', type: 'run', title: 'Z2' }, 0, 2, null, false, false);
  const itemOpen = card.match(/<div class="item [^"]*"[^>]*>/)[0];
  assert(!itemOpen.includes('onclick'), 'coach item card container has no onclick');
  assert(new RegExp(`<button type="button" class="item-check" onclick="A\\.toggleItem\\(${TW},${TD},'c-x'\\)"`).test(card), 'check circle is the toggle button');
  const cardSel = vm.runInContext('renderItemCard', sandbox)(TW, TD, { id: 'c-y', type: 'run', title: 'Z2' }, 0, 2, null, true, false);
  assert(new RegExp(`class="item-check" onclick="A\\.selectChoice\\(${TW},${TD},'c-y'\\)"`).test(cardSel), 'selectOne coach card: circle selects');
  const cardExp = vm.runInContext('renderItemCard', sandbox)(1, 0, { id: 'c-z', type: 'run', title: 'Z2' }, 0, 2, null, false, true);
  assert(!cardExp.includes('onclick="A.toggleItem') && cardExp.includes('<span class="item-check">'), 'expired card: circle is inert span');

  // ── 第 31 條：未來的日子不能預先打勾，但誤觸的一定能取消 ──
  const FW = TW + 1; // 下週同一天：一定是未來
  const fKey = PlanData.keyForWeekDay(FW, TD);
  assert(Store.isFutureKey(fKey) && !Store.isFutureKey(PlanData.keyForWeekDay(TW, TD)), 'isFutureKey: next week yes, today no');
  // 找下週一個非二擇一、只有一個非休息項目的日子，跟一個二擇一有休息選項的日子
  const fw = Store.effectiveWeek(FW);
  const singleIdx = fw.days.findIndex((d) => !d.selectOne && d.items.length === 1 && d.items[0].type !== 'rest');
  const choiceIdx = fw.days.findIndex((d) => d.selectOne && d.items.some((x) => x.type === 'rest') && d.items.some((x) => x.type !== 'rest'));
  assert(singleIdx >= 0 && choiceIdx >= 0, 'found future single day and future rest-choice day');
  const sKey = PlanData.keyForWeekDay(FW, singleIdx), sItem = fw.days[singleIdx].items[0];
  const doneOf = (k, id) => { const e = Store.entryFor(Store.activeUserId, k); return !!(e && e.done && e.done[id]); };
  assert(Store.toggleItemDone(sKey, sItem.id) === null && !doneOf(sKey, sItem.id), 'future: ticking a training item is refused');
  Store.setActualStats(sKey, { distanceKm: 5 }, true);
  assert(!doneOf(sKey, sItem.id), 'future: filling numbers does not auto-tick');
  // 模擬誤觸留下的完成（舊版漏洞）：直接寫進去
  Store._writeOwnEntry(sKey, { done: Store._fullDone(sKey, { [sItem.id]: true }), status: null }, true);
  assert(doneOf(sKey, sItem.id), 'setup: future day stuck as done');
  const stuckCard = vm.runInContext('renderDayRecordCard', sandbox)(FW, singleIdx, fw.days[singleIdx], Store.entryFor(Store.activeUserId, sKey), true);
  assert(/class="rec-done on[^"]*"/.test(stuckCard) && stuckCard.includes('應該是誤觸了'), 'stuck future day shows the 完成 button (on) with an undo hint');
  assert(stuckCard.includes('實際公里') || stuckCard.includes('實際時間'), 'future day shows number fields (decision 38)');
  Store.toggleItemDone(sKey, sItem.id);
  assert(!doneOf(sKey, sItem.id), 'future: un-ticking is always allowed');
  const cleanCard = vm.runInContext('renderDayRecordCard', sandbox)(FW, singleIdx, fw.days[singleIdx], Store.entryFor(Store.activeUserId, sKey), true);
  assert(!cleanCard.includes('class="rec-done'), 'future day not done → no 完成 button');
  // 教練模式項目卡：未來沒勾的圓圈停用、勾了的可以點掉
  const fCard = vm.runInContext('renderItemCard', sandbox)(FW, singleIdx, sItem, 0, 1, null, false, false);
  assert(/<button type="button" class="item-check" disabled/.test(fCard) && !fCard.includes('A.toggleItem'), 'future coach card: unticked circle disabled');
  const fCardDone = vm.runInContext('renderItemCard', sandbox)(FW, singleIdx, sItem, 0, 1, { done: { [sItem.id]: true } }, false, false);
  assert(fCardDone.includes(`A.toggleItem(${FW},${singleIdx},'${sItem.id}')`), 'future coach card: ticked circle can be clicked off');
  // 二擇一：未來只能預先選休息那一邊
  const cKey = PlanData.keyForWeekDay(FW, choiceIdx), cDay = fw.days[choiceIdx];
  const trainOpt = cDay.items.find((x) => x.type !== 'rest'), restOpt = cDay.items.find((x) => x.type === 'rest');
  assert(Store.setSelectedItem(cKey, trainOpt.id) === null, 'future choice: picking the training option is refused');
  assert(Store.setSelectedItem(cKey, restOpt.id) !== null && Store.entryFor(Store.activeUserId, cKey).selectedItemId === restOpt.id, 'future choice: pre-scheduling rest is allowed');
  const choiceCard = vm.runInContext('renderDayRecordCard', sandbox)(FW, choiceIdx, cDay, Store.entryFor(Store.activeUserId, cKey), true);
  assert(choiceCard.includes(`A.selectChoice(${FW},${choiceIdx},'${restOpt.id}')`) && !choiceCard.includes(`A.selectChoice(${FW},${choiceIdx},'${trainOpt.id}')`), 'future choice card: rest radio active, training radio disabled');
  Store.setSelectedItem(cKey, restOpt.id);
  assert(!Store.entryFor(Store.activeUserId, cKey).selectedItemId, 'future choice: un-selecting is allowed');
  // 今天照常可以打勾
  const tw = Store.effectiveWeek(TW).days[TD];
  if (!tw.selectOne) {
    const tKey = PlanData.keyForWeekDay(TW, TD);
    Store.toggleItemDone(tKey, tw.items[0].id);
    assert(doneOf(tKey, tw.items[0].id), 'today: ticking still works');
    Store.toggleItemDone(tKey, tw.items[0].id);
  }

  // ── 項目編輯表單：影片一列一個下拉 ──
  Store.coachMode = true;
  const form = vm.runInContext('renderTemplateForm', sandbox)({ id: 'c-f', name: 'F', item: { type: 'recovery', title: 'F', videoRefs: [vu.id, 'gone-id'], videoRef: vu.id } });
  const listHtml = form.split('class="vref-list">')[1].split('</div>\n          <template')[0];
  assert((listHtml.match(/name="videoRefs"/g) || []).length === 2, 'form: one select per video, got ' + (listHtml.match(/name="videoRefs"/g) || []).length);
  assert(listHtml.includes(`value="${vu.id}" selected`), 'form: first row preselects first video');
  assert(listHtml.includes('value="gone-id" selected'), 'form: unresolvable ref kept as its own selected option');
  assert((form.match(/<template class="vref-tpl">/g) || []).length === 1, 'form: one hidden row template');
  const formEmpty = vm.runInContext('renderTemplateForm', sandbox)({ id: 'new', name: '', item: { type: 'run', title: '', videoRefs: [], videoRef: null } });
  const emptyList = formEmpty.split('class="vref-list">')[1].split('</div>\n          <template')[0];
  assert((emptyList.match(/name="videoRefs"/g) || []).length === 1 && !emptyList.includes('selected'), 'new item form: one empty video row');
  assert(!/name="videoRef"[^s]/.test(form), 'form has no legacy single videoRef select left');
  Store.coachMode = false;

  // ── 二擇一選項卡：只有圓圈能選 ──
  // 找一個二擇一、還沒過期的日子
  let wn = null, di = null;
  for (const w of PlanData.plan.weeks) { const i = w.days.findIndex((d) => d.selectOne); if (i >= 0 && !PlanData.isExpired(w.weekNumber, i)) { wn = w.weekNumber; di = i; break; } }
  const rec = vm.runInContext('renderDayRecordCard', sandbox)(wn, di, Store.effectiveDay(wn, di), null, true);
  assert(!/<div class="rec-opt[^"]*"[^>]*onclick/.test(rec), 'rec-opt container has no onclick');
  assert((rec.match(/<button type="button" class="rec-radio" onclick="A\.selectChoice/g) || []).length === Store.effectiveDay(wn, di).items.length, 'each option has a radio button');

  // ── 庫的訂閱：只有 metadata 變的快照不重繪 ──
  let syncRenders = 0, storeRenders = 0;
  Sync.onChange(() => syncRenders++);
  Store.onChange(() => storeRenders++);
  let cb = null;
  vm.runInContext('fbDb = { collection: () => ({ onSnapshot: (opts, fn) => { globalThis.__libCb = fn; return () => {}; }, doc: () => ({ set: () => Promise.resolve() }) }) }', sandbox);
  Sync._detachLibrary();
  Sync._attachLibrary();
  cb = sandbox.__libCb;
  const snap = (changes, fromCache, docs) => ({ docChanges: () => changes, metadata: { fromCache }, forEach: (fn) => (docs || []).forEach(fn) });
  const docOf = (id, data) => ({ id, data: () => data });
  const remoteVideo = { kind: 'video', title: '遠端', linkType: 'search', searchQuery: 'x', deleted: false, updatedAt: '2026-09-14T00:00:00.000Z', fieldAt: {} };
  Sync.isSignedIn = () => false; // backfill 的 push 會直接略過
  syncRenders = 0; storeRenders = 0;
  cb(snap([{ type: 'added', doc: docOf('c-remote', remoteVideo) }], true));
  assert(storeRenders === 1 && syncRenders === 0, 'cache snapshot with a doc → one render via Store, got store=' + storeRenders + ' sync=' + syncRenders);
  syncRenders = 0; storeRenders = 0;
  cb(snap([], false, [docOf('c-remote', remoteVideo)])); // 快取→伺服器確認，只有 metadata 變
  assert(storeRenders === 0 && syncRenders === 0, 'metadata-only snapshot → no render, got store=' + storeRenders + ' sync=' + syncRenders);
  cb(snap([], true));
  assert(syncRenders === 0, 'another metadata flip → still no render');
  cb(snap([{ type: 'removed', doc: docOf('c-remote', remoteVideo) }], false));
  assert(syncRenders === 1 && !Store.library['c-remote'], 'removed doc → deleted locally and one render');
  syncRenders = 0;
  Sync.libraryDenied = true;
  cb(snap([], false));
  assert(syncRenders === 1 && Sync.libraryDenied === false, 'recovering from denied → one render to clear the banner');
})();
