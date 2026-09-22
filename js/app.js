// 所有使用者互動的「動作」（window.A），呼叫 Store/Sync，然後觸發重繪。
// 跟 babylog 同一套：inline onclick="A.xxx()"，動作本身不碰 DOM，只改 state 再重繪。

const App = {
  state: {
    page: 'week',          // 決策紀錄第 17 條：沒有「今日」頁，本週頁預設展開今天那一列
    weekViewNumber: 1,
    viewingUserId: null,   // null = 預設看自己；總覽頁「查看別人」、本週頁的名字選單用，跟 Store.activeUserId（寫入身分）分開。
                           // 第 56 條：教練模式下這就是「正在排誰的課表」（能不能改看 Store.canEditPlanOf）
    overviewPhaseId: null, // 決策紀錄第 22 條：總覽頁「階段目標」卡目前選看哪個階段；null = 目前所在階段
    expandedDay: null,     // {weekNumber,dayIndex}：本週頁手風琴目前展開的那一列；null = 全收
    itemPicker: null,      // 決策紀錄第 45 條：教練模式打開的項目庫清單 {weekNumber,dayIndex,itemId|'add'}
    savedFlash: null,      // 剛按「存成常用」的課表項目 id：那張卡寫「已存進項目庫」
    amountEdit: null,      // 決策紀錄第 46 條：點兩下正在改時間的課表項目 {weekNumber,dayIndex,itemId}
    noteEdit: null,        // 決策紀錄第 54 條：正在寫教練備註的課表項目 {weekNumber,dayIndex,itemId}
    libFlash: '',          // 決策紀錄第 52 條：改常用項目之後「已套用到 N 天」的一次性訊息
    viewMenuOpen: false,   // 決策紀錄第 53 條：本週訓練目標前面的名字點開的「要看誰」選單
    helpOpen: { vol: false, effort: false }, // 「？」說明的展開狀態
    modal: null,           // 'safety' | null
    privateNoteOpen: null, // 身體狀況的備註框被手動展開的那一天（dateKey）
    libraryEdit: null,     // 常用項目庫正在編輯的東西（決策紀錄第 26 條）：{kind, id|'new', draft}
    openDetails: {},       // 決策紀錄第 29 條：「查看動作」這類 <details> 目前打開的 key。render() 整個換掉 #root，
                           // 開關狀態只放在 DOM 上的話，任何一次重繪（同步快照、別人改課表）都會把它收起來
  },

  // <details> 的 ontoggle：只記下來、不重繪（使用者自己點開的，畫面已經是對的）。
  // render() 產生帶 open 屬性的 <details> 時也會觸發一次 toggle，值一樣，寫回去沒有副作用。
  setDetailsOpen(key, open) {
    if (open) this.state.openDetails[key] = true;
    else delete this.state.openDetails[key];
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
    this.state.libFlash = '';
    if (page === 'week') this._focusToday();
    this.state.itemPicker = null;
    this.state.amountEdit = null;
    this.state.noteEdit = null;
    this.state.libraryEdit = null;
    this.state.modal = null;
    render();
  },

  // 手風琴：點已展開的列＝收起；點別列＝切換過去。
  openDay(weekNumber, dayIndex) {
    const e = this.state.expandedDay;
    const same = e && e.weekNumber === weekNumber && e.dayIndex === dayIndex;
    this.state.expandedDay = same ? null : { weekNumber, dayIndex };
    this.state.itemPicker = null;
    this.state.amountEdit = null;
    this.state.noteEdit = null;
    this.state.libraryEdit = null; // 第 33 條：從卡片打開的清單編輯器不能跟著跑到別天
    render();
  },

  setWeekView(weekNumber) {
    this.state.weekViewNumber = weekNumber;
    // 切到今天那一週就展開今天；其他週全收，等使用者點。
    const loc = PlanData.locateToday();
    this.state.expandedDay = (loc.status === 'in-plan' && loc.weekNumber === weekNumber)
      ? { weekNumber, dayIndex: loc.dayIndex } : null;
    this.state.itemPicker = null;
    this.state.amountEdit = null;
    this.state.noteEdit = null;
    this.state.libraryEdit = null;
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

  // 決策紀錄第 53 條：看某個人每天的紀錄（唯讀）。null＝回到自己。fromOverview：從總覽過來，跳到本週頁今天那一列。
  viewWeekOf(userId, fromOverview) {
    this.state.viewingUserId = userId && userId !== Store.activeUserId ? userId : null;
    this.state.viewMenuOpen = false;
    this.state.itemPicker = null;
    this.state.amountEdit = null;
    this.state.noteEdit = null;
    this.state.libraryEdit = null;
    if (fromOverview) { this.goTo('week'); return; }
    render();
  },
  toggleViewMenu() {
    this.state.viewMenuOpen = !this.state.viewMenuOpen;
    render();
  },

  // 決策紀錄第 56 條：本週頁現在是誰的課表（每個人一份）。教練模式開著、而且 Store.canEditPlanOf 這個人，就是在排她的課表。
  planUserId() {
    const v = this.state.viewingUserId;
    return v && v !== Store.activeUserId && PlanData.userById[v] ? v : Store.activeUserId;
  },
  _canEditPlan() { return Store.coachMode && Store.canEditPlanOf(this.planUserId()); },

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
    if (!root || !Store.canEditGoalsOf(targetUserId || Store.activeUserId)) return;
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
    this.state.libraryEdit = null;
    render();
  },

  // ── 訓練目標（profile/goals；決策紀錄第 15、56 條：別人的只有教練能幫忙設）────────────
  // 每個 handler 都接受可選的 userId——views.js 的 renderGoalsCard 自己的表單也一律傳
  // 明確的 userId（等於 Store.activeUserId），不靠「不傳＝自己」的隱含預設，比較不容易
  // 在改動時漏掉。能不能寫由 Store 擋（canEditGoalsOf），畫面上沒有權限的本來就不給輸入框。
  setRaceGoal(value, userId) { Store.setRaceGoal(value, userId); render(); },
  addGoal(userId) {
    const el = document.getElementById('goal-new');
    if (!el || !el.value.trim() || !Store.canEditGoalsOf(userId || Store.activeUserId)) return;
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
    Store.markPlanSeen();
    if (this._focusNote) {
      const ta = [...document.querySelectorAll('.coach-note-edit')].find((x) => x.dataset.noteItem === this._focusNote);
      this._focusNote = null;
      if (ta) { ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) { /* 舊瀏覽器 */ } }
    }
    if (this._focusAmount) {
      const g = [...document.querySelectorAll('.amt-group')].find((x) => x.dataset.amtItem === this._focusAmount);
      this._focusAmount = null;
      const input = g && g.querySelector('input');
      if (input) { input.focus(); try { input.select(); } catch (e) { /* number input 有些瀏覽器不給 select */ } }
    }
    const le = this.state.libraryEdit;
    if (le && le.scrollOnce) {
      le.scrollOnce = false;
      const el = document.getElementById('tpl-edit-new') || document.querySelector('.lib-card .coach-editing');
      if (el) el.scrollIntoView({ block: 'start' });
    }
    if (this._sortable) { try { this._sortable.destroy(); } catch (e) { /* 舊 DOM 已被換掉 */ } this._sortable = null; }
    const list = document.querySelector('[data-daylist]');
    if (!list || typeof Sortable === 'undefined') return;
    const wn = Number(list.dataset.daylist);
    this._sortable = Sortable.create(list, {
      handle: '.drag-handle', draggable: '.weekday-acc', animation: 150,
      delay: 150, delayOnTouchOnly: true,        // 手指要按住一下才開始拖，不然跟捲動打架
      forceFallback: true, fallbackTolerance: 4, // 桌機／手機同一套行為，不靠瀏覽器原生 DnD
      // 教練模式（第 50 條）：兩天對調，不是插入——拖曳中列不移動（onMove 回 false），落點那一列亮起來；
      // 放開時以手指／滑鼠底下那一列為準（SortableJS 的 Swap 外掛不在 cdnjs 這個 build 裡，自己做）。
      onMove: (evt) => {
        if (list.dataset.coach !== '1') return true;
        list.querySelectorAll('.swap-target').forEach((x) => x.classList.remove('swap-target'));
        if (evt.related && !evt.related.classList.contains('locked') && evt.related !== evt.dragged) evt.related.classList.add('swap-target');
        return false;
      },
      onEnd: (evt) => {
        const coach = list.dataset.coach === '1';
        // 等 Sortable 自己收尾完再重繪——render() 整個換掉 #root，不能在它還握著節點時做。
        if (coach) {
          list.querySelectorAll('.swap-target').forEach((x) => x.classList.remove('swap-target'));
          const oe = evt.originalEvent;
          const pt = oe && (oe.changedTouches ? oe.changedTouches[0] : oe);
          const under = pt && Number.isFinite(pt.clientX) ? document.elementFromPoint(pt.clientX, pt.clientY) : null;
          const row = under && under.closest('.weekday-acc');
          const rows = [...list.querySelectorAll('.weekday-acc')];
          const from = rows.indexOf(evt.item), to = row && list.contains(row) ? rows.indexOf(row) : -1;
          if (from < 0 || to < 0 || from === to) return;
          setTimeout(() => this.swapPlanWeekDays(wn, from, to), 0);
          return;
        }
        const from = evt.oldDraggableIndex, to = evt.newDraggableIndex;
        if (from === to) return;
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

  // 教練模式拖曳（決策紀錄第 50 條）：正在排的那個人（第 56 條）的兩天課表對調。項目 id 跟著內容走，日期是格子的。
  // 今天以前的日子不能動（畫面上沒有把手、也不能當落點，這裡再擋一次）。牽涉到今天時先確認：今天已經練過的話，
  // 勾會留在今天、換走的課會在另一天顯示成沒做——那堂課不要再做一次（第 0 條）。
  swapPlanWeekDays(weekNumber, a, b) {
    a = Number(a); b = Number(b);
    if (!(a >= 0 && a <= 6 && b >= 0 && b <= 6) || a === b) return;
    if (!this._canEditPlan()) { render(); return; }
    const uid = this.planUserId();
    const today = PlanData.dayKey(PlanData.today());
    const ka = PlanData.keyForWeekDay(weekNumber, a), kb = PlanData.keyForWeekDay(weekNumber, b);
    if (ka < today || kb < today) { alert('今天以前的日子不能換。'); render(); return; }
    const week = this._cloneEffectiveWeek(weekNumber, uid);
    const days = week.days.slice();
    const la = PlanData.weekdayLabel(a), lb = PlanData.weekdayLabel(b);
    if ((ka === today || kb === today) && !confirm(`把週${la}跟週${lb}的課表對調？\n今天已經練過的話，打的勾會留在今天，換走的那堂課會在另一天顯示成還沒做——不要再做一次。`)) { render(); return; }
    [days[a], days[b]] = [days[b], days[a]];
    week.days = days.map((d, i) => ({ ...d, dayIndex: i }));
    week.layoutAt = new Date().toISOString(); // 天數換過了：別台還停在舊排列的畫面不能再照位置存（store.js savePlanWeek）
    const e = this.state.expandedDay;
    if (e && e.weekNumber === weekNumber && (e.dayIndex === a || e.dayIndex === b)) {
      this.state.expandedDay = { weekNumber, dayIndex: e.dayIndex === a ? b : a }; // 展開的那一天跟著內容走
    }
    this.state.itemPicker = null;
    this.state.amountEdit = null;
    this.state.noteEdit = null;
    this.state.libraryEdit = null;
    Store.savePlanWeek(uid, weekNumber, week);
    render();
  },

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
    // 決策紀錄第 51 條：登入之後「我是誰」就是登入的帳號（第 41 條自動判斷出來的）。切成別人只會讓每一筆寫入被
    // Firebase 拒絕（規則只准本人寫自己的紀錄），切回來之前還會卡在「寫入被拒」。要看別人，用總覽的「查看別人的進度」。
    const me = Sync.isSignedIn() ? Sync.detectedUserId : null;
    if (me && userId !== me) {
      const u = PlanData.userById[me];
      alert(`登入的帳號是「${u ? u.displayName : me}」，只能記自己的紀錄。要看別人的進度，到「總覽 → 查看別人的進度」。`);
      return;
    }
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
  // 決策紀錄第 56 條：每個人一份課表（Store.planWeeks，Firestore 的 users/{userId}/planWeeks/{週次}）。
  // 教練（Mick）排三個人的，其他人只能改自己的——改的是 planUserId() 那個人的。每次編輯都是
  // 「讀她那週目前有效的內容 → 深拷貝避免動到原物件 → 改一小塊 → 整週寫回」，不逐項目局部更新——
  // 這樣新增/刪除項目不需要處理陣列的部分寫入語意。

  toggleCoachMode() {
    Store.setCoachMode(!Store.coachMode);
    this.state.itemPicker = null;
    this.state.amountEdit = null;
    this.state.noteEdit = null;
    this.state.libraryEdit = null;
    render();
  },

  // ── 課表上的項目（決策紀錄第 45 條）─────────────────────────────────────────
  // 沒有編輯表單：名稱是項目庫的選單（換成別的常用項目）、時間那格直接改、存成常用、上下移、刪除。
  // 項目的內容（類型、心率、段落、影片、動作、備註）只在常用項目庫定義。
  // 決策紀錄第 59 條：過去的日子跟其他日子一樣可以改（以前這裡會擋，「今天以前的日子不能改」）。

  // 點兩下（第 46 條）：課表的時間、「第 X 週」切換教練模式都要點兩下，避免誤觸。
  // 自己判斷（400ms 內點同一個東西），不靠 dblclick——iOS Safari 對不是連結的元素不一定送 dblclick。
  // 第一下什麼都不做、不重畫。
  _lastTap: null,
  _isDoubleTap(key) {
    const now = Date.now();
    const last = this._lastTap;
    if (last && last.key === key && now - last.t < 400) { this._lastTap = null; return true; }
    this._lastTap = { key, t: now };
    return false;
  },
  weekTitleTap() {
    if (this._isDoubleTap('week-title')) this.toggleCoachMode();
  },
  amountTap(weekNumber, dayIndex, itemId) {
    if (!this._isDoubleTap(`amt:${weekNumber}-${dayIndex}-${itemId}`)) return;
    this.state.amountEdit = { weekNumber, dayIndex, itemId };
    this.state.itemPicker = null;
    this.state.noteEdit = null;
    this._focusAmount = itemId;
    render();
  },
  // 焦點離開整組時間輸入框（不是跳到同一組的另一格）：改完了，收回文字。存檔是各格的 onchange 做的。
  amountFocusOut(ev, group) {
    const next = ev && ev.relatedTarget;
    if (next && group && group.contains(next)) return;
    this.state.amountEdit = null;
    this.state.noteEdit = null;
    setTimeout(() => render(), 0);
  },

  // 教練備註（第 54 條）：這天這個項目的一句話。按「＋ 備註」在卡片裡打，離開輸入框就存；清空＝拿掉。
  startItemNote(weekNumber, dayIndex, itemId) {
    this.state.itemPicker = null;
    this.state.amountEdit = null;
    this.state.noteEdit = { weekNumber, dayIndex, itemId };
    this._focusNote = itemId;
    render();
  },
  saveItemNote(weekNumber, dayIndex, itemId, el) {
    this.state.noteEdit = null;
    const uid = this.planUserId();
    const text = String((el && el.value) || '').trim().slice(0, 200);
    const cur = Store.effectiveWeek(weekNumber, uid).days[dayIndex].items.find((x) => x.id === itemId);
    if (!this._canEditPlan() || !cur || (cur.coachNote || '') === text) { setTimeout(() => render(), 0); return; }
    const week = this._cloneEffectiveWeek(weekNumber, uid);
    const it = week.days[dayIndex].items.find((x) => x.id === itemId);
    if (!it) { setTimeout(() => render(), 0); return; }
    if (text) it.coachNote = text; else delete it.coachNote;
    Store.savePlanWeek(uid, weekNumber, week, { silent: true });
    setTimeout(() => render(), 0);
  },

  toggleItemPicker(weekNumber, dayIndex, itemId) {
    const p = this.state.itemPicker;
    const same = p && p.weekNumber === weekNumber && p.dayIndex === dayIndex && p.itemId === itemId;
    this.state.itemPicker = same ? null : { weekNumber, dayIndex, itemId };
    this.state.savedFlash = null;
    render();
  },

  // 從常用項目庫帶進課表的內容：深拷貝，拿掉「推導值」標記（教練挑的就是確認過的，第 19 條）
  _itemFromTemplate(tpl, id) {
    // templateId：記住從哪個常用項目來的，之後改常用項目才對得到（第 52 條）
    return { ...JSON.parse(JSON.stringify(tpl.item)), id, templateId: tpl.id, derived: false, intensityDerived: false };
  },

  // 決策紀錄第 52 條：改了常用項目，今天以後（含今天）用到它的課表項目跟著改，今天以前的日子不動。
  // 第 56 條：三個人的課表都套（常用項目庫只有教練能改，教練能寫三個人的課表）。
  // 只套「這次改了的欄位」——同名的出廠項目各週的備註、時間本來就不一樣，整份蓋過去會洗掉。
  // 影片：這次拿掉的從項目拿掉；常用項目有、項目還沒有的加上（之前存過、當時沒套上的修改，再按一次儲存就會補上）。
  // 時間／距離：項目的數字還是舊的常用項目那個數字才跟著改（某天單獨改過的時間不動）。
  // 套過的項目記下 templateId，之後改名也對得到。回傳改到幾天（同一天好幾個人都改到只算一天）。
  _applyTemplateToPlan(templateId, oldItem, newItem) {
    const norm = (it) => { const c = it && Store._cleanLibraryFields('item', { name: '', item: it }); return c ? c.item : null; };
    const o = norm(oldItem), n = norm(newItem);
    if (!o || !n) return 0;
    const J = (x) => JSON.stringify(x == null ? null : x);
    const copy = (x) => (x == null ? null : JSON.parse(JSON.stringify(x)));
    const changed = ['type', 'title', 'heartRateZone', 'rpe', 'intensityNote', 'notes', 'workoutRef', 'segments'].filter((k) => J(o[k]) !== J(n[k]));
    const amountChanged = ['duration', 'distanceKm'].filter((k) => J(o[k]) !== J(n[k]));
    const oldRefs = PlanData.itemVideoRefs(o), newRefs = PlanData.itemVideoRefs(n);
    const removed = oldRefs.filter((r) => !newRefs.includes(r));
    const today = PlanData.dayKey(PlanData.today());
    const touched = new Set();
    PlanData.users.forEach((u) => {
      const uid = u.userId;
      for (let wn = 1; wn <= PlanData.plan.totalWeeks; wn++) {
        if (PlanData.keyForWeekDay(wn, 6) < today) continue;
        if (!Store.effectiveWeek(wn, uid).days.some((d, di) => PlanData.keyForWeekDay(wn, di) >= today && d.items.some((it) => Store.usesTemplate(it, templateId, o)))) continue;
        const week = this._cloneEffectiveWeek(wn, uid);
        const changedDays = [];
        week.days.forEach((d, di) => {
          if (PlanData.keyForWeekDay(wn, di) < today) return;
          let dayChanged = false;
          d.items.forEach((it) => {
            if (!Store.usesTemplate(it, templateId, o)) return;
            const before = J(it);
            changed.forEach((k) => { it[k] = copy(n[k]); });
            amountChanged.forEach((k) => { if (J(it[k]) === J(o[k])) it[k] = copy(n[k]); });
            const refs = PlanData.itemVideoRefs(it).filter((r) => !removed.includes(r));
            newRefs.forEach((r) => { if (!refs.includes(r)) refs.push(r); });
            const capped = refs.slice(0, PlanData.MAX_ITEM_VIDEOS);
            it.videoRefs = capped;
            it.videoRef = capped[0] || null;
            it.templateId = templateId;
            if (changed.length) it.derived = false;
            if (J(it) !== before) dayChanged = true;
          });
          if (dayChanged) changedDays.push(di);
        });
        // 照項目 id 找、不是照位置改，不用檢查畫面有沒有被搬過天（batch）
        if (changedDays.length && Store.savePlanWeek(uid, wn, week, { silent: true, batch: true })) {
          changedDays.forEach((di) => touched.add(`${wn}-${di}`));
        }
      }
    });
    return touched.size;
  },

  // 換成別的常用項目：id 不變（打勾紀錄照 id 對，換掉不會讓做過的課又變成沒做）
  swapItemFromLibrary(weekNumber, dayIndex, itemId, templateId) {
    if (!this._canEditPlan()) return;
    const uid = this.planUserId();
    const tpl = Store.libraryList('item').find((t) => t.id === templateId);
    if (!tpl) { alert('找不到這個常用項目，可能剛被刪掉了。'); render(); return; }
    const week = this._cloneEffectiveWeek(weekNumber, uid);
    const day = week.days[dayIndex];
    const idx = day.items.findIndex((it) => it.id === itemId);
    if (idx === -1) { this.state.itemPicker = null; render(); return; }
    const keepNote = day.items[idx].coachNote; // 教練備註是給這一天的，換項目也留著（第 54 條）
    day.items[idx] = this._itemFromTemplate(tpl, itemId);
    if (keepNote) day.items[idx].coachNote = keepNote;
    // 二擇一是一組：教練動了其中一個就是整組看過了，一起清掉 derived（verify_plan.py B4 守的就是兩個選項對等）
    if (day.selectOne) day.items.forEach((it) => { it.derived = false; });
    this.state.itemPicker = null;
    this.state.amountEdit = null;
    this.state.noteEdit = null;
    this.state.savedFlash = null;
    Store.savePlanWeek(uid, weekNumber, week);
    render();
  },

  addItemFromLibrary(weekNumber, dayIndex, templateId) {
    if (!this._canEditPlan()) return;
    const uid = this.planUserId();
    const tpl = Store.libraryList('item').find((t) => t.id === templateId);
    if (!tpl) { alert('找不到這個常用項目，可能剛被刪掉了。'); render(); return; }
    const week = this._cloneEffectiveWeek(weekNumber, uid);
    const day = week.days[dayIndex];
    day.items.push(this._itemFromTemplate(tpl, newItemId()));
    if (day.selectOne) day.items.forEach((it) => { it.derived = false; });
    this.state.itemPicker = null;
    this.state.amountEdit = null;
    this.state.noteEdit = null;
    this.state.savedFlash = null;
    Store.savePlanWeek(uid, weekNumber, week);
    render();
  },

  // 時間（長跑是公里）那格改了：el 是改的那個輸入框，同一組兩格一起讀。兩格都空＝沒有這個數字。
  setItemAmount(weekNumber, dayIndex, itemId, el) {
    if (!this._canEditPlan()) return;
    const uid = this.planUserId();
    const box = el && el.closest('.amt-edit');
    if (!box) return;
    const key = box.dataset.amt === 'distanceKm' ? 'distanceKm' : 'duration';
    const inputs = [...box.querySelectorAll('input')];
    const [a, b] = inputs.map((x) => x.value.trim());
    let range = null;
    if (a !== '' || b !== '') {
      let lo = Number(a === '' ? b : a), hi = Number(b === '' ? a : b);
      const cap = key === 'duration' ? 300 : 100;
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || Math.min(lo, hi) < 0 || Math.max(lo, hi) > cap) {
        alert(key === 'duration' ? '時間要在 0 到 300 分之間。' : '距離要在 0 到 100 公里之間。');
        render();
        return;
      }
      // 下限改得比上限大：上限跟著改（不是兩個對調）——「20–25」把下限改成 30，接著要改上限成 40，
      // 對調會先存成 25–30，畫面上的下限變 25，最後變成 25–40。上限改得比下限小時同理，下限跟著改。
      if (lo > hi) { if (inputs.indexOf(el) === 1) lo = hi; else hi = lo; }
      range = { min: lo, max: hi };
    }
    // 點兩下正在改（第 46 條）：存檔不重畫——瀏覽器實測按 Tab 從下限跳到上限時，change 當下的重畫會把整組輸入框換掉，
    // 游標到不了上限那格。改完離開整組時（amountFocusOut）才重畫一次。
    const ae = this.state.amountEdit;
    const editing = !!(ae && ae.weekNumber === weekNumber && ae.dayIndex === dayIndex && ae.itemId === itemId);
    const week = this._cloneEffectiveWeek(weekNumber, uid);
    const it = week.days[dayIndex].items.find((x) => x.id === itemId);
    if (!it) { render(); return; }
    if (JSON.stringify(it[key] || null) === JSON.stringify(range)) { if (!editing) render(); return; } // 沒變（例如 30–30 寫成 30）
    it[key] = range;
    it.derived = false; // 教練動過數字就是確認過（第 19 條）
    this.state.savedFlash = null;
    Store.savePlanWeek(uid, weekNumber, week, { silent: editing });
    if (!editing) render();
  },

  // ── 常用項目庫（決策紀錄第 26 條）─────────────────────────────────────────────
  // 課表上的項目「存成常用」（第 26、45 條）：整套設定存一份到共用庫，名稱照標題。
  // 按鈕只在項目庫還沒有一模一樣的內容時出現（改過時間、或出廠課表的項目），所以不會存出重複的。
  // 第 56 條：常用項目庫只有教練能改，「存成常用」也是。
  saveItemAsTemplate(weekNumber, dayIndex, itemId) {
    if (!this._libraryAllowed()) return;
    const day = Store.effectiveWeek(weekNumber, this.planUserId()).days[dayIndex];
    const it = day && day.items.find((x) => x.id === itemId);
    if (!it) return;
    if (Store.libraryItemMatching(it)) { render(); return; }
    const saved = Store.saveLibraryDoc(null, 'item', { name: it.title, item: it });
    if (!saved) { alert('這個項目的內容不完整，沒辦法存成常用項目。'); return; }
    this.state.savedFlash = itemId;
    render();
  },


  // 第 56 條：常用項目庫只有教練能改（畫面上本來就不給，這裡是第二道——真正擋的是規則）
  _libraryAllowed() {
    if (Store.canEditLibrary()) return true;
    const c = Store.coachUser();
    alert(`常用項目庫只有 ${c ? c.displayName : '教練'} 能改。`);
    return false;
  },

  // 份量不預填（第 45 條）：以前預填「8–10 次」，改成秒的時候 8–10 留著，填 30 會存成「10–30 秒」
  _blankExercise() { return { name: '', sets: 2, qty: 'reps', min: '', max: '', perSide: false, notes: '' }; },

  // 打開動作清單／影片／常用項目的編輯器。
  // 內建的（第 33 條）也從這裡進來：預填「今天看到的版本」（有修改版用修改版，沒有用 JSON），
  // 不能用 Store.libraryDoc——還沒改過的內建清單在庫裡根本沒有文件，按了會沒反應。
  // baseUpdatedAt：打開這一刻修改版的 updatedAt（沒有＝null），存檔時交給 transaction 比對。
  // origin：從本週頁某張卡的「查看動作」打開的，編輯器就畫在那張卡的位置。
  // copyOf（第 43 條「複製」）：打開一份還沒存的新內容，照 copyOf 那份預填；按存檔才建立，取消什麼都不留。
  startLibraryEdit(kind, id, origin, copyOf) {
    if (!this._libraryAllowed()) return;
    this.state.libFlash = '';
    if (copyOf) id = 'new';
    const srcId = copyOf || id;
    const isBuiltin = !copyOf && id !== 'new' && (kind === 'workout' ? !!PlanData.workoutById[id] : (kind === 'video' ? !!PlanData.videoById[id] : false));
    const suffix = copyOf ? '（複本）' : '';
    let doc = null;
    if (srcId !== 'new') {
      doc = kind === 'workout' ? Store.workoutFor(srcId) : (kind === 'video' ? Store.videoFor(srcId) : Store.libraryDoc(srcId));
      if (!doc) { alert('找不到這份內容，可能還沒同步到這台裝置。'); return; }
    }
    let draft = null;
    if (kind === 'workout') {
      const exs = doc ? doc.exercises : [];
      draft = {
        name: doc ? doc.name + suffix : '',
        loadGuidance: doc ? (doc.loadGuidance || '') : '',
        exercises: exs.length ? exs.map((ex) => {
          const r = ex.holdSeconds || ex.reps || {};
          return { name: ex.name, sets: ex.sets, qty: ex.holdSeconds ? 'hold' : 'reps', min: r.min, max: r.max, perSide: !!ex.perSide, notes: ex.notes || '' };
        }) : [this._blankExercise()],
      };
    } else if (kind === 'video') {
      draft = {
        title: doc ? doc.title + suffix : '', creator: doc ? (doc.creator || '') : '',
        linkType: doc && (doc.linkType === 'video' || doc.linkType === 'none') ? doc.linkType : 'search',
        searchQuery: doc ? (doc.searchQuery || '') : '', url: doc ? (doc.url || '') : '',
        notes: doc ? (doc.notes || '') : '',
      };
    }
    // kind === 'item'：範本內容直接用 renderItemEditForm 的表單讀，不需要 draft
    const base = isBuiltin ? (kind === 'workout' ? PlanData.workoutById[id] : PlanData.videoById[id]) : null;
    this.state.libraryEdit = {
      kind, id, draft,
      builtin: isBuiltin,
      baseUpdatedAt: isBuiltin ? Store.libraryServerUpdatedAt(id) : null,
      origin: origin || null,
      safetyNote: kind === 'workout' && doc ? doc.safetyNote || '' : '',
      builtinNotes: kind === 'video' && base ? base.notes || '' : '',
      // 複製常用項目：表單照這份預填
      prefill: kind === 'item' && copyOf ? { name: doc.name + suffix, item: JSON.parse(JSON.stringify(doc.item)) } : null,
      // 從內建動作清單（或它的複本）複製：記住來源，安全提醒跟著內建走
      copiedFrom: kind === 'workout' && copyOf ? (doc.builtin ? copyOf : ((Store.libraryDoc(copyOf) || {}).copiedFrom || null)) : null,
      // 複本的編輯器排在群組最下面，常常在螢幕外：畫完捲過去一次（afterRender）
      scrollOnce: !!copyOf,
    };
    this.state.itemPicker = null;
    this.state.amountEdit = null;
    this.state.noteEdit = null;
    render();
  },

  // 刪除／恢復內建的動作清單或影片（決策紀錄第 39 條）
  deleteBuiltin(kind, id) {
    const base = kind === 'workout' ? PlanData.workoutById[id] : PlanData.videoById[id];
    if (!base || !this._libraryAllowed()) return;
    if (!Sync.isSignedIn()) { alert('要先登入才能刪除內建內容（三個人共用）。'); return; }
    const cur = kind === 'workout' ? Store.workoutFor(id) : Store.videoFor(id);
    const name = kind === 'workout' ? cur.name : cur.title;
    const u = Store.libraryUsage(kind, id);
    const where = kind === 'workout' ? '動作參照' : '影片參照';
    if (!confirm(`刪除「${name}」？\n會從常用項目庫跟下拉選單拿掉。${u.total ? `已經排進課表的 ${u.total} 天照樣顯示——要從那些天拿掉，請到那天的項目把${where}改成（無）。` : ''}\n之後可以在「已刪除的內建」恢復。`)) return;
    const r = Store.setBuiltinRemoved(kind, id, true, Store.libraryServerUpdatedAt(id), (ok, msg) => {
      if (!ok) { render(); alert(`${msg}\n「${name}」沒有刪除。`); }
    });
    if (!r.ok) { alert(r.reason); return; }
    if (this.state.libraryEdit && this.state.libraryEdit.id === id) this.state.libraryEdit = null;
    render();
  },
  undeleteBuiltin(kind, id) {
    if (!this._libraryAllowed()) return;
    if (!Sync.isSignedIn()) { alert('要先登入才能恢復內建內容（三個人共用）。'); return; }
    const r = Store.setBuiltinRemoved(kind, id, false, Store.libraryServerUpdatedAt(id), (ok, msg) => {
      if (!ok) { render(); alert(msg); }
    });
    if (!r.ok) { alert(r.reason); return; }
    render();
  },

  startLibraryEditFromCard(weekNumber, dayIndex, itemId, workoutId) {
    this.startLibraryEdit('workout', workoutId, { weekNumber, dayIndex, itemId });
  },

  // 內建內容還原成 JSON 的版本，一樣只從今天起（第 33 條）
  restoreBuiltin(kind, id) {
    const base = kind === 'workout' ? PlanData.workoutById[id] : PlanData.videoById[id];
    if (!base || !this._libraryAllowed()) return;
    if (!Sync.isSignedIn()) { alert('要先登入才能還原內建內容（三個人共用）。'); return; }
    const u = Store.libraryUsage(kind, id);
    const name = kind === 'workout' ? base.name : base.title;
    if (!confirm(`把「${name}」還原成內建版本？\n今天起用到它的 ${u.upcoming} 天會回到內建內容；今天以前的日子維持原樣。`)) return;
    const r = Store.saveBuiltinOverride(kind, id, null, Store.libraryServerUpdatedAt(id), (ok, msg) => {
      if (!ok) { render(); alert(`${msg}\n「${name}」維持原本的內容。`); }
    });
    if (!r.ok) { alert(r.reason); return; }
    if (this.state.libraryEdit && this.state.libraryEdit.id === id) this.state.libraryEdit = null;
    render();
  },

  cancelLibraryEdit() {
    this.state.libraryEdit = null;
    render();
  },

  // draft 欄位 onchange：只存不重繪（見 renderWorkoutEditor 的註解），會改版面的才傳 rerender
  libDraft(field, value, rerender) {
    const e = this.state.libraryEdit;
    if (!e || !e.draft) return;
    e.draft[field] = value;
    if (rerender) render();
  },
  libDraftExercise(i, field, value, rerender) {
    const e = this.state.libraryEdit;
    if (!e || !e.draft || !e.draft.exercises || !e.draft.exercises[i]) return;
    const ex = e.draft.exercises[i];
    // 次 ↔ 秒：原本的數字換了單位就不是同一件事（10 次≠10 秒），清掉重填
    if (field === 'qty' && ex.qty !== value) { ex.min = ''; ex.max = ''; }
    ex[field] = value;
    if (rerender) render();
  },
  addLibExercise() {
    const e = this.state.libraryEdit;
    if (!e || !e.draft) return;
    e.draft.exercises.push(this._blankExercise());
    render();
  },
  // 內建內容存檔的結果回呼（第 33 條）。雲端存不進去時，把編輯器連同剛剛改的內容打開回來、跳出原因——
  // 編輯器在按下儲存那一刻就關了（本機先改），不留這份草稿的話，失敗就等於改的東西全部不見。
  _builtinSaveResult(keep) {
    return (ok, msg) => {
      if (ok) return;
      this.state.libraryEdit = { ...keep, baseUpdatedAt: Store.libraryServerUpdatedAt(keep.id) };
      render();
      alert(`${msg}\n你改的內容還在編輯器裡：確定要用你的版本就再按一次儲存；不要的話按取消。`);
    };
  },

  moveLibExercise(i, dir) {
    const e = this.state.libraryEdit;
    if (!e || !e.draft || !e.draft.exercises) return;
    const j = i + dir;
    const list = e.draft.exercises;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    render();
  },
  removeLibExercise(i) {
    const e = this.state.libraryEdit;
    if (!e || !e.draft) return;
    if (e.draft.exercises.length <= 1) { alert('動作清單至少要有一個動作。'); return; }
    e.draft.exercises.splice(i, 1);
    render();
  },

  saveLibraryWorkout() {
    const e = this.state.libraryEdit;
    if (!e || e.kind !== 'workout' || !this._libraryAllowed()) return;
    const d = e.draft;
    if (!String(d.name || '').trim()) { alert('請填動作清單名稱。'); return; }
    const exercises = [];
    for (const ex of d.exercises) {
      const name = String(ex.name || '').trim();
      if (!name) continue; // 名稱空白的那一列當作沒填，直接略過
      const sets = Number(ex.sets);
      if (!Number.isInteger(sets) || sets < 1 || sets > 20) { alert(`「${name}」的組數要是 1 到 20 的整數。`); return; }
      const lo = Number(ex.min);
      const hi = ex.max === '' || ex.max == null ? lo : Number(ex.max);
      const cap = ex.qty === 'hold' ? 600 : 200;
      if (ex.min === '' || ex.min == null || !Number.isFinite(lo) || !Number.isFinite(hi) || Math.min(lo, hi) < 1 || Math.max(lo, hi) > cap) {
        alert(`「${name}」的${ex.qty === 'hold' ? '秒數要在 1 到 600' : '次數要在 1 到 200'} 之間。`); return;
      }
      const r = { min: Math.min(lo, hi), max: Math.max(lo, hi) };
      exercises.push({ name, sets, reps: ex.qty === 'hold' ? null : r, holdSeconds: ex.qty === 'hold' ? r : null, perSide: !!ex.perSide, notes: ex.notes });
    }
    if (!exercises.length) { alert('至少要有一個有名稱的動作。'); return; }
    const fields = { name: d.name, loadGuidance: d.loadGuidance, exercises };
    if (e.builtin) {
      const r = Store.saveBuiltinOverride('workout', e.id, fields, e.baseUpdatedAt, this._builtinSaveResult(JSON.parse(JSON.stringify(e))));
      if (!r.ok) { alert(r.reason); return; }
    } else {
      if (e.id !== 'new' && Store.library[e.id] && Store.library[e.id].deleted) {
        alert('這份動作清單已經從常用項目庫刪掉了，不能再改。要改的話請新增一份。'); return;
      }
      const saved = Store.saveLibraryDoc(e.id === 'new' ? null : e.id, 'workout', e.id === 'new' ? { ...fields, copiedFrom: e.copiedFrom } : fields);
      if (!saved) { alert('內容不完整，沒有存檔。'); return; }
    }
    this.state.libraryEdit = null;
    render();
  },

  saveLibraryVideo() {
    const e = this.state.libraryEdit;
    if (!e || e.kind !== 'video' || !this._libraryAllowed()) return;
    const d = e.draft;
    if (!String(d.title || '').trim()) { alert('請填影片標題。'); return; }
    if (d.linkType === 'video' && !/^https:\/\//i.test(String(d.url || '').trim())) {
      alert('影片網址要以 https:// 開頭——直接從 YouTube 複製網址貼上。'); return;
    }
    if (d.linkType === 'search' && !String(d.searchQuery || '').trim()) { alert('請填搜尋關鍵字。'); return; }
    if (e.builtin) {
      const r = Store.saveBuiltinOverride('video', e.id, d, e.baseUpdatedAt, this._builtinSaveResult(JSON.parse(JSON.stringify(e))));
      if (!r.ok) { alert(r.reason); return; }
    } else {
      const saved = Store.saveLibraryDoc(e.id === 'new' ? null : e.id, 'video', d);
      if (!saved) { alert('內容不完整，沒有存檔。'); return; }
    }
    this.state.libraryEdit = null;
    render();
  },

  // 編輯常用項目的內容：同一份項目表單（_readItemForm／_validateItemFields），只是存到庫裡
  saveTemplateEdit(id) {
    if (!this._libraryAllowed()) return;
    const isNew = id === 'new'; // 第 43 條：直接在項目庫新增
    const tpl = isNew ? null : Store.libraryDoc(id);
    if (!isNew && !tpl) return;
    const formId = `tpl-edit-${id}`;
    const fields = this._readItemForm(formId);
    if (!fields) return;
    const err = this._validateItemFields(fields);
    if (err) { alert(err); return; }
    delete fields.__segError;
    // 第 45 條：「範本名稱」跟「標題」合成一個「名稱」；強度說明畫面上沒有地方顯示、表單拿掉了，保留原本的值
    const le = this.state.libraryEdit;
    const src = tpl ? tpl.item : (le && le.prefill ? le.prefill.item : null); // 複製出來的新項目：照來源那份
    fields.intensityNote = src ? (src.intensityNote || null) : null;
    delete fields.derived; delete fields.intensityDerived;
    const saved = Store.saveLibraryDoc(isNew ? null : id, 'item', { name: fields.title, item: fields });
    if (!saved) { alert('內容不完整，沒有存檔。'); return; }
    // 第 52 條：今天以後用到它的課表跟著改（第 56 條：三個人的課表都套）
    const n = isNew ? 0 : this._applyTemplateToPlan(id, tpl.item, saved.item);
    this.state.libFlash = n ? `已套用到三個人今天以後的 ${n} 天課表（今天以前的日子不動）。` : '';
    this.state.libraryEdit = null;
    render();
  },

  // 複製（第 43 條）：打開一份預填好的新內容（名稱加「（複本）」），按存檔才建立。
  // 內建的動作清單／影片複製出來是自訂的（照今天看到的版本），原本那份不動。
  duplicateLibraryDoc(kind, id) { this.startLibraryEdit(kind, 'new', null, id); },

  deleteLibraryDoc(id) {
    const doc = Store.libraryDoc(id);
    if (!doc || !this._libraryAllowed()) return;
    const label = doc.name || doc.title;
    const msg = doc.kind === 'item'
      ? `刪除常用項目「${label}」？已經排進課表的日子不受影響。`
      : `刪除「${label}」？會從選單拿掉；已經用到它的課表項目照樣顯示。`;
    if (!confirm(msg)) return;
    if (this.state.libraryEdit && this.state.libraryEdit.id === id) this.state.libraryEdit = null;
    Store.deleteLibraryDoc(id);
    render();
  },

  // userId：要改的是誰的課表（第 56 條）。不給＝本週頁現在在排的那個人。
  _cloneEffectiveWeek(weekNumber, userId) {
    const uid = userId || this.planUserId();
    const clone = JSON.parse(JSON.stringify(Store.effectiveWeek(weekNumber, uid)));
    // 記住這次編輯是從哪個版本開始改的（她還沒有自己那份＝null，也是有效的起點）。
    // firebase-sync.js 存檔前會拿這個跟雲端最新版本比對，偵測「別人剛好也在改這週」的衝突——
    // Mick 跟 Annlin 可能同時在改 Annlin 的課表。
    clone.__baseUpdatedAt = Store._planBase(weekNumber, uid);
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
    // 訓練段落（第 42 條）：從表單 DOM 讀出來（_readSegmentsDom），數字不合法的記下錯誤，_validateItemFields 擋
    const segRead = this._readSegmentsDom(root.querySelector('.seg-root'));
    const segError = segRead.error;
    const segments = PlanData.cleanSegments(segRead.raw);
    // 影片（第 28 條）：每列一個下拉，選「（無）」的列當沒填；重複選同一部只留一次
    const videoRefs = [];
    root.querySelectorAll('select[name="videoRefs"]').forEach((el) => {
      const v = el.value.trim();
      if (v && !videoRefs.includes(v)) videoRefs.push(v);
    });
    return {
      type: val('type'),
      title: val('title'),
      duration: range('durationMin', 'durationMax'),
      distanceKm: range('distanceMin', 'distanceMax'),
      heartRateZone: PlanData.fmtHeartRateZone(val('heartRateZone')) || null, // 第 30 條：一律存成 Zone
      rpe: range('rpeMin', 'rpeMax'),
      intensityNote: val('intensityNote') || null,
      segments: segments.length ? segments : null,
      __segError: segError, // 只給 _validateItemFields 看，存檔前拿掉
      // 兩個都寫：videoRef＝第一部，給還開著舊版網頁的裝置看（見 PlanData.itemVideoRefs）
      videoRefs,
      videoRef: videoRefs[0] || null,
      workoutRef: val('workoutRef') || null,
      notes: val('notes') || null,
      // 決策紀錄第 19 條：這兩個是轉檔留下的「沒人確認過」標記，不是教練填的欄位。
      // 教練存過就是確認過——一律清掉，「推導值」「（推導）」標籤跟著消失。
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
    if (fields.videoRefs && fields.videoRefs.length > PlanData.MAX_ITEM_VIDEOS) return `一個項目最多 ${PlanData.MAX_ITEM_VIDEOS} 部影片`;
    if (fields.__segError) return fields.__segError;
    return null;
  },

  // ── 訓練段落編輯器（第 42 條）：直接改表單 DOM，不重繪 ────────────────────────
  // 從 DOM 讀段落，回傳 { raw, error }。只看 .seg-root 底下直接的子元素：<template> 的內容不在 DOM 樹上，不會被讀到。
  // error 是給教練看的第一個問題（數量不合法、超過單位上限、重複次數、空的重複組）——
  // cleanSegments 會把這些靜靜丟掉，所以要在這裡先講出來，不能讓她存完才發現段落不見了（審查抓到）。
  _readSegmentsDom(segRoot) {
    let error = null;
    const setErr = (m) => { if (!error) error = m; };
    const readStep = (el) => {
      const v = (n) => { const x = el.querySelector(`[data-f="${n}"]`); return x ? x.value.trim() : ''; };
      const unit = v('unit');
      ['min', 'max'].forEach((n) => {
        const x = v(n);
        if (x === '') return;
        const num = Number(x);
        if (!(num > 0) || !Number.isFinite(num)) setErr('訓練段落的數量要是大於 0 的數字（不需要就留空）');
        else if (PlanData.SEGMENT_UNIT_CAPS[unit] && num > PlanData.SEGMENT_UNIT_CAPS[unit]) {
          setErr(`訓練段落的數量太大：「${PlanData.SEGMENT_UNITS[unit]}」最多 ${PlanData.SEGMENT_UNIT_CAPS[unit]}，是不是單位選錯了？`);
        }
      });
      return { kind: v('kind'), amount: { unit, min: v('min'), max: v('max') }, zone: v('zone') || null, note: v('note') };
    };
    const raw = segRoot ? [...segRoot.children].filter((el) => el.dataset && el.dataset.seg).map((el) => {
      if (el.dataset.seg !== 'repeat') return readStep(el);
      const t = el.querySelector('[data-f="times"]');
      const times = t ? Number(t.value) : NaN;
      if (!Number.isInteger(times) || times < 1 || times > PlanData.SEGMENT_LIMITS.times) setErr(`重複次數要是 1 到 ${PlanData.SEGMENT_LIMITS.times} 的整數`);
      const list = el.querySelector('.seg-list');
      const steps = list ? [...list.children].filter((c) => c.dataset && c.dataset.seg === 'step').map(readStep) : [];
      const group = { kind: 'repeat', times, steps };
      if (!PlanData.cleanSegments([{ ...group, times: 1 }]).length) setErr('有一組重複裡面沒有內容：填上數量、心率或說明，或按 ✕ 刪掉這組');
      return group;
    }) : [];
    return { raw, error };
  },
  // 段落合計（編輯器底下的提示）：換單位手滑、跟總時長／距離對不上，一眼看得出來
  segUpdateSum(anyEl) {
    const editor = anyEl && anyEl.closest ? anyEl.closest('.seg-editor') : null;
    const out = editor && editor.querySelector('.seg-sum');
    if (!out) return;
    const segs = PlanData.cleanSegments(this._readSegmentsDom(editor.querySelector('.seg-root')).raw);
    const t = PlanData.segmentTotals(segs);
    const r1 = (x) => Math.round(x * 10) / 10;
    const rng = (o, unit) => (r1(o.min) === r1(o.max) ? `${r1(o.min)} ${unit}` : `${r1(o.min)}–${r1(o.max)} ${unit}`);
    const parts = [t.hasKm ? rng(t.km, '公里') : '', t.hasTime ? rng(t.minutes, '分') : ''].filter(Boolean);
    out.textContent = parts.length ? `段落合計：約 ${parts.join('＋')}` : '';
  },

  // ── 訓練段落編輯器的按鈕 ───────────────────
  segAdd(btn, kind) {
    const editor = btn.closest('.seg-editor');
    if (!editor) return;
    const inRepeat = btn.classList.contains('seg-add-in');
    const list = inRepeat ? btn.closest('.seg-repeat').querySelector('.seg-list') : editor.querySelector('.seg-root');
    const limit = inRepeat ? PlanData.SEGMENT_LIMITS.inRepeat : PlanData.SEGMENT_LIMITS.top;
    if ([...list.children].filter((c) => c.dataset && c.dataset.seg).length >= limit) {
      alert(inRepeat ? `一組重複最多 ${limit} 段。` : `訓練段落最多 ${limit} 段（重複組算一段）。`);
      return;
    }
    const tpl = editor.querySelector(kind === 'repeat' && !inRepeat ? 'template.seg-repeat-tpl' : 'template.seg-step-tpl');
    list.appendChild(tpl.content.cloneNode(true));
    this.segUpdateSum(editor);
  },
  segMove(btn, dir) {
    const el = btn.closest('[data-seg]');
    if (!el) return;
    if (dir < 0 && el.previousElementSibling) el.parentNode.insertBefore(el, el.previousElementSibling);
    if (dir > 0 && el.nextElementSibling) el.parentNode.insertBefore(el.nextElementSibling, el);
  },
  segRemove(btn) {
    const el = btn.closest('[data-seg]');
    if (!el) return;
    const editor = el.closest('.seg-editor');
    // 整組刪掉會連組裡打好的段一起沒了，而且沒有復原——有內容就先問
    if (el.dataset.seg === 'repeat') {
      const read = this._readSegmentsDom({ children: [el] });
      if (PlanData.cleanSegments(read.raw.map((g) => ({ ...g, times: 1 }))).length && !confirm('刪掉這整組重複（連同組裡的段）？')) return;
    }
    el.remove();
    this.segUpdateSum(editor);
  },
  // 間歇範本：她舉的例子「400 公尺 × 4 次，前後加暖身緩和」。心率不預設（第 40 條：強度由教練決定）。
  segIntervalTemplate(btn) {
    const editor = btn.closest('.seg-editor');
    const list = editor && editor.querySelector('.seg-root');
    if (!list) return;
    if ([...list.children].some((c) => c.dataset && c.dataset.seg) && !confirm('用間歇範本取代目前的訓練段落？')) return;
    list.innerHTML = [
      renderSegStep({ kind: 'warmup', amount: { unit: 'min', min: 10, max: 10 }, zone: null, note: '輕鬆跑' }),
      renderSegRepeat({ times: 4, steps: [
        { kind: 'main', amount: { unit: 'm', min: 400, max: 400 }, zone: null, note: '' },
        { kind: 'recover', amount: { unit: 'sec', min: 90, max: 90 }, zone: null, note: '慢跑或走路' },
      ] }),
      renderSegStep({ kind: 'cooldown', amount: { unit: 'min', min: 10, max: 10 }, zone: null, note: '輕鬆跑' }),
    ].join('');
    this.segUpdateSum(editor);
  },

  // 項目表單的「＋ 再加一部影片」／✕（第 28 條）：直接改表單 DOM，不重繪。表單其他欄位
  // 打到一半的內容不在 state 裡（_readItemForm 存檔時才一次讀），這時候 render() 會把標題、
  // 時長這些還沒存的字全部洗掉。
  addVideoRow(formId) {
    const root = document.getElementById(formId);
    const list = root && root.querySelector('.vref-list');
    const tpl = root && root.querySelector('template.vref-tpl');
    if (!list || !tpl) return;
    if (list.querySelectorAll('.vref-row').length >= PlanData.MAX_ITEM_VIDEOS) {
      alert(`一個項目最多 ${PlanData.MAX_ITEM_VIDEOS} 部影片。`);
      return;
    }
    list.appendChild(tpl.content.cloneNode(true));
  },

  removeVideoRow(btn) {
    const row = btn && btn.closest('.vref-row');
    if (row) row.remove();
  },

  deleteItem(weekNumber, dayIndex, itemId) {
    if (!this._canEditPlan()) return;
    const uid = this.planUserId();
    const week = this._cloneEffectiveWeek(weekNumber, uid);
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
    Store.savePlanWeek(uid, weekNumber, week);
    render();
  },

  moveItem(weekNumber, dayIndex, itemId, direction) {
    if (!this._canEditPlan()) return;
    const uid = this.planUserId();
    const week = this._cloneEffectiveWeek(weekNumber, uid);
    const day = week.days[dayIndex];
    const idx = day.items.findIndex((it) => it.id === itemId);
    const swapWith = idx + direction;
    if (idx === -1 || swapWith < 0 || swapWith >= day.items.length) return;
    const tmp = day.items[idx];
    day.items[idx] = day.items[swapWith];
    day.items[swapWith] = tmp;
    Store.savePlanWeek(uid, weekNumber, week);
    render();
  },

  toggleDaySelectOne(weekNumber, dayIndex) {
    if (!this._canEditPlan()) { render(); return; }
    const uid = this.planUserId();
    const week = this._cloneEffectiveWeek(weekNumber, uid);
    const day = week.days[dayIndex];
    if (!day.selectOne && day.items.length < 2) {
      alert('「二擇一」至少要有兩個選項，請先新增一個項目再切換。');
      return;
    }
    day.selectOne = !day.selectOne;
    Store.savePlanWeek(uid, weekNumber, week);
    render();
  },

  setDayNotes(weekNumber, dayIndex, value) {
    if (!this._canEditPlan()) return;
    const uid = this.planUserId();
    const week = this._cloneEffectiveWeek(weekNumber, uid);
    week.days[dayIndex].dayNotes = value || null;
    Store.savePlanWeek(uid, weekNumber, week, { silent: true }); // silent：避免 textarea 失焦時吃掉下一次點擊
  },

  setLongRunMetric(weekNumber, value) {
    if (!this._canEditPlan()) { render(); return; }
    const uid = this.planUserId();
    const week = this._cloneEffectiveWeek(weekNumber, uid);
    week.longRunMetric = value || null;
    Store.savePlanWeek(uid, weekNumber, week);
    render();
  },

  // 本週的目標跑量（決策紀錄第 49 條，取代第 13 條的「只能往下調」）：教練自己訂的數字，
  // 不限制在課表加總以下、不改課表、不影響進度條。兩個都留空＝清掉目標，跟 clearWeeklyVolume 同義。
  setWeeklyVolume(weekNumber, minVal, maxVal) {
    if (minVal === '' && maxVal === '') { this.clearWeeklyVolume(weekNumber); return; }
    const a = minVal === '' ? Number(maxVal) : Number(minVal);
    const b = maxVal === '' ? Number(minVal) : Number(maxVal);
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.min(a, b) < 0 || Math.max(a, b) > 200) { alert('目標跑量要在 0-200 公里之間'); return; }
    if (!this._canEditPlan()) { render(); return; }
    const uid = this.planUserId();
    const week = this._cloneEffectiveWeek(weekNumber, uid);
    week.weeklyVolumeKm = { min: Math.min(a, b), max: Math.max(a, b) };
    delete week.weeklyVolumeNullReason; // 舊版欄位（第 8 條時代），不再有意義
    Store.savePlanWeek(uid, weekNumber, week);
    render();
  },

  clearWeeklyVolume(weekNumber) {
    if (!this._canEditPlan()) { render(); return; }
    const uid = this.planUserId();
    const week = this._cloneEffectiveWeek(weekNumber, uid);
    delete week.weeklyVolumeKm;
    delete week.weeklyVolumeNullReason;
    Store.savePlanWeek(uid, weekNumber, week);
    render();
  },

  // 只還原正在排的那個人這一週（第 56 條），直接回到出廠課表
  resetPlanWeek(weekNumber) {
    if (!this._canEditPlan()) { render(); return; }
    const uid = this.planUserId();
    const name = (PlanData.userById[uid] || {}).displayName || uid;
    if (!confirm(`確定要把 ${name} 第 ${weekNumber} 週的課表還原成出廠預設值嗎？這週的調整都會消失（其他週、其他人不受影響）。`)) return;
    Store.resetPlanWeek(uid, weekNumber);
    render();
  },

  // 決策紀錄第 57 條：教練在對話裡給的整週課表（data/week-presets.json），一鍵排進正在排的那個人的那一週。只有教練
  //（會把還沒有的項目加進常用項目庫）。整週換掉，包含已經過去的日子——她要的：「雖然週一已經過了但還是排」；
  // 同一天原本就有的同一個項目沿用 id，打過的勾留著。按確認才排。
  applyWeekPreset(presetId) {
    const preset = (PlanData.weekPresets || []).find((p) => p.id === presetId);
    if (!preset || !Store.coachMode || !this._libraryAllowed()) { render(); return; }
    // 要對她雲端上的常用項目庫：沒登入時庫是空的，會把她自己調過的「Zone 2 跑」當成沒有、另外新增一份（審查抓到）
    if (!Sync.isSignedIn()) { render(); alert('要先登入才能排（要用你常用項目庫裡的項目）。'); return; }
    const uid = this.planUserId();
    if (!Store.canEditPlanOf(uid)) { render(); return; }
    if (preset.users && !preset.users.includes(uid)) { render(); return; } // 這份是排給別人的（畫面上本來就不給按鈕）
    const wn = preset.weekNumber;
    const name = (PlanData.userById[uid] || {}).displayName || uid;
    const { templates, missing, differ } = Store.presetTemplates(preset);
    // 先算一次（還沒進庫的先照 preset 的內容算）：哪幾天她記過的東西會被換掉，講給她聽
    const draft = { ...templates };
    missing.forEach((k) => { draft[k] = { id: null, item: preset.items[k] }; });
    const plan = Store.presetPlan(preset, uid, draft);
    const who = uid === Store.activeUserId ? '你' : `${name} `; // 名字後面空一格、「你」不用：「Phoebe 先選的」「你先選的」
    const dayLabel = (c) => { const d = PlanData.dateForWeekDay(wn, c); return `週${PlanData.weekdayLabel(c)}（${d.getMonth() + 1}/${d.getDate()}）`; };
    const titlesOf = (keys) => [...new Set(keys.map((k) => preset.items[k].title))];
    const reused = titlesOf(Object.keys(templates).filter((k) => templates[k] && templates[k].id));
    const added = titlesOf(missing);
    const differs = titlesOf(differ);
    const statusName = { rested: '自主休息', substituted: '更換項目' };
    // 只改其中幾天的（days 裡寫 null 的那天不動）：講清楚改哪幾天
    const changedDays = [0, 1, 2, 3, 4, 5, 6].filter((di) => preset.days[di] != null);
    const pastIncluded = changedDays.some((di) => PlanData.keyForWeekDay(wn, di) <= Store.todayKey());
    const lines = [
      `把「${preset.name}」排進 ${name} 第 ${wn} 週？`,
      changedDays.length === 7 ? '週一到週日七天全部照這份排，包含已經過去的日子跟今天。'
        : `${changedDays.map(dayLabel).join('、')}照這份排${pastIncluded ? '（包含已經過去的日子）' : ''}，其他天不動。`,
      added.length ? `常用項目庫會加上：${added.join('、')}。` : '',
      reused.length ? `用常用項目庫裡的：${reused.join('、')}。` : '',
      differs.length ? `常用項目庫裡的「${differs.join('」「')}」內容不一樣，這週照這份排（庫裡那份不動）。` : '',
      '同一天原本就有的同一個項目，打過的勾會留著。',
      ...plan.lost.map((x) => `${dayLabel(x.c)}${[
        x.picked.length ? `${who}${x.future ? '先' : ''}選的「${x.picked.join('」「')}」` : '',
        x.ticked.length ? `打過勾的「${x.ticked.join('」「')}」` : '',
      ].filter(Boolean).join('、')}不在新的課表裡，會換成這份排的內容。`),
      ...plan.statuses.map((x) => `${dayLabel(x.c)}${who}標了「${statusName[x.status]}」，那天會照樣顯示${statusName[x.status]}（要練的話到那天取消）。`),
      plan.reduced ? `${name} 標了第 ${wn} 週「本週已降量」。` : '',
      plan.swapped ? `${name} 這週自己換過順序，她那邊看到的日子會照她的對調。` : '',
    ].filter(Boolean);
    if (!confirm(lines.join('\n'))) return;
    for (const k of missing) {
      if (templates[k]) continue; // 同名同類型的前面已經存進庫了
      const def = preset.items[k];
      const saved = Store.saveLibraryDoc(null, 'item', { name: def.title, item: def });
      if (!saved) { alert(`「${def.title}」存不進常用項目庫，這次沒有排。`); render(); return; }
      templates[k] = { id: saved.id, item: saved.item };
      missing.filter((k2) => preset.items[k2].title === def.title && preset.items[k2].type === def.type).forEach((k2) => { templates[k2] = templates[k]; });
    }
    Store.savePlanWeek(uid, wn, Store.presetPlan(preset, uid, templates).week, { batch: true });
    this.state.itemPicker = null;
    this.state.amountEdit = null;
    this.state.noteEdit = null;
    render();
  },

  // 決策紀錄第 56 條：把 fromUserId 的課表複製給正在排的那個人。只有教練、只在教練模式。
  // range：'week'（畫面上這一週）| 'future'（今天以後全部）；一律從明天開始。按確認才複製。
  async copyPlanFrom(fromUserId, range) {
    this.state.viewMenuOpen = false;
    const to = this.planUserId();
    const name = (uid) => (PlanData.userById[uid] || {}).displayName || uid;
    if (!Store.coachMode || !Store.isCoach(Store.activeUserId) || fromUserId === to || !PlanData.userById[fromUserId]) { render(); return; }
    if (!Sync.isSignedIn()) { render(); alert('要先登入才能複製課表。'); return; }
    // 兩個人的課表都要讀到了才複製（審查抓到）：還沒讀到、或新的規則還沒發布時，會拿舊的共用課表／出廠當來源
    if (Sync.planWeeksDenied || !Sync.planWeeksLoaded(fromUserId) || !Sync.planWeeksLoaded(to)) {
      render(); alert('課表還沒讀完（或新的規則還沒發布），這次沒有複製。等一下再試。'); return;
    }
    const wn = this.state.weekViewNumber; // 等伺服器的期間換了週，「這一週」還是按下去那一週
    render();
    // 對方哪幾週自己對調過順序、哪幾天已經先記了東西，要問過伺服器才準（那些要跳過），連不上就不複製
    if (!(await Sync.fetchCopyGuards(to))) { alert('沒有連上網路，這次沒有複製。'); return; }
    const p = Store.copyPlanPreview(fromUserId, to, range, wn);
    const t = PlanData.parseLocalDate(p.tomorrow);
    const tomorrowLabel = `${t.getMonth() + 1}/${t.getDate()}`;
    const weeksText = (list) => `第 ${list.join('、')} 週`;
    const scope = range === 'week' ? `第 ${wn} 週`
      : (p.inRange.length ? `第 ${p.inRange[0]}～${p.inRange[p.inRange.length - 1]} 週` : '');
    if (!p.inRange.length) { alert(`${range === 'week' ? `第 ${wn} 週` : '課表'}沒有明天以後的日子，不用複製。`); return; }
    const skipLine = p.skipped.length ? `${weeksText(p.skipped)} ${name(to)} 自己對調過順序，${p.skipped.length === 1 ? '這週' : '這幾週'}跳過。` : '';
    const dayName = (x) => { const d = PlanData.dateForWeekDay(x.weekNumber, x.dayIndex); return `第 ${x.weekNumber} 週週${PlanData.weekdayLabel(x.dayIndex)}（${d.getMonth() + 1}/${d.getDate()}）`; };
    const recordedLine = p.recorded.length
      ? `${name(to)} 已經先記了東西（例如先選了休息）的 ${p.recorded.length} 天也會換成 ${name(fromUserId)} 的：${p.recorded.slice(0, 6).map(dayName).join('、')}${p.recorded.length > 6 ? ' 等' : ''}。` : '';
    if (!p.weeks.length) {
      // 跳過的週沒有比過，不能說它「一樣」：全部都跳過就只講跳過；有跳過的就只說「其他日子」一樣
      const allSkipped = p.skipped.length > 0 && p.skipped.length === p.inRange.length;
      alert(allSkipped
        ? `${weeksText(p.skipped)} ${name(to)} 自己對調過順序，${p.skipped.length === 1 ? '這週' : '這幾週'}跳過，這次沒有複製。`
        : [skipLine, `${p.skipped.length ? '其他日子' : `${name(to)} ${scope}（明天起）的課表`}已經跟 ${name(fromUserId)} 一樣了，不用複製。`].filter(Boolean).join('\n'));
      return;
    }
    const lines = [
      `把 ${name(fromUserId)} 的課表複製到 ${name(to)}？`,
      `範圍：${scope}，明天（${tomorrowLabel}）起；今天和以前不動。`,
      p.changedDays ? `會改 ${p.changedDays} 天。` : '',
      p.ownEdited ? `${name(to)} 自己改過的 ${p.ownEdited} 天會被蓋掉。` : '',
      recordedLine,
      skipLine,
      p.reduced.length ? `${weeksText(p.reduced)} ${name(to)} 標了「本週已降量」。` : '',
      p.goalChanged ? `目標跑量也會換成 ${name(fromUserId)} 的。` : '',
      p.metricChanged ? `長跑計量單位（以時間／距離計）也會換成 ${name(fromUserId)} 的。` : '',
    ].filter(Boolean);
    if (!confirm(lines.join('\n'))) return;
    Store.applyCopyPlan(p);
    render();
  },
};
const A = App; // 給 inline onclick="A.xxx()" 用的短名
