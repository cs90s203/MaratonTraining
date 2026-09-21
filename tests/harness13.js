// 決策紀錄第 42 條：訓練段落（間歇跑等）
const fs = require('fs');
const vm = require('vm');
const path = require('path').resolve(__dirname, '..'); // repo 根目錄
const load = (f) => JSON.parse(fs.readFileSync(path + '/data/' + f));
const map = { 'plan.json': load('plan.json'), 'videos.json': load('videos.json'), 'workouts.json': load('workouts.json'), 'users.json': load('users.json') };
const store = {};
const sandbox = {
  console, window: {}, crypto: require('crypto').webcrypto, location: { href: 'x' },
  document: { getElementById: () => null, addEventListener: () => {}, querySelector: () => null },
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: () => {} },
  fetch: async (u) => ({ json: async () => map[Object.keys(map).find((k) => u.includes(k))] }),
  APP_VERSION: 't',
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['js/plan-data.js', 'js/firebase-sync.js', 'js/store.js', 'js/views.js', 'js/app.js']) vm.runInContext(fs.readFileSync(path + '/' + f, 'utf8'), sandbox, { filename: f });
vm.runInContext('this.PlanData = PlanData; this.Store = Store; this.App = App;', sandbox);
function assert(c, m) { console.log((c ? 'PASS' : 'FAIL') + ': ' + m); if (!c) process.exitCode = 1; }
const J = (x) => JSON.stringify(x);
(async () => {
  await sandbox.PlanData.load();
  const { PlanData, Store, App } = sandbox;
  Store.activeUserId = 'mick'; Store.init(); Store._cloudPush = () => {}; Store._cloudPushLibrary = () => {};

  const interval = [
    { kind: 'warmup', amount: { unit: 'min', min: '10', max: '' }, zone: 'Zone 2', note: '輕鬆跑' },
    { kind: 'repeat', times: 4, steps: [
      { kind: 'main', amount: { unit: 'm', min: 400, max: 400 }, zone: 'Zone 4-5', note: '' },
      { kind: 'recover', amount: { unit: 'sec', min: 90, max: 90 }, zone: null, note: '慢跑或走路' },
    ] },
    { kind: 'cooldown', amount: { unit: 'min', min: 10, max: 10 }, zone: null, note: '' },
  ];
  const clean = PlanData.cleanSegments(interval);
  assert(clean.length === 3 && clean[0].amount.min === 10 && clean[0].amount.max === 10 && clean[1].times === 4 && clean[1].steps.length === 2, 'interval example cleans to warmup / 4 × (400 m + 90 s) / cooldown');
  assert(PlanData.fmtSegmentAmount(clean[1].steps[0].amount) === '400 公尺' && PlanData.fmtSegmentAmount({ unit: 'min', min: 10, max: 15 }) === '10–15 分', 'amount formatting');
  const t = PlanData.segmentTotals(clean);
  assert(Math.abs(t.km.min - 1.6) < 1e-9 && Math.abs(t.minutes.min - 26) < 1e-9 && t.hasKm && t.hasTime, `totals: 1.6 km + 26 min (got ${J(t)})`);

  // 清理規則
  assert(PlanData.cleanSegments([{ kind: 'bogus', note: 'x' }, { kind: 'main' }, { kind: 'main', amount: { unit: 'min', min: -5 } }]).length === 0, 'drops unknown kinds, empty steps and negative amounts');
  assert(PlanData.cleanSegments([{ kind: 'recover', amount: null, zone: 'Zone 1-2', note: '' }]).length === 1, 'zone-only step is kept (recover until Zone 1-2)');
  assert(PlanData.cleanSegments([{ kind: 'main', amount: { unit: 'min', min: 800 }, note: '' }]).length === 0, '800 分 exceeds the 分 cap');
  assert(PlanData.cleanSegments([{ kind: 'main', amount: { unit: 'm', min: 800 }, note: '' }])[0].amount.min === 800, '800 公尺 is fine');
  const swapped = PlanData.cleanSegments([{ kind: 'main', amount: { unit: 'm', min: '200000', max: '400' }, note: 'x' }]);
  assert(swapped[0].amount === null, 'cap applies after sorting (swapped min/max cannot bypass it)');
  assert(PlanData.cleanSegments([{ kind: 'main', amount: { unit: 'lightyear', min: 1 }, note: '只有說明' }])[0].amount === null, 'bad unit → amount null but note kept');
  assert(PlanData.cleanSegments([{ kind: 'repeat', times: 0, steps: [{ kind: 'main', note: 'x' }] }, { kind: 'repeat', times: 3, steps: [] }]).length === 0, 'drops repeat with bad times or no steps');
  assert(PlanData.cleanSegments([{ kind: 'repeat', times: 2, steps: [{ kind: 'repeat', times: 2, steps: [] }, { kind: 'main', note: 'a' }] }])[0].steps.length === 1, 'no nested repeats');
  assert(PlanData.cleanSegments([{ kind: 'main', amount: { unit: 'min', min: 1 }, zone: '80%', note: '' }])[0].zone === null, 'zone must be a Zone option');
  assert(PlanData.cleanSegments([{ kind: 'main', amount: null, zone: '80%', note: '' }]).length === 0, 'invalid zone alone is not content');
  assert(PlanData.cleanSegments(Array.from({ length: 30 }, () => ({ kind: 'main', note: 'x' }))).length === 20, 'top-level capped at 20');
  assert(PlanData.cleanSegments('nope').length === 0 && PlanData.itemSegments(null).length === 0, 'non-array input is safe');
  assert(PlanData.cleanSegments([{ kind: 'main', amount: { unit: 'min', min: 1 }, note: '<script>'.repeat(20) }])[0].note.length === 60, 'note capped at 60');

  // 卡片顯示
  const parts = vm.runInContext('itemPlanParts', sandbox)({ id: 'i1', type: 'interval', title: '間歇跑', segments: interval });
  assert(parts.body.includes('seg-view') && parts.body.includes('>4 ×<') && parts.body.includes('400 公尺 · Zone 4-5') && parts.body.includes('90 秒 · 慢跑或走路'), 'card shows segments with repeat count');
  const xss = vm.runInContext('itemPlanParts', sandbox)({ id: 'i2', type: 'run', title: 'x', segments: [{ kind: 'main', amount: null, zone: null, note: '<img src=x onerror=1>' }] });
  assert(!xss.body.includes('<img') && xss.body.includes('&lt;img'), 'segment notes are escaped');
  assert(!vm.runInContext('itemPlanParts', sandbox)({ id: 'i3', type: 'run', title: 'x' }).body.includes('seg-view'), 'no segments → no block');

  // 出廠課表：W9-16 跑姿訓練有段落
  const w10 = Store.effectiveWeek(10).days.flatMap((d) => d.items).find((it) => it.type === 'form-drill');
  const w14 = Store.effectiveWeek(14).days.flatMap((d) => d.items).find((it) => it.type === 'form-drill');
  assert(J(PlanData.itemSegments(w10).map((s) => [s.times, s.steps[0].note, s.steps[0].amount.min])) === J([[2, '高抬腿', 20], [2, '後踢腿', 20]]), 'W10 drill day: 2 × 20 m 高抬腿, 2 × 20 m 後踢腿');
  assert(J(PlanData.itemSegments(w14).map((s) => s.steps[0].note)) === J(['A-Skip', 'B-Skip']), 'W14 drill day: A-Skip, B-Skip');
  assert(w10.notes.includes('2 組 x 20 公尺'), 'drill numbers kept in notes as fallback for old clients');

  // 編輯表單有段落編輯器，預填段落
  Store.coachMode = true;
  const form = vm.runInContext('renderTemplateForm', sandbox)({ id: 'x1', name: '間歇跑', item: { type: 'interval', title: '間歇跑', segments: interval } });
  assert(form.includes('seg-editor') && (form.match(/data-seg="repeat"/g) || []).length === 2 && form.includes('value="400"'), 'edit form pre-fills segments (1 repeat + template)');
  assert(form.includes('A.segIntervalTemplate(this)') && form.includes('A.segAdd(this,\'repeat\')'), 'edit form has add / repeat / template buttons');
  // 驗證：段落數字錯誤會被擋
  assert(/重複次數/.test(App._validateItemFields({ title: 'x', type: 'interval', __segError: '重複次數要是 1 到 50 的整數' }) || ''), 'segment error blocks save');

  // 常用項目：段落跟著存、帶入時複製
  const tpl = Store.saveLibraryDoc(null, 'item', { name: '間歇 400', item: { type: 'interval', title: '間歇跑', segments: interval } });
  assert(tpl && tpl.item.segments && tpl.item.segments[1].times === 4, 'template keeps segments');
  const noSeg = Store.saveLibraryDoc(null, 'item', { name: 'x', item: { type: 'run', title: 'x', segments: [{ kind: 'main' }] } });
  assert(noSeg.item.segments === null, 'template with only empty segments stores null');
})();
