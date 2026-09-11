// 載入靜態資料（plan/videos/workouts/users）+ 所有日期算術。
//
// ⚠️ 全檔案唯一允許算日期的地方。不要在別的檔案裡自己用 new Date() 加減天數——
// 這裡的函式已經處理過 babylog 踩過的 UTC 陷阱
// （~/Documents/Projects/babylog/js/views.js:203-205 的教訓註解——注意是另一個
// 專案的檔案，不是本專案自己的 js/views.js）：
// `new Date("2026-09-07")` 會被解析成 UTC 午夜，`toISOString().slice(0,10)` 同樣是
// UTC 日期，兩者在 UTC+8 都會在本地凌晨到早上 8 點之間跟「今天」對不上。
// 這裡一律用「年/月/日三個數字」建構本地 Date，絕不用字串直接餵給 Date() 或呼叫
// toISOString()。日曆基準見 docs/日曆基準.md。
const PlanData = (() => {
  let plan = null, videos = null, workouts = null, users = null;
  let videoById = {}, workoutById = {}, userById = {};

  async function load() {
    const [p, v, w, u] = await Promise.all([
      fetch(`data/plan.json?v=${APP_VERSION}`).then((r) => r.json()),
      fetch(`data/videos.json?v=${APP_VERSION}`).then((r) => r.json()),
      fetch(`data/workouts.json?v=${APP_VERSION}`).then((r) => r.json()),
      fetch(`data/users.json?v=${APP_VERSION}`).then((r) => r.json()),
    ]);
    plan = p; videos = v.videos; workouts = w.workouts; users = u.users;
    videoById = Object.fromEntries(videos.map((x) => [x.id, x]));
    workoutById = Object.fromEntries(workouts.map((x) => [x.id, x]));
    userById = Object.fromEntries(users.map((x) => [x.userId, x]));
    return plan;
  }

  // ── 日期算術（唯一真相來源：startDate + weekNumber + dayIndex）──────────────
  // 課表 JSON 刻意不存 date/dayOfWeek——兩個必須互相對應的數字＝缺少單一真相來源，
  // 原規格書就是這樣錯的（"2026-09-10" 配 "dayOfWeek":"一"，那天其實是週四）。

  function parseLocalDate(isoStr) {
    // "YYYY-MM-DD" → 本地午夜的 Date。不用 new Date(isoStr)：那會被當成 UTC。
    const [y, m, d] = isoStr.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function localMidnight(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function dayKey(d) {
    // 本地日曆日期字串。不用 toISOString()——那是 UTC 日期，在 UTC+8 會在
    // 本地凌晨到早上 8 點之間跟「今天」錯位一天（babylog 吃過這個虧）。
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function dateForWeekDay(weekNumber, dayIndex) {
    const start = parseLocalDate(plan.startDate);
    return new Date(start.getFullYear(), start.getMonth(),
      start.getDate() + (weekNumber - 1) * 7 + dayIndex);
  }

  function keyForWeekDay(weekNumber, dayIndex) {
    return dayKey(dateForWeekDay(weekNumber, dayIndex));
  }

  function today() {
    return localMidnight(new Date());
  }

  // 「今天」定位到第幾週第幾天。三種邊界狀態：還沒開始／進行中／已經比完賽。
  function locateToday() {
    const start = parseLocalDate(plan.startDate);
    const t = today();
    const diffDays = Math.round((t - start) / 86400000);
    const totalDays = plan.totalWeeks * 7;
    if (diffDays < 0) {
      return { status: 'before-start', daysUntilStart: -diffDays };
    }
    if (diffDays >= totalDays) {
      return { status: 'after-plan', daysSincePlanEnd: diffDays - totalDays + 1 };
    }
    const weekNumber = Math.floor(diffDays / 7) + 1;
    const dayIndex = diffDays % 7;
    return { status: 'in-plan', weekNumber, dayIndex, key: dayKey(t) };
  }

  function isExpired(weekNumber, dayIndex) {
    return keyForWeekDay(weekNumber, dayIndex) < plan.expiredBefore;
  }

  function daysUntilRace() {
    const race = parseLocalDate(plan.raceDate);
    return Math.round((race - today()) / 86400000);
  }

  function phaseForWeek(weekNumber) {
    return plan.phases.find((ph) => weekNumber >= ph.weekRange[0] && weekNumber <= ph.weekRange[1]);
  }

  function week(weekNumber) {
    return plan.weeks[weekNumber - 1];
  }

  function day(weekNumber, dayIndex) {
    return week(weekNumber).days[dayIndex];
  }

  function weekdayLabel(dayIndex) {
    return '一二三四五六日'[dayIndex];
  }

  function fmtRange(range, unit) {
    if (!range) return '';
    return range.min === range.max ? `${range.min}${unit}` : `${range.min}-${range.max}${unit}`;
  }

  function fmtItemMeta(item) {
    const bits = [];
    if (item.duration) bits.push(fmtRange(item.duration, ' 分'));
    if (item.distanceKm) bits.push(fmtRange(item.distanceKm, 'K'));
    return bits.join(' · ');
  }

  return {
    load,
    get plan() { return plan; },
    get videos() { return videos; },
    get workouts() { return workouts; },
    get users() { return users; },
    // ⚠️ 一定要是 getter，不能用 shorthand property。videoById/workoutById/userById
    // 在模組頂端先宣告成空物件，load() 之後才重新指派——如果這裡直接寫
    // `videoById, workoutById, userById,`，這個回傳物件在 IIFE 執行的那一刻
    // （load() 還沒跑）就把值凍結成初始的空物件了，之後 load() 重新指派本地變數
    // 完全不會反映到這個已經回傳出去的物件上。三個查找表因此永遠是空的，
    // 每一次 PlanData.videoById[x] 都靜默回傳 undefined，不會拋錯，很難發現。
    get videoById() { return videoById; },
    get workoutById() { return workoutById; },
    get userById() { return userById; },
    parseLocalDate, dayKey, dateForWeekDay, keyForWeekDay, today, locateToday,
    isExpired, daysUntilRace, phaseForWeek, week, day, weekdayLabel,
    fmtRange, fmtItemMeta,
  };
})();
