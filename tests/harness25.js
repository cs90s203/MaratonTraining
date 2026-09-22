// 決策紀錄第 63、64 條：複製課表的結果照實講；存課表網路失敗時修改留著、自動補存、不再誤判成「別人改過」
// 她：「為什麼我按複製課表給別人的這部分，課表的內部順序以及備註都沒有被同步？」——排 Annlin、按「Phoebe 的 這一週」，
// Phoebe 那週用 ↑↓ 換過順序、加過備註。
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
  alert: (m) => sandbox.__alerts.push(m), confirm: (m) => { sandbox.__confirms.push(m); return true; }, __alerts: [], __confirms: [],
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
  Store.activeUserId = 'mick'; Store.init(); Store._cloudPush = () => {}; Store._cloudPushLibrary = () => {};
  Sync.user = { email: 'x@example.com' }; Sync.detectedUserId = 'mick'; Sync.state = 'done';
  Sync.planWeeksLoaded = () => true; Sync.fetchCopyGuards = async () => true;
  // 假的 Firestore：transaction 照真的（讀雲端版本、比對、寫），可以讓它「沒連上網路」或「被拒」
  sandbox.__remote = {}; sandbox.__fail = null;
  vm.runInContext(`fbDb = {
    collection: (p) => ({ doc: (id) => ({ path: p + '/' + id, get: () => Promise.resolve(globalThis.__remote[p + '/' + id] ? { exists: true, data: () => JSON.parse(JSON.stringify(globalThis.__remote[p + '/' + id])) } : { exists: false }) }) }),
    runTransaction: (f) => {
      if (globalThis.__fail === 'network') return Promise.reject(Object.assign(new Error('Failed to get document because the client is offline.'), { code: 'unavailable' }));
      if (globalThis.__fail === 'denied') return Promise.reject(Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }));
      if (globalThis.__fail === 'hang') return new Promise(() => {}); // SDK 還在自己重試（真的 Firestore 斷線時會試好幾秒）
      const landed = globalThis.__fail === 'landed-then-error'; // 寫進去了、快照先送來這一份，回應才失敗
      const w = [];
      const lost = globalThis.__fail === 'committed-but-no-reply';
      return f({ get: (ref) => ref.get(), set: (ref, d) => w.push([ref.path, d]) }).then(() => {
        w.forEach(([p, d]) => { globalThis.__remote[p] = JSON.parse(JSON.stringify(d)); });
        if (landed) w.forEach(([p, d]) => { const [, uid, , wn] = p.split('/'); Store.mergeRemotePlanWeek(uid, Number(wn), JSON.parse(JSON.stringify(d)), true); });
        if (lost || landed) throw Object.assign(new Error('deadline exceeded'), { code: 'deadline-exceeded' });
      });
    },
  }`, sandbox);
  Store._cloudPushPlanWeek = Sync.pushPlanWeek.bind(Sync);
  Store.coachMode = true;
  const W = Math.min(PlanData.locateToday().weekNumber + 1, PlanData.plan.totalWeeks);
  App.state.page = 'week'; App.state.weekViewNumber = W;
  const titles = (u, di) => Store.effectiveWeek(W, u).days[di].items.map((i) => i.title).join('+');
  const cloudDoc = (u) => sandbox.__remote[`users/${u}/planWeeks/${W}`];
  const stopRetry = () => { clearTimeout(Sync._unsavedRetryTimer); Sync._unsavedRetryTimer = null; };
  const unsaved = (u, w) => Store.planUnsavedWeeks().some((x) => x.userId === u && x.weekNumber === w);
  const pillNow = () => vm.runInContext('renderSyncPill', sandbox)();
  // 只有寫 Annlin 那一下出狀況（複製前「等兩邊存完」、寫 Phoebe 都正常）
  const realPush = Sync._pushPlanWeekNow.bind(Sync);
  const copyWith = async (fail) => {
    Sync._pushPlanWeekNow = (uid, ...rest) => { if (uid === 'Annlin') sandbox.__fail = fail; const r = realPush(uid, ...rest); sandbox.__fail = null; return r; };
    await App.copyPlanFrom('Phoebe', 'week');
    Sync._pushPlanWeekNow = realPush;
  };
  const tpl = Store.saveLibraryDoc(null, 'item', { name: '伸展', item: { type: 'recovery', title: '伸展', duration: { min: 10, max: 10 } } });

  // ── 她的步驟：排 Phoebe，同一天 ↑ 換順序、加教練備註；排 Annlin 按「Phoebe 的 這一週」──
  App.viewWeekOf('Phoebe');
  App.addItemFromLibrary(W, 0, tpl.id);
  await settle();
  const added = Store.effectiveWeek(W, 'Phoebe').days[0].items.slice(-1)[0];
  App.moveItem(W, 0, added.id, -1);
  App.saveItemNote(W, 1, Store.effectiveWeek(W, 'Phoebe').days[1].items[0].id, { value: '給 Annlin 看的備註' });
  await settle();
  const phoebeMon = titles('Phoebe', 0);
  assert(phoebeMon.startsWith('伸展+') && cloudDoc('Phoebe').days[0].items[0].title === '伸展', 'setup: Phoebe\'s ↑ and note reached the cloud');
  App.viewWeekOf('Annlin');
  sandbox.__alerts.length = 0;
  await App.copyPlanFrom('Phoebe', 'week');
  assert(titles('Annlin', 0) === phoebeMon && Store.effectiveWeek(W, 'Annlin').days[1].items[0].coachNote === '給 Annlin 看的備註', 'copied: the item order within the day and the coach note both arrive');
  assert(cloudDoc('Annlin').days[1].items[0].coachNote === '給 Annlin 看的備註' && cloudDoc('Annlin').days[0].items[0].title === '伸展', 'and they are in Annlin\'s cloud copy (her phone sees them)');
  assert(sandbox.__alerts.length === 1 && /^已經把 Phoebe 的課表複製給 Annlin：第 \d+ 週，改了 \d+ 天。$/.test(sandbox.__alerts[0]), `after the cloud confirms, it says so: ${sandbox.__alerts[0]}`);
  assert(sandbox.__confirms.slice(-1)[0].includes('整週都換') && !sandbox.__confirms.slice(-1)[0].includes('已經過去的日子'), 'confirm says the whole week is copied (a future week: no mention of past days)');

  // ── 第 64 條：網路斷掉時存檔——畫面上的修改留著、講清楚、不會在下一次被誤判成「別人改過」──
  App.viewWeekOf('Phoebe');
  sandbox.__fail = 'network';
  App.moveItem(W, 0, Store.effectiveWeek(W, 'Phoebe').days[0].items[0].id, 1);
  await settle();
  const afterMove = titles('Phoebe', 0);
  assert(!afterMove.startsWith('伸展+') && unsaved('Phoebe', W), 'network failure: the edit stays on screen, marked as not in the cloud yet');
  const why = Sync.planIssueMessage();
  assert(pillNow().includes('還沒存進雲端，點擊看原因') && why.includes(`Phoebe 的第 ${W} 週還沒存進雲端（沒有連上網路）`) && why.includes('自動補存'), `and the sync status says so in plain words: ${why}`);
  // 雲端送來的還是舊的那份：不蓋掉這台還沒存上去的
  assert(Store.mergeRemotePlanWeek('Phoebe', W, JSON.parse(JSON.stringify(cloudDoc('Phoebe')))) === 'kept' && titles('Phoebe', 0) === afterMove, 'an old cloud copy does not wipe the unsaved edit');
  // 斷線中想複製：先講、不複製（來源那份還沒到雲端）
  App.viewWeekOf('Annlin');
  sandbox.__alerts.length = 0;
  await App.copyPlanFrom('Phoebe', 'week');
  assert(sandbox.__alerts.length === 1 && sandbox.__alerts[0].includes(`Phoebe 的第 ${W} 週還有修改沒存進雲端`) && sandbox.__alerts[0].includes('這次先不複製') && titles('Annlin', 0) === phoebeMon, 'copying while the source has unsaved edits: refused with the reason');
  stopRetry();
  // 網路恢復之後的下一個修改：比對基準是雲端確認過的那版，兩個修改一起存進去（以前會被判成「剛被別人改過」、兩個都不見）
  sandbox.__fail = null;
  App.viewWeekOf('Phoebe');
  App.saveItemNote(W, 2, Store.effectiveWeek(W, 'Phoebe').days[2].items[0].id, { value: '網路回來之後' });
  await settle();
  const pc = cloudDoc('Phoebe');
  assert(pc.days[0].items.map((i) => i.title).join('+') === afterMove && pc.days[2].items[0].coachNote === '網路回來之後', 'the next save carries both edits to the cloud');
  assert(!sandbox.__alerts.some((m) => m.includes('剛被別人改過')) && !unsaved('Phoebe', W) && pillNow().includes('已同步'), 'no false "someone else changed it"; unsaved cleared; status back to 已同步');

  // ── 自動補送：斷線時改的，網路回來（或切回 App、按同步狀態重試）就送出去 ──
  sandbox.__fail = 'network';
  App.saveItemNote(W, 3, Store.effectiveWeek(W, 'Phoebe').days[3].items[0].id, { value: '斷線時寫的' });
  await settle();
  assert(unsaved('Phoebe', W) && !!Sync._unsavedRetryTimer, 'an unsaved edit schedules a retry');
  stopRetry();
  sandbox.__fail = null;
  Sync.retryUnsavedPlanWeeks();
  await settle();
  assert(cloudDoc('Phoebe').days[3].items[0].coachNote === '斷線時寫的' && !unsaved('Phoebe', W), 'retry sends it once the network is back');

  // ── 別人（別台）在這段時間改了：這台沒存上去的換成雲端的（Sync 會講）──
  sandbox.__fail = 'network';
  App.saveItemNote(W, 4, Store.effectiveWeek(W, 'Phoebe').days[4].items[0].id, { value: '會被換掉的' });
  await settle();
  stopRetry();
  sandbox.__fail = null;
  const theirs = { ...JSON.parse(JSON.stringify(cloudDoc('Phoebe'))), updatedAt: '2099-01-01T00:00:00.000Z' };
  assert(Store.mergeRemotePlanWeek('Phoebe', W, theirs) === 'dropped' && !unsaved('Phoebe', W), 'a newer cloud copy from elsewhere replaces the unsaved edit (reported as dropped)');
  sandbox.__remote[`users/Phoebe/planWeeks/${W}`] = theirs;

  // ── 複製的結果：對方那份沒存進雲端的三種原因，各講各的 ──
  const phoebeNote = async (di, text) => { App.viewWeekOf('Phoebe'); App.saveItemNote(W, di, Store.effectiveWeek(W, 'Phoebe').days[di].items[0].id, { value: text }); await settle(); App.viewWeekOf('Annlin'); };
  // (a) 沒連上網路：這台改好了、會自動補存，Annlin 的手機暫時看不到
  await phoebeNote(5, '要複製的');
  sandbox.__alerts.length = 0;
  await copyWith('network');
  let a = sandbox.__alerts.slice(-1)[0] || '';
  assert(a.includes('在這台改好了，但還沒存進雲端（沒有連上網路）') && a.includes('連上網路會自動補存') && a.includes('Annlin 的手機看不到') && !a.includes('已經把'), `network: says it will be saved automatically, and not that it was copied: ${a}`);
  stopRetry();
  Sync.retryUnsavedPlanWeeks(); await settle();
  assert(cloudDoc('Annlin').days[5].items[0].coachNote === '要複製的', 'and the retry gets it into Annlin\'s cloud copy');
  // (b) 規則擋下：講要發布規則
  await phoebeNote(6, '規則那次');
  sandbox.__alerts.length = 0;
  await copyWith('denied');
  a = sandbox.__alerts.slice(-1)[0] || '';
  assert(a.includes('寫入被拒') && a.includes('firestore.rules.local') && !a.includes('已經把'), `denied: says to publish the rules: ${a}`);
  stopRetry();
  Sync.retryUnsavedPlanWeeks(); await settle(); Sync.state = 'done';
  // (c) 別人剛改過 Annlin 那週：這次沒有複製，畫面換成雲端的
  await phoebeNote(6, '衝突那次');
  sandbox.__remote[`users/Annlin/planWeeks/${W}`] = { ...JSON.parse(JSON.stringify(cloudDoc('Annlin'))), updatedAt: '2099-02-02T00:00:00.000Z' };
  sandbox.__alerts.length = 0;
  await App.copyPlanFrom('Phoebe', 'week');
  await settle();
  a = sandbox.__alerts.slice(-1)[0] || '';
  assert(a.includes('剛被別人改過，這次沒有複製') && !a.includes('已經把') && Store.effectiveWeek(W, 'Annlin').days[6].items[0].coachNote !== '衝突那次', `conflict: not copied, and her week shows the cloud version: ${a}`);

  // ── 按了取消：什麼都不存、也不講結果 ──
  sandbox.confirm = () => false;
  sandbox.__alerts.length = 0;
  await App.copyPlanFrom('Phoebe', 'week');
  assert(sandbox.__alerts.length === 0 && Store.effectiveWeek(W, 'Annlin').days[6].items[0].coachNote !== '衝突那次', 'declined: nothing saved, no result message');
  sandbox.confirm = (m) => { sandbox.__confirms.push(m); return true; };

  // ══ 審查第三輪 ══
  // ── 她真正的情況：這一週、改的是今天跟之前的日子（v0.26.10 只複製明天以後，這些過不去）──
  const loc = PlanData.locateToday();
  if (loc.status === 'in-plan') {
    const TW = loc.weekNumber, TD = loc.dayIndex, PD = Math.max(TD - 1, 0);
    App.state.weekViewNumber = TW;
    App.viewWeekOf('Phoebe');
    App.addItemFromLibrary(TW, PD, tpl.id);
    await settle();
    const addedP = Store.effectiveWeek(TW, 'Phoebe').days[PD].items.slice(-1)[0];
    App.moveItem(TW, PD, addedP.id, -1);
    App.saveItemNote(TW, TD, Store.effectiveWeek(TW, 'Phoebe').days[TD].items[0].id, { value: '今天的備註' });
    await settle();
    App.viewWeekOf('Annlin');
    sandbox.__alerts.length = 0;
    await App.copyPlanFrom('Phoebe', 'week');
    const aw = Store.effectiveWeek(TW, 'Annlin');
    assert(aw.days[PD].items[0].title === '伸展' && aw.days[TD].items[0].coachNote === '今天的備註', 'this week: the ↑ on an earlier day and today\'s note are copied too (her report)');
    assert(sandbox.__confirms.slice(-1)[0].includes('包含已經過去的日子跟今天'), 'and the confirm says past days and today are included');
    App.state.weekViewNumber = W;
  } else console.log('SKIP: today is not inside the plan');

  // ── 排在後面、照舊內容改的存檔，不能在衝突之後蓋掉別人的（審查抓到的回歸）──
  const W2 = Math.min(W + 2, PlanData.plan.totalWeeks);
  App.state.weekViewNumber = W2;
  App.viewWeekOf('Annlin');
  App.saveItemNote(W2, 0, Store.effectiveWeek(W2, 'Annlin').days[0].items[0].id, { value: 'C0' });
  await settle();
  const X = { ...JSON.parse(JSON.stringify(sandbox.__remote[`users/Annlin/planWeeks/${W2}`])), updatedAt: '2099-03-03T00:00:00.000Z' };
  X.days[0].items[0].coachNote = 'Annlin 自己的手機改的';
  sandbox.__remote[`users/Annlin/planWeeks/${W2}`] = X; // 別台先存了，這台還不知道
  App.saveItemNote(W2, 1, Store.effectiveWeek(W2, 'Annlin').days[1].items[0].id, { value: '教練第一下' });
  App.saveItemNote(W2, 2, Store.effectiveWeek(W2, 'Annlin').days[2].items[0].id, { value: '教練第二下' });
  await settle(); await settle();
  const remoteW2 = sandbox.__remote[`users/Annlin/planWeeks/${W2}`];
  assert(remoteW2.updatedAt === X.updatedAt && remoteW2.days[0].items[0].coachNote === 'Annlin 自己的手機改的', 'two queued saves after someone else\'s write: neither overwrites it');
  assert(sandbox.__alerts.filter((m) => m.includes(`Annlin 的第 ${W2} 週剛被別人改過`)).length === 1 && Store.effectiveWeek(W2, 'Annlin').days[0].items[0].coachNote === 'Annlin 自己的手機改的', 'the conflict pops up once (not once per queued save) and her version is on screen');
  // 衝突之後接著改：從雲端那版重新開始，照常存得進去
  App.saveItemNote(W2, 3, Store.effectiveWeek(W2, 'Annlin').days[3].items[0].id, { value: '衝突後再改' });
  await settle();
  assert(sandbox.__remote[`users/Annlin/planWeeks/${W2}`].days[3].items[0].coachNote === '衝突後再改' && sandbox.__remote[`users/Annlin/planWeeks/${W2}`].days[0].items[0].coachNote === 'Annlin 自己的手機改的', 'the next edit after the conflict saves normally, on top of her version');

  // ── 雲端其實寫進去了、只是回應沒收到：補送不能被誤判成「別人改過」──
  sandbox.__fail = 'committed-but-no-reply';
  App.saveItemNote(W2, 4, Store.effectiveWeek(W2, 'Annlin').days[4].items[0].id, { value: '其實存了' });
  await settle();
  sandbox.__fail = null;
  stopRetry();
  assert(unsaved('Annlin', W2), 'setup: the client thinks it failed');
  Sync.retryUnsavedPlanWeeks(); await settle();
  assert(Sync._planResult[`planWeeks:${W2}:Annlin`] === 'ok' && !unsaved('Annlin', W2) && sandbox.__remote[`users/Annlin/planWeeks/${W2}`].days[4].items[0].coachNote === '其實存了', 'the retry sees its own write in the cloud: no false conflict');

  // ── 關掉 App 再打開：還沒存上去的還在（存在手機本機，照帳號分開），登入後還原、補送 ──
  sandbox.__fail = 'network';
  App.saveItemNote(W2, 5, Store.effectiveWeek(W2, 'Annlin').days[5].items[0].id, { value: '關掉前寫的' });
  await settle(); stopRetry();
  const saved = JSON.parse(store['mt_plan_unsaved_v1'] || '{}');
  assert(saved['x@example.com'] && saved['x@example.com'][`Annlin:${W2}`], 'the unsaved week is kept on the phone, under this account');
  // 模擬重新打開：記憶體清空
  Store.resetPlanSyncState(); delete Store.planWeeks.Annlin[W2];
  assert(Store.effectiveWeek(W2, 'Annlin').days[5].items[0].coachNote !== '關掉前寫的', 'setup: after the reload the edit is not in memory');
  Sync.user = { email: 'other@example.com' };
  assert(Sync._restoreUnsaved() === 0, 'another account signing in on this phone does not get it');
  Sync.user = { email: 'x@example.com' };
  sandbox.__alerts.length = 0;
  const localEdit = App._cloneEffectiveWeek(W2, 'Annlin'); localEdit.days[6] = { ...localEdit.days[6], dayNotes: '登入前在這台改的' };
  Store.planWeeks.Annlin[W2] = localEdit;
  assert(Sync._restoreUnsaved() === 1 && Store.effectiveWeek(W2, 'Annlin').days[5].items[0].coachNote === '關掉前寫的', 'the same account signs in: the edit is back on screen');
  await settle();
  assert(sandbox.__alerts.some((m) => m.includes('換成上次還沒存進雲端的那份')), 'and if something else was on screen (edited while signed out) it says so, instead of swapping it silently');
  assert(Store.mergeRemotePlanWeek('Annlin', W2, JSON.parse(JSON.stringify(sandbox.__remote[`users/Annlin/planWeeks/${W2}`]))) === 'kept', 'the first cloud snapshot (still the old version) does not wipe it');
  // 同步狀態看得出原因
  const pill = pillNow();
  assert(pill.includes('還沒存進雲端，點擊看原因') && pill.includes('A.syncPillTap()'), 'the sync status says 還沒存進雲端 and tapping it shows why');
  sandbox.__fail = null;
  Sync.retryUnsavedPlanWeeks(); await settle();
  assert(sandbox.__remote[`users/Annlin/planWeeks/${W2}`].days[5].items[0].coachNote === '關掉前寫的' && !JSON.parse(store['mt_plan_unsaved_v1'] || '{}')['x@example.com'], 'then it is saved and removed from the phone copy');
  // 同步狀態是算出來的：存好了就自己回到「已同步」，不用點、不會停在已經存好的那週
  assert(pillNow().includes('已同步') && !Sync.planIssueMessage(), 'once it is saved the status is 已同步 by itself');
  Sync.resubscribe = () => {};

  // ══ 審查第四輪：同步狀態卡住／講錯、修改沒存進去卻沒講 ══
  const W3 = Math.min(W + 3, PlanData.plan.totalWeeks), W4 = Math.min(W + 4, PlanData.plan.totalWeeks);
  App.state.weekViewNumber = W3;
  const note = (wn, di, text) => App.saveItemNote(wn, di, Store.effectiveWeek(wn, 'Annlin').days[di].items[0].id, { value: text });
  const elsewhere = (wn) => { const d = { ...JSON.parse(JSON.stringify(sandbox.__remote[`users/Annlin/planWeeks/${wn}`] || { ...PlanData.week(wn), weekNumber: wn, userId: 'Annlin' })), updatedAt: `2099-04-0${wn % 9 + 1}T00:00:00.000Z` }; sandbox.__remote[`users/Annlin/planWeeks/${wn}`] = d; };
  // (1) 斷線時改了兩週、這段時間兩週都被別台改過；網路回來補送 → 兩週都當下跳視窗講（以前只在小字，看了最後一筆就全清掉）
  note(W3, 0, 'w3 基準'); note(W4, 0, 'w4 基準'); await settle();
  sandbox.__fail = 'network';
  note(W3, 1, '斷線 w3'); note(W4, 1, '斷線 w4'); await settle(); stopRetry();
  sandbox.__fail = null;
  elsewhere(W3); elsewhere(W4);
  sandbox.__alerts.length = 0;
  Sync.retryUnsavedPlanWeeks(); await settle(); await settle();
  const both = sandbox.__alerts.join('\n');
  assert(W3 !== W4 && both.includes(`Annlin 的第 ${W3} 週剛被別人改過`) && both.includes(`Annlin 的第 ${W4} 週剛被別人改過`) && sandbox.__alerts.length === 1, `both lost weeks pop up, in one window: ${both}`);
  assert(pillNow().includes('已同步') && !unsaved('Annlin', W3) && !unsaved('Annlin', W4), 'and nothing is left stuck in the status');
  // (2) 還原本週斷線：講「沒有還原成功」，不講「修改還在、會自動補存」；同步狀態不卡住
  sandbox.__fail = 'network';
  sandbox.__alerts.length = 0;
  Store.resetPlanWeek('Annlin', W3); await settle(); stopRetry();
  sandbox.__fail = null;
  assert(sandbox.__alerts.some((m) => m.includes(`第 ${W3} 週沒有還原成功（沒有連上網路），畫面退回原本的內容`)) && !Sync.planIssueMessage().includes(`第 ${W3} 週`) && pillNow().includes('已同步'), `reset offline: says it did not reset, and the status is not stuck: ${sandbox.__alerts.join(' / ')}`);
  // (3) 寫進去了、快照先送來這一份，回應才失敗：不算沒存上去，同步狀態、手機本機都不留（以前會一直卡著、下次開 App 還原舊的）
  sandbox.__fail = 'landed-then-error';
  note(W3, 2, '其實寫進去了'); await settle(); stopRetry();
  sandbox.__fail = null;
  Sync._planSettled();
  assert(!unsaved('Annlin', W3) && pillNow().includes('已同步') && !(JSON.parse(store['mt_plan_unsaved_v1'] || '{}')['x@example.com'] || {})[`Annlin:${W3}`], 'written but the reply was lost (its snapshot arrived first): not unsaved, not kept on the phone');
  // (4) 存的當下就留在手機本機：送的期間關掉 App 也不會丟（以前送失敗才存）
  sandbox.__fail = 'hang';
  note(W3, 3, '送的期間關掉');
  const onPhone = (JSON.parse(store['mt_plan_unsaved_v1'] || '{}')['x@example.com'] || {})[`Annlin:${W3}`];
  assert(onPhone && onPhone.doc.days[3].items[0].coachNote === '送的期間關掉', 'the edit is on the phone copy as soon as it is saved, before the cloud answers');
  assert(pillNow().includes('同步中'), 'while it is being sent the status says 同步中 (not 已同步)');
  // 模擬關掉重開（那一筆永遠沒有回來）
  sandbox.__fail = null;
  Store.resetPlanSyncState(); delete Store.planWeeks.Annlin[W3];
  Sync._planQueue = {};
  assert(Sync._restoreUnsaved() === 1 && Store.effectiveWeek(W3, 'Annlin').days[3].items[0].coachNote === '送的期間關掉', 'reopened: the edit is back');
  Sync.retryUnsavedPlanWeeks(); await settle();
  assert(sandbox.__remote[`users/Annlin/planWeeks/${W3}`].days[3].items[0].coachNote === '送的期間關掉' && !unsaved('Annlin', W3), 'and it is saved');
  // (5) 課表存好了，不會把別的問題（例如紀錄的訂閱斷了）洗成「已同步」
  Sync._set('fail', '同步發生錯誤：紀錄的訂閱斷了');
  note(W3, 4, '一般的修改'); await settle();
  assert(Sync.state === 'fail' && pillNow().includes('同步有問題，點擊看原因'), 'a plan save does not hide an unrelated sync problem');
  Sync._set('done', '已同步');
  // (6) 寫入被拒：同步狀態寫「還沒存進雲端」，點了講要發布規則、而且會重送
  sandbox.__fail = 'denied';
  note(W3, 5, '規則還沒發布'); await settle(); stopRetry();
  assert(pillNow().includes('還沒存進雲端，點擊看原因') && Sync.planIssueMessage().includes('firestore.rules.local'), 'denied: the status says why (publish the rules)');
  sandbox.__fail = null;
  sandbox.__alerts.length = 0;
  App.syncPillTap(); await settle();
  assert(sandbox.__alerts[0] && sandbox.__alerts[0].includes('firestore.rules.local') && sandbox.__remote[`users/Annlin/planWeeks/${W3}`].days[5].items[0].coachNote === '規則還沒發布' && pillNow().includes('已同步'), 'tapping it shows the reason, then sends it again (after the rules are published it goes through)');
  App.state.weekViewNumber = W;

  // ── 複製會讓她的日子看起來變差的，確認畫面一天一天講（第 0 條，審查抓到）──
  if (loc.status === 'in-plan') {
    const TW = loc.weekNumber, TD = loc.dayIndex;
    App.state.weekViewNumber = TW;
    // 今天：她做完了一個跑步項目；Phoebe 的今天換成「完全休息 或 同一個跑步」→ 沒選＝未完成
    const aDay = Store.effectiveWeek(TW, 'Annlin').days[TD];
    const runIt = { id: 'r-1', type: 'run', title: '測試跑', duration: { min: 30, max: 30 } };
    App.viewWeekOf('Annlin');
    const aw = App._cloneEffectiveWeek(TW, 'Annlin'); aw.days[TD] = { ...aw.days[TD], selectOne: false, items: [runIt] };
    Store.savePlanWeek('Annlin', TW, aw); await settle();
    Store.mergeRemoteEntry('Annlin', PlanData.keyForWeekDay(TW, TD), { done: { 'r-1': true }, selectedItemId: null, status: null, updatedAt: '2026-09-22T10:00:00.000Z', fieldAt: {} });
    const pw = App._cloneEffectiveWeek(TW, 'Phoebe');
    pw.days[TD] = { ...pw.days[TD], selectOne: true, items: [{ id: 'p-rest', type: 'rest', title: '完全休息' }, { ...runIt, id: 'p-run' }] };
    Store.savePlanWeek('Phoebe', TW, pw); await settle();
    const pv = Store.copyPlanPreview('Phoebe', 'Annlin', 'week', TW);
    assert(pv.drops.some((x) => x.dayIndex === TD && x.kind === 'undone'), 'a day she finished that would become not-finished is flagged');
    sandbox.confirm = (m) => { sandbox.__confirms.push(m); return false; }; // 看確認畫面就好，不真的複製
    await App.copyPlanFrom('Phoebe', 'week');
    const c = sandbox.__confirms.slice(-1)[0] || '';
    assert(c.includes('Annlin 原本是「完成」，換成 Phoebe 的之後會變成「待完成」'), `and the confirm names it (today: 待完成, like the day card): ${c.split('\n').find((l) => l.includes('原本是')) || ''}`);
    // 過去的休息日（沒紀錄）變成要練的日子
    if (TD > 0) {
      const aw2 = App._cloneEffectiveWeek(TW, 'Annlin'); aw2.days[TD - 1] = { ...aw2.days[TD - 1], selectOne: false, items: [{ id: 'a-rest', type: 'rest', title: '完全休息' }] };
      Store.savePlanWeek('Annlin', TW, aw2); await settle();
      const pk = PlanData.keyForWeekDay(TW, TD - 1);
      if (Store.entries.Annlin) delete Store.entries.Annlin[pk];
      const pw2 = App._cloneEffectiveWeek(TW, 'Phoebe'); pw2.days[TD - 1] = { ...pw2.days[TD - 1], selectOne: false, items: [{ id: 'p-run2', type: 'run', title: '輕鬆跑', duration: { min: 30, max: 30 } }] };
      Store.savePlanWeek('Phoebe', TW, pw2); await settle();
      await App.copyPlanFrom('Phoebe', 'week');
      const c2 = sandbox.__confirms.slice(-1)[0] || '';
      assert(c2.includes('原本是休息日，換成 Phoebe 的之後會變成要練的日子（沒有紀錄會顯示未完成）'), 'a past rest day turning into a training day is named too');
      // 審查抓到：那天只寫了附註（沒打勾）也一樣——附註不是做完
      Store.mergeRemoteEntry('Annlin', pk, { done: {}, selectedItemId: null, status: null, actualNote: '今天休息，只推嬰兒車散步', updatedAt: '2026-09-22T10:00:01.000Z', fieldAt: {} });
      assert(Store.copyPlanPreview('Phoebe', 'Annlin', 'week', TW).drops.some((x) => x.dayIndex === TD - 1 && x.kind === 'rest-to-training'), 'a past rest day with only a note is still named');
      // 審查抓到：部分完成的一天換成二擇一，留著的勾沒被選到就不算——「部分完成」往下掉也要講
      const aw3 = App._cloneEffectiveWeek(TW, 'Annlin');
      aw3.days[TD - 1] = { ...aw3.days[TD - 1], selectOne: false, items: [{ id: 'a-core', type: 'recovery', title: '核心', duration: { min: 10, max: 10 } }, { id: 'a-run3', type: 'run', title: '輕鬆跑', duration: { min: 30, max: 30 } }] };
      Store.savePlanWeek('Annlin', TW, aw3); await settle();
      Store.mergeRemoteEntry('Annlin', pk, { done: { 'a-core': true }, selectedItemId: null, status: null, updatedAt: '2026-09-22T10:00:02.000Z', fieldAt: {} });
      const pw3 = App._cloneEffectiveWeek(TW, 'Phoebe');
      pw3.days[TD - 1] = { ...pw3.days[TD - 1], selectOne: true, items: [{ id: 'p-core', type: 'recovery', title: '核心', duration: { min: 10, max: 10 } }, { id: 'p-rest3', type: 'rest', title: '完全休息' }] };
      Store.savePlanWeek('Phoebe', TW, pw3); await settle();
      await App.copyPlanFrom('Phoebe', 'week');
      const c3 = sandbox.__confirms.slice(-1)[0] || '';
      assert(c3.includes('Annlin 原本是「部分完成」，換成 Phoebe 的之後會變成「未完成」'), `partial → not counted is named: ${c3.split('\n').find((l) => l.includes('部分完成')) || ''}`);
    }
    // 審查抓到：今天是休息日、換成要練的，也要講（整週複製包含今天）
    {
      const aw4 = App._cloneEffectiveWeek(TW, 'Annlin'); aw4.days[TD] = { ...aw4.days[TD], selectOne: false, items: [{ id: 'a-rest4', type: 'rest', title: '完全休息' }] };
      Store.savePlanWeek('Annlin', TW, aw4); await settle();
      if (Store.entries.Annlin) delete Store.entries.Annlin[PlanData.keyForWeekDay(TW, TD)];
      const pw4 = App._cloneEffectiveWeek(TW, 'Phoebe'); pw4.days[TD] = { ...pw4.days[TD], selectOne: false, items: [{ id: 'p-run4', type: 'run', title: '輕鬆跑', duration: { min: 30, max: 30 } }] };
      Store.savePlanWeek('Phoebe', TW, pw4); await settle();
      await App.copyPlanFrom('Phoebe', 'week');
      const c4 = sandbox.__confirms.slice(-1)[0] || '';
      assert(c4.includes('原本是休息日，換成 Phoebe 的之後會變成要練的日子（今天還沒練）'), 'today\'s rest day turning into a training day is named');
    }
    // 範圍的說法照實際（審查抓到）：整週都在過去的，不寫「包含今天」
    if (TW > 1) {
      App.state.weekViewNumber = TW - 1;
      const pw5 = App._cloneEffectiveWeek(TW - 1, 'Phoebe'); pw5.days[0] = { ...pw5.days[0], dayNotes: '上週的備註' };
      Store.savePlanWeek('Phoebe', TW - 1, pw5); await settle();
      await App.copyPlanFrom('Phoebe', 'week');
      const c5 = sandbox.__confirms.slice(-1)[0] || '';
      assert(c5.includes('整週都換（包含已經過去的日子）。'), `a past week: "past days", not "and today": ${c5.split('\n').find((l) => l.includes('範圍')) || ''}`);
      App.state.weekViewNumber = TW;
    }
    sandbox.confirm = (m) => { sandbox.__confirms.push(m); return true; };
    App.state.weekViewNumber = W;
  }

  // ══ 審查第五輪（重整之後）══
  {
    const W5 = Math.min(W + 5, PlanData.plan.totalWeeks);
    App.state.weekViewNumber = W5;
    App.viewWeekOf('Annlin');
    const note5 = (di, text) => App.saveItemNote(W5, di, Store.effectiveWeek(W5, 'Annlin').days[di].items[0].id, { value: text });
    const cloud5 = () => sandbox.__remote[`users/Annlin/planWeeks/${W5}`];
    note5(0, '基準'); await settle();
    // (1) 結果照「雲端到底有沒有」講：_planResult 被清掉（登出）也不會把沒送到的講成成功
    sandbox.__fail = 'network';
    note5(1, '沒送到'); await settle(); stopRetry();
    sandbox.__fail = null;
    delete Sync._planResult[`planWeeks:${W5}:Annlin`];
    const settled = await Sync.settlePlanWeeks('Annlin', [W5]);
    assert(settled.length === 1 && settled[0].kind === 'network', 'a week that never reached the cloud is reported as not saved, even when the recorded result was cleared');
    // 等的期間又被排進去送（補送）：settle 要一起等完，不能先回報「沒問題」
    const settling = Sync.settlePlanWeeks('Annlin', [W5]);
    Sync.retryUnsavedPlanWeeks();
    assert((await settling).length === 0 && !unsaved('Annlin', W5), 'a week requeued while settle is waiting is waited for too');
    // (2) 複製途中別台改了同一週、這次又沒送到：說「剛被別人改過、這次沒有複製」，不能說「會自動補存」
    App.viewWeekOf('Phoebe');
    App.saveItemNote(W5, 2, Store.effectiveWeek(W5, 'Phoebe').days[2].items[0].id, { value: '要複製的內容' });
    await settle();
    App.viewWeekOf('Annlin');
    sandbox.__alerts.length = 0;
    const realPush2 = Sync._pushPlanWeekNow.bind(Sync);
    Sync._pushPlanWeekNow = (uid, wn, ...rest) => {
      if (uid !== 'Annlin') return realPush2(uid, wn, ...rest);
      sandbox.__fail = 'network';
      const theirs2 = { ...JSON.parse(JSON.stringify(cloud5())), updatedAt: '2099-06-06T00:00:00.000Z' };
      theirs2.days[6] = { ...theirs2.days[6], dayNotes: 'Annlin 自己手機上改的' };
      sandbox.__remote[`users/Annlin/planWeeks/${W5}`] = theirs2;
      const r = realPush2(uid, wn, ...rest);
      Store.mergeRemotePlanWeek('Annlin', W5, JSON.parse(JSON.stringify(theirs2)), true); // 送的期間快照進來
      sandbox.__fail = null;
      return r;
    };
    await App.copyPlanFrom('Phoebe', 'week');
    Sync._pushPlanWeekNow = realPush2;
    await settle(); stopRetry();
    const ca = sandbox.__alerts.join('\n');
    assert(ca.includes('剛被別人改過') && ca.includes('這次沒有複製') && !ca.includes('會自動補存') && !ca.includes('已經把'), `copy overwritten by the other device: says it was not copied, not that it will be auto-saved: ${ca}`);
    assert(Store.effectiveWeek(W5, 'Annlin').days[6].dayNotes === 'Annlin 自己手機上改的' && !unsaved('Annlin', W5), 'her own version is on screen and nothing is pretending to be unsaved');
    // (3) 還原本週沒送到、期間又改過：不能說「畫面退回原本的內容」（畫面是還原之後再改的，之後會補存）
    sandbox.__fail = 'network';
    sandbox.__alerts.length = 0;
    Store.resetPlanWeek('Annlin', W5);
    note5(3, '還原之後又改的');
    await settle(); stopRetry();
    sandbox.__fail = null;
    const ra = sandbox.__alerts.join('\n');
    assert(ra.includes('還原沒有存進雲端') && ra.includes('畫面上是還原之後再改的內容') && !ra.includes('畫面退回原本的內容'), `reset that could not roll back says what is really on screen: ${ra}`);
    Sync.retryUnsavedPlanWeeks(); await settle();
    assert(cloud5().days[3].items[0].coachNote === '還原之後又改的' && !unsaved('Annlin', W5), 'and that content is what gets saved');
    // 同樣的情況但被規則擋下：不能說「連上網路會自動補存」（她本來就連著網路）
    sandbox.__fail = 'denied';
    sandbox.__alerts.length = 0;
    Store.resetPlanWeek('Annlin', W5);
    note5(3, '被拒之後又改的');
    await settle(); stopRetry();
    sandbox.__fail = null;
    const da = sandbox.__alerts.join('\n');
    assert(da.includes('寫入被拒') && da.includes('存得進去的時候會自動補存') && !da.includes('連上網路會自動補存'), `denied reset says what really has to happen: ${da}`);
    Sync.retryUnsavedPlanWeeks(); await settle();
    // (4) 有課表沒存上去、同時又有別的同步問題：兩個都看得到
    sandbox.__fail = 'network';
    note5(4, '同時有別的問題'); await settle(); stopRetry();
    sandbox.__fail = null;
    Sync._set('write-denied', '這個 Google 帳號不能寫入「Annlin」的紀錄。');
    assert(pillNow().includes('同步有問題，點擊看原因') && Sync.syncMessage().includes('還沒存進雲端') && Sync.syncMessage().includes('不能寫入'), `both problems are visible: ${Sync.syncMessage()}`);
    Sync._set('done', '已同步');
    Sync.retryUnsavedPlanWeeks(); await settle();
    // (5) 課表訂閱斷過一次：恢復之後同步狀態回得來（以前永遠卡在「同步有問題」）
    Sync._handleSnapErr({ code: 'unavailable', message: '串流斷了' }, 'planWeeks', 'Annlin');
    assert(Sync.state === 'fail' && pillNow().includes('同步有問題'), 'setup: a dropped plan subscription shows a problem');
    clearTimeout(Sync._planRetryTimer); Sync._planRetryTimer = null;
    Sync._clearSnapFail('planWeeks:Phoebe');
    assert(Sync.state === 'fail', 'another person\'s plan subscription coming back does not clear hers (one listener per person)');
    // 離線時重掛，Firestore 會馬上用快取送一份回來：那不算「恢復了」
    Sync._clearSnapFail('planWeeks:Annlin', { metadata: { fromCache: true } });
    assert(Sync.state === 'fail' && pillNow().includes('同步有問題'), 'a cache-only snapshot does not count as the subscription coming back');
    Sync._clearSnapFail('planWeeks:Annlin', { metadata: { fromCache: false } });
    assert(Sync.state === 'done' && pillNow().includes('已同步'), 'when that subscription comes back the status does too');
    // 紀錄那邊的訂閱斷掉（不是權限問題）：真的走 _handleSnapErr，不是直接設狀態——審查抓到那裡有一行變數名寫錯，整個錯誤被吞掉
    Sync._handleSnapErr({ code: 'unavailable', message: '串流斷了' }, 'entries');
    assert(Sync.state === 'fail' && Sync.message.includes('同步發生錯誤') && pillNow().includes('同步有問題'), 'a dropped records subscription is visible (not swallowed)');
    // 一次斷了好幾個、只有會自己重掛的課表恢復：不能就說「已同步」（紀錄那邊還是斷的）
    Sync._handleSnapErr({ code: 'unavailable', message: '串流斷了' }, 'planWeeks', 'Annlin');
    clearTimeout(Sync._planRetryTimer); Sync._planRetryTimer = null;
    Sync._clearSnapFail('planWeeks:Annlin');
    assert(Sync.state === 'fail' && pillNow().includes('同步有問題'), 'the plan subscription healing itself does not hide the records subscription that is still dead');
    Sync._clearSnapFail('entries');
    assert(Sync.state === 'done', 'only when every dropped subscription is back does it say 已同步');
    // 舊的共用課表訂閱斷掉：拆掉才重掛得了（不然它設的「同步有問題」永遠清不掉）
    vm.runInContext('unsubPlanOverrides = () => {};', sandbox);
    Sync._handleSnapErr({ code: 'unavailable', message: '串流斷了' }, 'planOverrides');
    assert(Sync.state === 'fail' && vm.runInContext('unsubPlanOverrides', sandbox) === null, 'a dropped legacy-plan subscription is torn down so it can be re-attached');
    Sync._clearSnapFail('planOverrides');
    assert(Sync.state === 'done', 'and once it is back the status is too');
    // (6) 教練改了別人的課表還沒送出去，這台把「我是誰」切成別人：照樣補送（規則才是決定能不能寫的）
    sandbox.__fail = 'network';
    note5(5, '切身分前改的'); await settle(); stopRetry();
    sandbox.__fail = null;
    sandbox.__alerts.length = 0;
    Store.activeUserId = 'Phoebe';
    Sync.retryUnsavedPlanWeeks(); await settle();
    assert(cloud5().days[5].items[0].coachNote === '切身分前改的' && !sandbox.__alerts.some((m) => m.includes('只能改自己的課表')), 'switching who this device is set to does not throw away the coach\'s unsaved edit');
    Store.activeUserId = 'mick';
    // (7) 沒登入時改的：留在這台、不補送；登入後雲端有別的版本會換掉——要講
    Sync.user = null;
    const lw = App._cloneEffectiveWeek(W5, 'Annlin'); lw.days[6] = { ...lw.days[6], dayNotes: '沒登入時改的' };
    Store.savePlanWeek('Annlin', W5, lw);
    assert(Store.effectiveWeek(W5, 'Annlin').days[6].dayNotes === '沒登入時改的' && !unsaved('Annlin', W5), 'signed out: the edit stays on this device and is not queued for the cloud');
    Sync.user = { email: 'x@example.com' };
    sandbox.__alerts.length = 0;
    Sync._noticeLocalOnly(); await settle();
    assert(sandbox.__alerts.some((m) => m.includes('不會上傳，重新整理就會不見')), 'signing in tells her the signed-out edit will not be uploaded (even when the cloud has no copy of that week)');
    assert(!Store.planLocalOnlyWeeks().length && pillNow().includes('已同步'), 'and after saying it once the status is not left stuck on it');
    Sync.user = null;
    const lw2 = App._cloneEffectiveWeek(W5, 'Annlin'); lw2.days[6] = { ...lw2.days[6], dayNotes: '沒登入時改的' };
    Store.savePlanWeek('Annlin', W5, lw2);
    Sync.user = { email: 'x@example.com' };
    sandbox.__alerts.length = 0;
    Sync._mergeRemote('Annlin', W5, JSON.parse(JSON.stringify(cloud5())), true);
    await settle();
    assert(sandbox.__alerts.some((m) => m.includes('沒登入的時候在這台改的')) && Store.effectiveWeek(W5, 'Annlin').days[6].dayNotes !== '沒登入時改的', 'after signing in the cloud version wins, and it says so');
    // (8) 手機本機那份：另一個分頁的離線修改不能被這個分頁抹掉
    sandbox.__fail = 'network';
    note5(6, '這個分頁的'); await settle(); stopRetry();
    sandbox.__fail = null;
    const box = JSON.parse(store['mt_plan_unsaved_v1']);
    box['x@example.com']['Phoebe:2'] = { doc: { weekNumber: 2, userId: 'Phoebe', isFactory: true, updatedAt: 'T' }, base: null, mine: ['T'] };
    store['mt_plan_unsaved_v1'] = JSON.stringify(box);
    Sync._persistUnsaved();
    const box2 = JSON.parse(store['mt_plan_unsaved_v1']);
    assert(box2['x@example.com']['Phoebe:2'] && box2['x@example.com'][`Annlin:${W5}`], 'another tab\'s unsaved week survives this tab rewriting the phone copy');
    Sync.retryUnsavedPlanWeeks(); await settle();
    assert(JSON.parse(store['mt_plan_unsaved_v1'])['x@example.com']['Phoebe:2'], 'and it is still there after this tab saves its own');
    delete box2['x@example.com']['Phoebe:2']; store['mt_plan_unsaved_v1'] = JSON.stringify(box2); Sync._myUnsaved = [];
    // (9) 離線快取送來的舊版本不能把雲端確認過的蓋回去（transaction 寫的不會進快取）
    note5(0, '剛寫進雲端的'); await settle();
    const oldSnap = { ...JSON.parse(JSON.stringify(cloud5())), updatedAt: '2000-01-01T00:00:00.000Z' };
    assert(Store.mergeRemotePlanWeek('Annlin', W5, oldSnap, true, true) === 'stale' && Store.effectiveWeek(W5, 'Annlin').days[0].items[0].coachNote === '剛寫進雲端的', 'a cached older snapshot does not roll the screen back');
    note5(1, '之後又改的'); await settle();
    assert(cloud5().days[1].items[0].coachNote === '之後又改的' && !sandbox.__alerts.some((m) => m.includes(`第 ${W5} 週剛被別人改過`)), 'and the next edit still saves (no false "someone else changed it")');
    App.state.weekViewNumber = W;
  }

  // ── 同一天有兩個同名項目：先留她打過勾的那個 id ──
  const cd = Store._copyDay({ items: [{ id: 'x', type: 'recovery', title: '伸展' }] }, { items: [{ id: 'sa', type: 'recovery', title: '伸展' }, { id: 'sb', type: 'recovery', title: '伸展' }] }, 0, { done: { sb: true } });
  assert(cd.items[0].id === 'sb', 'duplicate names in a day: the ticked one keeps its id');

  stopRetry(); clearTimeout(Sync._planRetryTimer);
})();
