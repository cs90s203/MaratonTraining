// 狀態 + localStorage 持久化。跟 babylog 同一套分層（見 docs/data-model.md 的說法）：
//
// 同步邊界：
//   mt_entries::{userId}   -> Firestore users/{userId}/entries/{date}（白名單內可讀，只有本人可寫）
//   mt_private::{userId}   -> Firestore users/{userId}/private/{date}（只有本人可讀寫）
//   mt_weekadj::{userId}   -> Firestore users/{userId}/weekAdjustments/{weekNumber}（只有本人）
//   planOverrides          -> Firestore planOverrides/{weekNumber}（白名單內都可讀寫——
//                             教練模式改的課表內容，跟上面「個人紀錄」是不同的共用資源）
//   mt_active_user         -> 本機限定，不同步。「我是誰」跟 Google 登入身分是分開的兩件事。
//   mt_local_theme         -> 本機限定。
//   mt_local_coachmode     -> 本機限定。教練模式開關，久久才切一次，跟裝置綁定不是跟人綁定。
//
// 本機寫入呼叫 Store._cloudPush(...)（wired 到 firebase-sync.js 的 Sync.pushDoc，
// 未登入前是 no-op），推到 Firestore。遠端變動透過 Store.mergeRemote*() 寫回，
// 呼叫路徑不經過 _cloudPush，避免寫入迴圈。
//
// 離線支援：不自己刻 outbox 佇列——Firestore SDK 的 enablePersistence()（在
// firebase-sync.js 開）本身就會在斷線時佇列寫入、恢復連線後自動補送
// （babylog docs/sync.md:52-54 用的是同一套）。這裡只需要在 UI 顯示
// snapshot.metadata.hasPendingWrites，不需要重新發明佇列。
//
// ── 完成紀錄用「項目 id」而不是「陣列位置」對應 ──────────────────────────────
// entry.done 是 {itemId: true} 的 map，entry.selectedItemId 是選擇題選中的項目 id
// （字串，不是索引）。這是教練模式的前提：教練在 UI 上新增/刪除/調整當天項目順序時，
// id 不變，位置會變——如果完成紀錄是用位置索引記錄，教練隨便一個調整就會讓舊紀錄
// 悄悄對到錯的項目上（「這天做了 A」變成「這天做了 B」，使用者不會發現）。
// 每個項目的 id 由 tools/build_plan.py 產生（出廠課表）或教練新增項目時產生
// （見 firebase-sync.js 的 crypto.randomUUID）。

const ACTIVE_USER_KEY = 'mt_active_user';
const THEME_KEY = 'mt_local_theme';
const COACH_MODE_KEY = 'mt_local_coachmode';

function nowIso() { return new Date().toISOString(); }

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage full/blocked: keep going in-memory */ }
}

const Store = {
  activeUserId: null,
  theme: 'system',
  coachMode: false,
  entries: {},          // { [userId]: { [dateKey]: entryDoc } }
  privateData: {},      // { [dateKey]: privateDoc }  — 只有 activeUserId 自己的
  weekAdjustments: {},  // { [weekNumber]: adjDoc }   — 只有 activeUserId 自己的
  planOverrides: {},    // { [weekNumber]: weekDoc }  — 白名單共用，教練模式改過的週
  listeners: [],

  _cloudPush: null, // wired by firebase-sync.js: (kind, docId, data) => void

  init() {
    this.activeUserId = localStorage.getItem(ACTIVE_USER_KEY) || (PlanData.users[0] && PlanData.users[0].userId) || null;
    this.theme = localStorage.getItem(THEME_KEY) || 'system';
    this.coachMode = localStorage.getItem(COACH_MODE_KEY) === '1';
    this._loadUserCache(this.activeUserId);
  },

  _loadUserCache(userId) {
    if (!userId) return;
    if (!this.entries[userId]) {
      this.entries[userId] = loadJSON(`mt_entries::${userId}`, {});
    }
    this.privateData = loadJSON(`mt_private::${userId}`, {});
    this.weekAdjustments = loadJSON(`mt_weekadj::${userId}`, {});
  },

  onChange(fn) { this.listeners.push(fn); },
  _notify() { this.listeners.forEach((fn) => fn()); },

  persist() {
    saveJSON(`mt_entries::${this.activeUserId}`, this.entries[this.activeUserId] || {});
    saveJSON(`mt_private::${this.activeUserId}`, this.privateData);
    saveJSON(`mt_weekadj::${this.activeUserId}`, this.weekAdjustments);
    this._notify();
  },

  setActiveUser(userId) {
    if (userId === this.activeUserId) return;
    this.activeUserId = userId;
    localStorage.setItem(ACTIVE_USER_KEY, userId);
    this._loadUserCache(userId);
    if (window.Sync) window.Sync.resubscribe();
    this._notify();
  },

  setTheme(t) {
    this.theme = t;
    localStorage.setItem(THEME_KEY, t);
    this._notify();
  },

  setCoachMode(on) {
    this.coachMode = on;
    localStorage.setItem(COACH_MODE_KEY, on ? '1' : '0');
    this._notify();
  },

  // ── entries（自己的紀錄）────────────────────────────────────────────────
  entryFor(userId, dateKey) {
    return (this.entries[userId] && this.entries[userId][dateKey]) || null;
  },

  _writeOwnEntry(dateKey, patch) {
    const userId = this.activeUserId;
    if (!this.entries[userId]) this.entries[userId] = {};
    const prev = this.entries[userId][dateKey] || { done: {}, selectedItemId: null, actualDurationMinutes: null, actualDistanceKm: null };
    const next = { ...prev, ...patch, updatedAt: nowIso(), deleted: false };
    this.entries[userId][dateKey] = next;
    this.persist();
    if (this._cloudPush) this._cloudPush('entries', dateKey, next);
    return next;
  },

  toggleItemDone(dateKey, itemId) {
    const prev = this.entryFor(this.activeUserId, dateKey);
    const done = { ...(prev && prev.done) };
    done[itemId] = !done[itemId];
    return this._writeOwnEntry(dateKey, { done });
  },

  // 選擇題（day.selectOne）專用：選一個選項＝那個選項直接算完成，其餘選項清空。
  // ⚠️ 不要借用 toggleItemDone（那是「翻轉」語意，給多項目打勾用）——曾經這裡直接呼叫
  // toggleItemDone，結果在兩個選項之間切換兩次（A→B→A）會把 A 的完成狀態翻回 false，
  // UI 上「這次選了這個」跟「打勾」變成互相矛盾。改成每次選擇都整組重建 done，
  // 只有選到的那個 id 為 true。
  setSelectedItem(dateKey, itemId) {
    const prev = this.entryFor(this.activeUserId, dateKey);
    const already = prev && prev.selectedItemId === itemId;
    if (already) {
      // 再點一次同一個選項＝取消選擇，回到「待完成」。
      return this._writeOwnEntry(dateKey, { selectedItemId: null, done: {} });
    }
    const done = {}; done[itemId] = true;
    return this._writeOwnEntry(dateKey, { selectedItemId: itemId, done });
  },

  setActualStats(dateKey, { durationMinutes, distanceKm }) {
    // ⚠️ 只把「真的有傳的欄位」放進 patch。Firestore 對值為 undefined 的欄位是
    // **同步丟例外**（不是 Promise reject），如果這裡明寫 actualDistanceKm: undefined，
    // 那個例外會在 pushDoc 呼叫當下就炸穿整條呼叫鏈、連 .catch() 都接不到，
    // 畫面上卻什麼提示都沒有——這筆資料會安靜地沒有存到雲端。
    const patch = {};
    if (durationMinutes !== undefined) patch.actualDurationMinutes = durationMinutes;
    if (distanceKm !== undefined) patch.actualDistanceKm = distanceKm;
    return this._writeOwnEntry(dateKey, patch);
  },

  // 遠端（自己的其他裝置，或白名單內其他人的 entries）寫回快取。不呼叫 _cloudPush。
  mergeRemoteEntry(userId, dateKey, doc) {
    if (!this.entries[userId]) this.entries[userId] = {};
    const local = this.entries[userId][dateKey];
    // last-write-wins by updatedAt——但兩邊都是同一份文件的不同版本才需要比較；
    // 若本機還沒有任何版本，遠端直接贏。
    if (!local || !local.updatedAt || (doc.updatedAt && doc.updatedAt > local.updatedAt)) {
      this.entries[userId][dateKey] = doc;
      if (userId === this.activeUserId) saveJSON(`mt_entries::${userId}`, this.entries[userId]);
      this._notify();
    }
  },

  // ── private（只有自己）──────────────────────────────────────────────────
  privateFor(dateKey) { return this.privateData[dateKey] || null; },

  setFlag(dateKey, flagKey, value) {
    const prev = this.privateData[dateKey] || { flags: {}, note: '' };
    const next = { ...prev, flags: { ...prev.flags, [flagKey]: value }, updatedAt: nowIso(), deleted: false };
    this.privateData[dateKey] = next;
    this.persist();
    if (this._cloudPush) this._cloudPush('private', dateKey, next);
    return next;
  },

  setNote(dateKey, note) {
    const prev = this.privateData[dateKey] || { flags: {}, note: '' };
    const next = { ...prev, note, updatedAt: nowIso(), deleted: false };
    this.privateData[dateKey] = next;
    this.persist();
    if (this._cloudPush) this._cloudPush('private', dateKey, next);
    return next;
  },

  mergeRemotePrivate(dateKey, doc) {
    const local = this.privateData[dateKey];
    if (!local || !local.updatedAt || (doc.updatedAt && doc.updatedAt > local.updatedAt)) {
      this.privateData[dateKey] = doc;
      saveJSON(`mt_private::${this.activeUserId}`, this.privateData);
      this._notify();
    }
  },

  // ── 週調整（決策紀錄第 0 條：降量不能變相增加強度）──────────────────────
  // 標記「本週已降量」只影響總覽頁的顯示方式（灰底顯示、不算違反連續紀錄），
  // 絕不會把少掉的量搬到別的週——那正是決策紀錄第 0 條明講禁止的做法。
  weekAdjustmentFor(weekNumber) { return this.weekAdjustments[weekNumber] || null; },

  setWeekReduced(weekNumber, reduced, reason, note) {
    const next = { reduced, reason: reason || null, note: note || '', updatedAt: nowIso() };
    this.weekAdjustments[weekNumber] = next;
    this.persist();
    if (this._cloudPush) this._cloudPush('weekAdjustments', String(weekNumber), next);
    return next;
  },

  mergeRemoteWeekAdjustment(weekNumber, doc) {
    const local = this.weekAdjustments[weekNumber];
    if (!local || !local.updatedAt || (doc.updatedAt && doc.updatedAt > local.updatedAt)) {
      this.weekAdjustments[weekNumber] = doc;
      saveJSON(`mt_weekadj::${this.activeUserId}`, this.weekAdjustments);
      this._notify();
    }
  },

  // ── 教練模式：課表內容的共用覆寫層 ──────────────────────────────────────
  // planOverrides[weekNumber] 存在時整週優先讀它，不存在時退回 PlanData 的出廠預設值
  // （tools/build_plan.py 產生、git 版控的 data/plan.json）。三個白名單成員都能寫
  // （見 firestore.rules 的 planOverrides 規則），不像 entries/private 是本人專用。
  // ⚠️ 這裡是唯一讀「教練改過的內容」的入口，所以形狀檢查放在這裡守一次就
  // 保護到全部呼叫端——之前沒有這道檢查時，一份缺 days 的殘缺覆寫文件（不管是
  // 程式錯誤、還是有人直接在 Firebase Console 手改）會被 renderWeekPage /
  // renderLongRunTrend 直接拿去 .map()/.findIndex()，讓「總覽」跟該週的「本週」
  // 頁對所有人同時當機——而「還原本週為出廠預設值」那顆自救按鈕剛好畫在會當機
  // 的那個頁面裡，連自救都做不到。壞掉的覆寫層直接當作不存在，退回出廠值。
  effectiveWeek(weekNumber) {
    const override = this.planOverrides[weekNumber];
    if (override && this._isValidWeekShape(override)) return override;
    return PlanData.week(weekNumber);
  },

  _isValidWeekShape(w) {
    return !!w && Array.isArray(w.days) && w.days.length === 7 &&
      w.days.every((d) => d && Array.isArray(d.items) && d.items.length >= 1 &&
        d.items.every((it) => it && typeof it.id === 'string' && it.id && it.title && it.type));
  },

  effectiveDay(weekNumber, dayIndex) {
    return this.effectiveWeek(weekNumber).days[dayIndex];
  },

  // 教練模式編輯之後呼叫：整週寫回（覆寫層是「整週一份文件」的粒度，不是逐項目寫，
  // 避免新增/刪除項目時要處理陣列的部分更新）。存檔前先檢查形狀，壞資料不送出去——
  // 這是第一道防線；effectiveWeek 的檢查是第二道，防的是規則以外的路徑寫進壞資料
  // （例如手動改 Firebase Console）。
  //
  // weekObj.__baseUpdatedAt（app.js 的 _cloneEffectiveWeek 放的）記著這次編輯是
  // 從哪個版本開始改的，firebase-sync.js 用它做寫入前的版本比對——三個白名單成員
  // 共用同一份課表，偵測到「已經被別人改過」時要中止並告知，不能整份靜默蓋過去。
  saveWeekOverride(weekNumber, weekObj) {
    if (!this._isValidWeekShape(weekObj)) {
      alert('這週的資料格式不完整（可能缺天數或項目），沒有存檔，請檢查後再試一次。');
      return null;
    }
    const baseUpdatedAt = weekObj.__baseUpdatedAt;
    const clean = { ...weekObj };
    delete clean.__baseUpdatedAt;
    const next = { ...clean, weekNumber, updatedAt: nowIso(), updatedBy: this.activeUserId };
    this.planOverrides[weekNumber] = next;
    this._notify();
    if (this._cloudPushPlanOverride) this._cloudPushPlanOverride(weekNumber, next, baseUpdatedAt);
    return next;
  },

  // 還原成出廠預設值：清掉覆寫層，之後 effectiveWeek 自動退回 PlanData.week()。
  // 先留一份備份——雲端刪除若失敗（離線／權限被收回），要把本機狀態復原，
  // 不能讓「這台裝置看起來已經還原、其他裝置其實沒變」這種分岔在沒有任何提示下發生。
  resetWeekOverride(weekNumber) {
    const backup = this.planOverrides[weekNumber];
    delete this.planOverrides[weekNumber];
    this._notify();
    if (this._cloudDeletePlanOverride) this._cloudDeletePlanOverride(weekNumber, backup);
  },

  rollbackResetWeekOverride(weekNumber, backup) {
    if (backup) this.planOverrides[weekNumber] = backup;
    this._notify();
  },

  mergeRemoteWeekOverride(weekNumber, doc) {
    this.planOverrides[weekNumber] = doc;
    this._notify();
  },

  clearRemoteWeekOverride(weekNumber) {
    delete this.planOverrides[weekNumber];
    this._notify();
  },

  // ── 完成度計算（一律用 effectiveDay/effectiveWeek，讓教練改過的內容也算得對）──
  dayStatus(weekNumber, dayIndex) {
    if (PlanData.isExpired(weekNumber, dayIndex)) return 'expired';
    const dateKey = PlanData.keyForWeekDay(weekNumber, dayIndex);
    const d = this.effectiveDay(weekNumber, dayIndex);
    const entry = this.entryFor(this.activeUserId, dateKey);
    if (d.selectOne) {
      // ⚠️ 教練模式可能刪掉了使用者當初選的那個選項——selectedItemId 是懸空引用時
      // 不能算「完成」，否則週視圖／總覽的完成率會被一筆對不到任何項目的舊紀錄灌水，
      // 直到使用者下次重新點擊這天才會自我修正。
      const chosen = entry && entry.selectedItemId;
      const stillExists = chosen != null && d.items.some((it) => it.id === chosen);
      if (stillExists && entry.done && entry.done[chosen]) return 'done';
      return 'pending';
    }
    const items = d.items;
    const doneCount = items.filter((it) => entry && entry.done && entry.done[it.id]).length;
    if (doneCount === 0) return 'pending';
    if (doneCount === items.length) return 'done';
    return 'partial';
  },

  // 供總覽頁使用：某一週的完成率（休息日 type=rest 不計入分母，決策紀錄第 0 條附註）。
  weekCompletionRate(weekNumber, userId) {
    const w = this.effectiveWeek(weekNumber);
    let countable = 0, done = 0;
    w.days.forEach((d, i) => {
      if (PlanData.isExpired(weekNumber, i)) return;
      const isAllRest = d.items.every((it) => it.type === 'rest');
      if (isAllRest) return;
      countable++;
      const dateKey = PlanData.keyForWeekDay(weekNumber, i);
      const entry = this.entryFor(userId, dateKey);
      if (d.selectOne) {
        // 同 dayStatus：selectedItemId 若被教練刪掉了，不能算完成（見上方註解）。
        const chosen = entry && entry.selectedItemId;
        const stillExists = chosen != null && d.items.some((it) => it.id === chosen);
        if (stillExists && entry.done && entry.done[chosen]) done++;
      } else {
        const doneCount = d.items.filter((it) => entry && entry.done && entry.done[it.id]).length;
        if (doneCount === d.items.length) done++;
      }
    });
    return countable === 0 ? null : done / countable;
  },
};
