// 決策紀錄第 62 條：存下來的舊課表複本照新說法顯示；產後課程兩支 Fitness Blender 都掛
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
  alert: () => {}, confirm: () => true,
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
  const { PlanData, Store } = sandbox;
  Store.activeUserId = 'mick'; Store.init(); Store._cloudPush = () => {}; Store._cloudPushPlanWeek = () => {};
  const legacy = PlanData.plan.legacy;
  const OLD_FB = Object.keys(legacy.videoRefsByNote)[0];
  const OLD_STRENGTH = Object.keys(legacy.notes).find((k) => k.startsWith('Phase 1 全部'));
  const OLD_DAYNOTE = Object.keys(legacy.notes).find((k) => k.startsWith('原文只寫'));
  const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // ── 出廠課表：產後課程掛兩支 Fitness Blender ──
  const W = 5;
  const fbDay = PlanData.week(W).days.findIndex((d) => d.items.some((it) => it.title === '產後骨盆底／腹直肌專門課程'));
  const fb = PlanData.week(W).days[fbDay].items.find((it) => it.title === '產後骨盆底／腹直肌專門課程');
  assert(JSON.stringify(PlanData.itemVideoRefs(fb)) === JSON.stringify(['fitnessblender-postpartum', 'fitnessblender-postnatal-equipment']) && fb.videoRef === 'fitnessblender-postpartum', 'factory item has both Fitness Blender videos (videoRef = the first one, for old clients)');
  const fac = fn('itemPlanParts')(fb, {}).body;
  assert(fac.includes('<span>Fitness Blender (no equipment)</span>') && fac.includes('<span>Fitness Blender (equipment)</span>') && fac.includes('watch?v=rCv7Tx8l_y4') && fac.includes('watch?v=wMHODqY4k08'), 'both buttons, with the titles she asked for and the links she picked');
  assert(fac.includes('約 19 分鐘') && fac.includes('約 30 分鐘'), 'each button has its own description underneath');

  // ── 已經存下來的舊複本（改版前整週存進雲端的）：畫面照新說法 ──
  const saved = JSON.parse(JSON.stringify(PlanData.week(W)));
  const sFb = saved.days[fbDay].items.find((it) => it.title === '產後骨盆底／腹直肌專門課程');
  sFb.notes = OLD_FB; delete sFb.videoRefs; // 改版前的樣子：舊備註、一支搜尋連結
  const sDay = saved.days.findIndex((d) => d.items.some((it) => it.title.startsWith('重量訓練 A')));
  saved.days[sDay].items.find((it) => it.title.startsWith('重量訓練 A')).notes = OLD_STRENGTH;
  Store.mergeRemotePlanWeek('mick', W, { ...saved, weekNumber: W, userId: 'mick', updatedAt: '2026-09-20T00:00:00.000Z' });
  const eff = Store.effectiveWeek(W, 'mick');
  assert(eff.days[fbDay].items.find((it) => it.id === sFb.id).notes === OLD_FB, 'setup: the saved copy really has the old wording (data is not rewritten)');
  const oldFbHtml = text(fn('renderDayRecordCard')(W, fbDay, eff.days[fbDay], null, true));
  assert(oldFbHtml.includes(legacy.notes[OLD_FB]) && !oldFbHtml.includes('原計畫第六節'), 'saved copy: the note shows the new wording');
  assert(oldFbHtml.includes('Fitness Blender (no equipment)') && oldFbHtml.includes('Fitness Blender (equipment)'), 'saved copy of the old item: both videos show');
  const oldStrHtml = text(fn('renderDayRecordCard')(W, sDay, eff.days[sDay], null, true));
  assert(oldStrHtml.includes(legacy.notes[OLD_STRENGTH]) && !oldStrHtml.includes('Phase 1'), 'saved copy: strength note shows the new wording');

  // ── 只換一字不差的舊字；她自己寫的、教練刻意只留一支的都不動 ──
  assert(PlanData.displayNote('Phase 1 全部用徒手，我自己加的') === 'Phase 1 全部用徒手，我自己加的' && PlanData.displayNote(null) === null && PlanData.displayNote('toString') === 'toString', 'only exact old factory strings are replaced (not her own notes, not prototype keys)');
  const kept = { id: 'k', type: 'recovery', title: '產後骨盆底／腹直肌專門課程', notes: legacy.notes[OLD_FB], videoRef: 'fitnessblender-postpartum' };
  assert(JSON.stringify(PlanData.displayVideoRefs(kept)) === JSON.stringify(['fitnessblender-postpartum']), 'an item with the new note and one video (coach kept only one) is not given the second one back');
  // 審查抓到：只看備註太寬。套用常用項目會換影片但不一定換備註——那樣的項目照她換的顯示
  const viaTemplate = { id: 't', type: 'recovery', title: '產後骨盆底／腹直肌專門課程', notes: OLD_FB, videoRef: 'fitnessblender-postpartum', templateId: 'c-x' };
  const otherVideo = { id: 'o', type: 'recovery', title: '產後骨盆底／腹直肌專門課程', notes: OLD_FB, videoRef: 'pamela-daily-stretch' };
  assert(PlanData.displayVideoRefs(viaTemplate).length === 1 && JSON.stringify(PlanData.displayVideoRefs(otherVideo)) === '["pamela-daily-stretch"]', 'old note but linked to a library item, or with a different video: shown as stored');
  // v0.26.9（上線約一個半小時）那段時間存下來的複本也一樣
  const V0269 = Object.keys(legacy.videoRefsByNote).find((k) => k !== OLD_FB);
  const c269 = { id: 'n', type: 'recovery', title: '產後骨盆底／腹直肌專門課程', notes: V0269, videoRef: 'fitnessblender-postpartum' };
  assert(!!V0269 && PlanData.displayVideoRefs(c269).length === 2 && PlanData.displayNote(V0269) === fb.notes, 'a copy saved under v0.26.9 also shows both videos and the current note');
  assert(fb.notes.includes('挑一支做（沒器材、有器材）') && fb.notes.includes('做到時間就停'), 'factory note: pick one (same order as the buttons), stop at the planned time');

  // 存成常用：存的是畫面上看到的（新說法、兩支影片），不是存著的舊字（審查抓到）
  const oldCopy = eff.days[fbDay].items.find((it) => it.id === sFb.id);
  const sandboxApp = sandbox.App;
  sandboxApp.state.savedFlash = null;
  Store.coachMode = true;
  sandboxApp.saveItemAsTemplate(W, fbDay, oldCopy.id);
  const tpl = Store.libraryList('item').find((t) => t.item.title === '產後骨盆底／腹直肌專門課程');
  assert(tpl && tpl.item.notes === fb.notes && JSON.stringify(PlanData.itemVideoRefs(tpl.item)) === JSON.stringify(PlanData.itemVideoRefs(fb)), '存成常用 on an old copy saves the new wording and both videos');
  const card = fn('renderItemCard')(W, fbDay, oldCopy, 0, 1, null, false, false);
  assert(!card.includes('A.saveItemAsTemplate('), 'and the old copy now counts as already in the library (no second 存成常用 button)');
  // 複製課表的比對：舊複本跟出廠內容看起來一樣，就不算「不一樣」
  const dck = fn('dayCompareKey');
  assert(dck(eff.days[fbDay]) === dck(PlanData.week(W).days[fbDay]), 'copy comparison: an old copy and the factory day it matches are the same');

  // ── 那天的備註（二擇一的說明）也一樣 ──
  const W3 = 18;
  const s3 = JSON.parse(JSON.stringify(PlanData.week(W3)));
  const cDay = s3.days.findIndex((d) => d.selectOne && d.items.some((it) => it.type === 'strength'));
  s3.days[cDay].dayNotes = OLD_DAYNOTE;
  Store.mergeRemotePlanWeek('mick', W3, { ...s3, weekNumber: W3, userId: 'mick', updatedAt: '2026-09-20T00:00:00.000Z' });
  Store.coachMode = false;
  const dayHtml = text(fn('renderDayBody')(W3, cDay, 'mick'));
  assert(dayHtml.includes(legacy.notes[OLD_DAYNOTE]) && !dayHtml.includes('原文只寫'), 'saved copy: the day note banner shows the new wording');
  Store.coachMode = true;
  const coachHtml = fn('renderDayBody')(W3, cDay, 'mick');
  assert(coachHtml.includes(legacy.notes[OLD_DAYNOTE]) && !coachHtml.includes('原文只寫'), 'coach mode: the day-note box shows the new wording too');
})();
