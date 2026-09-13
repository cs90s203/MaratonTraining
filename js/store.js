// 狀態 + localStorage 持久化。跟 babylog 同一套分層（見 docs/data-model.md 的說法）：
//
// 同步邊界：
//   mt_entries::{userId}   -> Firestore users/{userId}/entries/{date}（白名單內可讀，只有本人可寫）
//   mt_private::{userId}   -> Firestore users/{userId}/private/{date}（只有本人可讀寫）
//   mt_weekadj::{userId}   -> Firestore users/{userId}/weekAdjustments/{weekNumber}（白名單內可讀，只有本人可寫；跟 entries 同層）
//   mt_goals::{userId}     -> Firestore users/{userId}/profile/goals（白名單內可讀，只有本人可寫）
//                             訓練目標：比賽目標一句 + 自訂目標清單。每個人自己的，不是共用課表。
//   mt_phasetargets::{userId} -> Firestore users/{userId}/profile/phaseTargets（同上，白名單內可讀，
//                             只有本人可寫）。決策紀錄第 22 條：依訓練階段設定 Zone 2 配速／跑量／
//                             5K 技術指標目標，教練模式下任何白名單成員都能幫別人設（第 15 條）。
//   planOverrides          -> Firestore planOverrides/{weekNumber}（白名單內都可讀寫——
//                             教練模式改的課表內容，跟上面「個人紀錄」是不同的共用資源）
//   mt_active_user         -> 本機限定，不同步。「我是誰」跟 Google 登入身分是分開的兩件事。
//   mt_local_theme         -> 本機限定。
//   mt_local_coachmode     -> 本機限定。教練模式開關，久久才切一次，跟裝置綁定不是跟人綁定。
//   mt_local_weekview      -> 本機限定。週視圖是卡片還是表格。
//
// entries 一天一筆的欄位：
//   done              {itemId: true}                 打勾（見下方「項目 id」那段）
//   selectedItemId    string|null                    二擇一選了哪個
//   actualDurationMinutes / actualDistanceKm         當天實際數字（一天一筆，不是一項目一筆）
//   status            null|'substituted'|'missed'|'rested'
//                     null = 照表（由打勾推導 done/partial/pending）；
//                     'substituted' 改做了別的、'missed' 錯過、'rested' 主動休息。
//                     只有這三個非 null 值會覆蓋打勾推導的結果——「做完」永遠靠打勾，
//                     不另存一個 'done'，避免兩個欄位各自宣稱完成卻互相矛盾。
//   actualNote        string                         實際做了什麼／改做了什麼（白名單三人都看得到；
//                                                    身體狀況要寫 private.note，那個只有本人可讀）
//   substituteType    null|SUBSTITUTE_TYPES 之一      「改做」時做了哪一類（決策紀錄第 17 條）——
//                                                    只有 'run' 的公里才算進週跑量
//   effort            null|1..10                     練完自己打的體感強度（Apple Fitness 的
//                                                    Rate Your Effort；1-3 輕鬆 4-6 中等 7-8 困難 9-10 全力）
//                                                    這是「實際」，課表項目的 rpe 是「要求」，兩者分開存
//   fieldAt           {欄位: ISO 時間}               每個欄位各自的最後修改時間（見 mergeDocs）
//
// ── 跨裝置合併：欄位各有時間戳，雲端只送這次改的欄位 ──────────────────────────
// 雲端用 set(merge:true)：只覆蓋送出的欄位。所以本機寫入時**只把這次 patch 的欄位**推上去
//（不是整份文件），兩台裝置分別改同一天的不同欄位時，雲端會兩個都留住。
// 本機收到遠端文件時逐欄位比 fieldAt（誰的時間新誰贏），不是整份比 updatedAt——
// 整份 LWW 在「雲端已合併兩邊欄位、updatedAt 卻只是其中一台的」情況下永遠不收斂。
// done 是 map，merge:true 對 map 是深層合併（舊 key 不會被清掉），所以寫 done 時一律把
// 當天所有項目 id 都列出（沒勾的寫 false），讓深層合併等同整個換掉。
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
const WEEK_VIEW_KEY = 'mt_local_weekview';

// 一天的狀態覆寫值（entries.status）。'done' 刻意不在裡面——完成永遠由打勾推導。
const DAY_STATUS_OVERRIDES = ['substituted', 'missed', 'rested'];
// 「改做」做了哪一類（entries.substituteType）。views.js 的 SUBSTITUTE_LABELS 是它的顯示文字。
const SUBSTITUTE_TYPES = ['run', 'strength', 'core', 'bike', 'swim', 'walk', 'other'];
// 週跑量目標只加總這三種 type。⚠️ 跟 tools/verify_plan.py 的 RUN_TYPES 必須一致
//（Python／瀏覽器 JS 兩個執行環境，沒辦法共用常數，只能靠註解互相提醒）。
// race 刻意不在裡面：比賽是整份計畫的終點，不是賽週的跑量目標（算進去賽週目標會變 47K+）。
// walk-run 是 v3 的舊類型（決策紀錄第 12 條拿掉了），教練改過的舊覆寫文件裡可能還有，
// 算跑量時視同 run，不要無聲算成 0。
const RUN_TYPES = ['run', 'long-run', 'tempo'];
const LEGACY_RUN_TYPES = ['walk-run'];
function isRunType(t) { return RUN_TYPES.includes(t) || LEGACY_RUN_TYPES.includes(t); }

// 一週的顯示順序：identity＝出廠順序（週一顯示週一的內容...）。決策紀錄第 14 條：
// 環境因素讓某天跟另一天對調時，用這個排列表示「日曆上的第 i 天，顯示的其實是
// 出廠課表第 order[i] 天的內容」——課表項目一個字都沒改，只是重新標籤，所以不可能
// 變相加量。isValidDayOrder 檔壞資料（缺值、有重複）：長度 7 且涵蓋 0-6 全部，
// 就保證是排列（不需要另外檢查重複）。
const IDENTITY_ORDER = [0, 1, 2, 3, 4, 5, 6];
function isValidDayOrder(order) {
  return Array.isArray(order) && order.length === 7 && IDENTITY_ORDER.every((i) => order.includes(i));
}

function nowIso() { return new Date().toISOString(); }
function round1(x) { return Math.round(x * 10) / 10; }
function round2(x) { return Math.round(x * 100) / 100; }

// 階段性目標（決策紀錄第 22 條）可設定的六個欄位。跟 views.js 的 PHASE_TARGET_META
// 是同一份清單的兩個切面——這裡只管「合不合法」，那邊管「怎麼顯示、單位、輸入格式」。
const PHASE_TARGET_FIELDS = ['zone2Pace', 'volumeKm', 'cadence', 'verticalOscillation', 'groundContactTime', 'strideLength'];

// 遠端文件寫回本機快取時的合併規則（見檔頭「跨裝置合併」）：逐欄位比 fieldAt，
// 沒有 fieldAt 的舊文件退回用整份 updatedAt 當每個欄位的時間。
function fieldTime(doc, key) {
  return (doc.fieldAt && doc.fieldAt[key]) || doc.updatedAt || '';
}
function mergeDocs(local, remote) {
  if (!local) return remote;
  if (!remote) return local;
  const out = { ...local };
  const fieldAt = { ...(local.fieldAt || {}) };
  Object.keys(remote).forEach((k) => {
    if (k === 'fieldAt' || k === 'updatedAt') return;
    const rt = fieldTime(remote, k), lt = fieldTime(local, k);
    if (!(k in local) || rt > lt) { out[k] = remote[k]; fieldAt[k] = rt; }
    else if (!fieldAt[k]) fieldAt[k] = lt;
  });
  out.fieldAt = fieldAt;
  out.updatedAt = [local.updatedAt || '', remote.updatedAt || ''].sort().pop();
  return out;
}
// 本機寫入：next 是完整文件（給 UI 用），push 只含這次改的欄位（給雲端 merge:true 用）。
function applyPatch(prev, patch) {
  Object.keys(patch).forEach((k) => {
    if (patch[k] === undefined) throw new Error(`patch 欄位 ${k} 是 undefined（要清空請寫 null）`);
  });
  const at = nowIso();
  const stamp = {};
  Object.keys(patch).forEach((k) => { stamp[k] = at; });
  const next = { ...prev, ...patch, updatedAt: at, deleted: false, fieldAt: { ...(prev.fieldAt || {}), ...stamp } };
  const push = { ...patch, updatedAt: at, deleted: false, fieldAt: stamp };
  return { next, push };
}

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
  weekViewMode: 'cards', // 'cards' | 'table'
  entries: {},          // { [userId]: { [dateKey]: entryDoc } }
  privateData: {},      // { [dateKey]: privateDoc }  — 只有 activeUserId 自己的
  weekAdjustments: {},  // { [userId]: { [weekNumber]: adjDoc } } — 自己的會存 localStorage；別人的（查看進度用）只在記憶體
  goals: {},            // { [userId]: goalsDoc }     — 自己的會存 localStorage；別人的只在記憶體（總覽頁唯讀）
  phaseTargets: {},     // { [userId]: { [phaseId]: {zone2Pace,volumeKm,cadence,verticalOscillation,groundContactTime,strideLength} } } — 同上
  planOverrides: {},    // { [weekNumber]: weekDoc }  — 白名單共用，教練模式改過的週
  listeners: [],

  _cloudPush: null, // wired by firebase-sync.js: (kind, docId, data) => void

  init() {
    this.activeUserId = localStorage.getItem(ACTIVE_USER_KEY) || (PlanData.users[0] && PlanData.users[0].userId) || null;
    this.theme = localStorage.getItem(THEME_KEY) || 'system';
    this.coachMode = localStorage.getItem(COACH_MODE_KEY) === '1';
    this.weekViewMode = localStorage.getItem(WEEK_VIEW_KEY) === 'table' ? 'table' : 'cards';
    this._loadUserCache(this.activeUserId);
  },

  _loadUserCache(userId) {
    if (!userId) return;
    // 記憶體裡可能已經有這個人的資料（總覽頁「查看別人」訂閱進來的雲端版本），
    // 不能因此跳過 localStorage——本機專屬、還沒推上雲的紀錄會被下一次 persist 蓋掉。
    // 兩邊逐份 mergeDocs。
    const stored = loadJSON(`mt_entries::${userId}`, {});
    const mem = this.entries[userId] || {};
    const merged = { ...mem };
    Object.keys(stored).forEach((k) => { merged[k] = mergeDocs(stored[k], mem[k]); });
    this.entries[userId] = merged;
    this.privateData = loadJSON(`mt_private::${userId}`, {});
    const storedAdj = loadJSON(`mt_weekadj::${userId}`, {});
    const memAdj = this.weekAdjustments[userId] || {};
    const mergedAdj = { ...memAdj };
    Object.keys(storedAdj).forEach((k) => { mergedAdj[k] = mergeDocs(storedAdj[k], memAdj[k]); });
    this.weekAdjustments[userId] = mergedAdj;
    const g = loadJSON(`mt_goals::${userId}`, null);
    if (g) this.goals[userId] = mergeDocs(g, this.goals[userId]);
    const pt = loadJSON(`mt_phasetargets::${userId}`, null);
    if (pt) this.phaseTargets[userId] = mergeDocs(pt, this.phaseTargets[userId]);
  },

  onChange(fn) { this.listeners.push(fn); },
  _notify() { this.listeners.forEach((fn) => fn()); },

  // silent=true：只存不重繪。文字欄位（備註、目標文字）的 onchange 用——
  // 存檔當下整頁重繪會把使用者緊接著那一下點擊吞掉（blur → change → 重繪 → click 落空）。
  persist(silent) {
    saveJSON(`mt_entries::${this.activeUserId}`, this.entries[this.activeUserId] || {});
    saveJSON(`mt_private::${this.activeUserId}`, this.privateData);
    saveJSON(`mt_weekadj::${this.activeUserId}`, this.weekAdjustments[this.activeUserId] || {});
    if (this.goals[this.activeUserId]) saveJSON(`mt_goals::${this.activeUserId}`, this.goals[this.activeUserId]);
    if (this.phaseTargets[this.activeUserId]) saveJSON(`mt_phasetargets::${this.activeUserId}`, this.phaseTargets[this.activeUserId]);
    if (!silent) this._notify();
  },

  setWeekViewMode(mode) {
    this.weekViewMode = mode === 'table' ? 'table' : 'cards';
    localStorage.setItem(WEEK_VIEW_KEY, this.weekViewMode);
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

  _writeOwnEntry(dateKey, patch, silent) {
    // applyPatch 裡有可執行的守衛：patch 不准有 undefined（undefined 會讓本機清掉欄位、
    // pushDoc 卻把它剝掉不送——本機刪、雲端留）。要清空一律寫 null。
    const userId = this.activeUserId;
    if (!this.entries[userId]) this.entries[userId] = {};
    const prev = this.entries[userId][dateKey] || { done: {}, selectedItemId: null, actualDurationMinutes: null, actualDistanceKm: null, status: null, actualNote: '', substituteType: null, effort: null };
    const { next, push } = applyPatch(prev, patch);
    this.entries[userId][dateKey] = next;
    this.persist(silent);
    if (this._cloudPush) this._cloudPush('entries', dateKey, push);
    return next;
  },

  // 當天所有項目 id 都列出的 done map（沒勾的寫 false）——見檔頭「done 是 map」那段。
  // 用 effectiveDayOrder 解析成「這個日曆日實際顯示的內容」，不是出廠當天——如果這天
  // 被對調過（決策紀錄第 14 條），打的勾屬於顯示出來的那份內容，不是日曆格子本來的內容。
  _fullDone(dateKey, trueIds) {
    const loc = PlanData.locateKey(dateKey);
    const order = loc ? this.effectiveDayOrder(loc.weekNumber, this.activeUserId) : IDENTITY_ORDER;
    const items = loc ? this.effectiveDay(loc.weekNumber, order[loc.dayIndex]).items : [];
    const done = {};
    items.forEach((it) => { done[it.id] = false; });
    Object.keys(trueIds || {}).forEach((id) => { if (trueIds[id]) done[id] = true; });
    return done;
  },

  // 打勾與狀態覆寫互斥（單一真相）：打勾＝回到「照表」，status 清成 null；
  // 反過來 setDayStatus 設了改做／錯過／主動休息就把勾清空。不然卡片是綠色打勾、
  // 底下卻寫「改做」、完成率又不算，三個東西各自有真相。
  toggleItemDone(dateKey, itemId) {
    const prev = this.entryFor(this.activeUserId, dateKey);
    const cur = { ...(prev && prev.done) };
    cur[itemId] = !cur[itemId];
    return this._writeOwnEntry(dateKey, { done: this._fullDone(dateKey, cur), status: null });
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
      return this._writeOwnEntry(dateKey, { selectedItemId: null, done: this._fullDone(dateKey, {}), status: null });
    }
    const chosen = {}; chosen[itemId] = true;
    return this._writeOwnEntry(dateKey, { selectedItemId: itemId, done: this._fullDone(dateKey, chosen), status: null });
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

  // 一天的狀態：null（照表，由打勾推導）或 DAY_STATUS_OVERRIDES 其中之一。
  // 再點一次同一個＝取消，回到照表。不合法的值一律當 null，不讓壞值進資料。
  // 設成非 null 時同一筆 patch 把勾清掉（見 toggleItemDone 的註解）；錯過／主動休息
  // 連實際分鐘／公里也清成 null——「錯過卻有 5 公里」是兩套表示互相矛盾。
  // 改做保留數字（改做的內容也可能有量）。
  setDayStatus(dateKey, status) {
    const prev = this.entryFor(this.activeUserId, dateKey);
    const valid = DAY_STATUS_OVERRIDES.includes(status) ? status : null;
    const next = prev && prev.status === valid ? null : valid;
    if (next === null) {
      // 取消覆寫、回到照表：如果這天課表本身沒有跑步／沒有時長項目，「改做」期間填的
      // 實際數字要一併清掉。renderActualBox 的公里／分鐘輸入框只在「有跑步項目」／
      // 「有時長項目」或「狀態是改做」時顯示——取消後這兩個條件都不成立，輸入框會消失，
      // 但數字若留在 entry 裡，週跑量 weekVolume 還是會繼續把它加進去，畫面上卻沒有
      // 任何地方看得到、也沒辦法清掉。
      const loc = PlanData.locateKey(dateKey);
      const order = loc ? this.effectiveDayOrder(loc.weekNumber, this.activeUserId) : IDENTITY_ORDER;
      const day = loc && this.effectiveDay(loc.weekNumber, order[loc.dayIndex]);
      const patch = { status: null, substituteType: null };
      if (day) {
        if (!day.items.some((it) => isRunType(it.type) || it.type === 'race')) patch.actualDistanceKm = null;
        if (!day.items.some((it) => it.duration)) patch.actualDurationMinutes = null;
      }
      return this._writeOwnEntry(dateKey, patch);
    }
    const patch = { status: next, done: this._fullDone(dateKey, {}), selectedItemId: null };
    // 錯過／主動休息：沒有做，所以實際數字、改做類型、體感強度都清掉——「錯過卻有 5 公里」
    // 或「休息卻打了 7 分」是兩套表示互相矛盾。改做保留數字跟體感（改做的內容也有量、也有感受）。
    if (next !== 'substituted') { patch.actualDurationMinutes = null; patch.actualDistanceKm = null; patch.substituteType = null; patch.effort = null; }
    return this._writeOwnEntry(dateKey, patch);
  },

  // 改做做了哪一類。再點同一個＝取消。不合法的值一律當 null。
  setSubstituteType(dateKey, type) {
    const prev = this.entryFor(this.activeUserId, dateKey);
    const valid = SUBSTITUTE_TYPES.includes(type) ? type : null;
    const next = prev && prev.substituteType === valid ? null : valid;
    const patch = { substituteType: next };
    // 改成非跑步類：之前填的公里沒有意義了（週跑量只算跑步），清掉，免得畫面上看不到卻被加總
    if (next && next !== 'run') patch.actualDistanceKm = null;
    return this._writeOwnEntry(dateKey, patch);
  },

  // 體感強度 1-10。再點同一個數字＝清掉。範圍外一律當 null。
  setEffort(dateKey, n) {
    const prev = this.entryFor(this.activeUserId, dateKey);
    const v = Number(n);
    const valid = Number.isInteger(v) && v >= 1 && v <= 10 ? v : null;
    const next = prev && prev.effort === valid ? null : valid;
    return this._writeOwnEntry(dateKey, { effort: next });
  },

  setActualNote(dateKey, note) {
    return this._writeOwnEntry(dateKey, { actualNote: String(note || '') }, true);
  },

  // 遠端（自己的其他裝置，或白名單內其他人的 entries）寫回快取。不呼叫 _cloudPush。
  mergeRemoteEntry(userId, dateKey, doc) {
    if (!this.entries[userId]) this.entries[userId] = {};
    const local = this.entries[userId][dateKey];
    // 逐欄位合併（見 mergeDocs 的註解），不是整份 last-write-wins。
    this.entries[userId][dateKey] = mergeDocs(local, doc);
    if (userId === this.activeUserId) saveJSON(`mt_entries::${userId}`, this.entries[userId]);
    this._notify();
  },

  // ── private（只有自己）──────────────────────────────────────────────────
  privateFor(dateKey) { return this.privateData[dateKey] || null; },

  _writeOwnPrivate(dateKey, patch, silent) {
    const prev = this.privateData[dateKey] || { flags: {}, note: '' };
    const { next, push } = applyPatch(prev, patch);
    this.privateData[dateKey] = next;
    this.persist(silent);
    if (this._cloudPush) this._cloudPush('private', dateKey, push);
    return next;
  },

  setFlag(dateKey, flagKey, value) {
    const prev = this.privateData[dateKey] || { flags: {}, note: '' };
    // flags 是 map：整份列出（跟 done 同理，讓 merge:true 的深層合併等同整個換掉）
    const flags = { leakage: false, pain: false, overTired: false, ...(prev.flags || {}), [flagKey]: !!value };
    return this._writeOwnPrivate(dateKey, { flags });
  },

  setNote(dateKey, note) {
    return this._writeOwnPrivate(dateKey, { note: String(note || '') }, true);
  },

  mergeRemotePrivate(dateKey, doc) {
    this.privateData[dateKey] = mergeDocs(this.privateData[dateKey], doc);
    saveJSON(`mt_private::${this.activeUserId}`, this.privateData);
    this._notify();
  },

  // ── 週調整（決策紀錄第 0 條：降量不能變相增加強度）──────────────────────
  // 標記「本週已降量」只影響週日回顧橫幅（顯示已標記）與跑量卡（不比對目標）；
  // 不進完成率、絕不會把少掉的量搬到別的週——那正是第 0 條明講禁止的做法。
  // 這份文件也存「這週的顯示順序對調」（決策紀錄第 14 條），跟降量標記是同一類東西：
  // 「這週對我來說不太一樣」的個人狀態，不是課表內容改變，只有本人能寫。
  weekAdjustmentFor(weekNumber, userId) {
    const uid = userId || this.activeUserId;
    return (this.weekAdjustments[uid] && this.weekAdjustments[uid][weekNumber]) || null;
  },

  setWeekReduced(weekNumber, reduced, reason, note) {
    const userId = this.activeUserId;
    if (!this.weekAdjustments[userId]) this.weekAdjustments[userId] = {};
    const prev = this.weekAdjustments[userId][weekNumber] || {};
    const { next, push } = applyPatch(prev, { reduced: !!reduced, reason: reason || null, note: note || '' });
    this.weekAdjustments[userId][weekNumber] = next;
    this.persist();
    if (this._cloudPush) this._cloudPush('weekAdjustments', String(weekNumber), push);
    return next;
  },

  // 顯示順序：教練模式一律回傳出廠順序（identity），不管本人有沒有對調過——教練模式
  // 編輯的是所有人共用的課表結構，且 renderDayBody 在教練模式下把「日曆格子」直接
  // 當成「要編輯的出廠天」用，順序被打亂會編輯到錯的一天。不合法的 dayOrder（缺值、
  // 舊格式）一律退回 identity，不讓壞資料讓畫面錯位——跟 _isValidWeekShape 同一個精神。
  effectiveDayOrder(weekNumber, userId) {
    if (this.coachMode) return IDENTITY_ORDER;
    const adj = this.weekAdjustmentFor(weekNumber, userId);
    const order = adj && adj.dayOrder;
    return isValidDayOrder(order) ? order : IDENTITY_ORDER;
  },

  // 決策紀錄第 14 條：環境因素讓這週的某天跟另一天對調，課表項目完全不變，只是重新
  // 標籤「日曆上第 i 天顯示第 order[i] 天的內容」。只有自己能設（跟「本週已降量」同一份
  // 文件、同樣本人專用）——這是個人排程狀況，不是教練要改的課表內容。
  setDayOrder(weekNumber, dayOrder) {
    const userId = this.activeUserId;
    if (!this.weekAdjustments[userId]) this.weekAdjustments[userId] = {};
    const prev = this.weekAdjustments[userId][weekNumber] || {};
    const valid = isValidDayOrder(dayOrder) ? dayOrder : null;
    const { next, push } = applyPatch(prev, { dayOrder: valid });
    this.weekAdjustments[userId][weekNumber] = next;
    this.persist();
    if (this._cloudPush) this._cloudPush('weekAdjustments', String(weekNumber), push);
    return next;
  },

  // 拖曳（UI 的唯一入口，決策紀錄第 18 條）：把第 from 格拿出來插到第 to 格——插入語意，
  // 中間的格子順移一格，跟 iOS 清單拖曳一致。回到出廠順序時直接清掉 dayOrder，
  // 不留一筆「順序其實跟出廠一樣」的空紀錄。
  moveWeekDay(weekNumber, from, to) {
    from = Number(from); to = Number(to);
    const ok = (n) => Number.isInteger(n) && n >= 0 && n <= 6;
    if (!ok(from) || !ok(to) || from === to) return null;
    const order = this.effectiveDayOrder(weekNumber, this.activeUserId).slice();
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    const isIdentity = order.every((v, i) => v === i);
    return this.setDayOrder(weekNumber, isIdentity ? null : order);
  },

  resetDayOrder(weekNumber) { return this.setDayOrder(weekNumber, null); },

  mergeRemoteWeekAdjustment(userId, weekNumber, doc) {
    if (!this.weekAdjustments[userId]) this.weekAdjustments[userId] = {};
    this.weekAdjustments[userId][weekNumber] = mergeDocs(this.weekAdjustments[userId][weekNumber], doc);
    if (userId === this.activeUserId) saveJSON(`mt_weekadj::${userId}`, this.weekAdjustments[userId]);
    this._notify();
  },

  // ── 訓練目標（users/{userId}/profile/goals）───────────────────────────────
  // 形狀：{ raceGoal: string, items: [{id, text, done}], updatedAt, deleted }
  // 每個人自己的目標，例如「完賽」「VO₂max 34 → 40」——不是課表的一部分，也不會拿它去改
  // 任何一天的負荷（第 0 條）。決策紀錄第 15 條：教練模式開著時，任何白名單成員都能
  // 幫別人設目標（跟教練模式改課表同一套「三人皆可」哲學，不限定某一人是教練），
  // 所以寫入函式都接受一個可選的 targetUserId；不傳就是寫自己的。
  goalsFor(userId) {
    const g = this.goals[userId];
    if (!g || g.deleted) return null;
    return { raceGoal: g.raceGoal || '', items: Array.isArray(g.items) ? g.items : [] };
  },

  _writeGoalsFor(targetUserId, patch, silent) {
    const uid = targetUserId || this.activeUserId;
    const prev = this.goals[uid] || { raceGoal: '', items: [] };
    const { next, push } = applyPatch(prev, patch);
    this.goals[uid] = next;
    // 只有自己的目標存進本機 localStorage 快取——幫別人設的目標已經在記憶體裡
    // （靠 subscribeOtherProfile 保持最新），不需要、也不該用自己的裝置快取別人的資料。
    if (uid === this.activeUserId) this.persist(silent);
    else if (!silent) this._notify();
    if (this._cloudPush) this._cloudPush('profile', 'goals', push, uid);
    return next;
  },

  setRaceGoal(text, targetUserId) { return this._writeGoalsFor(targetUserId, { raceGoal: String(text || '').trim() }, true); },

  addGoal(text, targetUserId) {
    const t = String(text || '').trim();
    if (!t) return null;
    const cur = this.goalsFor(targetUserId || this.activeUserId) || { items: [] };
    return this._writeGoalsFor(targetUserId, { items: [...cur.items, { id: newItemId(), text: t, done: false }] });
  },

  toggleGoalDone(id, targetUserId) {
    const cur = this.goalsFor(targetUserId || this.activeUserId);
    if (!cur) return null;
    return this._writeGoalsFor(targetUserId, { items: cur.items.map((g) => g.id === id ? { ...g, done: !g.done } : g) });
  },

  setGoalText(id, text, targetUserId) {
    const cur = this.goalsFor(targetUserId || this.activeUserId);
    if (!cur) return null;
    const t = String(text || '').trim();
    if (!t) return null; // 清空不等於刪除——要刪按 ×
    return this._writeGoalsFor(targetUserId, { items: cur.items.map((g) => g.id === id ? { ...g, text: t } : g) }, true);
  },

  removeGoal(id, targetUserId) {
    const cur = this.goalsFor(targetUserId || this.activeUserId);
    if (!cur) return null;
    return this._writeGoalsFor(targetUserId, { items: cur.items.filter((g) => g.id !== id) });
  },

  mergeRemoteGoals(userId, doc) {
    this.goals[userId] = mergeDocs(this.goals[userId], doc);
    if (userId === this.activeUserId) saveJSON(`mt_goals::${userId}`, this.goals[userId]);
    this._notify();
  },

  // ── 階段性目標（users/{userId}/profile/phaseTargets）───────────────────────
  // 決策紀錄第 22 條：教練依訓練階段（恢復奠基期／基礎期／賽前期／減量期／賽週）設定
  // Zone 2 配速、跑量、5K 技術指標（Cadence／Vertical Oscillation／Ground Contact Time／
  // Stride Length）的目標範圍。形狀：{ [phaseId]: {欄位: {min,max}|null, ...}, updatedAt, deleted }
  // ——頂層欄位是 phaseId，逐階段合併（applyPatch），跟 goals 用同一套哲學：每個人自己的，
  // 教練模式下任何白名單成員都能幫別人設（第 15 條）。
  //
  // 刻意跟週跑量目標不同：週跑量目標是系統自動算出來、教練只能往下調的天花板（第 0 條
  // 的機械防線，因為那是每週都在調的高頻動作，容易手滑）；這裡的六個數字是教練低頻率、
  // 深思熟慮的專業判斷，不設自動上限、不擋存檔——App 只在旁邊顯示背景參考（課表這階段
  // 自動算出的量、這階段 Zone 2 的心率／RPE 區間），讓教練「看得到」邊界，不是「被擋住」。
  phaseTargetsFor(userId) {
    const p = this.phaseTargets[userId];
    if (!p || p.deleted) return {};
    const out = {};
    PlanData.plan.phases.forEach((ph) => { if (p[ph.phaseId]) out[ph.phaseId] = p[ph.phaseId]; });
    return out;
  },

  // fields：{欄位: {min,max}|null, ...}（六個欄位不必全給，沒給的維持原值）——由
  // app.js 的 savePhaseTargets 一次讀整份表單、算好每個欄位再呼叫這裡，寫回時整個
  // phaseId 當一個欄位（一次 applyPatch／一次雲端寫入），不是六次個別欄位寫入。
  setPhaseTargetsForPhase(phaseId, fields, targetUserId) {
    if (!PlanData.plan.phases.some((p) => p.phaseId === phaseId)) return null;
    const uid = targetUserId || this.activeUserId;
    const cur = (this.phaseTargets[uid] && this.phaseTargets[uid][phaseId]) || {};
    const next = { ...cur };
    PHASE_TARGET_FIELDS.forEach((k) => {
      if (!(k in fields)) return;
      const r = fields[k];
      // 防呆：min/max 打反也存得進去（app.js 的表單已經排過序了，這裡是第二道防線——
      // 跟 _isValidWeekShape 同一個精神，不假設呼叫端一定做對）。
      next[k] = (r && Number.isFinite(r.min) && Number.isFinite(r.max))
        ? { min: round2(Math.min(r.min, r.max)), max: round2(Math.max(r.min, r.max)) }
        : null;
    });
    return this._writePhaseTargetsFor(targetUserId, { [phaseId]: next }, true);
  },

  _writePhaseTargetsFor(targetUserId, patch, silent) {
    const uid = targetUserId || this.activeUserId;
    const prev = this.phaseTargets[uid] || {};
    const { next, push } = applyPatch(prev, patch);
    this.phaseTargets[uid] = next;
    if (uid === this.activeUserId) this.persist(silent);
    else if (!silent) this._notify();
    if (this._cloudPush) this._cloudPush('profile', 'phaseTargets', push, uid);
    return next;
  },

  mergeRemotePhaseTargets(userId, doc) {
    this.phaseTargets[userId] = mergeDocs(this.phaseTargets[userId], doc);
    if (userId === this.activeUserId) saveJSON(`mt_phasetargets::${userId}`, this.phaseTargets[userId]);
    this._notify();
  },

  // 這個階段課表本身自動算出來大約多少公里——純參考文字用，把該階段每一週的自動目標
  // （跟 setWeeklyVolume 的天花板同一個算法，planOnly：不看任何人的 entries／對調順序，
  // 課表本身的加總不該因為誰在看畫面而變）加總。跟教練填的目標**不比對、不強制**，
  // 只是讓教練填數字時看得到背景（決策紀錄第 22 條）。
  phaseVolumeAutoRange(phaseId, userId) {
    const ph = PlanData.plan.phases.find((p) => p.phaseId === phaseId);
    if (!ph) return null;
    let min = 0, max = 0;
    for (let w = ph.weekRange[0]; w <= ph.weekRange[1]; w++) {
      const t = this.weekTargetAuto(w, userId, { planOnly: true });
      min += t.min; max += t.max;
    }
    return { min: round1(min), max: round1(max) };
  },

  // 這個階段至今累積的實際跑量——沿用「週跑量」的實際值算法（第 17 條：改做非跑步類
  // 不算、休息／過期排除…）逐週加總，不是另一套新規則。回傳 null 表示這個階段完全
  // 沒有任何一週有記錄（畫面上顯示「—」，不是 0——第 0 條：沒資料不等於做了 0）。
  phaseVolumeActual(phaseId, userId) {
    const ph = PlanData.plan.phases.find((p) => p.phaseId === phaseId);
    if (!ph) return null;
    let sum = 0, hasAny = false;
    for (let w = ph.weekRange[0]; w <= ph.weekRange[1]; w++) {
      const v = this.weekVolume(w, userId);
      if (v.actual != null) { sum += v.actual; hasAny = true; }
    }
    return hasAny ? round1(sum) : null;
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
  // silent=true：跟 _writeOwnEntry 的 silent 同理——setDayNotes 這種文字欄位的 onchange
  // 若立刻整頁重繪，剛好落在「blur → change → 重繪」跟使用者緊接著點下一個按鈕的
  // mousedown 同一個事件序列裡，重繪會把那個按鈕換成新節點，點擊因此落空（需要點兩次）。
  // 不 notify 不代表不存檔：this.planOverrides 已經更新，下次任何原因觸發的重繪都會是新值。
  saveWeekOverride(weekNumber, weekObj, silent) {
    if (!this._isValidWeekShape(weekObj)) {
      alert('這週的資料格式不完整（可能缺天數或項目），沒有存檔，請檢查後再試一次。');
      return null;
    }
    const baseUpdatedAt = weekObj.__baseUpdatedAt;
    const clean = { ...weekObj };
    delete clean.__baseUpdatedAt;
    // v3 殘留欄位（決策紀錄第 8 條時代的「參考上限」），下次編輯時自然洗掉——
    // kind:'reference' 的 weeklyVolumeKm 是原文那個課表達不到的數字，絕不能變成教練目標。
    delete clean.weeklyVolumeNullReason;
    if (clean.weeklyVolumeKm && clean.weeklyVolumeKm.kind === 'reference') delete clean.weeklyVolumeKm;
    // 記下這份覆寫是基於哪一版出廠課表改的：出廠課表更新（例如第 12 條拿掉走跑）之後，
    // 被教練改過的週不會自動跟上，週視圖用這個欄位提示「這週的調整基於舊版」。
    const next = { ...clean, weekNumber, basePlanVersion: PlanData.plan.planVersion, updatedAt: nowIso(), updatedBy: this.activeUserId };
    this.planOverrides[weekNumber] = next;
    if (!silent) this._notify();
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
  // 回傳：expired | substituted | missed | rested | done | partial | pending
  // 前四個之後的三個由打勾推導；status 覆寫值優先（使用者說「今天改做了別的」，
  // 就算卡片還有勾也不算「照表完成」）。
  dayStatus(weekNumber, dayIndex, userId) {
    if (PlanData.isExpired(weekNumber, dayIndex)) return 'expired';
    const uid = userId || this.activeUserId;
    const dateKey = PlanData.keyForWeekDay(weekNumber, dayIndex);
    // dayIndex 是日曆格子；effectiveDayOrder 解析出那個格子實際顯示哪個出廠天的內容
    // （決策紀錄第 14 條的對調）。dateKey 永遠對應日曆格子本身，不受對調影響——
    // 對調換的是「看到什麼」，不是「哪天算哪天」。
    const order = this.effectiveDayOrder(weekNumber, uid);
    const d = this.effectiveDay(weekNumber, order[dayIndex]);
    const entry = this.entryFor(uid, dateKey);
    if (entry && DAY_STATUS_OVERRIDES.includes(entry.status)) return entry.status;
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

  // 供總覽頁使用：某一週的「照表完成率」。
  // 分母拿掉：過期日、課表本身全是休息的日子、使用者標「主動休息」或「改做」的日子
  //（決策紀錄第 0 條：休息不是失敗；「取代」是第 0 條唯一允許的補做方式，把它算成
  // 跟「錯過」同分會把人推向硬照表操課）。「錯過」留在分母、不進分子。
  // 不另外算一個「有練率」，避免第二個分數在催人。
  weekCompletionRate(weekNumber, userId) {
    const w = this.effectiveWeek(weekNumber);
    const order = this.effectiveDayOrder(weekNumber, userId);
    let countable = 0, done = 0;
    for (let i = 0; i < 7; i++) {
      const d = w.days[order[i]]; // 那個日曆格子實際顯示的內容（見 dayStatus 的註解）
      if (d.items.every((it) => it.type === 'rest')) continue;
      // 狀態的唯一出口是 dayStatus——這裡不重抄一遍 selectOne／doneCount 的推導。
      const st = this.dayStatus(weekNumber, i, userId);
      if (st === 'expired' || st === 'rested' || st === 'substituted') continue;
      countable++;
      if (st === 'done') done++;
    }
    return countable === 0 ? null : done / countable;
  },

  // ── 週跑量：目標 vs 實際（決策紀錄第 13 條）────────────────────────────────
  // 目標預設從該週的跑步項目即時加總（不存進 plan.json，教練改項目就自動跟著變）：
  //   - 只算 RUN_TYPES（＋舊的 walk-run）；有 distanceKm 用它，只有 duration 的用
  //     timeBasedRunPaceMinPerKm 換算（分速取慢端，換出來是低估值）
  //   - 過期日不算（W1 的 9/07-9/09 沒人要求補做，目標裡也不該有它們）
  //   - 使用者標「主動休息」的日子不算、「改做」且沒記公里的日子不算——跟完成率的分母
  //     同一套（第 0 條：降量週縮小分母，少掉的量就是少掉了）；「錯過」的日子照算，缺口是真的
  //   - 比賽日整天不算（目標與實際都不算）：比賽是終點不是那週的跑量，另外回傳 race
  //   - 二擇一的日子：下限取各選項的最小值（休息選項＝0，所以含休息的日子下限自然不含它）、
  //     上限取最大值——這是誠實的區間，不是把「可以休息」偷偷算成「要跑」
  // 教練模式可以覆寫（week.weeklyVolumeKm = {min,max}，存在 planOverrides 那份文件裡），
  // 但上限不能高於自動加總（app.js setWeeklyVolume 擋）——數字只能把目標調低，
  // 要加量請改課表項目，那才會被看見。
  // 實際＝該週各天的公里加總；某天沒填公里但有填分鐘、且當天課表有跑步項目，就用同一個
  // 分速換算（跟目標對稱，否則 Phase 1 以時間計的八週實際永遠是 —），並標 estimated。
  // 「本週已降量」（weekAdjustments）只有自己的才讀得到；reduced=true 時畫面不比對目標。
  // opts.planOnly=true：純課表加總（只扣過期日、不看任何人的 entries、不看任何人對調過的
  // 順序）——教練設目標時的上限與面板上的「課表加總」用這個；使用者自己看的目標才依
  // entries／自己的對調順序縮分母。
  weekTargetAuto(weekNumber, userId, opts) {
    const planOnly = !!(opts && opts.planOnly);
    const w = this.effectiveWeek(weekNumber);
    const pace = Number(PlanData.plan.timeBasedRunPaceMinPerKm) || 9;
    const uid = userId || this.activeUserId;
    const order = planOnly ? IDENTITY_ORDER : this.effectiveDayOrder(weekNumber, uid);
    let min = 0, max = 0, timeBased = false;
    const kmRange = (it) => {
      if (!isRunType(it.type)) return [0, 0];
      if (it.distanceKm) return [it.distanceKm.min, it.distanceKm.max];
      if (it.duration) { timeBased = true; return [it.duration.min / pace, it.duration.max / pace]; }
      return [0, 0];
    };
    for (let i = 0; i < 7; i++) {
      const d = w.days[order[i]];
      if (PlanData.isExpired(weekNumber, i)) continue;
      if (d.items.some((it) => it.type === 'race')) continue;
      if (!d.items.some((it) => isRunType(it.type))) continue;
      const e = planOnly ? null : this.entryFor(uid, PlanData.keyForWeekDay(weekNumber, i));
      if (e && e.status === 'rested') continue;
      // 改做：改做的是跑步且有記公里才照算，跟實際對得上；改騎車／核心，或沒記公里，
      // 這天就不算——不然畫面會出現一個她已經決定不跑的缺口。substituteType 沒填的舊紀錄
      // 維持原本的規則（有公里就算）。
      if (e && e.status === 'substituted' && (e.actualDistanceKm == null || (e.substituteType && e.substituteType !== 'run'))) continue;
      const ranges = d.items.map(kmRange);
      if (d.selectOne) {
        min += Math.min(...ranges.map((r) => r[0]));
        max += Math.max(...ranges.map((r) => r[1]));
      } else {
        ranges.forEach((r) => { min += r[0]; max += r[1]; });
      }
    }
    return { min: round1(min), max: round1(max), timeBased };
  },

  weekVolume(weekNumber, userId) {
    const w = this.effectiveWeek(weekNumber);
    const pace = Number(PlanData.plan.timeBasedRunPaceMinPerKm) || 9;
    const uid = userId || this.activeUserId;
    const order = this.effectiveDayOrder(weekNumber, uid);
    const auto = this.weekTargetAuto(weekNumber, uid);
    const ov = w.weeklyVolumeKm;
    // 教練目標是「上限」不是固定數字：讀取時再夾一次在（這個人的）自動加總以下——
    // 寫入時的守衛（app.js setWeeklyVolume）擋不到已存在的資料，也擋不到教練設完目標後
    // 又改課表項目、或使用者標了主動休息的情況。kind:'reference' 是 v3 的舊參考值，一律不算。
    const coachSet = !!(ov && ov.kind !== 'reference' && Number.isFinite(ov.min) && Number.isFinite(ov.max));
    const target = coachSet
      ? { min: round1(Math.min(ov.min, ov.max, auto.min)), max: round1(Math.min(Math.max(ov.min, ov.max), auto.max)), source: 'coach', timeBased: auto.timeBased }
      : { ...auto, source: 'auto' };
    let actual = null, estimated = false, race = null;
    for (let i = 0; i < 7; i++) {
      const d = w.days[order[i]];
      const e = this.entryFor(uid, PlanData.keyForWeekDay(weekNumber, i));
      // ⚠️ 先判 != null 再 Number()：Number(null) 是 0，會把「沒填」算成「跑了 0 公里」，
      // 讓整週實際顯示 0 而不是 —。
      const km = e && !e.deleted && e.actualDistanceKm != null ? Number(e.actualDistanceKm) : NaN;
      const minutes = e && !e.deleted && e.actualDurationMinutes != null ? Number(e.actualDurationMinutes) : NaN;
      if (d.items.some((it) => it.type === 'race')) {
        race = { planned: 42.195, actual: Number.isFinite(km) ? km : null };
        continue;
      }
      if (e && (e.status === 'rested' || e.status === 'missed')) continue;
      if (e && e.status === 'substituted' && e.substituteType && e.substituteType !== 'run') continue; // 改騎車的公里不是跑量
      if (Number.isFinite(km)) { actual = (actual || 0) + km; continue; }
      // 分鐘換公里只在「照表、且當天所有有時長的項目都是跑步」時做——一天一個分鐘欄，
      // 跑姿訓練＋節奏跑那種混合日換算會把跑姿的分鐘也當跑步；二擇一以選中的那個為準；
      // 改做的分鐘不知道是不是跑步，不換。
      const timed = d.selectOne
        ? d.items.filter((it) => e && e.selectedItemId === it.id)
        : d.items.filter((it) => it.duration);
      const allRun = timed.length > 0 && timed.every((it) => isRunType(it.type));
      if (Number.isFinite(minutes) && allRun && !(e && e.status)) {
        actual = (actual || 0) + minutes / pace;
        estimated = true;
      }
    }
    const adj = uid === this.activeUserId ? this.weekAdjustmentFor(weekNumber, uid) : null;
    return {
      target,
      actual: actual == null ? null : round1(actual),
      estimated,
      race,
      reduced: !!(adj && adj.reduced),
    };
  },
};
