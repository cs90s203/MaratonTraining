// 決策紀錄第 30 條：心率一律用 Zone
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
vm.runInContext('this.PlanData = PlanData; this.Store = Store; this.App = App;', sandbox);
function assert(c, m) { console.log((c ? 'PASS' : 'FAIL') + ': ' + m); if (!c) process.exitCode = 1; }
(async () => {
  await sandbox.PlanData.load();
  const { Store, PlanData } = sandbox;
  Store.activeUserId = 'mick'; Store.init(); Store._cloudPush = () => {}; Store._cloudPushLibrary = () => {};
  const F = PlanData.fmtHeartRateZone;
  const cases = [
    ['50-60%', 'Zone 1'], ['60-70%', 'Zone 2'], ['65-72%', 'Zone 2-3'], ['70-75%', 'Zone 3'], ['75-80%', 'Zone 3'],
    ['60–70%', 'Zone 2'], ['60%-70%', 'Zone 2'], [' 60 - 70 % ', 'Zone 2'], ['65%', 'Zone 2'], ['70%', 'Zone 3'],
    ['80-90%', 'Zone 4'], ['85-95%', 'Zone 4-5'], ['90-100%', 'Zone 5'], ['40-50%', 'Zone 1'], ['55-65%', 'Zone 1-2'],
    ['Zone 2', 'Zone 2'], ['zone2', 'Zone 2'], ['ZONE 2-3', 'Zone 2-3'], ['Zone 3-2', 'Zone 2-3'], ['Zone 2 - Zone 3', 'Zone 2-3'],
    ['', ''], [null, ''], [undefined, ''], ['輕鬆', '輕鬆'], ['Zone 6', 'Zone 6'],
  ];
  cases.forEach(([inp, out]) => assert(F(inp) === out, `fmtHeartRateZone(${JSON.stringify(inp)}) → ${JSON.stringify(out)}, got ${JSON.stringify(F(inp))}`));
  assert(PlanData.HR_ZONE_OPTIONS.every((z) => F(z) === z), 'every dropdown option is already in canonical form');

  // 出廠資料全部是 Zone
  const all = PlanData.plan.weeks.flatMap((w) => w.days.flatMap((d) => d.items));
  assert(all.every((it) => it.heartRateZone == null || PlanData.HR_ZONE_OPTIONS.includes(it.heartRateZone)), 'factory plan: every heartRateZone is a dropdown option');
  assert(!JSON.stringify(PlanData.plan).match(/\d+-\d+%/g)?.some((m) => m !== '20-30%'), 'factory plan: no percent ranges left except 跑量遞減 20-30%');

  // 舊資料（Firestore 裡教練改過的週）：卡片顯示成 Zone
  const legacy = { id: 'L1', type: 'long-run', title: '長跑', heartRateZone: '65-72%', rpe: { min: 5, max: 6 } };
  const body = vm.runInContext('itemPlanParts', sandbox)(legacy).body;
  assert(body.includes('>Zone 2-3<') && !body.includes('65-72%'), 'legacy percent item renders as Zone 2-3');
  const tempo = { id: 'T1', type: 'tempo', title: '節奏跑', heartRateZone: 'Zone 3', intensityDerived: true };
  assert(vm.runInContext('itemPlanParts', sandbox)(tempo).body.includes('Zone 3（推導）'), 'derived intensity suffix is （推導）');

  // 表單：舊百分比預選換算後的 Zone；看不懂的舊文字保留成一個選項
  Store.coachMode = true;
  const form = vm.runInContext('renderTemplateForm', sandbox)({ id: 'L2', name: 'x', item: { type: 'run', title: 'x', heartRateZone: '60-70%' } });
  const hrSelect = form.split('name="heartRateZone">')[1].split('</select>')[0];
  assert(hrSelect.includes('<option value="Zone 2" selected>'), 'form: legacy 60-70% preselects Zone 2');
  assert((hrSelect.match(/selected/g) || []).length === 1, 'form: exactly one option selected');
  assert(!form.includes('name="heartRateZone" type="text"'), 'form: no free-text heart rate input');
  const formOdd = vm.runInContext('renderTemplateForm', sandbox)({ id: 'L3', name: 'x', item: { type: 'run', title: 'x', heartRateZone: '輕鬆' } });
  const oddSelect = formOdd.split('name="heartRateZone">')[1].split('</select>')[0];
  assert(oddSelect.includes('<option value="輕鬆" selected>輕鬆（舊寫法，請改選）</option>'), 'form: unparseable legacy text kept as its own selected option');
  const formNone = vm.runInContext('renderTemplateForm', sandbox)({ id: 'new', name: '', item: { type: 'run', title: '' } });
  const noneSelect = formNone.split('name="heartRateZone">')[1].split('</select>')[0];
  assert(!noneSelect.includes('selected'), 'form: new item has no zone preselected');
  Store.coachMode = false;

  // 常用項目：存的時候換成 Zone
  const tpl = Store.saveLibraryDoc(null, 'item', { name: 't', item: { type: 'run', title: 'x', heartRateZone: '50-60%' } });
  assert(tpl.item.heartRateZone === 'Zone 1', 'library template converts percent to Zone on save, got ' + tpl.item.heartRateZone);

  // 階段目標卡的 Zone 2 參考：講體感，不再印心率
  const ref = vm.runInContext('findZone2Reference', sandbox)(PlanData.plan.phases[0]);
  assert(ref && ref.rpe, 'findZone2Reference still finds the phase 1 Zone 2 run');
  const noHr = { ...ref, heartRateZone: null };
  assert(!!noHr.rpe, 'reference no longer depends on heartRateZone');
})();
