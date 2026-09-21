// 階段性目標（決策紀錄第 22 條）：setPhaseTargetsForPhase / phaseTargetsFor /
// phaseVolumeAutoRange / phaseVolumeActual / mergeRemotePhaseTargets
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
  fetch: async (url) => { const map = { 'plan.json': plan, 'videos.json': videos, 'workouts.json': workouts, 'users.json': users }; const key = Object.keys(map).find((k) => url.includes(k)); return { json: async () => map[key] }; },
  APP_VERSION: 'test',
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['js/plan-data.js', 'js/firebase-sync.js', 'js/store.js']) vm.runInContext(fs.readFileSync(path + '/' + f, 'utf8'), sandbox, { filename: f });
vm.runInContext('this.PlanData = PlanData; this.Store = Store;', sandbox);
function assert(c, m) { console.log((c ? 'PASS' : 'FAIL') + ': ' + m); if (!c) process.exitCode = 1; }
(async () => {
  await sandbox.PlanData.load();
  const { Store, PlanData } = sandbox;
  Store.activeUserId = 'mick'; Store.init(); Store._cloudPush = () => {};

  const phases = PlanData.plan.phases;
  assert(phases.length === 5, 'plan has 5 phases, got ' + phases.length);
  const p1 = phases[0].phaseId; // 恢復奠基期

  // 空狀態
  assert(Object.keys(Store.phaseTargetsFor('mick')).length === 0, 'no targets set yet → {}');
  assert(Store.phaseVolumeActual(p1, 'mick') === null, '累積實際 no data yet → null (not 0)');
  const auto1 = Store.phaseVolumeAutoRange(p1, 'mick');
  assert(auto1 && auto1.max > 0, 'phaseVolumeAutoRange computed a positive max, got ' + JSON.stringify(auto1));

  // 存一整份（六個欄位，volumeKm 故意設得比自動加總高 → 應該存得進去，沒有天花板擋）
  const fields = {
    zone2Pace: { min: 6.5, max: 7 },       // 6:30–7:00 /km
    volumeKm: { min: auto1.max + 50, max: auto1.max + 80 }, // 刻意超過自動參考值
    cadence: { min: 170, max: 178 },
    verticalOscillation: { min: 7.2, max: 8.5 },
    groundContactTime: { min: 230, max: 260 },
    strideLength: { min: 1.05, max: 1.15 },
  };
  Store.setPhaseTargetsForPhase(p1, fields, undefined); // 寫自己的
  const t1 = Store.phaseTargetsFor('mick')[p1];
  assert(t1 && t1.zone2Pace.min === 6.5 && t1.zone2Pace.max === 7, 'zone2Pace saved, got ' + JSON.stringify(t1 && t1.zone2Pace));
  assert(t1.volumeKm.max === round1(auto1.max + 80), 'volumeKm NOT capped by auto ceiling (decision-0 deliberately opt-out), got ' + JSON.stringify(t1.volumeKm));
  assert(t1.cadence.min === 170 && t1.cadence.max === 178, 'cadence saved');
  assert(t1.groundContactTime.min === 230, 'groundContactTime saved');
  function round1(x) { return Math.round(x * 10) / 10; }

  // 只清掉 volumeKm（傳 null），其餘欄位應該維持不變（決策：patch 語意，不是整份覆蓋清空）
  const fields2 = { ...fields, volumeKm: null };
  Store.setPhaseTargetsForPhase(p1, fields2, undefined);
  const t2 = Store.phaseTargetsFor('mick')[p1];
  assert(t2.volumeKm === null, 'volumeKm cleared');
  assert(t2.cadence.min === 170, 'other fields survive a save that only changes one field, got ' + JSON.stringify(t2.cadence));

  // 教練幫別人設（決策紀錄第 15 條同一套哲學）
  Store.setPhaseTargetsForPhase(p1, { cadence: { min: 165, max: 172 } }, 'Annlin');
  const tA = Store.phaseTargetsFor('Annlin')[p1];
  assert(tA && tA.cadence.min === 165, 'coach can set for another user, got ' + JSON.stringify(tA));
  assert(Store.phaseTargetsFor('mick')[p1].cadence.min === 170, "setting Annlin's did not touch mick's, got " + Store.phaseTargetsFor('mick')[p1].cadence.min);

  // min/max 打反自動排正
  Store.setPhaseTargetsForPhase(p1, { strideLength: { min: 1.2, max: 1.0 } }, undefined);
  const t3 = Store.phaseTargetsFor('mick')[p1];
  assert(t3.strideLength.min === 1.0 && t3.strideLength.max === 1.2, 'reversed min/max auto-sorted, got ' + JSON.stringify(t3.strideLength));

  // 未知 phaseId 拒絕
  const before = JSON.stringify(Store.phaseTargets['mick']);
  const r = Store.setPhaseTargetsForPhase('not-a-phase', { cadence: { min: 1, max: 2 } }, undefined);
  assert(r === null, 'unknown phaseId rejected');
  assert(JSON.stringify(Store.phaseTargets['mick']) === before, 'unknown phaseId write did not mutate state');

  // 累積實際：填幾天的 actualDistanceKm 進 p1 的第一週，phaseVolumeActual 應該抓得到
  const wn = phases[0].weekRange[0];
  const tue = PlanData.keyForWeekDay(wn, 1);
  Store.setActualStats(tue, { distanceKm: 5 });
  const actual1 = Store.phaseVolumeActual(p1, 'mick');
  assert(actual1 === 5, 'phaseVolumeActual picks up a logged run, got ' + actual1);

  // mergeRemotePhaseTargets：模擬遠端傳回一份文件，逐欄位合併不整份蓋掉
  const remoteDoc = { groundContactTime: { min: 220, max: 245 }, updatedAt: new Date(Date.now() + 5000).toISOString(), fieldAt: { groundContactTime: new Date(Date.now() + 5000).toISOString() } };
  Store.mergeRemotePhaseTargets('mick', { [p1]: remoteDoc, updatedAt: remoteDoc.updatedAt, fieldAt: { [p1]: remoteDoc.updatedAt } });
  const t4 = Store.phaseTargetsFor('mick')[p1];
  assert(t4.groundContactTime.min === 220, 'remote merge applied newer field, got ' + JSON.stringify(t4.groundContactTime));

  console.log('done');
})();
