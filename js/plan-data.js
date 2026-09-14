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

  // 反向：dateKey → {weekNumber, dayIndex}；不在計畫期間回 null。
  function locateKey(dateKey) {
    const start = parseLocalDate(plan.startDate);
    const d = parseLocalDate(dateKey);
    const diffDays = Math.round((d - start) / 86400000);
    if (diffDays < 0 || diffDays >= plan.totalWeeks * 7) return null;
    return { weekNumber: Math.floor(diffDays / 7) + 1, dayIndex: diffDays % 7 };
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

  // 項目的影片（決策紀錄第 28 條）：新格式 videoRefs 是陣列；舊格式（出廠 plan.json、舊的
  // 教練覆寫、舊的常用項目）只有單一的 videoRef。新版存檔兩個都寫，videoRef＝第一部——
  // 給還開著舊版網頁的裝置看得到至少一部。**讀取一律走這裡**，不要直接讀 item.videoRef。
  // 兩邊對不上時（舊版網頁只改了 videoRef、或有人在 Firebase Console 手改）取聯集、videoRef
  // 排第一：寧可多顯示一部，也不要安靜地少掉一部。
  // 心率一律用 Zone 表示（決策紀錄第 30 條）。**顯示一律走 fmtHeartRateZone**，不要直接印
  // item.heartRateZone：教練改過的週（Firestore planOverrides）跟常用項目裡還存著舊的「60-70%」，
  // 不做資料遷移，讀的時候換算，下次教練存檔就會存成 Zone。
  // 換算基準（第 30 條）：最大心率百分比的五區，Zone 1 50-60%、Zone 2 60-70%、Zone 3 70-80%、
  // Zone 4 80-90%、Zone 5 90-100%。區間上限剛好在邊界上不算進下一區（60-70% 是 Zone 2）；
  // 跨區就寫成「Zone 2-3」（原本的長跑 65-72%）。
  const HR_ZONE_OPTIONS = ['Zone 1', 'Zone 1-2', 'Zone 2', 'Zone 2-3', 'Zone 3', 'Zone 3-4', 'Zone 4', 'Zone 4-5', 'Zone 5'];
  function fmtHeartRateZone(value) {
    const s = String(value == null ? '' : value).trim();
    if (!s) return '';
    const range = (a, b) => { const lo = Math.min(a, b), hi = Math.max(a, b); return lo === hi ? `Zone ${lo}` : `Zone ${lo}-${hi}`; };
    const z = s.match(/^zone\s*([1-5])(?:\s*[-–~]\s*(?:zone\s*)?([1-5]))?$/i);
    if (z) return range(Number(z[1]), z[2] ? Number(z[2]) : Number(z[1]));
    const p = s.match(/^(\d+(?:\.\d+)?)\s*%?\s*(?:[-–~]\s*(\d+(?:\.\d+)?)\s*)?%$/);
    if (p) {
      const a = Number(p[1]), b = p[2] != null ? Number(p[2]) : a;
      const zoneOf = (pct) => Math.min(5, Math.max(1, Math.floor((pct - 50) / 10) + 1));
      const lo = Math.min(a, b), hi = Math.max(a, b);
      return range(zoneOf(lo), hi > lo ? zoneOf(hi - 1e-9) : zoneOf(lo));
    }
    return s; // 看不懂的舊文字（教練手打的）原樣顯示，不猜
  }

  const MAX_ITEM_VIDEOS = 10;
  function itemVideoRefs(item) {
    const list = [];
    if (!item) return list;
    const add = (id) => { if (typeof id === 'string' && id && !list.includes(id)) list.push(id); };
    add(item.videoRef);
    if (Array.isArray(item.videoRefs)) item.videoRefs.forEach(add);
    return list;
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
    parseLocalDate, dayKey, dateForWeekDay, keyForWeekDay, today, locateToday, locateKey,
    isExpired, daysUntilRace, phaseForWeek, week, day, weekdayLabel,
    fmtRange, fmtItemMeta, itemVideoRefs, MAX_ITEM_VIDEOS, fmtHeartRateZone, HR_ZONE_OPTIONS,
  };
})();
