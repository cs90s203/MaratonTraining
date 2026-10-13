// 固定日期的機制本身（tests/lib/clock.js）：run.sh 把「今天」固定在某一天去跑其他 harness，這支確認那真的有生效——
// 沒生效的話「固定日期都綠」是假的（整輪掃的其實都是真實日期）。沒設 MARATHON_TODAY 時只確認 Date 沒被動到。
const fs = require('fs');
const vm = require('vm');
const path = require('path').resolve(__dirname, '..'); // repo 根目錄
const load = (f) => JSON.parse(fs.readFileSync(path + '/data/' + f));
const map = { 'plan.json': load('plan.json'), 'videos.json': load('videos.json'), 'workouts.json': load('workouts.json'), 'users.json': load('users.json') };
function assert(c, m) { console.log((c ? 'PASS' : 'FAIL') + ': ' + m); if (!c) process.exitCode = 1; }

// 跟其他 harness 一樣的開法：自己組一個物件，再 vm.createContext
const sandbox = { console, fetch: async (u) => ({ json: async () => map[Object.keys(map).find((k) => u.includes(k))] }), APP_VERSION: 't' };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path + '/js/plan-data.js', 'utf8'), sandbox, { filename: 'js/plan-data.js' });
vm.runInContext('this.PlanData = PlanData;', sandbox);
const inside = (code) => vm.runInContext(code, sandbox);
const native = (d) => /\[native code\]/.test(Function.prototype.toString.call(d));

(async () => {
  await sandbox.PlanData.load();
  const pin = process.env.MARATHON_TODAY;
  if (!pin || pin === 'real') {
    assert(native(Date) && native(inside('Date')), 'real clock: Date is the built-in one, in the harness and in the sandbox');
    assert(Math.abs(inside('Date.now()') - Date.now()) < 5000, 'real clock: the sandbox agrees with the machine');
    return;
  }
  const [y, m, d] = pin.split('-').map(Number);
  const noon = new Date(y, m - 1, d, 12).getTime();
  const near = (t) => t > noon && t < noon + 60000; // 中午過一點點（每次呼叫 +1ms，一輪不會超過一分鐘）
  assert(near(Date.now()) && near(new Date().getTime()), `harness: the clock is pinned to ${pin} at noon`);
  assert(near(inside('Date.now()')) && near(inside('new Date().getTime()')) && inside('globalThis.Date === Date'), 'sandbox: same day, also through globalThis');
  const ticks = [inside('new Date().getTime()'), inside('Date.now()'), inside('new Date().getTime()')];
  assert(ticks[0] < ticks[1] && ticks[1] < ticks[2], 'the clock moves forward on every call (updatedAt values must differ)');
  assert(inside('new Date(2026, 8, 7).getDate()') === 7 && inside('new Date(2026, 8, 7) instanceof Date') && inside('Date.name') === 'Date', 'constructing a date from numbers still works the normal way');
  // 整條路：app 自己的 locateToday() 跟「從 plan.json 另外算」的答案一樣
  const plan = map['plan.json'];
  const [sy, sm, sd] = plan.startDate.split('-').map(Number);
  const diff = Math.round((new Date(y, m - 1, d) - new Date(sy, sm - 1, sd)) / 86400000);
  const loc = inside('PlanData.locateToday()');
  const want = diff < 0 ? { status: 'before-start' } : diff >= plan.totalWeeks * 7 ? { status: 'after-plan' } : { status: 'in-plan', weekNumber: Math.floor(diff / 7) + 1, dayIndex: diff % 7 };
  assert(loc.status === want.status && loc.weekNumber === want.weekNumber && loc.dayIndex === want.dayIndex, `PlanData.locateToday() says ${JSON.stringify(loc)}`);
})();
