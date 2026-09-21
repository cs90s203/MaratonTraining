// 決策紀錄第 41 條：登入後用 rules（private 只有本人讀得到）自動選身分
const fs = require('fs');
const vm = require('vm');
const path = require('path').resolve(__dirname, '..'); // repo 根目錄
const load = (f) => JSON.parse(fs.readFileSync(path + '/data/' + f));
const map = { 'plan.json': load('plan.json'), 'videos.json': load('videos.json'), 'workouts.json': load('workouts.json'), 'users.json': load('users.json') };
const store = {};
const sandbox = {
  console, window: {}, crypto: require('crypto').webcrypto, setTimeout, location: { href: 'https://example.test/' },
  document: { getElementById: () => null, addEventListener: () => {}, querySelector: () => null },
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  fetch: async (u) => ({ json: async () => map[Object.keys(map).find((k) => u.includes(k))] }),
  APP_VERSION: 't',
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['js/plan-data.js', 'js/firebase-sync.js', 'js/store.js', 'js/views.js', 'js/app.js']) vm.runInContext(fs.readFileSync(path + '/' + f, 'utf8'), sandbox, { filename: f });
vm.runInContext('this.PlanData = PlanData; this.Store = Store; this.Sync = Sync; this.App = App; globalThis.render = () => {};', sandbox);
function assert(c, m) { console.log((c ? 'PASS' : 'FAIL') + ': ' + m); if (!c) process.exitCode = 1; }
const tick = () => new Promise((r) => setTimeout(r, 5));

(async () => {
  await sandbox.PlanData.load();
  const { Store, Sync, PlanData } = sandbox;
  Store.init();

  // 假的 Firestore：rules 決定哪個 userId 讀得到；記下 get 的 options
  let allowed = new Set(['Annlin']);
  let mode = 'rules'; // 'rules' | 'offline' | 'hang'
  const calls = [];
  let hangResolvers = [];
  vm.runInContext(`fbDb = { collection: (c) => ({ doc: (uid) => ({ collection: (sub) => ({ limit: () => ({ get: (opts) => globalThis.__probe(c, uid, sub, opts) }) }) }) }) }`, sandbox);
  sandbox.__probe = (c, uid, sub, opts) => {
    calls.push({ c, uid, sub, opts });
    if (mode === 'offline') return Promise.reject(Object.assign(new Error('offline'), { code: 'unavailable' }));
    if (mode === 'hang') return new Promise((res, rej) => hangResolvers.push({ uid, res, rej }));
    return allowed.has(uid) ? Promise.resolve({ empty: true }) : Promise.reject(Object.assign(new Error('denied'), { code: 'permission-denied' }));
  };
  let resubs = 0, backfills = [];
  Sync.resubscribe = () => { resubs++; backfills.push('resub:' + Store.activeUserId); };
  Sync._backfillLocal = (uid) => backfills.push(uid);

  // ── 1. 裝置上選的是 mick，登入的是 Annlin 的帳號 → 切成 Annlin ──
  Store.setActiveUser = Store.setActiveUser.bind(Store);
  Store.activeUserId = 'mick';
  Sync.user = { email: 'someone@example.com' };
  Sync.state = 'wrong-identity';
  const r1 = await Sync._detectIdentity();
  assert(r1 === 'Annlin' && Sync.detectedUserId === 'Annlin', 'detects the only readable userId');
  assert(Store.activeUserId === 'Annlin' && store.mt_active_user === 'Annlin', 'switches active identity and persists it');
  assert(resubs === 1 && backfills.join(',') === 'resub:Annlin', 'resubscribes once; no backfill under the wrong identity');
  assert(Sync._autoSelectedUserId === 'Annlin', 'remembers that the identity was auto-selected');
  assert(calls.length === PlanData.users.length && calls.every((c) => c.c === 'users' && c.sub === 'private' && c.opts && c.opts.source === 'server'), 'probes every user private collection from the server (not cache)');

  // ── 2. 已經是對的身分 → 不切，照常補推 ──
  resubs = 0; backfills = []; calls.length = 0;
  const r2 = await Sync._detectIdentity();
  assert(r2 === 'Annlin' && resubs === 0 && backfills.join(',') === 'Annlin', 'same identity: no switch, backfill current user');

  // ── 3. 離線 → 維持原本選的 ──
  mode = 'offline'; Store.activeUserId = 'mick'; backfills = []; resubs = 0;
  const r3 = await Sync._detectIdentity();
  assert(r3 === null && Store.activeUserId === 'mick' && resubs === 0 && backfills.join(',') === 'mick', 'offline: keep current identity, backfill as before');

  // ── 4. rules 對到兩個（設定錯）→ 不切 ──
  mode = 'rules'; allowed = new Set(['mick', 'Phoebe']); backfills = [];
  const r4 = await Sync._detectIdentity();
  assert(r4 === null && Store.activeUserId === 'mick', 'ambiguous (two readable): no switch');

  // ── 5. 一個都讀不到（白名單內但 isSelf 沒有這個人）→ 不切 ──
  allowed = new Set();
  const r5 = await Sync._detectIdentity();
  assert(r5 === null && Store.activeUserId === 'mick', 'none readable: no switch');

  // ── 6. 部分被拒、部分離線 → 不確定，不切 ──
  sandbox.__probe = (c, uid, sub, opts) => uid === 'Phoebe'
    ? Promise.resolve({})
    : Promise.reject(Object.assign(new Error('x'), { code: uid === 'mick' ? 'permission-denied' : 'unavailable' }));
  const r6 = await Sync._detectIdentity();
  assert(r6 === null && Store.activeUserId === 'mick', 'one readable but another unanswered: no switch');

  // ── 7. 偵測途中登出 → 結果作廢 ──
  sandbox.__probe = (c, uid) => new Promise((res, rej) => hangResolvers.push({ uid, res, rej }));
  hangResolvers = [];
  Store.activeUserId = 'mick';
  const p7 = Sync._detectIdentity();
  Sync.user = null; Sync._identityProbeSeq++; // 等同 onAuthStateChanged(null) 做的事
  hangResolvers.forEach((h) => (h.uid === 'Phoebe' ? h.res({}) : h.rej(Object.assign(new Error('d'), { code: 'permission-denied' }))));
  const r7 = await p7;
  assert(r7 === null && Store.activeUserId === 'mick', 'sign-out during detection: result ignored');

  // ── 8. 換帳號登入：舊的偵測結果不能蓋掉新的 ──
  Sync.user = { email: 'a@example.com' };
  hangResolvers = [];
  const pOld = Sync._detectIdentity();
  Sync.user = { email: 'b@example.com' };
  const pNew = Sync._detectIdentity();
  const oldSet = hangResolvers.slice(0, PlanData.users.length), newSet = hangResolvers.slice(PlanData.users.length);
  newSet.forEach((h) => (h.uid === 'Annlin' ? h.res({}) : h.rej(Object.assign(new Error('d'), { code: 'permission-denied' }))));
  await pNew;
  oldSet.forEach((h) => (h.uid === 'Phoebe' ? h.res({}) : h.rej(Object.assign(new Error('d'), { code: 'permission-denied' }))));
  await pOld;
  assert(Store.activeUserId === 'Annlin', 'stale detection from a previous account does not override the newer one');

  // ── 9. 設定頁標出登入的帳號 ──
  const html = vm.runInContext('renderSettingsPage', sandbox)({});
  const annRow = html.split('user-opt').find((s) => s.includes('>Annlin'));
  assert(annRow && annRow.includes('登入的帳號'), 'settings tags the detected user');
  assert(html.includes('登入之後固定是登入的帳號'), 'settings explains the identity is the signed-in account');

  // ── 11. resubscribe：換身分清掉上一個身分的錯誤狀態；一般重試只清身分不符 ──
  const realResub = vm.runInContext('Sync', sandbox).constructor === Object ? null : null;
  const SyncProto = sandbox.Sync;
  const src = fs.readFileSync(path + '/js/firebase-sync.js', 'utf8');
  // 拿回真正的 resubscribe（上面被 stub 掉了）：重新載入一份乾淨的 Sync 在新的 context
  const ctx2 = { ...sandbox };
  ctx2.window = ctx2;
  vm.createContext(ctx2);
  for (const f of ['js/plan-data.js', 'js/firebase-sync.js', 'js/store.js']) vm.runInContext(fs.readFileSync(path + '/' + f, 'utf8'), ctx2, { filename: f });
  vm.runInContext('this.PlanData = PlanData; this.Store = Store; this.Sync = Sync;', ctx2);
  await ctx2.PlanData.load();
  const S2 = ctx2.Sync;
  S2.user = { email: 'x@example.com' };
  S2._detachListeners = () => {}; S2._attachListeners = () => {}; S2._detachLibrary = () => {}; S2._attachLibrary = () => {}; S2._backfillLocal = () => {};
  S2.state = 'write-denied'; S2.failedWrites = new Set(['entries:2026-09-14', 'private:2026-09-14', 'library:c-1']);
  S2.resubscribe(true);
  assert(!S2.failedWrites.has('entries:2026-09-14') && !S2.failedWrites.has('private:2026-09-14') && S2.failedWrites.has('library:c-1'), 'identity change drops only the previous identity own-write failures');
  assert(S2.state === 'write-denied', 'write-denied stays while a non-identity failure remains');
  S2.failedWrites = new Set(['entries:2026-09-14']); S2.state = 'write-denied';
  S2.resubscribe(true);
  assert(S2.state === 'syncing' && S2.failedWrites.size === 0, 'identity change clears write-denied when nothing else failed');
  S2.state = 'wrong-identity'; S2.failedWrites = new Set(['entries:2026-09-15']);
  S2.resubscribe();
  assert(S2.state === 'syncing' && S2.failedWrites.has('entries:2026-09-15'), 'plain retry clears wrong-identity but keeps pending failures');

  // ── 12. 登入前記的紀錄：沒選過身分、預設的人沒同步過 → 搬給登入的人 ──
  const fresh = {};
  const ctx3 = { ...sandbox, localStorage: { getItem: (k) => (k in fresh ? fresh[k] : null), setItem: (k, v) => { fresh[k] = String(v); }, removeItem: (k) => { delete fresh[k]; } }, alert: (m) => ctx3.__alerts.push(m), __alerts: [] };
  ctx3.window = ctx3;
  vm.createContext(ctx3);
  for (const f of ['js/plan-data.js', 'js/firebase-sync.js', 'js/store.js']) vm.runInContext(fs.readFileSync(path + '/' + f, 'utf8'), ctx3, { filename: f });
  vm.runInContext('this.PlanData = PlanData; this.Store = Store; this.Sync = Sync;', ctx3);
  await ctx3.PlanData.load();
  const St3 = ctx3.Store, Sy3 = ctx3.Sync;
  St3.init();
  assert(St3.activeUserId === 'mick' && St3.activeUserExplicit === false, 'fresh device: default identity, not explicit');
  St3._cloudPush = null;
  St3.setActualStats('2026-09-14', { durationMinutes: 12 }, true);
  St3.setFlag && St3.setFlag('2026-09-14', 'pain', true);
  assert(JSON.parse(fresh['mt_entries::mick'])['2026-09-14'].actualDurationMinutes === 12, 'signed-out record saved under default mick');
  vm.runInContext(`fbDb = { collection: () => ({ doc: (uid) => ({ collection: () => ({ limit: () => ({ get: () => uid === 'Phoebe' ? Promise.resolve({}) : Promise.reject(Object.assign(new Error('d'), { code: 'permission-denied' })) }) }) }) }) }`, ctx3);
  let backfilled3 = [];
  Sy3.resubscribe = (changed) => backfilled3.push(['resub', changed, St3.activeUserId]);
  Sy3.user = { email: 'p@example.com' };
  await Sy3._detectIdentity();
  await new Promise((r) => setTimeout(r, 5));
  assert(St3.activeUserId === 'Phoebe', 'fresh device switches to Phoebe');
  assert(!fresh['mt_entries::mick'] && JSON.parse(fresh['mt_entries::Phoebe'])['2026-09-14'].actualDurationMinutes === 12, 'pre-sign-in record moved from mick to Phoebe');
  assert(St3.entryFor('Phoebe', '2026-09-14') && St3.entryFor('Phoebe', '2026-09-14').actualDurationMinutes === 12, 'moved record visible for Phoebe');
  assert(ctx3.__alerts.some((m) => m.includes('已經移到「Phoebe」')), 'tells the user the records were moved');
  assert(JSON.stringify(backfilled3[0]) === JSON.stringify(['resub', true, 'Phoebe']), 'resubscribe(true) after migration so backfill pushes them');

  // ── 13. 預設的人在這台同步過（別人的雲端資料）→ 絕對不搬 ──
  const dev = {};
  const ctx4 = { ...sandbox, localStorage: { getItem: (k) => (k in dev ? dev[k] : null), setItem: (k, v) => { dev[k] = String(v); }, removeItem: (k) => { delete dev[k]; } }, alert: () => {} };
  ctx4.window = ctx4;
  vm.createContext(ctx4);
  for (const f of ['js/plan-data.js', 'js/firebase-sync.js', 'js/store.js']) vm.runInContext(fs.readFileSync(path + '/' + f, 'utf8'), ctx4, { filename: f });
  vm.runInContext('this.PlanData = PlanData; this.Store = Store; this.Sync = Sync;', ctx4);
  await ctx4.PlanData.load();
  dev['mt_entries::mick'] = JSON.stringify({ '2026-09-10': { actualDurationMinutes: 30, updatedAt: '2026-09-10T00:00:00.000Z', fieldAt: {} } });
  dev['mt_synced_users'] = JSON.stringify(['mick']);
  ctx4.Store.init();
  vm.runInContext(`fbDb = { collection: () => ({ doc: (uid) => ({ collection: () => ({ limit: () => ({ get: () => uid === 'Annlin' ? Promise.resolve({}) : Promise.reject(Object.assign(new Error('d'), { code: 'permission-denied' })) }) }) }) }) }`, ctx4);
  ctx4.Sync.resubscribe = () => {};
  ctx4.Sync.user = { email: 'a@example.com' };
  await ctx4.Sync._detectIdentity();
  assert(ctx4.Store.activeUserId === 'Annlin' && dev['mt_entries::mick'] && !dev['mt_entries::Annlin'], 'mick synced on this device before: his cached records are NOT moved to Annlin');
  // 手動選過身分的裝置也不搬
  assert(ctx4.Store.activeUserExplicit === true, 'after auto switch the identity counts as explicit');

  // ── 14. 登出：自動選過去的人，身體狀況快取清掉 ──
  dev['mt_private::Annlin'] = JSON.stringify({ '2026-09-14': { note: '私人' } });
  ctx4.Store.privateData = { '2026-09-14': { note: '私人' } };
  ctx4.Sync._autoSelectedUserId = 'Annlin';
  let authCb = null;
  vm.runInContext(`firebase = { apps: [1], auth: () => ({ onAuthStateChanged: (cb) => { globalThis.__authCb = cb; }, getRedirectResult: () => Promise.resolve({}) }), firestore: () => ({ settings: () => {}, enablePersistence: () => Promise.resolve() }) }; FIREBASE_CONFIG = {};`, ctx4);
  ctx4.Sync._detachListeners = () => {}; ctx4.Sync._detachPlanOverrides = () => {}; ctx4.Sync._detachLibrary = () => {};
  ctx4.Sync.init();
  ctx4.__authCb(null);
  assert(!dev['mt_private::Annlin'] && Object.keys(ctx4.Store.privateData).length === 0 && ctx4.Sync._autoSelectedUserId === null, 'sign-out clears the auto-selected user private cache');

  // ── 10. 公開的檔案裡沒有 email ──
  // 要找的 email 從 gitignore 的 firestore.rules.local 讀（這支測試在公開 repo 裡，不能把成員的 email 寫在這裡）
  const tracked = ['js/firebase-sync.js', 'js/views.js', 'js/store.js', 'js/app.js', 'data/users.json'];
  const localRules = path + '/firestore.rules.local';
  if (fs.existsSync(localRules)) {
    const emails = [...new Set(fs.readFileSync(localRules, 'utf8').match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) || [])];
    const locals = emails.map((e) => e.split('@')[0].toLowerCase()).filter((x) => x.length >= 5);
    const leaks = tracked.filter((f) => { const src = fs.readFileSync(path + '/' + f, 'utf8').toLowerCase(); return locals.some((x) => src.includes(x)); });
    assert(locals.length > 0 && leaks.length === 0, 'no member email in public js/data files, got ' + JSON.stringify(leaks));
  } else console.log('SKIP: firestore.rules.local not on this machine (member email leak check)');
})();
