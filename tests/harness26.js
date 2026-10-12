// 決策紀錄第 65 條：複製自己另一週的課表——「這週和下週都改成跟第 3 週一樣的內容，包含今天」
// 跟複製別人的課表（第 56、64 條）同一套：整週、同名項目沿用 id 留著打過的勾、會變差的日子點名、存進雲端之後才講結果。
// 這支測試不能綁死某一天：「今天」是第幾週、星期幾，都由 PlanData.locateToday() 算，來源週選一個不是目標的週。
const fs = require('fs');
const vm = require('vm');
const path = require('path').resolve(__dirname, '..'); // repo 根目錄
const load = (f) => JSON.parse(fs.readFileSync(path + '/data/' + f));
const map = { 'plan.json': load('plan.json'), 'videos.json': load('videos.json'), 'workouts.json': load('workouts.json'), 'users.json': load('users.json'), 'week-presets.json': load('week-presets.json') };
const store = {};
const sandbox = {
  console, window: {}, crypto: require('crypto').webcrypto, location: { href: 'x' }, setTimeout, clearTimeout,
  document: { getElementById: () => null, addEventListener: () => {}, querySelector: () => null },
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: () => {} },
  fetch: async (u) => ({ json: async () => map[Object.keys(map).find((k) => u.includes(k))] }),
  alert: (m) => sandbox.__alerts.push(m), confirm: (m) => { sandbox.__confirms.push(m); return sandbox.__ok; }, __alerts: [], __confirms: [], __ok: true,
  APP_VERSION: 't', Sortable: function () {},
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['js/plan-data.js', 'js/firebase-sync.js', 'js/store.js', 'js/views.js', 'js/app.js']) vm.runInContext(fs.readFileSync(path + '/' + f, 'utf8'), sandbox, { filename: f });
vm.runInContext('this.PlanData = PlanData; this.Store = Store; this.App = App; this.Sync = Sync; globalThis.render = () => {};', sandbox);
function assert(c, m) { console.log((c ? 'PASS' : 'FAIL') + ': ' + m); if (!c) process.exitCode = 1; }
const settle = () => new Promise((r) => setTimeout(r, 20));
(async () => {
  await sandbox.PlanData.load();
  const { PlanData, Store, App, Sync } = sandbox;
  const loc = PlanData.locateToday();
  if (loc.status !== 'in-plan') { console.log('SKIP: today is not inside the plan'); return; }
  const TW = loc.weekNumber, TD = loc.dayIndex, total = PlanData.plan.totalWeeks;
  const hasNext = TW < total; // 最後一週（賽週）沒有下一週：「這週和下週」只剩這一週
  const targets = hasNext ? [TW, TW + 1] : [TW];
  const scope = hasNext ? `第 ${TW}～${TW + 1} 週` : `第 ${TW} 週`;
  Store.activeUserId = 'mick'; Store.init(); Store._cloudPush = () => {}; Store._cloudPushLibrary = () => {};
  Sync.user = { email: 'x@example.com' }; Sync.detectedUserId = 'mick'; Sync.state = 'done';
  Sync.planWeeksLoaded = () => true; Sync.fetchCopyGuards = async () => true;
  sandbox.__remote = {}; sandbox.__fail = null;
  vm.runInContext(`fbDb = {
    collection: (p) => ({ doc: (id) => ({ path: p + '/' + id, get: () => Promise.resolve(globalThis.__remote[p + '/' + id] ? { exists: true, data: () => JSON.parse(JSON.stringify(globalThis.__remote[p + '/' + id])) } : { exists: false }) }) }),
    runTransaction: (f) => {
      if (globalThis.__fail === 'network') return Promise.reject(Object.assign(new Error('Failed to get document because the client is offline.'), { code: 'unavailable' }));
      const w = [];
      return f({ get: (ref) => ref.get(), set: (ref, d) => w.push([ref.path, d]) }).then(() => { w.forEach(([p, d]) => { globalThis.__remote[p] = JSON.parse(JSON.stringify(d)); }); });
    },
  }`, sandbox);
  Store._cloudPushPlanWeek = Sync.pushPlanWeek.bind(Sync);
  Store.coachMode = true;
  App.state.page = 'week';
  // 來源週：不是這週、也不是下週（選得到的第一個）
  const S = [TW + 3, TW + 4, TW - 3, TW - 4].find((n) => n >= 1 && n <= total);
  const stopRetry = () => { clearTimeout(Sync._unsavedRetryTimer); Sync._unsavedRetryTimer = null; };
  const edit = (uid, wn, fnEdit) => { const x = App._cloneEffectiveWeek(wn, uid); fnEdit(x); return Store.savePlanWeek(uid, wn, x); };
  const wk = (wn, uid) => Store.effectiveWeek(wn, uid || 'mick');
  const ck = fn_dayContentKey();
  function fn_dayContentKey() { return vm.runInContext('dayContentKey', sandbox); }
  const sameContent = (a, b) => [0, 1, 2, 3, 4, 5, 6].every((di) => ck(a.days[di]) === ck(b.days[di]));
  const cloud = (wn, uid) => sandbox.__remote[`users/${uid || 'mick'}/planWeeks/${wn}`];
  const lastConfirm = () => sandbox.__confirms.slice(-1)[0] || '';
  const lastAlert = () => sandbox.__alerts.slice(-1)[0] || '';
  const panel = () => vm.runInContext('renderWeekCoachPanel', sandbox)(TW, wk(TW), true, 'mick');

  // ── 來源週：做成一份一眼看得出是它的課表（新增項目＋順序＋備註＋目標跑量＋整天換內容）──
  const item0 = wk(TW).days[TD].items[0]; // 今天這個項目：來源那天也放一個同名同類型的，用來看打過的勾會不會留著
  edit('mick', S, (x) => {
    x.days[TD] = { ...x.days[TD], selectOne: false, dayNotes: `第 ${S} 週這天的備註`, items: [
      { id: 'src-a', type: 'recovery', title: `只有第 ${S} 週有的項目`, duration: { min: 10, max: 10 }, coachNote: '來源的教練備註' },
      { ...JSON.parse(JSON.stringify(item0)), id: 'src-b' },
    ] };
    x.weeklyVolumeKm = { min: 7, max: 9 };
  });
  await settle();
  const srcWeek = wk(S);
  assert(Store.planUnsavedWeeks().length === 0 && cloud(S), 'setup: the source week is saved in the cloud');

  // 今天這個項目她已經打了勾
  const todayKey = PlanData.keyForWeekDay(TW, TD);
  Store.mergeRemoteEntry('mick', todayKey, { done: { [item0.id]: true }, selectedItemId: null, status: null, updatedAt: new Date().toISOString(), fieldAt: {} });
  const otherBefore = JSON.stringify(wk(TW, 'Annlin'));

  // ── 按鈕：沒選來源週時不能按；選了才能；第二顆按鈕在最後一週不出現；只有教練看得到 ──
  App.state.copySrcWeek = null;
  let html = panel();
  assert(html.includes('複製 Mick 另一週的課表') && html.includes(`value="${S}"`) && html.includes(`複製到第 ${TW} 週`) && (TW < total ? html.includes(`複製到第 ${TW}～${TW + 1} 週`) : true), 'the coach panel has the copy-another-week row, with the real week numbers on the buttons');
  assert((html.match(/class="copy-btn" disabled/g) || []).length === (TW < total ? 2 : 1), 'no source week chosen yet: the buttons are disabled');
  App.setCopySrcWeek(String(S));
  html = panel();
  assert(App.state.copySrcWeek === S && !html.includes('class="copy-btn" disabled') && html.includes(`<option value="${S}" selected>`), 'chosen: the buttons work and the choice is remembered across redraws');
  const wasCoach = Store.canEditLibrary;
  Store.canEditLibrary = () => false;
  assert(!panel().includes('另一週的課表'), 'not shown to anyone but the coach');
  Store.canEditLibrary = wasCoach;
  assert(vm.runInContext('renderWeekCoachPanel', sandbox)(total, wk(total), false, 'mick').includes(`複製到第 ${total} 週`) && !vm.runInContext('renderWeekCoachPanel', sandbox)(total, wk(total), false, 'mick').includes(`複製到第 ${total}～`), 'on the last week there is no 「這週和下週」 button');

  // ── 守則：沒選來源週、來源週不合法、不是教練 ──
  App.state.copySrcWeek = null; sandbox.__alerts.length = 0;
  App.copyOwnWeek(1);
  assert(lastAlert() === '先選要複製哪一週的課表。', 'nothing chosen: tells her to choose first');
  App.state.copySrcWeek = S;
  const before = JSON.stringify(wk(TW));
  for (const bad of [0, total + 1, 1.5]) await App.copyPlanFrom('mick', 1, bad);
  assert(JSON.stringify(wk(TW)) === before && sandbox.__confirms.length === 0, 'an impossible source week does nothing');
  Store.coachMode = false;
  await App.copyOwnWeek(2);
  assert(JSON.stringify(wk(TW)) === before && sandbox.__confirms.length === 0, 'outside coach mode nothing happens');
  Store.coachMode = true;
  assert(JSON.stringify(Store.copyWeeksInRange(2, total)) === JSON.stringify([total]) && JSON.stringify(Store.copyWeeksInRange(2, total - 1)) === JSON.stringify([total - 1, total]) && Store.copyWeeksInRange(3, TW).length === Math.min(3, total - TW + 1), 'a run of weeks stops at the last week');

  // ── 她要的：這週和下週都改成跟來源週一樣，包含今天 ──
  App.state.weekViewNumber = TW;
  sandbox.__alerts.length = 0; sandbox.__confirms.length = 0;
  await App.copyOwnWeek(2);
  const c = lastConfirm();
  assert(c.includes(`把 Mick 第 ${S} 週的課表複製到${scope}？`) && c.includes(`範圍：${scope}，整週都換（包含`) && c.includes('同一天名稱一樣的項目，打過的勾會留著'), `the confirm says which week goes where: ${c.split('\n').slice(0, 3).join(' / ')}`);
  assert(targets.every((w) => sameContent(wk(w), srcWeek)), `this week and next week now have exactly week ${S}'s content (every day, including today)`);
  assert(wk(TW).days[TD].dayNotes === `第 ${S} 週這天的備註` && wk(TW).days[TD].items[0].coachNote === '來源的教練備註' && JSON.stringify(wk(TW).weeklyVolumeKm) === JSON.stringify({ min: 7, max: 9 }), 'the day note, the coach note and the weekly goal come along');
  assert(targets.every((w) => cloud(w) && sameContent(cloud(w), srcWeek)), 'and both weeks are in the cloud (her phone sees them)');
  assert(srcWeek === wk(S) && cloud(S).updatedAt === srcWeek.updatedAt, `the source week ${S} itself is untouched`);
  assert(JSON.stringify(wk(TW, 'Annlin')) === otherBefore, 'nobody else\'s plan changes');
  // 項目 id：沒有跟來源週共用（不然兩週的勾會互相對到）；今天打過勾的那個項目還是同一個 id，勾還在
  const idsOf = (w) => w.days.flatMap((d) => d.items.map((i) => i.id));
  const allIds = targets.flatMap((w) => idsOf(wk(w)));
  assert(allIds.every((id) => !idsOf(srcWeek).includes(id)) && new Set(allIds).size === allIds.length, 'copied items get their own ids (nothing shared with the source week or between the two weeks)');
  assert(wk(TW).days[TD].items.some((i) => i.id === item0.id) && Store.entryFor('mick', todayKey).done[item0.id] === true, 'today: the same-name item keeps her id, so the tick she already made is still there');
  assert(sandbox.__alerts.length === 1 && new RegExp(`^已經把第 ${S} 週的課表複製到${scope}，改了 \\d+ 天。$`).test(lastAlert()), `after the cloud confirms: ${lastAlert()}`);
  assert(!Store.planUnsavedWeeks().length && !Store.planSyncing(), 'nothing is left unsaved');

  // ── 再按一次：已經一樣了，不用複製 ──
  sandbox.__alerts.length = 0; sandbox.__confirms.length = 0;
  await App.copyOwnWeek(2);
  assert(sandbox.__confirms.length === 0 && lastAlert().includes(`已經跟第 ${S} 週一樣了，不用複製`), `already the same: says so and changes nothing (${lastAlert()})`);

  // ── 按了取消：什麼都不改 ──
  const NW = hasNext ? TW + 1 : TW; // 最後一週沒有下一週：改用這週
  edit('mick', NW, (x) => { x.days[1] = { ...x.days[1], dayNotes: '之後又改的' }; });
  await settle();
  const keep = JSON.stringify(wk(NW));
  sandbox.__ok = false; sandbox.__alerts.length = 0;
  await App.copyOwnWeek(2);
  sandbox.__ok = true;
  assert(JSON.stringify(wk(NW)) === keep && sandbox.__alerts.length === 0, 'declined: nothing changes, no result message');
  // 只換這一週：下一週不動
  if (hasNext) {
    await App.copyOwnWeek(1);
    assert(wk(TW + 1).days[1].dayNotes === '之後又改的', 'only this week asked for: next week is left alone');
  }

  // ── 會變差的日子照日期點名：她今天打過勾的項目不在來源那天裡 ──
  edit('mick', TW, (x) => { x.days[TD] = { ...x.days[TD], items: [{ id: 'mine-x', type: 'run', title: '只有我這週有的跑步', duration: { min: 20, max: 20 } }] }; });
  await settle();
  Store.mergeRemoteEntry('mick', todayKey, { done: { 'mine-x': true }, selectedItemId: null, status: null, updatedAt: new Date(Date.now() + 5).toISOString(), fieldAt: {} });
  sandbox.__confirms.length = 0; sandbox.__ok = false;
  await App.copyOwnWeek(1);
  sandbox.__ok = true;
  const lc = lastConfirm();
  const wd = PlanData.weekdayLabel(TD);
  assert(lc.includes(`打過勾的「只有我這週有的跑步」不在第 ${S} 週週${wd}的課表裡，會換成第 ${S} 週週${wd}的內容`), 'a tick that would be lost is named, with the exact weekday of the source week it is compared against (not just 「第 N 週」)');
  assert(PlanData.isExpired(TW, TD) || /原本是「完成」，換成第 \d+ 週週[一二三四五六日]的之後會變成「(待完成|未完成|部分完成)」/.test(lc), 'and a finished day that would no longer count is named too (not for the first three days of the plan, which are marked expired)');

  // ── 沒連上網路：這台改好了、會自動補存，講的是「別台裝置」（這就是她自己的課表）──
  edit('mick', TW, (x) => { x.days[TD] = { ...x.days[TD], dayNotes: '先換掉再複製' }; });
  await settle();
  sandbox.__alerts.length = 0; sandbox.__confirms.length = 0; sandbox.__fail = null;
  const realPush = Sync._pushPlanWeekNow.bind(Sync);
  Sync._pushPlanWeekNow = (uid, ...rest) => { sandbox.__fail = 'network'; const r = realPush(uid, ...rest); sandbox.__fail = null; return r; };
  await App.copyOwnWeek(1);
  Sync._pushPlanWeekNow = realPush; stopRetry();
  const na = sandbox.__alerts.join('\n');
  assert(na.includes('在這台改好了，但還沒存進雲端（沒有連上網路）') && na.includes('別台裝置看不到') && !na.includes('Mick 的手機') && !na.includes('已經把'), `offline: says it will be saved automatically, not that it was copied: ${na}`);
  Sync.retryUnsavedPlanWeeks(); await settle();
  assert(sameContent(cloud(TW), srcWeek) && !Store.planUnsavedWeeks().length, 'and the retry gets it into the cloud');

  // ── 目標週自己對調過順序：整週跳過，講出來 ──
  if (hasNext) {
    Store.weekAdjustments.mick = { ...(Store.weekAdjustments.mick || {}), [TW + 1]: { dayOrder: [1, 0, 2, 3, 4, 5, 6] } };
    edit('mick', TW + 1, (x) => { x.days[0] = { ...x.days[0], dayNotes: '會被跳過的' }; });
    await settle();
    sandbox.__confirms.length = 0; sandbox.__alerts.length = 0;
    await App.copyOwnWeek(2);
    assert(lastAlert().includes(`第 ${TW + 1} 週 Mick 自己對調過順序`) || lastConfirm().includes(`第 ${TW + 1} 週 Mick 自己對調過順序`), 'a target week she swapped days in is skipped, and it says so');
    assert(wk(TW + 1).days[0].dayNotes === '會被跳過的', '…and left as it was');
    delete Store.weekAdjustments.mick[TW + 1]; // 後面的測試要用這一週，把對調拿掉
  }

  // ── 她的真實情況：第 3 週是她用預排課表（9/21 那週）排進去的；這週和下週改成跟它一樣 ──
  {
    const preset = (PlanData.weekPresets || []).find((x) => x.weekNumber === 3);
    App.state.viewingUserId = null; App.state.weekViewNumber = 3;
    sandbox.__alerts.length = 0; sandbox.__confirms.length = 0; sandbox.__ok = true;
    App.applyWeekPreset(preset.id);
    await settle();
    const w3 = wk(3);
    assert(!!preset && w3.days[0].items.map((i) => i.title).join('+') === preset.days[0].map((k) => preset.items[k].title).join('+'), 'setup: her week 3 is the 9/21 preset (Monday = rest + breathing + stretch)');
    const V = TW <= 3 ? 5 : TW; // 目標週不能是第 3 週自己
    const VT = V < total ? [V, V + 1] : [V];
    App.state.weekViewNumber = V; App.state.copySrcWeek = 3;
    sandbox.__alerts.length = 0; sandbox.__confirms.length = 0;
    const kmOf = (w) => Store.weekTargetAuto(w, 'mick', { planOnly: true });
    const fmtKm = (t) => (t.min === t.max ? `${t.min}` : `${t.min}–${t.max}`);
    const kmBefore = VT.map(kmOf), km3 = kmOf(3);
    const dirOf = (a, b) => (b.min >= a.min && b.max >= a.max ? '變多' : (b.min <= a.min && b.max <= a.max ? '變少' : '有增有減')); // 跟 App 同一條規則：上下限都同方向才講變多／變少
    await App.copyOwnWeek(2);
    // 預計跑量換之前、換之後要講：她排的第 3 週比出廠的後面幾週還多，複製過去跑量會變多（第 0 條）
    const kmExpected = VT.map((w, i) => (kmBefore[i].min === km3.min && kmBefore[i].max === km3.max ? null : `預計跑量：第 ${w} 週 ${fmtKm(kmBefore[i])} K → ${fmtKm(km3)} K（${dirOf(kmBefore[i], km3)}）`)).filter(Boolean);
    assert(kmExpected.every((line) => lastConfirm().includes(line)), `the confirm says what happens to the planned distance: ${kmExpected.join(' / ') || '(same as before)'}`);
    assert(VT.every((w) => sameContent(wk(w), wk(3))) && VT.every((w) => sameContent(cloud(w), wk(3))), `weeks ${VT.join('、')} are exactly week 3 as she arranged it, on screen and in the cloud`);
    assert(VT.every((w) => wk(w).days.every((d, di) => d.items.map((i) => i.title).join('+') === w3.days[di].items.map((i) => i.title).join('+') && d.selectOne === w3.days[di].selectOne)), 'every day: same items in the same order, same 「一起做」 (no 「或」 appears)');
    assert(/^已經把第 3 週的課表複製到/.test(lastAlert()) && !Store.planUnsavedWeeks().length, `and it says so only after the cloud has it: ${lastAlert()}`);
    assert(sandbox.__confirms.slice(-1)[0].includes('以時間計的跑步用 9 分速換算，預計跑量是約略值、偏低'), 'her week 3 has runs written in minutes, so the confirm says the distance is an estimate (low)');
    // 複製的是畫面上這一刻的第 3 週：她之後在第 3 週改了什麼，再複製就跟著變
    edit('mick', 3, (x) => { x.days[2].items[0].coachNote = '第 3 週之後才寫的備註'; });
    await settle();
    await App.copyOwnWeek(2);
    assert(VT.every((w) => wk(w).days[2].items[0].coachNote === '第 3 週之後才寫的備註'), 'it copies week 3 as it is now (an edit made to week 3 later comes along next time)');
  }

  // 兩個方向都要講清楚：整週都是休息的週 R，跟第 3 週（她排的、有三次 Zone 2 跑加一次間歇跑）互相複製（都按取消，只看確認畫面）
  {
    const R = TW <= 3 ? 5 : TW;
    edit('mick', R, (x) => { x.days = x.days.map((d, di) => ({ ...d, selectOne: false, dayNotes: null, items: [{ id: `r-${di}`, type: 'rest', title: '完全休息' }] })); });
    await settle();
    sandbox.__ok = false;
    App.state.weekViewNumber = R; App.state.copySrcWeek = 3; sandbox.__confirms.length = 0;
    await App.copyOwnWeek(1);
    assert(/預計跑量：第 \d+ 週 0 K → [\d.–]+ K（變多）/.test(lastConfirm()), `copying a heavier week onto a lighter one says 變多: ${(lastConfirm().split('\n').find((l) => l.startsWith('預計跑量')) || '')}`);
    App.state.weekViewNumber = 3; App.state.copySrcWeek = R; sandbox.__confirms.length = 0;
    await App.copyOwnWeek(1);
    sandbox.__ok = true;
    assert(/預計跑量：第 3 週 [\d.–]+ K → 0 K（變少）/.test(lastConfirm()), `and a lighter one onto a heavier week says 變少: ${(lastConfirm().split('\n').find((l) => l.startsWith('預計跑量')) || '')}`);
  }


  // ══ 審查之後補的（資料安全一位、文字一位）══
  const used = new Set([TW, TW + 1, TW + 2, S, 3, 4, 5, 6]);
  const free = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24].filter((n) => !used.has(n));
  const [wT, wS, wX] = free; // 專門給這幾個測試用的週：目標、來源、另一個
  const runItem = (id, lo, hi) => ({ id, type: 'run', title: 'Zone 2 跑', distanceKm: { min: lo, max: hi } });
  // runs：七天，null＝完全休息，[下限, 上限]＝一次跑步
  const setKm = async (uid, wn, runs, goal) => {
    edit(uid, wn, (x) => {
      x.days = x.days.map((d, di) => ({ ...d, selectOne: false, dayNotes: null, items: [runs[di] ? runItem(`k-${uid}-${wn}-${di}`, runs[di][0], runs[di][1]) : { id: `k-${uid}-${wn}-${di}`, type: 'rest', title: '完全休息' }] }));
      if (goal === undefined) return;
      if (goal === null) delete x.weeklyVolumeKm; else x.weeklyVolumeKm = goal;
    });
    await settle();
  };
  const asks = async (src, target, count) => { // 只看確認畫面（按取消）
    App.state.viewingUserId = null; App.state.weekViewNumber = target; App.state.copySrcWeek = src;
    sandbox.__confirms.length = 0; sandbox.__alerts.length = 0; sandbox.__ok = false;
    await App.copyOwnWeek(count || 1);
    sandbox.__ok = true;
    return lastConfirm();
  };
  const kmLine = (c) => c.split('\n').find((l) => l.startsWith('預計跑量')) || '';
  const restDays = [null, null, null, null, null, null, null];
  const twoRuns = (lo, hi) => [null, [lo, hi], null, null, [lo, hi], null, null];

  // ── 預計跑量那一行：數字、方向都要對（方向只在上下限都同方向時才講，不然「有增有減」）──
  await setKm('mick', wT, twoRuns(5, 6)); // 目標：10–12
  await setKm('mick', wS, [null, [3, 4], null, null, null, null, null]); // 來源：3–4
  const cDist = await asks(wS, wT);
  assert(kmLine(cDist) === `預計跑量：第 ${wT} 週 10–12 K → 3–4 K（變少）`, 'both bounds fall: 變少, with the real numbers');
  assert(!cDist.includes('以時間計的跑步'), 'distances written as km: no 「estimated from minutes」 note');
  await setKm('mick', wS, twoRuns(5, 6.5)); // 10–13
  assert(kmLine(await asks(wS, wT)) === `預計跑量：第 ${wT} 週 10–12 K → 10–13 K（變多）`, 'lower bound the same and upper bound up: 變多');
  await setKm('mick', wS, twoRuns(5.5, 6)); // 11–12
  assert(kmLine(await asks(wS, wT)) === `預計跑量：第 ${wT} 週 10–12 K → 11–12 K（變多）`, 'lower bound up and upper bound the same: 變多');
  await setKm('mick', wS, twoRuns(4.5, 6.5)); // 9–13
  assert(kmLine(await asks(wS, wT)) === `預計跑量：第 ${wT} 週 10–12 K → 9–13 K（有增有減）`, 'lower bound falls while the upper bound rises: 有增有減, not a made-up 變少 (review)');
  await setKm('mick', wS, twoRuns(4.5, 5.5)); // 9–11
  assert(kmLine(await asks(wS, wT)).endsWith('9–11 K（變少）'), 'both bounds fall: 變少');
  // 完全一樣的跑量、只有目標不一樣：不印預計跑量那一行，目標跑量講換之前、換之後
  await setKm('mick', wT, twoRuns(5, 6), { min: 12, max: 14 });
  await setKm('mick', wS, twoRuns(5, 6), null);
  let c2 = await asks(wS, wT);
  assert(!c2.includes('預計跑量：') && c2.includes(`目標跑量：第 ${wT} 週 12–14 K → 沒有`) && c2.includes('目標跑量也會換成第'), 'only the goal differs: no pointless distance line, and the goal line shows before → after (cleared = 沒有)');
  await setKm('mick', wS, twoRuns(5, 6), { min: 20, max: 22 });
  await setKm('mick', wT, twoRuns(5, 6), null);
  assert((await asks(wS, wT)).includes(`目標跑量：第 ${wT} 週 沒有 → 20–22 K`), 'and the other way round');

  // ── 休息日（今天跟以後）變成要練、可以選休息的日子沒了：要講（她的情況：第 3 週週日是間歇跑，第 6、7 週週日原本可以選休息）──
  if (hasNext) {
    const NWk = TW + 1; // 下一週的每一天都在未來
    edit('mick', NWk, (x) => {
      x.days[1] = { ...x.days[1], selectOne: false, items: [{ id: 'rest-a', type: 'rest', title: '完全休息' }] }; // 整天休息
      x.days[2] = { ...x.days[2], selectOne: true, items: [{ id: 'rest-b', type: 'rest', title: '完全休息' }, { id: 'walk-b', type: 'recovery', title: '散步＋伸展' }] }; // 可以選休息
    });
    await settle();
    await setKm('mick', wS, restDays);
    edit('mick', wS, (x) => { x.days[1] = { ...x.days[1], selectOne: false, items: [{ id: 'lift', type: 'strength', title: '重量訓練', duration: { min: 40, max: 40 } }] }; x.days[2] = { ...x.days[2], selectOne: false, items: [{ id: 'run-c', type: 'run', title: '間歇跑', duration: { min: 35, max: 40 } }] }; });
    await settle();
    const cr = await asks(wS, NWk);
    assert(cr.includes(`第 ${NWk} 週週${PlanData.weekdayLabel(1)}（`) && cr.includes(`原本是休息日，換成第 ${wS} 週週${PlanData.weekdayLabel(1)}的之後要練。`), 'a future rest day that becomes a training day is named (it was silent before: only today and past days were)');
    assert(cr.includes(`原本可以選休息，換成第 ${wS} 週週${PlanData.weekdayLabel(2)}的之後沒有休息可以選。`), 'a 「rest or walk」 day whose rest option disappears is named too');
  }
  // 今天是「可以選休息」的日子、換了之後沒有休息可以選：也要講
  edit('mick', TW, (x) => { x.days[TD] = { ...x.days[TD], selectOne: true, items: [{ id: 'rest-t', type: 'rest', title: '完全休息' }, { id: 'walk-t', type: 'recovery', title: '散步＋伸展' }] }; });
  await settle();
  edit('mick', wS, (x) => { x.days[TD] = { ...x.days[TD], selectOne: false, items: [{ id: 'lift-t', type: 'strength', title: '重量訓練', duration: { min: 40, max: 40 } }] }; });
  await settle();
  const ct = await asks(wS, TW);
  assert(PlanData.isExpired(TW, TD) || ct.includes(`第 ${TW} 週週${PlanData.weekdayLabel(TD)}（`) && ct.includes('原本可以選休息'), 'today too: the rest option that goes away is named');

  // ── 比賽日：預計跑量不算比賽日，那一行看不出來，要另外講 ──
  const raceItem = PlanData.week(total).days[6].items.find((i) => i.type === 'race');
  const rc = await asks(total, wT);
  assert(!!raceItem && rc.includes(`會變成比賽「${raceItem.title}」（第 ${total} 週週日有比賽）`), `copying the race week onto another week says a race appears: ${(rc.split('\n').find((l) => l.includes('比賽')) || '')}`);
  const rc2 = await asks(wT, total);
  assert(rc2.includes(`的比賽「${raceItem.title}」會被拿掉（第 ${wT} 週週日沒有比賽）`), 'and copying a week over the race week says the race is taken out');

  // ── 範圍照實際會換的週：跳過的週、來源週自己不算 ──
  if (hasNext) {
    await setKm('mick', wT, twoRuns(5, 6)); await setKm('mick', wX, twoRuns(5, 6));
    await setKm('mick', wS, [null, [3, 4], null, null, null, null, null]);
    Store.weekAdjustments.mick = { ...(Store.weekAdjustments.mick || {}), [wX]: { dayOrder: [1, 0, 2, 3, 4, 5, 6] } };
    // wT 和 wX 要連在一起才能用「連續兩週」：這裡直接用預覽看範圍，不靠週次剛好相鄰
    const pv = Store.copyPlanPreview('mick', 'mick', 2, wT, wS);
    assert(pv.inRange.length === 2 && pv.weeks.every((x) => x.weekNumber !== wX), 'setup: a requested week she swapped days in is skipped by the preview');
    delete Store.weekAdjustments.mick[wX];
    // 來源週在範圍裡：來源那一週自己不換，確認畫面跟成功的提示都只講真的換的那週
    await setKm('mick', wS, twoRuns(5, 6.5));
    App.state.weekViewNumber = wS; App.state.copySrcWeek = wS; App.state.viewingUserId = null;
    sandbox.__confirms.length = 0; sandbox.__alerts.length = 0; sandbox.__ok = true;
    const before2 = wS + 1 <= total ? JSON.stringify(wk(wS + 1)) : '';
    await App.copyOwnWeek(2);
    if (wS + 1 <= total) {
      assert(lastConfirm().includes(`範圍：第 ${wS + 1} 週，整週都換`) && lastConfirm().includes(`複製到第 ${wS + 1} 週？`) && !lastConfirm().includes(`第 ${wS}～${wS + 1} 週`), 'the source week inside the range is not listed as a target (only the week that really changes)');
      assert(new RegExp(`^已經把第 ${wS} 週的課表複製到第 ${wS + 1} 週，改了 \\d+ 天。$`).test(lastAlert()) && JSON.stringify(wk(wS + 1)) !== before2, `and the result alert says the same: ${lastAlert()}`);
    }
  }

  // ── 她排的是別人的課表（名字選單選了 Annlin）：來源是 Annlin 自己的另一週，不是 Mick 的 ──
  App.viewWeekOf('Annlin');
  edit('Annlin', wS, (x) => { x.days[0] = { ...x.days[0], dayNotes: 'Annlin 的第來源週備註' }; });
  edit('mick', wS, (x) => { x.days[0] = { ...x.days[0], dayNotes: 'Mick 的第來源週備註（不該進 Annlin 的課表）' }; });
  await settle();
  App.state.viewingUserId = 'Annlin'; App.state.weekViewNumber = wT; App.state.copySrcWeek = wS;
  sandbox.__confirms.length = 0; sandbox.__alerts.length = 0; sandbox.__ok = true;
  const mickT = JSON.stringify(wk(wT, 'mick'));
  await App.copyOwnWeek(1);
  assert(lastConfirm().includes(`把 Annlin 第 ${wS} 週的課表複製到第 ${wT} 週？`), 'planning Annlin: the confirm names Annlin, not the person using the app');
  assert(wk(wT, 'Annlin').days[0].dayNotes === 'Annlin 的第來源週備註' && JSON.stringify(wk(wT, 'mick')) === mickT, 'the source is Annlin\'s own week, and Mick\'s own plan is not touched');
  // 沒連上網路：講的是 Annlin 的手機（她自己的課表才講「別台裝置」）；衝突：別人（Annlin 自己的手機都算別人）
  edit('Annlin', wS, (x) => { x.days[1] = { ...x.days[1], dayNotes: '再改一下來源' }; });
  await settle();
  const realPush3 = Sync._pushPlanWeekNow.bind(Sync);
  sandbox.__alerts.length = 0; sandbox.__ok = true;
  Sync._pushPlanWeekNow = (uid, ...rest) => { sandbox.__fail = 'network'; const r = realPush3(uid, ...rest); sandbox.__fail = null; return r; };
  await App.copyOwnWeek(1);
  Sync._pushPlanWeekNow = realPush3; stopRetry();
  assert(lastAlert().includes('Annlin 的手機看不到') && !lastAlert().includes('別台裝置'), `offline while planning Annlin: ${lastAlert()}`);
  Sync.retryUnsavedPlanWeeks(); await settle();
  edit('Annlin', wS, (x) => { x.days[1] = { ...x.days[1], dayNotes: '又改一次來源' }; });
  await settle();
  Sync._pushPlanWeekNow = (uid, wn, ...rest) => { const k = `users/${uid}/planWeeks/${wn}`; if (sandbox.__remote[k]) sandbox.__remote[k] = { ...sandbox.__remote[k], updatedAt: '2099-01-01T00:00:00.000Z' }; return realPush3(uid, wn, ...rest); };
  sandbox.__alerts.length = 0;
  await App.copyOwnWeek(1);
  Sync._pushPlanWeekNow = realPush3;
  assert(lastAlert().includes('剛被別人改過，這次沒有複製'), `planning Annlin, someone wrote her week meanwhile: ${lastAlert()}`);
  App.viewWeekOf(null);
  // 她自己的課表被別台寫了：只有她的別台裝置能寫，所以說「別的裝置」
  await setKm('mick', wT, twoRuns(5, 6));
  await setKm('mick', wS, twoRuns(5, 6.5));
  Sync._pushPlanWeekNow = (uid, wn, ...rest) => { const k = `users/${uid}/planWeeks/${wn}`; if (sandbox.__remote[k]) sandbox.__remote[k] = { ...sandbox.__remote[k], updatedAt: '2099-02-02T00:00:00.000Z' }; return realPush3(uid, wn, ...rest); };
  App.state.viewingUserId = null; App.state.weekViewNumber = wT; App.state.copySrcWeek = wS;
  sandbox.__alerts.length = 0; sandbox.__ok = true;
  await App.copyOwnWeek(1);
  Sync._pushPlanWeekNow = realPush3;
  assert(lastAlert().includes('剛被別的裝置改過，這次沒有複製'), `her own plan, written meanwhile: says another device, not 「別人」: ${lastAlert()}`);

  // ── 守則：來源週有還沒存進雲端的修改就不複製；連不上伺服器就不複製 ──
  await setKm('mick', wS, twoRuns(5, 6));
  sandbox.__fail = 'network';
  edit('mick', wS, (x) => { x.days[3] = { ...x.days[3], dayNotes: '來源週還沒存進雲端的修改' }; });
  await settle(); stopRetry();
  sandbox.__fail = null;
  const keepT = JSON.stringify(wk(wT));
  App.state.weekViewNumber = wT; App.state.copySrcWeek = wS; sandbox.__alerts.length = 0; sandbox.__confirms.length = 0;
  await App.copyOwnWeek(1);
  assert(lastAlert().includes(`Mick 的第 ${wS} 週還有修改沒存進雲端`) && lastAlert().includes('這次先不複製') && sandbox.__confirms.length === 0 && JSON.stringify(wk(wT)) === keepT, 'the source week has changes that never reached the cloud: refused, nothing copied');
  Sync.retryUnsavedPlanWeeks(); await settle();
  Sync.fetchCopyGuards = async () => false;
  sandbox.__alerts.length = 0; sandbox.__confirms.length = 0;
  await App.copyOwnWeek(1);
  Sync.fetchCopyGuards = async () => true;
  assert(lastAlert() === '沒有連上網路，這次沒有複製。' && sandbox.__confirms.length === 0 && JSON.stringify(wk(wT)) === keepT, 'cannot reach the server to check her records: nothing is copied');
  // 來源週不合法：預覽跟存都擋（0 是「沒選」，不在這裡）
  for (const bad of [total + 1, 1.5, '3', -1]) {
    assert(Store.copyPlanPreview('mick', 'mick', 1, TW, bad).weeks.length === 0 && Store.applyCopyPlan({ from: 'mick', to: 'mick', srcWeek: bad, weeks: [{ weekNumber: TW, days: [0], fields: [] }] }).weeks.length === 0, `an impossible source week (${JSON.stringify(bad)}) is refused by both the preview and the save`);
  }

  // ── 已經複製給別人的功能照舊（同一個函式、沒有來源週時）──
  assert(Store.copyPlanPreview('mick', 'Annlin', 'week', TW).srcWeek === null, 'copying between people still works as before (no source week)');
})();
