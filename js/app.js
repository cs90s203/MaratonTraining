// 所有使用者互動的「動作」（window.A），呼叫 Store/Sync，然後觸發重繪。
// 跟 babylog 同一套：inline onclick="A.xxx()"，動作本身不碰 DOM，只改 state 再重繪。

const App = {
  state: {
    page: 'week',          // 決策紀錄第 17 條：沒有「今日」頁，本週頁預設展開今天那一列
    weekViewNumber: 1,
    viewingUserId: null,   // null = 預設看自己；總覽頁「查看別人」用，跟 Store.activeUserId（寫入身分）分開
    overviewPhaseId: null, // 決策紀錄第 22 條：總覽頁「階段目標」卡目前選看哪個階段；null = 目前所在階段
    expandedDay: null,     // {weekNumber,dayIndex}：本週頁手風琴目前展開的那一列；null = 全收
    editingItem: null,     // 教練模式：{weekNumber,dayIndex,itemId}，itemId==='new' 表示正在新增項目
    helpOpen: { vol: false, effort: false }, // 「？」說明的展開狀態
    modal: null,           // 'safety' | null
    privateNoteOpen: null, // 身體狀況的備註框被手動展開的那一天（dateKey）
  },

  // 本週頁的預設定位：今天那一週、今天那一列展開。開 App、按「本週」、或切回本週都走這裡。
  _focusToday() {
    const loc = PlanData.locateToday();
    this.state.weekViewNumber = loc.status === 'in-plan' ? loc.weekNumber
      : (loc.status === 'before-start' ? 1 : PlanData.plan.totalWeeks);
    this.state.expandedDay = loc.status === 'in-plan' ? { weekNumber: loc.weekNumber, dayIndex: loc.dayIndex } : null;
  },

  goTo(page) {
    if (page === 'today') page = 'week'; // 舊的入口一律導到本週頁
    this.state.page = page;
    if (page === 'week') this._focusToday();
    this.state.editingItem = null;
    this.state.modal = null;
    render();
  },

  // 手風琴：點已展開的列＝收起；點別列＝切換過去。
  openDay(weekNumber, dayIndex) {
    const e = this.state.expandedDay;
    const same = e && e.weekNumber === weekNumber && e.dayIndex === dayIndex;
    this.state.expandedDay = same ? null : { weekNumber, dayIndex };
    this.state.editingItem = null;
    render();
  },

  setWeekView(weekNumber) {
    this.state.weekViewNumber = weekNumber;
    // 切到今天那一週就展開今天；其他週全收，等使用者點。
    const loc = PlanData.locateToday();
    this.state.expandedDay = (loc.status === 'in-plan' && loc.weekNumber === weekNumber)
      ? { weekNumber, dayIndex: loc.dayIndex } : null;
    this.state.editingItem = null;
    render();
  },

  setEffort(weekNumber, dayIndex, n) {
    Store.setEffort(PlanData.keyForWeekDay(weekNumber, dayIndex), n);
    render();
  },

  setSubstituteType(weekNumber, dayIndex, type) {
    Store.setSubstituteType(PlanData.keyForWeekDay(weekNumber, dayIndex), type);
    render();
  },

  toggleHelp(key) {
    this.state.helpOpen[key] = !this.state.helpOpen[key];
    render();
  },

  openModal(name) { this.state.modal = name; render(); },
  closeModal() { this.state.modal = null; render(); },

  openPrivateNote(dateKey) { this.state.privateNoteOpen = dateKey; render(); },

  viewProgress(userId) {
    this.state.viewingUserId = userId;
    this.state.overviewPhaseId = null; // 換人看，階段選擇跟著退回「目前所在階段」
    render();
  },

  // ── 階段性目標（總覽頁；決策紀錄第 22 條）──────────────────────────────────
  setOverviewPhase(phaseId) {
    this.state.overviewPhaseId = phaseId;
    render();
  },

  // 六個欄位一次讀整份表單、一次存——跟教練模式的項目編輯表單同一種「整份讀、整份存」
  // 模式（見 _readItemForm 的註解）。配速用 parsePaceStr 接受 "6:30" 或純小數；
  // 其餘用純數字，min/max 打反了自動排正。空字串（兩邊都空）＝清掉這一項。
  savePhaseTargets(phaseId, targetUserId) {
    const root = document.getElementById('ptgt-form');
    if (!root) return;
    const val = (name) => { const el = root.querySelector(`[name="${name}"]`); return el ? el.value.trim() : ''; };
    const range = (parse, key) => {
      const a = parse(val(`${key}_min`)), b = parse(val(`${key}_max`));
      if (a == null && b == null) return null;
      const lo = a == null ? b : a, hi = b == null ? a : b;
      return { min: Math.min(lo, hi), max: Math.max(lo, hi) };
    };
    const numOrNull = (s) => { const n = Number(s); return s !== '' && Number.isFinite(n) ? n : null; };
    const fields = {};
    PHASE_TARGET_META.forEach((m) => {
      fields[m.key] = range(m.kind === 'pace' ? parsePaceStr : numOrNull, m.key);
    });
    Store.setPhaseTargetsForPhase(phaseId, fields, targetUserId);
    render();
  },

  toggleItem(weekNumber, dayIndex, itemId) {
    const dateKey = PlanData.keyForWeekDay(weekNumber, dayIndex);
    Store.toggleItemDone(dateKey, itemId);
    render();
  },

  selectChoice(weekNumber, dayIndex, itemId) {
    const dateKey = PlanData.keyForWeekDay(weekNumber, dayIndex);
    // 選了選項就直接算完成——選擇題的「選」跟「做完」在 UI 上是同一個點擊，
    // 避免多一次操作。Store.setSelectedItem 自己處理 done 的重建，
    // 不要在這裡另外呼叫 toggleItemDone（那會把選項間切換弄壞既有的完成紀錄）。
    Store.setSelectedItem(dateKey, itemId);
    render();
  },

  // 數字框是當天紀錄卡最上面、最常被填的欄位（決策紀錄第 23 條），填完緊接著就會點
  // 「完成」或體感強度——onchange 當下整頁重繪會把那一下點擊吞掉（blur → change → 重繪 →
  // click 落空）。所以先安靜存檔、稍後再重繪：點擊本身會觸發重繪，這個延遲只負責「沒有
  // 接著點任何東西」時把自動亮起的「完成」畫出來。
  setActualStats(weekNumber, dayIndex, field, value) {
    const dateKey = PlanData.keyForWeekDay(weekNumber, dayIndex);
    const num = value === '' ? null : Number(value);
    if (num != null && (!Number.isFinite(num) || num < 0)) return;
    Store.setActualStats(dateKey, field === 'duration' ? { durationMinutes: num } : { distanceKm: num }, true);
    setTimeout(render, 350);
  },

  setDayStatus(weekNumber, dayIndex, status) {
    const dateKey = PlanData.keyForWeekDay(weekNumber, dayIndex);
    Store.setDayStatus(dateKey, status);
    render();
  },

  setActualNote(dateKey, value) {
    Store.setActualNote(dateKey, value);
    // 不 render()：跟 setNote 同理，避免 textarea 失焦。
  },

  setWeekViewMode(mode) {
    Store.setWeekViewMode(mode);
    render();
  },

  // ── 訓練目標（profile/goals；決策紀錄第 15 條：教練模式下可以幫別人設）────────────
  // 每個 handler 都接受可選的 userId——views.js 的 renderGoalsCard 自己的表單也一律傳
  // 明確的 userId（等於 Store.activeUserId），不靠「不傳＝自己」的隱含預設，比較不容易
  // 在改動時漏掉。
  setRaceGoal(value, userId) { Store.setRaceGoal(value, userId); render(); },
  addGoal(userId) {
    const el = document.getElementById('goal-new');
    if (!el || !el.value.trim()) return;
    Store.addGoal(el.value, userId);
    render();
  },
  toggleGoal(id, userId) { Store.toggleGoalDone(id, userId); render(); },
  // 清空不等於刪除（Store.setGoalText 空字串時直接不寫）——要刪一條目標請按 ×，
  // 不要讓「打字打到一半、暫時清空重打」這個動作變成靜默刪除且沒有復原。
  setGoalText(id, value, userId) {
    Store.setGoalText(id, value, userId);
    // 不 render()：避免 input 失焦。
  },
  removeGoal(id, userId) { Store.removeGoal(id, userId); render(); },

  // ── 本週順序：拖曳換（決策紀錄第 14、18 條）────────────────────────────────
  // 每次整頁重繪後重新掛 SortableJS——render() 整個換掉 #root，舊的實例跟著舊 DOM 一起沒了。
  // SortableJS 沒載到（離線、CDN 被擋）時 views 不畫把手，這裡也不掛；「還原順序」照常。
  _sortable: null,
  afterRender() {
    if (this._sortable) { try { this._sortable.destroy(); } catch (e) { /* 舊 DOM 已被換掉 */ } this._sortable = null; }
    const list = document.querySelector('[data-daylist]');
    if (!list || typeof Sortable === 'undefined') return;
    const wn = Number(list.dataset.daylist);
    this._sortable = Sortable.create(list, {
      handle: '.drag-handle', draggable: '.weekday-acc', animation: 150,
      delay: 150, delayOnTouchOnly: true,        // 手指要按住一下才開始拖，不然跟捲動打架
      forceFallback: true, fallbackTolerance: 4, // 桌機／手機同一套行為，不靠瀏覽器原生 DnD
      onEnd: (evt) => {
        const from = evt.oldDraggableIndex, to = evt.newDraggableIndex;
        if (from === to) return;
        // 等 Sortable 自己收尾完再重繪——render() 整個換掉 #root，不能在它還握著節點時做。
        setTimeout(() => this.moveWeekDay(wn, from, to), 0);
      },
    });
  },
  moveWeekDay(weekNumber, from, to) {
    // 展開的那一列跟著內容走：被拖的就是它 → 落點；在拖動範圍內的 → 順移一格。
    const e = this.state.expandedDay;
    if (e && e.weekNumber === weekNumber) {
      let d = e.dayIndex;
      if (d === from) d = to;
      else if (from < d && d <= to) d -= 1;
      else if (to <= d && d < from) d += 1;
      this.state.expandedDay = { weekNumber, dayIndex: d };
    }
    Store.moveWeekDay(weekNumber, from, to);
    render();
  },
  resetDayOrder(weekNumber) { Store.resetDayOrder(weekNumber); render(); },

  // 同步膠囊「寫入被拒」：手機沒有 hover 看不到 title，點了直接把原因講出來。
  showSyncMessage() { alert(Sync.message || '寫入被拒。'); },

  toggleFlag(dateKey, flagKey) {
    const priv = Store.privateFor(dateKey);
    const cur = !!(priv && priv.flags && priv.flags[flagKey]);
    Store.setFlag(dateKey, flagKey, !cur);
    render();
  },

  setNote(dateKey, value) {
    Store.setNote(dateKey, value);
    // 不 render()：重繪會讓 textarea 失焦/游標跳動，值已經寫進 Store 了，畫面不需要立刻變。
  },

  markWeekReduced(weekNumber) {
    Store.setWeekReduced(weekNumber, true, 'flagged', '');
    render();
  },

  switchIdentity(userId) {
    if (userId === Store.activeUserId) return;
    Store.setActiveUser(userId);
    this.state.viewingUserId = null;
    render();
  },

  setTheme(t) {
    Store.setTheme(t);
    applyTheme();
    render();
  },

  signIn() { Sync.signIn(); },
  signOut() { Sync.signOut(); },
  // 「重試」在兩種情況下都會被點到：已登入但訂閱斷線（resubscribe 有意義），或
  // 登入本身沒有完成（見 firebase-sync.js 的登入逾時保險）——後者 resubscribe()
  // 一開頭就 `if (!isSignedIn()) return;` 直接不做事，要重跑一次真正的登入流程。
  retrySync() {
    if (Sync.isSignedIn()) { Sync.resubscribe(); render(); }
    else { Sync.signIn(); }
  },

  // ── 教練模式 ──────────────────────────────────────────────────────────────
  // 課表內容存在 Store.planOverrides（Firestore 的 planOverrides/{週次}，白名單內
  // 任何人都能寫）。每次編輯都是「讀整週目前有效的內容（出廠值或已有的覆寫）→
  // 深拷貝避免動到原物件 → 改一小塊 → 整週寫回」，不逐項目局部更新——這樣新增/
  // 刪除項目不需要處理陣列的部分寫入語意。

  toggleCoachMode() {
    Store.setCoachMode(!Store.coachMode);
    this.state.editingItem = null;
    render();
  },

  startEditItem(weekNumber, dayIndex, itemId) {
    this.state.editingItem = { weekNumber, dayIndex, itemId };
    render();
  },

  startAddItem(weekNumber, dayIndex) {
    this.state.editingItem = { weekNumber, dayIndex, itemId: 'new' };
    render();
  },

  cancelEditItem() {
    this.state.editingItem = null;
    render();
  },

  _cloneEffectiveWeek(weekNumber) {
    const current = Store.effectiveWeek(weekNumber);
    const clone = JSON.parse(JSON.stringify(current));
    // 記住這次編輯是從哪個版本開始改的（出廠值沒有 updatedAt，null 也是有效的
    // 起點）。firebase-sync.js 存檔前會拿這個跟雲端最新版本比對，偵測「別人剛好
    // 也在改這週」的衝突——三個白名單成員共用同一份課表，這是真的會發生的情境。
    clone.__baseUpdatedAt = current.updatedAt || null;
    return clone;
  },

  // 讀 #item-edit-... 表單容器裡的欄位值，組成一個 item 物件。用 scoped querySelector
  // 而不是把 12 個欄位塞進 onclick 參數——那樣任何欄位含引號/特殊字元都會拼壞整串
  // inline JS（jsq() 只解決得了單一個字串參數，解決不了一次塞 12 個）。
  _readItemForm(formId) {
    const root = document.getElementById(formId);
    if (!root) return null;
    const val = (name) => { const el = root.querySelector(`[name="${name}"]`); return el ? el.value.trim() : ''; };
    const range = (minName, maxName) => {
      const min = val(minName), max = val(maxName);
      if (min === '' && max === '') return null;
      const a = min === '' ? Number(max) : Number(min);
      const b = max === '' ? Number(min) : Number(max);
      if (Number.isNaN(a) || Number.isNaN(b)) return null;
      return { min: Math.min(a, b), max: Math.max(a, b) };
    };
    return {
      type: val('type'),
      title: val('title'),
      duration: range('durationMin', 'durationMax'),
      distanceKm: range('distanceMin', 'distanceMax'),
      heartRateZone: val('heartRateZone') || null,
      rpe: range('rpeMin', 'rpeMax'),
      intensityNote: val('intensityNote') || null,
      videoRef: val('videoRef') || null,
      workoutRef: val('workoutRef') || null,
      notes: val('notes') || null,
      // 決策紀錄第 19 條：這兩個是轉檔留下的「沒人確認過」標記，不是教練填的欄位。
      // 教練存過就是確認過——一律清掉，「推導值」「（內插）」標籤跟著消失。
      intensityDerived: false,
      derived: false,
    };
  },

  // 存檔前的健全性檢查——這是一份「寧可保守也不要硬撐」的產後恢復課表，教練模式
  // 開了一條跟出廠資料（有 tools/verify_plan.py 一路守著）完全平行、沒人守的
  // 寫入路徑：HTML input 的 min/max 只是視覺提示，不會真的擋住送出的值。手滑打錯
  // 一個負號或多打幾個 9，就會讓所有人看到「RPE 2-9999」，且不會有任何錯誤訊息。
  _validateItemFields(fields) {
    if (!fields.title) return '標題不能空白';
    // 舊覆寫文件裡的 walk-run（v3 類型）會以「走跑交替（舊類型，請改選）」出現在下拉裡，
    // 存檔時一律擋下要求改選——不能靜默存回去，也不能讓瀏覽器預設成第一個選項。
    if (!VALID_TYPES.includes(fields.type)) return `類型「${TYPE_LABELS[fields.type] || fields.type}」已停用，請改選一個類型（走跑請選「跑步」）`;
    const r = fields.duration;
    if (r && (r.min < 0 || r.max > 300)) return '時長要在 0-300 分鐘之間';
    const k = fields.distanceKm;
    if (k && (k.min < 0 || k.max > 100)) return '距離要在 0-100 公里之間';
    const p = fields.rpe;
    if (p && (p.min < 0 || p.max > 10)) return 'RPE 要在 0-10 之間';
    return null;
  },

  saveItemEdit(weekNumber, dayIndex, itemIdOrNew) {
    const isNew = itemIdOrNew === 'new';
    const formId = `item-edit-${weekNumber}-${dayIndex}-${itemIdOrNew}`;
    const fields = this._readItemForm(formId);
    if (!fields) return;
    const err = this._validateItemFields(fields);
    if (err) { alert(err); return; }

    const week = this._cloneEffectiveWeek(weekNumber);
    const day = week.days[dayIndex];
    if (isNew) {
      fields.id = newItemId();
      day.items.push(fields);
    } else {
      const idx = day.items.findIndex((it) => it.id === itemIdOrNew);
      if (idx === -1) return;
      fields.id = itemIdOrNew; // id 永遠不變，這是教練模式安全性的核心
      day.items[idx] = fields;
    }
    // 二擇一是一組：兩個選項並排在同一天，教練存了其中一個就是整組看過了——一起
    // 清掉 derived，不然「推導值」標籤只剩在另一個選項上，兩個對等的選擇顯示不對等
    // （tools/verify_plan.py B4 對出廠資料守的就是這件事）。intensityDerived 是逐項的
    // 心率來源標記，不跟著清。
    if (day.selectOne) day.items.forEach((it) => { it.derived = false; });
    Store.saveWeekOverride(weekNumber, week);
    this.state.editingItem = null;
    render();
  },

  deleteItem(weekNumber, dayIndex, itemId) {
    const week = this._cloneEffectiveWeek(weekNumber);
    const day = week.days[dayIndex];
    if (day.items.length <= 1) { alert('這天至少要留一個項目——原規格書的教訓：一天空白會讓畫面壞掉。'); return; }

    const target = day.items.find((it) => it.id === itemId);
    if (day.selectOne) {
      // tools/verify_plan.py 的 B4 檢查「selectOne 的日子至少兩個選項」，但那條規則
      // 只管出廠課表，教練模式完全繞過它——刪到剩 1 個會讓「二擇一」這個語意失真。
      if (day.items.length <= 2) { alert('這天是「二擇一」，至少要留兩個選項。'); return; }
      // 決策紀錄第 0 條：「休息或受傷的調整，不應該變相增加強度」。刪掉二擇一裡
      // 唯一的休息選項，等於把「可以完全休息」變成「一定要做點什麼」——負荷確定
      // 比原本高，這正是第 0 條明講禁止的事，不是一般的內容編輯，直接擋下。
      const restCount = day.items.filter((it) => it.type === 'rest').length;
      if (target && target.type === 'rest' && restCount <= 1) {
        alert('不能刪除這天唯一的休息選項——決策紀錄第 0 條：調整不能變相增加強度。');
        return;
      }
    }

    if (!confirm('確定刪除這個項目？已經打過勾的舊紀錄會保留在資料裡，但畫面上不會再顯示。')) return;
    day.items = day.items.filter((it) => it.id !== itemId);
    Store.saveWeekOverride(weekNumber, week);
    render();
  },

  moveItem(weekNumber, dayIndex, itemId, direction) {
    const week = this._cloneEffectiveWeek(weekNumber);
    const day = week.days[dayIndex];
    const idx = day.items.findIndex((it) => it.id === itemId);
    const swapWith = idx + direction;
    if (idx === -1 || swapWith < 0 || swapWith >= day.items.length) return;
    const tmp = day.items[idx];
    day.items[idx] = day.items[swapWith];
    day.items[swapWith] = tmp;
    Store.saveWeekOverride(weekNumber, week);
    render();
  },

  toggleDaySelectOne(weekNumber, dayIndex) {
    const week = this._cloneEffectiveWeek(weekNumber);
    const day = week.days[dayIndex];
    if (!day.selectOne && day.items.length < 2) {
      alert('「二擇一」至少要有兩個選項，請先新增一個項目再切換。');
      return;
    }
    day.selectOne = !day.selectOne;
    Store.saveWeekOverride(weekNumber, week);
    render();
  },

  setDayNotes(weekNumber, dayIndex, value) {
    const week = this._cloneEffectiveWeek(weekNumber);
    week.days[dayIndex].dayNotes = value || null;
    Store.saveWeekOverride(weekNumber, week, true); // silent：避免 textarea 失焦時吃掉下一次點擊
  },

  setLongRunMetric(weekNumber, value) {
    const week = this._cloneEffectiveWeek(weekNumber);
    week.longRunMetric = value || null;
    Store.saveWeekOverride(weekNumber, week);
    render();
  },

  // 週跑量目標的教練覆寫（決策紀錄第 13 條）。預設沒有這個欄位——目標由
  // Store.weekVolume 從課表跑步項目即時加總；教練設了才存 {min,max}。兩個都留空
  // 等於「改回自動加總」，跟 clearWeeklyVolume 同義。
  setWeeklyVolume(weekNumber, minVal, maxVal) {
    if (minVal === '' && maxVal === '') { this.clearWeeklyVolume(weekNumber); return; }
    const a = minVal === '' ? Number(maxVal) : Number(minVal);
    const b = maxVal === '' ? Number(minVal) : Number(maxVal);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b > 100) { alert('週跑量要在 0-100 公里之間'); return; }
    // 決策紀錄第 0 條：手動目標只能把數字往下調。比課表加總高的目標＝用一個數字催人
    // 多跑，卻沒有任何一天的課表項目支撐它——要加量請改項目，那才看得見、也才會被審。
    // planOnly=true：純課表加總，不看操作者自己的 entries——否則教練當週若標了自主休息
    // 或更換項目，這條擋線會用「他自己剩下要跑的量」當上限，同樣的目標在別人的裝置上卻合法，
    // 而且錯誤訊息會講出一個不是課表真實加總的數字（審查抓到：W3 標休息後上限從 9.4 縮到
    // 6.7，換成沒有紀錄的 Annlin 身分同一個數字卻直接放行）。
    const auto = Store.weekTargetAuto(weekNumber, Store.activeUserId, { planOnly: true });
    if (Math.max(a, b) > auto.max + 0.05) {
      alert(`目標上限不能高於課表加總（${auto.max} K）。要加量請直接改課表項目，不要只改數字。`);
      return;
    }
    const week = this._cloneEffectiveWeek(weekNumber);
    week.weeklyVolumeKm = { min: Math.min(a, b), max: Math.max(a, b) };
    delete week.weeklyVolumeNullReason; // 舊版欄位（第 8 條時代），不再有意義
    Store.saveWeekOverride(weekNumber, week);
    render();
  },

  clearWeeklyVolume(weekNumber) {
    const week = this._cloneEffectiveWeek(weekNumber);
    delete week.weeklyVolumeKm;
    delete week.weeklyVolumeNullReason;
    Store.saveWeekOverride(weekNumber, week);
    render();
  },

  resetWeekOverride(weekNumber) {
    if (!confirm('確定要把這週還原成出廠預設值嗎？你在這週做的所有調整都會消失（其他週不受影響）。')) return;
    Store.resetWeekOverride(weekNumber);
    render();
  },
};
const A = App; // 給 inline onclick="A.xxx()" 用的短名
