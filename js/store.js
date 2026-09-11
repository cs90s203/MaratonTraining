// 狀態 + localStorage 持久化。跟 babylog 同一套分層（見 docs/data-model.md 的說法）：
//
// 同步邊界：
//   mt_entries::{userId}   -> Firestore users/{userId}/entries/{date}（白名單內可讀，只有本人可寫）
//   mt_private::{userId}   -> Firestore users/{userId}/private/{date}（只有本人可讀寫）
//   mt_weekadj::{userId}   -> Firestore users/{userId}/weekAdjustments/{weekNumber}（只有本人）
//   mt_active_user         -> 本機限定，不同步。「我是誰」跟 Google 登入身分是分開的兩件事。
//   mt_local_theme         -> 本機限定。
//
// 本機寫入呼叫 Store._cloudPush(...)（wired 到 firebase-sync.js 的 Sync.pushDoc，
// 未登入前是 no-op），推到 Firestore。遠端變動透過 Store.mergeRemote*() 寫回，
// 呼叫路徑不經過 _cloudPush，避免寫入迴圈。
//
// 離線支援：不自己刻 outbox 佇列——Firestore SDK 的 enablePersistence()（在
// firebase-sync.js 開）本身就會在斷線時佇列寫入、恢復連線後自動補送
// （babylog docs/sync.md:52-54 用的是同一套）。這裡只需要在 UI 顯示
// snapshot.metadata.hasPendingWrites，不需要重新發明佇列。

const ACTIVE_USER_KEY = 'mt_active_user';
const THEME_KEY = 'mt_local_theme';

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
  entries: {},          // { [userId]: { [dateKey]: entryDoc } }
  privateData: {},      // { [dateKey]: privateDoc }  — 只有 activeUserId 自己的
  weekAdjustments: {},  // { [weekNumber]: adjDoc }   — 只有 activeUserId 自己的
  pendingWrites: 0,      // Firestore hasPendingWrites 計數，給同步小提示列用
  listeners: [],

  _cloudPush: null, // wired by firebase-sync.js: (path, docId, data) => void

  init() {
    this.activeUserId = localStorage.getItem(ACTIVE_USER_KEY) || (PlanData.users[0] && PlanData.users[0].userId) || null;
    this.theme = localStorage.getItem(THEME_KEY) || 'system';
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

  // ── entries（自己的紀錄）────────────────────────────────────────────────
  entryFor(userId, dateKey) {
    return (this.entries[userId] && this.entries[userId][dateKey]) || null;
  },

  _writeOwnEntry(dateKey, patch) {
    const userId = this.activeUserId;
    if (!this.entries[userId]) this.entries[userId] = {};
    const prev = this.entries[userId][dateKey] || { itemsDone: [], selectedChoice: null, actualDurationMinutes: null, actualDistanceKm: null };
    const next = { ...prev, ...patch, updatedAt: nowIso(), deleted: false };
    this.entries[userId][dateKey] = next;
    this.persist();
    if (this._cloudPush) this._cloudPush('entries', dateKey, next);
    return next;
  },

  toggleItemDone(dateKey, itemIndex, itemCount) {
    const prev = this.entryFor(this.activeUserId, dateKey);
    const itemsDone = (prev && prev.itemsDone ? [...prev.itemsDone] : new Array(itemCount).fill(false));
    while (itemsDone.length < itemCount) itemsDone.push(false);
    itemsDone[itemIndex] = !itemsDone[itemIndex];
    return this._writeOwnEntry(dateKey, { itemsDone });
  },

  // 選擇題（day.selectOne）專用：選一個選項＝那個選項直接算完成，其餘選項清空。
  // ⚠️ 不要借用 toggleItemDone（那是「翻轉」語意，給多項目打勾用）——曾經這裡直接呼叫
  // toggleItemDone，結果在兩個選項之間切換兩次（A→B→A）會把 A 的 itemsDone 翻回
  // false，UI 上「這次選了這個」跟「打勾」變成互相矛盾，週視圖/總覽也會把已完成的
  // 一天重新算成未完成。改成每次選擇都整組重建 itemsDone，只有選到的那格為 true。
  setSelectedChoice(dateKey, itemIndex, itemCount) {
    const prev = this.entryFor(this.activeUserId, dateKey);
    const already = prev && prev.selectedChoice === itemIndex;
    if (already) {
      // 再點一次同一個選項＝取消選擇，回到「待完成」。
      return this._writeOwnEntry(dateKey, { selectedChoice: null, itemsDone: new Array(itemCount).fill(false) });
    }
    const itemsDone = new Array(itemCount).fill(false);
    itemsDone[itemIndex] = true;
    return this._writeOwnEntry(dateKey, { selectedChoice: itemIndex, itemsDone });
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

  // ── 完成度計算 ──────────────────────────────────────────────────────────
  dayStatus(weekNumber, dayIndex) {
    if (PlanData.isExpired(weekNumber, dayIndex)) return 'expired';
    const dateKey = PlanData.keyForWeekDay(weekNumber, dayIndex);
    const d = PlanData.day(weekNumber, dayIndex);
    const entry = this.entryFor(this.activeUserId, dateKey);
    if (d.selectOne) {
      const chosen = entry && entry.selectedChoice;
      if (chosen != null && entry.itemsDone && entry.itemsDone[chosen]) return 'done';
      return 'pending';
    }
    const items = d.items;
    const doneCount = items.filter((_, i) => entry && entry.itemsDone && entry.itemsDone[i]).length;
    if (doneCount === 0) return 'pending';
    if (doneCount === items.length) return 'done';
    return 'partial';
  },

  // 供總覽頁使用：某一週的完成率（休息日 type=rest 不計入分母，決策紀錄第 0 條附註）。
  weekCompletionRate(weekNumber, userId) {
    const w = PlanData.week(weekNumber);
    let countable = 0, done = 0;
    w.days.forEach((d, i) => {
      if (PlanData.isExpired(weekNumber, i)) return;
      const isAllRest = d.items.every((it) => it.type === 'rest');
      if (isAllRest) return;
      countable++;
      const dateKey = PlanData.keyForWeekDay(weekNumber, i);
      const entry = this.entryFor(userId, dateKey);
      if (d.selectOne) {
        const chosen = entry && entry.selectedChoice;
        if (chosen != null && entry.itemsDone && entry.itemsDone[chosen]) done++;
      } else {
        const doneCount = d.items.filter((_, idx) => entry && entry.itemsDone && entry.itemsDone[idx]).length;
        if (doneCount === d.items.length) done++;
      }
    });
    return countable === 0 ? null : done / countable;
  },
};
