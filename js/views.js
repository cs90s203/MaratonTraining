// 純渲染：state + Store/PlanData → innerHTML 字串。沒有 virtual DOM，每次狀態變動就
//整個 #root 重繪一次——跟 babylog 同一套（docs/architecture.md 的理由：資料量小，
// 重繪成本可忽略，換來不需要任何建置工具）。

// ── 小工具 ──────────────────────────────────────────────────────────────────
function h(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// 給 inline onclick="A.xxx('...')" 用的 JS 字串轉義（h() 只轉義 HTML 屬性用的字元，
// 不轉義單引號——userId 來自 data/users.json，是人工填入的資料而非程式碼常數，
// 含單引號時會提前結束 onclick 裡的 JS 字串字面值，讓那個按鈕整個失效）。
function jsq(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function pct(x) { return x == null ? '—' : Math.round(x * 100) + '%'; }

const ICON = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  week: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="3"/><path d="M3 10h18M9 4v18M15 4v18"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 9l-5 5-3-3-4 4"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  // 影片專用（決策紀錄第 34 條）：實心圓＋反白三角形。只用 ▶ 的話跟「查看動作」前面展開的 ▶ 太像。
  // 三角形的顏色交給 CSS（.pc-fg），跟著所在卡片的底色走，深淺主題都是「挖空」的樣子。
  playCircle: '<svg class="play-circle" viewBox="0 0 24 24" aria-hidden="true"><circle class="pc-bg" cx="12" cy="12" r="12"/><path class="pc-fg" d="M9.75 7.4v9.2l7.2-4.6z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V4l14 6-14 6"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4.5"/><path d="M12 17.5h.01"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/></svg>',
  grip: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.8"/><circle cx="15" cy="5" r="1.8"/><circle cx="9" cy="12" r="1.8"/><circle cx="15" cy="12" r="1.8"/><circle cx="9" cy="19" r="1.8"/><circle cx="15" cy="19" r="1.8"/></svg>',
};

// 「更換項目」換成哪一類（Store 的 SUBSTITUTE_TYPES）→ 顯示文字
const SUBSTITUTE_LABELS = { run: '跑步', strength: '重訓', core: '核心', bike: '騎車', swim: '游泳', walk: '走路', other: '其他' };
// 體感強度：Apple Fitness「Rate Your Effort」的四段（1-10）
const EFFORT_BANDS = [[1, 3, '輕鬆'], [4, 6, '中等'], [7, 8, '困難'], [9, 10, '全力']];
function effortLabel(n) { const b = EFFORT_BANDS.find(([a, z]) => n >= a && n <= z); return b ? b[2] : ''; }

const FLAG_LABELS = { leakage: '漏尿', pain: '疼痛', overTired: '過度疲勞' };

// 階段性目標（決策紀錄第 22 條）六個欄位的顯示設定——跟 store.js 的 PHASE_TARGET_FIELDS
// 是同一份清單，這裡管單位／輸入格式／小數位數。kind:'pace' 用 mm:ss 輸入＋顯示；
// 'km' 沿用跑量既有的 fmtKmRange；'num' 是純數字，step 決定輸入框的精度。
const PHASE_TARGET_META = [
  { key: 'zone2Pace', label: 'Zone 2 配速目標', unit: '/km', kind: 'pace' },
  { key: 'volumeKm', label: '目標跑量', unit: 'km', kind: 'km', step: 0.5 },
  { key: 'cadence', label: 'Cadence 步頻', unit: 'spm', kind: 'num', step: 1 },
  { key: 'verticalOscillation', label: 'Vertical Oscillation 垂直振幅', unit: 'cm', kind: 'num', step: 0.1 },
  { key: 'groundContactTime', label: 'Ground Contact Time 觸地時間', unit: 'ms', kind: 'num', step: 1 },
  { key: 'strideLength', label: 'Stride Length 步幅', unit: 'm', kind: 'num', step: 0.01 },
];
// "6:30" -> 6.5（分鐘小數，跟課表估算配速 timeBasedRunPaceMinPerKm 同一種單位）；
// 也接受純數字（使用者直接打小數）。不合法（空字串、打錯格式）回傳 null。
function parsePaceStr(str) {
  const s = String(str == null ? '' : str).trim();
  if (!s) return null;
  const m = s.match(/^(\d+):([0-5]?\d)$/);
  if (m) return Number(m[1]) + Number(m[2]) / 60;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function fmtPace(decimalMin) {
  if (!Number.isFinite(decimalMin)) return '';
  const total = Math.round(decimalMin * 60);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
function fmtTargetRange(r, meta) {
  if (!r) return '';
  if (meta.kind === 'pace') return r.min === r.max ? fmtPace(r.min) : `${fmtPace(r.min)}–${fmtPace(r.max)}`;
  return r.min === r.max ? `${r.min}` : `${r.min}–${r.max}`;
}

// 教練模式編輯表單的 type 下拉選單。⚠️ 跟 tools/verify_plan.py 的 VALID_TYPES 必須
// 保持一致——那支腳本管出廠課表，這裡管教練模式的即時編輯，是兩個不同的執行環境
// （Python / 瀏覽器 JS），沒辦法共用同一份常數，只能靠這條註解互相提醒同步改。
// muscle＝肌力訓練（決策紀錄第 47 條：徒手／彈力帶這類，跟有負重的「重量訓練」分開）。tools/verify_plan.py 會讀這一行比對。
const VALID_TYPES = ['recovery', 'run', 'long-run', 'tempo', 'interval', 'form-drill', 'muscle', 'strength', 'rest', 'race'];
const TYPE_LABELS = {
  recovery: '恢復', run: '跑步', 'long-run': '長跑',
  tempo: '節奏跑', interval: '間歇跑', 'form-drill': '跑姿訓練', muscle: '肌力訓練', strength: '重量訓練', rest: '休息', race: '比賽',
  'walk-run': '走跑交替（舊類型，請改選）', // v3 舊覆寫文件裡可能還有；只供顯示，不在 VALID_TYPES 下拉
};
// Store.dayStatus() 的回傳值 → 畫面文字。unfinished 不是 dayStatus 的回傳值：過去的日子
// 還是 'pending' 時畫面寫「未完成」，今天和未來才寫「待完成」（決策紀錄第 23 條）——
// 用 dayStatusLabel()，不要直接查這張表。
const DAY_STATUS_LABELS = {
  expired: '已過期', substituted: '更換項目', rested: '自主休息',
  done: '已完成', partial: '部分完成', pending: '待完成', unfinished: '未完成',
};
function dayStatusLabel(status, dateKey) {
  if (status === 'pending' && dateKey < PlanData.dayKey(PlanData.today())) return DAY_STATUS_LABELS.unfinished;
  return DAY_STATUS_LABELS[status] || DAY_STATUS_LABELS.pending;
}
// 可按的狀態 chip（「沒照表？」那一排）。「照表」（status=null）不是 chip，是紀錄卡標題右邊的
// 唯讀文字——它是「沒有覆寫」而不是一個選項，見決策紀錄第 13b 條。「錯過」第 23 條拿掉。
const DAY_STATUS_CHIPS = [['substituted', '更換項目'], ['rested', '自主休息']];
const DAY_STATUS_HINTS = {
  substituted: '更換項目只是記錄，不算補做，也不會把原本的量搬到別天。',
  rested: '自主休息不計入完成率——休息不是失敗。',
};

// ── 頂層外殼 ─────────────────────────────────────────────────────────────────
function renderApp(state) {
  const dr = PlanData.daysUntilRace();
  const raceLine = dr > 0 ? `距離比賽還有 ${dr} 天` : dr === 0 ? '今天是比賽日！' : `已完賽 ${-dr} 天`;
  return `
    ${Store.coachMode && !(state.page === 'week' && state.viewingUserId && state.viewingUserId !== Store.activeUserId) ? `<div class="coach-banner">🛠 教練模式——這裡改的是所有人共用的課表，不是你自己的紀錄</div>` : ''}
    <div class="topbar">
      <div class="topbar-inner">
        <div class="topbar-title">東京馬拉松 2027
          <span class="race-count">${h(raceLine)}</span>
        </div>
        ${renderSyncPill()}
      </div>
      ${renderDesktopNav(state)}
    </div>
    <div class="wrap">
      ${renderPage(state)}
    </div>
    ${renderBottomNav(state)}
    ${renderModal(state)}
  `;
}

// 全域彈窗。目前只有安全提醒（週視圖標題旁的「！」）。決策紀錄第 10 條：那四段文字
// 可以藏在按鈕後面，但不能少——verify_plan.py 只驗 plan.json，這裡要靠自己守。
function renderModal(state) {
  if (state.modal !== 'safety') return '';
  const s = PlanData.plan.safety;
  return `
    <div class="modal-backdrop" onclick="A.closeModal()">
      <div class="modal card" onclick="event.stopPropagation()">
        <div class="modal-head"><b>⚠️ 開始前 / 安全提醒</b><button class="icon-btn" onclick="A.closeModal()" aria-label="關閉">✕</button></div>
        <div class="modal-body">
          <p>${h(s.prerequisite)}</p>
          <p>${h(s.intensityPrinciple)}</p>
          <p>${h(s.weeklySelfCheck)}</p>
          <p style="font-style:italic">${h(s.disclaimer)}</p>
        </div>
      </div>
    </div>`;
}

function renderSyncPill() {
  // ⚠️ 明確的錯誤狀態要排在 hasPendingWrites 之前檢查。hasPendingWrites 只在
  // 「上一次成功的 snapshot」裡被設過值，訂閱真的失敗之後它不會自動清成 false——
  // 如果查詢順序反過來，一個曾經有 pending 寫入、後來訂閱失敗的畫面會卡在
  // 「同步中」，蓋掉使用者真正需要看到的失敗/未授權/身分不符訊息。
  if (!Sync.isSignedIn()) {
    // ⚠️ 這兩條務必排在「點擊登入以同步」前面——之前登入卡住（跨網站資料被瀏覽器擋掉、
    // 彈出視窗的結果傳不回主頁面）時 Sync.state 會變成 'signing-in' 或 'fail'，但
    // isSignedIn() 一直是 false，如果沒有這兩條，畫面會一直顯示「點擊登入以同步」，
    // 跟使用者從沒按過登入一模一樣——這正是「登入後還是跟未登入一樣」的成因。
    if (Sync.state === 'unauthorized') {
      // _handleSnapErr 判定未授權後會 signOut()，這時 isSignedIn() 已經是 false——
      // 這個分支一定要在這裡（沒登入的區塊）也有，不然畫面會退回「點擊登入以同步」。
      return `<button class="sync-pill off" title="${h(Sync.message)}" onclick="A.goTo('settings')"><span class="dot"></span>未授權</button>`;
    }
    if (Sync.state === 'signing-in') {
      // 可以再點：彈出視窗被關掉或沒出現時，再點一次會重新開一個。
      return `<button class="sync-pill busy" onclick="A.signIn()"><span class="dot"></span>登入中…</button>`;
    }
    if (Sync.state === 'fail') {
      return `<button class="sync-pill off" title="${h(Sync.message)}" onclick="A.retrySync()"><span class="dot"></span>登入失敗，點擊重試</button>`;
    }
    return `<button class="sync-pill off" onclick="A.signIn()"><span class="dot"></span>點擊登入以同步</button>`;
  }
  if (Sync.state === 'unauthorized') {
    return `<button class="sync-pill off" onclick="A.signIn()"><span class="dot"></span>未授權</button>`;
  }
  if (Sync.state === 'wrong-identity') {
    return `<button class="sync-pill off" title="${h(Sync.message)}" onclick="A.goTo('settings')"><span class="dot"></span>身分不符</button>`;
  }
  if (Sync.state === 'write-denied') {
    // 手機沒有 hover，title 看不到——原因要點得出來，不然只剩四個字猜不出哪筆、為什麼。
    return `<button class="sync-pill off" title="${h(Sync.message)}" onclick="A.showSyncMessage()"><span class="dot"></span>寫入被拒，點擊看原因</button>`;
  }
  if (Sync.state === 'fail') {
    return `<button class="sync-pill off" onclick="A.retrySync()"><span class="dot"></span>離線，點擊重試</button>`;
  }
  if (Sync.hasPendingWrites) {
    return `<span class="sync-pill busy"><span class="dot"></span>本機已存，同步中…</span>`;
  }
  return `<span class="sync-pill ok"><span class="dot"></span>已同步</span>`;
}

// 決策紀錄第 17 條：沒有「今日」頁了——本週頁預設展開今天那一列。
function renderDesktopNav(state) {
  const tabs = [['week', '本週'], ['overview', '總覽'], ['settings', '設定']];
  return `<div class="desktopnav">${tabs.map(([id, label]) =>
    `<button class="${state.page === id ? 'active' : ''}" onclick="A.goTo('${id}')">${label}</button>`).join('')}</div>`;
}

function renderBottomNav(state) {
  const tabs = [['week', '本週', ICON.week], ['overview', '總覽', ICON.chart], ['settings', '設定', ICON.user]];
  return `
    <div class="bottomnav"><div class="bottomnav-inner">
      ${tabs.map(([id, label, icon]) => `
        <button class="navbtn ${state.page === id ? 'active' : ''}" onclick="A.goTo('${id}')">
          ${icon}<span>${label}</span>
        </button>`).join('')}
    </div></div>
  `;
}

function renderPage(state) {
  if (state.page === 'overview') return renderOverviewPage(state);
  if (state.page === 'settings') return renderSettingsPage(state);
  return renderWeekPage(state);
}

// ── 一天展開後的內容（本週頁手風琴的列身；決策紀錄第 17、23 條）──────────────
// 一般模式：一張「當天紀錄卡」，課表項目是卡片標題，底下照運動回來先記什麼排
// （見 renderDayRecordCard）。教練模式：項目卡另外畫（有編輯工具列，塞不進合併的卡片），
// 紀錄卡畫在下面、不重畫標題。本週回顧不在這裡——第 23 條搬到頂端的本週訓練目標卡。
// userId：決策紀錄第 53 條，看別人的紀錄時是那個人（唯讀）；沒給＝自己。
function renderDayBody(weekNumber, dayIndex, userId) {
  const uid = userId || Store.activeUserId;
  const viewingOther = uid !== Store.activeUserId;
  const w = Store.effectiveWeek(weekNumber);
  // dayIndex 是日曆格子；教練模式下 effectiveDayOrder 一律回傳出廠順序，所以這裡
  // 同時是「要編輯的出廠天」（coach 專用的按鈕都掛在這條路徑上，見下方 coachToolbar）。
  // 非教練模式時若這天被對調過（決策紀錄第 14 條），這裡顯示的就是對調後的內容。
  const order = Store.effectiveDayOrder(weekNumber, uid);
  const contentIndex = order[dayIndex];
  const d = w.days[contentIndex];
  const dateKey = PlanData.keyForWeekDay(weekNumber, dayIndex);
  const isExpired = PlanData.isExpired(weekNumber, dayIndex);
  const entry = Store.entryFor(uid, dateKey);
  const coach = Store.coachMode && !viewingOther;

  let html = `<div class="section day-body">`;

  if (isExpired) {
    html += `<div class="banner info">${ICON.info}<div><b>這天已過期</b>起算日修正後，${h(PlanData.plan.expiredBefore)} 之前的日期不計入完成率，也不需要補做。</div></div>`;
  }

  // 身體狀況只有本人讀得到（Firebase 規則），看別人時不畫
  if (!viewingOther) {
    const priv = Store.privateFor(dateKey);
    if (priv && priv.flags && (priv.flags.leakage || priv.flags.pain || priv.flags.overTired)) {
      const active = Object.keys(priv.flags).filter((k) => priv.flags[k]).map((k) => FLAG_LABELS[k]).join('、');
      html += `<div class="banner crit">${ICON.warn}<div><b>這天記錄了異常：${h(active)}</b>建議隔天視狀況減量或休息。若持續出現，${h(PlanData.plan.safety.disclaimer)}</div></div>`;
    }
  }

  if (viewingOther) {
    if (d.dayNotes) html += `<div class="banner info">${ICON.info}<div>${h(d.dayNotes)}</div></div>`;
    html += renderReadOnlyDay(weekNumber, dayIndex, d, entry, uid);
    html += `</div>`;
    return html;
  }

  if (!coach) {
    if (d.dayNotes) html += `<div class="banner info">${ICON.info}<div>${h(d.dayNotes)}</div></div>`;
    html += renderDayRecordCard(weekNumber, dayIndex, d, entry, true);
    html += `</div>`;
    return html;
  }

  html += `
    <div class="day-coach-row">
      <label class="toggle-switch">
        <span class="switch"><input type="checkbox" ${d.selectOne ? 'checked' : ''} onchange="A.toggleDaySelectOne(${weekNumber},${dayIndex})"><span class="slider"></span></span>
        這天是「二擇一」
      </label>
    </div>
    <textarea class="note-input daynotes-edit" placeholder="這天的備註（選填，例如二擇一的說明）" onchange="A.setDayNotes(${weekNumber},${dayIndex},this.value)">${h(d.dayNotes || '')}</textarea>
  `;

  // 決策紀錄第 45 條：課表上的項目只能「從項目庫換」「改時間」，今天以前的日子不能改
  const planLocked = PlanData.keyForWeekDay(weekNumber, dayIndex) < PlanData.dayKey(PlanData.today());

  if (d.selectOne) {
    html += d.items.map((item, i) => renderItemCard(weekNumber, dayIndex, item, i, d.items.length, entry, true, isExpired)).join(
      `<div class="choice-or">或</div>`);
  } else {
    html += d.items.map((item, i) => renderItemCard(weekNumber, dayIndex, item, i, d.items.length, entry, false, isExpired)).join('');
  }

  if (planLocked) {
    html += `<div class="coach-locked-note">今天以前的日子不能改。</div>`;
  } else {
    const pk = App.state.itemPicker;
    const addOpen = !!(pk && pk.weekNumber === weekNumber && pk.dayIndex === dayIndex && pk.itemId === 'add');
    html += `<div class="coach-add-row"><button class="btn coach-add-row" aria-expanded="${addOpen}" onclick="A.toggleItemPicker(${weekNumber},${dayIndex},'add')">＋ 從項目庫加一個</button></div>`;
    if (addOpen) html += renderLibraryPickList(weekNumber, dayIndex, 'add', null);
  }

  // 第 46 條：教練模式是改課表的地方，當天紀錄（實際數字、沒照表、體感強度、附註、身體狀況）不畫，關掉教練模式照舊

  html += `</div>`;
  return html;
}

// 決策紀錄第 53 條：看別人的一天（唯讀）。課表項目＋那個人打的勾、當天狀態、實際時間／公里、體感、附註。
// 全部是文字，沒有任何按鈕會寫資料。身體狀況只有本人讀得到，只寫一行說明。
function renderReadOnlyDay(weekNumber, dayIndex, d, entry, uid) {
  const dateKey = PlanData.keyForWeekDay(weekNumber, dayIndex);
  const status = Store.dayStatus(weekNumber, dayIndex, uid);
  const st = entryStatus(entry);
  const items = d.items.map((it) => {
    const done = d.selectOne
      ? !!(entry && entry.selectedItemId === it.id && entry.done && entry.done[it.id])
      : !!(entry && entry.done && entry.done[it.id]);
    return `
      <div class="ro-item ${done ? 'done' : ''}">
        <span class="ro-mark" aria-label="${done ? '完成' : '未勾'}">${done ? ICON.check : ''}</span>
        <div class="ro-body"><div class="rec-title">${h(it.title)}${it.type === 'race' ? ' 🏁' : ''}</div>${itemPlanParts(it, { dateKey }).body}</div>
      </div>`;
  }).join(d.selectOne ? '<div class="choice-or">或</div>' : '');
  const nums = [];
  if (entry && entry.actualDurationMinutes != null) nums.push(`實際時間 ${entry.actualDurationMinutes} 分`);
  if (entry && entry.actualDistanceKm != null) nums.push(`實際公里 ${entry.actualDistanceKm} km`);
  if (entry && Number.isInteger(entry.effort) && st !== 'rested') nums.push(`體感 ${entry.effort} · ${effortLabel(entry.effort)}`);
  const isAllRest = d.items.every((it) => it.type === 'rest');
  return `
    <div class="card rec-card ro-card">
      <div class="rec-sec">${items}</div>
      <div class="rec-sec">
        <div class="ro-status">${isAllRest && status === 'pending' ? '休息日' : h(dayStatusLabel(status, dateKey) + (status === 'substituted' && entry && SUBSTITUTE_LABELS[entry.substituteType] ? '·' + SUBSTITUTE_LABELS[entry.substituteType] : ''))}</div>
        ${nums.length ? `<div class="ro-nums">${h(nums.join('　'))}</div>` : ''}
        ${entry && entry.actualNote ? `<div class="ro-note"><span class="rec-lbl">附註</span>${h(entry.actualNote)}</div>` : ''}
      </div>
      <div class="rec-sec ro-private">🔒 身體狀況只有本人看得到。</div>
    </div>`;
}

// 項目的課表說明（時長／心率／RPE、影片、動作清單）——教練模式的項目卡跟當天紀錄卡的
// 標題區共用同一份，改一處兩邊一起變。外層卡片不可以點（決策紀錄第 29 條：只有圓圈能打勾），
// 所以這裡的連結跟 <details> 不用擋冒泡。
// opts.dateKey：這張卡是哪一天的——動作清單／影片照日期挑版本（第 33 條：教練改的內容只從改的那天起生效）。
// opts.coachEdit：教練模式的項目卡傳 { weekNumber, dayIndex }，「查看動作」裡多一顆「編輯這份動作清單」。
// opts.amountHtml：教練卡把「時長／距離」那格換成可以改的輸入框（第 45 條）。
function itemPlanParts(item, opts) {
  opts = opts || {};
  const meta = [];
  const metaStr = PlanData.fmtItemMeta(item);
  if (opts.amountHtml) meta.push(opts.amountHtml);
  else if (metaStr) meta.push(metaStr);
  const hrZone = PlanData.fmtHeartRateZone(item.heartRateZone); // 第 30 條：舊的百分比也顯示成 Zone
  if (hrZone) meta.push(`<span class="zone">${h(hrZone)}${item.intensityDerived ? '（推導）' : ''}</span>`);
  if (item.rpe) meta.push(`RPE ${item.rpe.min}-${item.rpe.max}`);

  // 一個項目可以有好幾部影片（第 28 條），每部一個連結。連結上直接寫影片名稱——
  // 好幾個「看影片」並排會分不出哪個是哪個。查不到的（庫還沒同步到這台）略過不畫。
  const links = [];
  PlanData.itemVideoRefs(item).forEach((ref) => {
    const v = Store.videoFor(ref, opts.dateKey);
    // 自訂影片的網址是教練貼的（第 26 條）：只接受 https://，擋掉 javascript: 之類會執行的連結
    // 只要是影片一律實心圓播放鍵開頭（第 32、34 條：一眼分得出哪些是影片），搜尋型的用文字講「搜尋」
    if (v && v.linkType === 'video' && v.url && /^https:\/\//i.test(v.url)) {
      links.push(`<a class="item-link" href="${h(v.url)}" target="_blank" rel="noopener">${ICON.playCircle}<span>${h(v.title || '看影片')}</span></a>`);
    } else if (v && v.linkType === 'search') {
      const q = encodeURIComponent(v.searchQuery || v.title);
      links.push(`<a class="item-link" href="https://www.youtube.com/results?search_query=${q}" target="_blank" rel="noopener">${ICON.playCircle}<span>搜尋「${h(v.creator ? v.creator + ' ' : '')}${h(v.title)}」</span></a>`);
    } else if (v && v.linkType === 'none') {
      // 「不需要連結（只是說明）」：只顯示文字，不是影片所以不放播放鍵
      links.push(`<span class="item-link plain">${h(v.title)}</span>`);
    }
  });
  let workoutBlock = '';
  if (item.workoutRef) {
    const wo = Store.workoutFor(item.workoutRef, opts.dateKey);
    if (wo) {
      // 開關狀態記在 App.state.openDetails（第 29 條），不然任何一次重繪都會把它收起來。
      // key 用項目 id：出廠跟教練新增的 id 全課表唯一；對調日子時開關狀態跟著內容走。
      const dKey = `wo:${item.id || item.workoutRef}`;
      const ce = opts.coachEdit;
      workoutBlock = `
        <details style="margin-top:8px" ${App.state.openDetails[dKey] ? 'open' : ''} ontoggle="A.setDetailsOpen('${jsq(dKey)}', this.open)">
          <summary style="cursor:pointer;font-size:12.5px;font-weight:600;color:var(--accent2)">查看動作（${wo.exercises.length}）</summary>
          <div class="wo-body">
            ${wo.loadGuidance ? `<div class="wo-guide">${h(wo.loadGuidance)}</div>` : ''}
            ${wo.exercises.map((ex) => {
              const qty = ex.reps ? PlanData.fmtRange(ex.reps, ' 次') : (ex.holdSeconds ? PlanData.fmtRange(ex.holdSeconds, ' 秒') : '');
              return `<div>· ${h(ex.name)} · ${ex.sets} 組 × ${qty}${ex.perSide ? '（每邊）' : ''}${ex.notes ? '　' + h(ex.notes) : ''}</div>`;
            }).join('')}
            ${wo.safetyNote ? `<div class="wo-safety">${h(wo.safetyNote)}</div>` : ''}
            ${wo.derived && wo.derivedNote ? `<div class="wo-derived">${h(wo.derivedNote)}</div>` : ''}
            ${ce && !wo.deleted ? `<button type="button" class="link-btn wo-edit" onclick="A.startLibraryEditFromCard(${ce.weekNumber},${ce.dayIndex},'${jsq(item.id)}','${jsq(item.workoutRef)}')">編輯這份動作清單</button>` : ''}
          </div>
        </details>`;
    }
  }
  // 訓練段落（第 42 條）：一段一行，重複組左邊寫「4 ×」，組裡的段縮排
  const segs = PlanData.itemSegments(item);
  const segLine = (st) => `<div class="seg-v-line"><span class="seg-v-kind k-${st.kind}">${h(PlanData.SEGMENT_KINDS[st.kind])}</span><span class="seg-v-body">${[PlanData.fmtSegmentAmount(st.amount), st.zone, st.note].filter(Boolean).map(h).join(' · ')}</span></div>`;
  const segBlock = segs.length ? `<div class="seg-view">${segs.map((sg) => (sg.kind === 'repeat'
    ? `<div class="seg-v-repeat"><div class="seg-v-times">${sg.times} ×</div><div class="seg-v-steps">${sg.steps.map(segLine).join('')}</div></div>`
    : segLine(sg))).join('')}</div>` : '';
  const body = `
    ${meta.length ? `<div class="item-meta">${meta.join('')}</div>` : ''}
    ${segBlock}
    ${item.notes ? `<div class="item-notes">${h(item.notes)}</div>` : ''}
    ${links.length ? `<div class="item-links">${links.join('')}</div>` : ''}
    ${workoutBlock}`;
  return { meta, links, workoutBlock, body };
}

// 當天紀錄卡（決策紀錄第 23 條）。課表項目是標題，底下照「運動回來先記什麼」排：
//   ① 實際公里／分鐘＋完成 → ② 沒照表？更換項目｜自主休息 → ③ 體感強度 → ④ 附註 → ⑤ 身體狀況
// 一張卡、區塊之間用分隔線。沒照表時 ② 移到數字前面：先說換成什麼，再填多少。
// 二擇一的日子先選（第 7 條：兩個選項地位相等，不預設要做），選了非休息的選項才長出數字欄；
// 課表本身有休息選項的二擇一日不另外放「自主休息」——休息只留一條路。
// withPlan=false：教練模式，項目卡畫在上面，這裡不畫標題、也不放「完成」（勾在項目卡上）。
function renderDayRecordCard(weekNumber, dayIndex, d, entry, withPlan) {
  const dateKey = PlanData.keyForWeekDay(weekNumber, dayIndex);
  const isExpired = PlanData.isExpired(weekNumber, dayIndex);
  const isFuture = dateKey > PlanData.dayKey(PlanData.today());
  const st = entryStatus(entry);
  const subType = entry && SUBSTITUTE_LABELS[entry.substituteType] ? entry.substituteType : null;
  const derived = Store.dayStatus(weekNumber, dayIndex);
  const isAllRest = d.items.every((it) => it.type === 'rest');
  const hasRestOption = d.selectOne && d.items.some((it) => it.type === 'rest');
  const chosen = d.selectOne && entry && entry.selectedItemId ? d.items.find((it) => it.id === entry.selectedItemId) || null : null;
  const chosenIsRest = !!(chosen && chosen.type === 'rest');
  // 數字跟體感強度對應「這天實際要做的項目」：二擇一只看選中的那個——還沒選、或選了休息，
  // 就不長數字欄（以前用整天的項目判斷，選了完全休息還會跑出公里框）。
  const active = d.selectOne ? (chosen ? [chosen] : []) : d.items;
  const activeTrains = active.some((it) => it.type !== 'rest');
  const hasRun = active.some((it) => isRunType(it.type) || it.type === 'race');
  // 「完成」按鈕只給「非二擇一、只有一個不是休息的項目」的日子——跟 Store.setActualStats
  // 自動打勾的條件同一套；兩項的日子勾在各自那一行，二擇一「選」本身就算完成。
  const single = !d.selectOne && d.items.length === 1 && d.items[0].type !== 'rest' ? d.items[0] : null;
  const dim = st === 'substituted' || st === 'rested';
  const unsynced = Sync.isSignedIn() && Sync.isWriteFailed('entries', dateKey);

  // 標題右邊的唯讀狀態（第 13b 條：「照表」是文字，不是一顆可以按的 chip）
  const statusText = isAllRest ? '' :
    st === 'substituted' ? `更換項目${subType ? '·' + SUBSTITUTE_LABELS[subType] : ''}` :
    st === 'rested' ? DAY_STATUS_LABELS.rested :
    (derived === 'done' || derived === 'partial') ? `照表 · ${DAY_STATUS_LABELS[derived]}` :
    dayStatusLabel(derived, dateKey);
  const statusHtml = `<span class="rec-status ${st || derived}">${h(statusText)}${unsynced ? ' <span class="rec-unsynced">尚未同步</span>' : ''}</span>`;

  const secs = [];

  // ── 標題：課表項目 ──
  if (withPlan) {
    if (d.selectOne) {
      const opts = d.items.map((it) => {
        const on = !!(chosen && chosen.id === it.id);
        // 只有圓圈能選（決策紀錄第 29 條）：以前整張選項卡都能點，點「查看動作」或影片旁邊一點點
        // 就把這天選掉、算成完成。
        // 未來的日子只能預先選休息那一邊；已經選了的永遠能點掉（第 31 條，Store.canMarkDoneAhead）
        const radio = isExpired
          ? `<span class="rec-radio"></span>`
          : (on || Store.canMarkDoneAhead(dateKey, it.id))
            ? `<button type="button" class="rec-radio" onclick="A.selectChoice(${weekNumber},${dayIndex},'${jsq(it.id)}')" aria-pressed="${on}" aria-label="選這個：${h(it.title)}"></button>`
            : `<button type="button" class="rec-radio" disabled title="還沒到這天，只能預先選休息" aria-label="還沒到這天：${h(it.title)}"></button>`;
        return `
          <div class="rec-opt ${on ? 'on' : ''} ${dim ? 'dim' : ''}">
            <div class="rec-opt-t">${radio}<span class="rec-title ${it.derived ? 'derived' : ''}">${h(it.title)}</span></div>
            ${itemPlanParts(it, { dateKey }).body}
          </div>`;
      }).join('<span class="rec-or">或</span>');
      secs.push(`
        <div class="rec-plan-head"><span class="rec-lbl">今天二選一</span>${statusHtml}</div>
        <div class="rec-choice">${opts}</div>
        ${chosenIsRest ? '<div class="status-hint">休息不是失敗，也不需要改天補。</div>' : ''}`);
    } else {
      const tickable = d.items.length > 1 && !isExpired;
      secs.push(d.items.map((it, i) => {
        const done = !!(entry && entry.done && entry.done[it.id]) && st === null;
        const tick = !tickable ? ''
          : (done || Store.canMarkDoneAhead(dateKey, it.id))
            ? `<button class="rec-tick ${done ? 'on' : ''}" onclick="A.toggleItem(${weekNumber},${dayIndex},'${jsq(it.id)}')" aria-pressed="${done}" aria-label="完成：${h(it.title)}">${ICON.check}</button>`
            : `<button class="rec-tick" disabled title="還沒到這天，不能預先打勾" aria-label="還沒到這天：${h(it.title)}">${ICON.check}</button>`;
        return `
          <div class="rec-line">
            ${tick}
            <div class="rec-line-body">
              <div class="rec-plan-head">
                <span class="rec-title ${dim ? 'dim' : ''} ${it.derived ? 'derived' : ''}">${h(it.title)}${it.type === 'race' ? ' 🏁' : ''}</span>
                ${i === 0 ? statusHtml : ''}
              </div>
              ${itemPlanParts(it, { dateKey }).body}
            </div>
          </div>`;
      }).join(''));
    }
  }

  if (isExpired) return secs.length ? `<div class="card rec-card">${secs.map((s) => `<div class="rec-sec">${s}</div>`).join('')}</div>` : '';

  // ── ① 實際數字＋完成 ──
  // 決策紀錄第 38 條（使用者裁定）：今天以後的日子也看得到、填得了實際公里／分鐘——以前（v0.10.0 起）未來的日子
  // 不畫數字欄，看起來像欄位被刪掉。填了不會自動打勾（Store.setActualStats 對未來的日子不打勾，第 31 條），
  // 「完成」也照舊要當天才出現。
  const showNums = st !== 'rested' && (st === 'substituted' || activeTrains);
  // 換成騎車／游泳的公里沒有意義（週跑量只算跑步）；還沒選類型的舊紀錄照舊可以記公里
  const showKm = showNums && (st === 'substituted' ? (!subType || subType === 'run') : hasRun);
  // 第 46 條：以前只有課表寫了時長才給「實際分鐘」，從項目庫換來的間歇跑（只有段落、沒有總時長）只剩公里，
  // 記不了用時。有訓練的日子一律給。
  const showMin = showNums;
  const isDone = derived === 'done';
  // 決策紀錄第 13b 條：未來的日子不能預先打勾完成，所以不給「完成」——但已經被打成完成的
  // （誤觸，或 v0.12.0 以前的漏洞留下的）一定要給，不然沒有任何地方能取消（第 31 條）。
  const showDone = withPlan && st === null && !!single && (!isFuture || isDone);
  const kmVal = entry && entry.actualDistanceKm != null ? entry.actualDistanceKm : '';
  const durVal = entry && entry.actualDurationMinutes != null ? entry.actualDurationMinutes : '';
  const nums = (showKm || showMin || showDone) ? `
    ${isFuture && isDone ? '<div class="status-hint">這天還沒到，應該是誤觸了——再點一下「完成」就能取消。</div>' : ''}
    <div class="rec-nums">
      ${showKm ? `<label class="rec-num">實際公里<input type="number" inputmode="decimal" min="0" step="0.1" value="${h(kmVal)}" onchange="A.setActualStats(${weekNumber},${dayIndex},'distance',this.value)"></label>` : ''}
      ${showMin ? `<label class="rec-num">實際時間<input type="number" inputmode="decimal" min="0" placeholder="分鐘" value="${h(durVal)}" onchange="A.setActualStats(${weekNumber},${dayIndex},'duration',this.value)"></label>` : ''}
      ${showDone ? `<button class="rec-done ${isDone ? 'on' : ''} ${showKm || showMin ? '' : 'solo'}" onclick="A.toggleItem(${weekNumber},${dayIndex},'${jsq(single.id)}')" aria-pressed="${isDone}"><span class="rec-done-circ">${ICON.check}</span>${showKm || showMin ? '完成' : '照表完成'}</button>` : ''}
    </div>` : '';

  // ── ② 沒照表？更換項目｜自主休息 ──
  // 純休息日不放（第 13b 條：在休息日給「更換項目」＝App 主動遞出「用訓練取代休息」）。
  // 課表有休息選項的二擇一日不放「自主休息」——除非這天已經是自主休息（舊紀錄），不然取消不了。
  const chips = isAllRest ? [] : DAY_STATUS_CHIPS.filter(([k]) => !(k === 'rested' && hasRestOption && st !== 'rested'));
  const alt = chips.length ? `
    <div class="rec-alt">
      <span class="rec-q">沒照表？</span>
      ${chips.map(([k, label]) => {
        const disabled = isFuture && k !== 'rested' && st !== k;
        return `<button class="status-chip ${k} ${st === k ? 'active' : ''}" ${disabled ? 'disabled title="未來的日子只能預先排休息"' : ''} onclick="A.setDayStatus(${weekNumber},${dayIndex},'${k}')">${label}</button>`;
      }).join('')}
    </div>
    ${st === 'substituted' ? `<div class="status-row sub-row">
      ${SUBSTITUTE_TYPES.map((k) => `<button class="status-chip sub ${subType === k ? 'active' : ''}" onclick="A.setSubstituteType(${weekNumber},${dayIndex},'${k}')">${SUBSTITUTE_LABELS[k]}</button>`).join('')}
    </div>` : ''}
    ${st ? `<div class="status-hint">${h(st === 'substituted' && !subType ? '換成哪一類？點一個。' : DAY_STATUS_HINTS[st])}</div>` : ''}` : '';

  const action = st === null ? nums + alt : alt + nums;
  if (action.trim()) secs.push(action);

  // ── ③ 體感強度 ──（二擇一：選了非休息的選項、或更換項目時才有東西可以評）
  const showEffort = !isFuture && !isAllRest && st !== 'rested' && (d.selectOne ? (st === 'substituted' || (chosen && !chosenIsRest)) : true);
  if (showEffort) secs.push(renderEffortControl(weekNumber, dayIndex, d, entry));

  // ── ④ 附註（白名單三人看得到）──
  // 「誰看得到」寫在標題旁（第 13a 條）：跟 ⑤ 在同一張卡裡，只剩標題能分流，寫錯框 Security Rules 擋不了。
  secs.push(`
    <div class="rec-lbl">附註 <span class="vis-tag">${h(othersLabel())}</span></div>
    <textarea class="note-input" placeholder="例如：後半段有點喘，放慢了" onchange="A.setActualNote('${dateKey}', this.value)">${h(entry && entry.actualNote || '')}</textarea>`);

  // ── ⑤ 身體狀況（只有本人）──三顆旗標常駐；私密文字框有旗標、有內容、或點了才展開。
  const priv = Store.privateFor(dateKey) || { flags: {}, note: '' };
  const hasFlag = !!(priv.flags && Object.keys(priv.flags).some((k) => priv.flags[k]));
  const noteOpen = hasFlag || !!(priv.note && String(priv.note).trim()) || App.state.privateNoteOpen === dateKey;
  const privateSec = `
    <div class="rec-plan-head">
      <span class="rec-lbl">🔒 身體狀況 <span class="vis-tag private">只有你看得到</span></span>
      ${noteOpen ? '' : `<button class="link-btn" onclick="A.openPrivateNote('${dateKey}')">＋寫給自己</button>`}
    </div>
    <div class="flag-row">
      ${Object.keys(FLAG_LABELS).map((k) => `<button class="flag-chip ${priv.flags && priv.flags[k] ? 'active' : ''}" onclick="A.toggleFlag('${dateKey}','${k}')">${FLAG_LABELS[k]}</button>`).join('')}
    </div>
    ${noteOpen ? `<textarea class="note-input" placeholder="例如：小腿有點緊、下墜感（選填）" onchange="A.setNote('${dateKey}', this.value)">${h(priv.note)}</textarea>` : ''}`;

  return `
    <div class="card rec-card ${withPlan ? '' : 'coach'}">
      ${secs.map((s) => `<div class="rec-sec">${s}</div>`).join('')}
      <div class="rec-sec rec-private">${privateSec}</div>
    </div>`;
}

function renderItemCard(weekNumber, dayIndex, item, itemIndexInDay, itemCountInDay, entry, isSelectOne, isExpired) {
  const coach = Store.coachMode;
  // 從這張卡的「查看動作」打開的動作清單編輯器，就畫在這張卡的位置（第 33 條）
  const le = App.state.libraryEdit;
  if (coach && le && le.origin && le.origin.weekNumber === weekNumber && le.origin.dayIndex === dayIndex && le.origin.itemId === item.id) {
    return renderWorkoutEditor(le);
  }

  const done = isSelectOne
    ? (entry && entry.selectedItemId === item.id && entry.done && entry.done[item.id])
    : (entry && entry.done && entry.done[item.id]);
  const chosen = isSelectOne && entry && entry.selectedItemId === item.id;
  const dateKey = PlanData.keyForWeekDay(weekNumber, dayIndex);
  // 樂觀寫入被 Firestore 拒絕時不回滾這個打勾（見決策紀錄第 0 條：不該因為權限問題
  // 懲罰使用者剛完成的動作），但要讓使用者看得出「這筆沒有真的存到雲端」，
  // 不能讓它看起來跟正常同步過的紀錄一樣。
  const unsynced = Sync.isSignedIn() && Sync.isWriteFailed('entries', dateKey);

  // 決策紀錄第 45 條：教練模式的項目卡沒有編輯表單。名稱是項目庫的選單（點了換成別的常用項目），
  // 時間（長跑是公里）那格可以直接改；其餘內容在「設定 → 常用項目庫」定義。今天以前的日子全部唯讀。
  const editable = coach && dateKey >= PlanData.dayKey(PlanData.today());
  const pk = App.state.itemPicker;
  const pickerOpen = editable && !!(pk && pk.weekNumber === weekNumber && pk.dayIndex === dayIndex && pk.itemId === item.id);
  // 時間平常是文字，點兩下才變輸入框（第 46 條：避免一碰就改到）
  const ae = App.state.amountEdit;
  const amountEditing = editable && !!(ae && ae.weekNumber === weekNumber && ae.dayIndex === dayIndex && ae.itemId === item.id);
  const amountHtml = !editable || item.type === 'rest' ? ''
    : amountEditing ? renderAmountEdit(weekNumber, dayIndex, item) : renderAmountView(weekNumber, dayIndex, item);
  const parts = itemPlanParts(item, { dateKey, coachEdit: coach ? { weekNumber, dayIndex } : null, amountHtml });

  // 只有圓圈能打勾（決策紀錄第 29 條）：以前整張卡都能點，點「查看動作」、影片或備註旁邊都會打勾。
  // 未來的日子不能預先打勾（第 31 條）：還沒勾的圓圈停用，已經勾了的照樣能點掉
  const check = isExpired
    ? `<span class="item-check">${ICON.check}</span>`
    : !(done || Store.canMarkDoneAhead(dateKey, item.id))
    ? `<button type="button" class="item-check" disabled title="還沒到這天，不能預先打勾" aria-label="還沒到這天：${h(item.title)}">${ICON.check}</button>`
    : `<button type="button" class="item-check" onclick="${isSelectOne
      ? `A.selectChoice(${weekNumber},${dayIndex},'${jsq(item.id)}')`
      : `A.toggleItem(${weekNumber},${dayIndex},'${jsq(item.id)}')`}" aria-pressed="${!!done}" aria-label="${isSelectOne ? '選這個' : '完成'}：${h(item.title)}">${ICON.check}</button>`;

  // 存成常用：項目庫裡還沒有一模一樣的才出現（改過時間、或出廠課表的項目）；剛存的那張卡寫「已存進項目庫」
  const inLibrary = coach && !!Store.libraryItemMatching(item);
  const justSaved = coach && App.state.savedFlash === item.id && inLibrary;
  const saveBtn = justSaved
    ? `<span class="saved-flash">已存進項目庫</span>`
    : (coach && !inLibrary && Store.canSaveItemAsTemplate(item) ? `<button onclick="A.saveItemAsTemplate(${weekNumber},${dayIndex},'${jsq(item.id)}')">存成常用</button>` : '');
  const coachToolbar = coach && (editable || saveBtn) ? `
    <div class="coach-toolbar">
      ${editable ? `<button ${itemIndexInDay === 0 ? 'disabled' : ''} onclick="A.moveItem(${weekNumber},${dayIndex},'${jsq(item.id)}',-1)" aria-label="往上移">↑</button>
      <button ${itemIndexInDay === itemCountInDay - 1 ? 'disabled' : ''} onclick="A.moveItem(${weekNumber},${dayIndex},'${jsq(item.id)}',1)" aria-label="往下移">↓</button>` : ''}
      ${saveBtn}
      ${editable ? `<button class="danger" ${itemCountInDay <= 1 ? 'disabled' : ''} onclick="A.deleteItem(${weekNumber},${dayIndex},'${jsq(item.id)}')">刪除</button>` : ''}
    </div>
  ` : '';
  const titleText = `${h(item.title)}${item.type === 'race' ? ' 🏁' : ''}`;
  const titleHtml = editable
    ? `<button type="button" class="item-pick" aria-expanded="${pickerOpen}" onclick="A.toggleItemPicker(${weekNumber},${dayIndex},'${jsq(item.id)}')"><span>${titleText}</span>${ICON.chevronDown}</button>`
    : titleText;

  return `
    <div class="item ${done ? 'done' : ''} ${isExpired ? 'expired' : ''} ${item.derived ? 'derived' : ''}">
      <div class="item-row">
        ${check}
        <div class="item-body">
          <div class="item-title">${titleHtml}${unsynced ? ' <span style="font-size:10px;font-weight:600;color:var(--warn);background:var(--warnBg);border-radius:5px;padding:1px 5px;vertical-align:2px">尚未同步</span>' : ''}</div>
          ${pickerOpen ? renderLibraryPickList(weekNumber, dayIndex, item.id, item) : ''}
          ${parts.body}
          ${isSelectOne && chosen ? `<div class="choice-note">✓ 這次選了這個</div>` : ''}
          ${coachToolbar}
        </div>
      </div>
    </div>
  `;
}

// ── 訓練段落編輯器（決策紀錄第 42 條）─────────────────────────────────────────
// 一段一列（類型、數量、單位、心率、說明），重複組是一個框：「重複 N 次」＋組裡的段。
// 加段／刪段／上下移都直接改表單 DOM、不重繪（跟影片列同一個理由：表單其他欄位打到一半的字不在 state 裡）；
// 新的段從 <template> 複製。存檔時 A._readItemForm 從 DOM 讀，再過 PlanData.cleanSegments。
function renderSegStep(st) {
  st = st || { kind: 'main', amount: null, zone: null, note: '' };
  const a = st.amount || {};
  const tools = `<span class="seg-tools"><button type="button" class="link-btn" onclick="A.segMove(this,-1)" aria-label="往上移">↑</button><button type="button" class="link-btn" onclick="A.segMove(this,1)" aria-label="往下移">↓</button><button type="button" class="link-btn lib-del" onclick="A.segRemove(this)" aria-label="刪除這段">✕</button></span>`;
  return `
    <div class="seg-step" data-seg="step">
      <div class="seg-line">
        <select data-f="kind" aria-label="段落類型">${Object.keys(PlanData.SEGMENT_KINDS).map((k) => `<option value="${k}" ${st.kind === k ? 'selected' : ''}>${PlanData.SEGMENT_KINDS[k]}</option>`).join('')}</select>
        ${tools}
      </div>
      <div class="seg-line">
        <input data-f="min" type="number" inputmode="decimal" min="0" step="any" value="${a.min != null ? h(a.min) : ''}" placeholder="數量" aria-label="數量">
        <span class="seg-dash">–</span>
        <input data-f="max" type="number" inputmode="decimal" min="0" step="any" value="${a.max != null && a.max !== a.min ? h(a.max) : ''}" placeholder="上限" aria-label="上限（選填）">
        <select data-f="unit" aria-label="單位">${Object.keys(PlanData.SEGMENT_UNITS).map((u) => `<option value="${u}" ${(a.unit || 'min') === u ? 'selected' : ''}>${PlanData.SEGMENT_UNITS[u]}</option>`).join('')}</select>
      </div>
      <div class="seg-line seg-line-zn">
        <select data-f="zone" aria-label="心率區間"><option value="">心率不指定</option>${PlanData.HR_ZONE_OPTIONS.map((z) => `<option value="${z}" ${st.zone === z ? 'selected' : ''}>${z}</option>`).join('')}</select>
        <input data-f="note" type="text" maxlength="${PlanData.SEGMENT_LIMITS.note}" value="${h(st.note || '')}" placeholder="說明，例如：MP 配速、慢跑或走路" aria-label="說明">
      </div>
    </div>`;
}
function renderSegRepeat(r) {
  r = r || { times: 4, steps: [{ kind: 'main', amount: null, zone: null, note: '' }, { kind: 'recover', amount: null, zone: null, note: '' }] };
  return `
    <div class="seg-repeat" data-seg="repeat">
      <div class="seg-repeat-head">
        <span>重複</span><input data-f="times" type="number" inputmode="numeric" min="1" max="${PlanData.SEGMENT_LIMITS.times}" value="${h(r.times)}" aria-label="重複次數"><span>次</span>
        <span class="seg-tools"><button type="button" class="link-btn" onclick="A.segMove(this,-1)" aria-label="往上移">↑</button><button type="button" class="link-btn" onclick="A.segMove(this,1)" aria-label="往下移">↓</button><button type="button" class="link-btn lib-del" onclick="A.segRemove(this)" aria-label="刪除這組">✕</button></span>
      </div>
      <div class="seg-list">${r.steps.map(renderSegStep).join('')}</div>
      <button type="button" class="link-btn seg-add-in" onclick="A.segAdd(this,'step')">＋ 在這組加一段</button>
    </div>`;
}
function renderSegmentEditor(segments) {
  const segs = PlanData.cleanSegments(segments);
  return `
        <div class="field wide seg-editor" onchange="A.segUpdateSum(this)">
          <label class="field-lbl">訓練段落（選填）</label>
          <div class="seg-list seg-root">${segs.map((sg) => (sg.kind === 'repeat' ? renderSegRepeat(sg) : renderSegStep(sg))).join('')}</div>
          <div class="seg-sum">${(() => { const t = PlanData.segmentTotals(segs); const r1 = (x) => Math.round(x * 10) / 10; const rng = (o, u) => (r1(o.min) === r1(o.max) ? `${r1(o.min)} ${u}` : `${r1(o.min)}–${r1(o.max)} ${u}`); const p = [t.hasKm ? rng(t.km, '公里') : '', t.hasTime ? rng(t.minutes, '分') : ''].filter(Boolean); return p.length ? `段落合計：約 ${p.join('＋')}` : ''; })()}</div>
          <div class="seg-actions">
            <button type="button" class="link-btn" onclick="A.segAdd(this,'step')">＋ 加一段</button>
            <button type="button" class="link-btn" onclick="A.segAdd(this,'repeat')">＋ 加一組重複</button>
            <button type="button" class="link-btn" onclick="A.segIntervalTemplate(this)">套用間歇範本</button>
          </div>
          <template class="seg-step-tpl">${renderSegStep(null)}</template>
          <template class="seg-repeat-tpl">${renderSegRepeat(null)}</template>
        </div>`;
}

// 常用項目庫的項目表單（決策紀錄第 26、45 條）：項目的內容只在這裡定義，課表上只能換、改時間。
// 用 scoped querySelector 讀值（A.saveTemplateEdit 找 #tpl-edit-... 容器內的 [name=...]），
// 不是把欄位塞進 onclick 參數——特殊字元會拼壞 inline JS。
// 第 45 條精簡：「範本名稱」跟「標題」合成一個「名稱」；強度說明畫面上沒有地方顯示，表單拿掉（存檔保留原值）。
function renderTemplateForm(tpl) {
  const it = tpl.item;
  const formId = `tpl-edit-${tpl.id}`;
  // 下拉選單：內建＋庫裡的自訂。這個項目現在引用的若是已經從庫裡刪掉的，也要放進選項，
  // 不然 <select> 找不到對應值會落回「（無）」，存檔就把引用安靜地洗掉了。
  // 連這台裝置都查不到的（庫還沒同步到、或文件壞了）也一樣保留成一個選項，存檔才不會洗掉。
  const refOptions = (list, currentId, lookup, label) => {
    const opts2 = list.slice();
    if (currentId && !opts2.some((x) => x.id === currentId)) {
      const cur = lookup(currentId);
      opts2.unshift(cur ? { ...cur, __deleted: true } : { id: currentId, __missing: true });
    }
    return opts2.map((x) => `<option value="${h(x.id)}" ${currentId === x.id ? 'selected' : ''}>${x.__missing
      ? '（這台裝置找不到這個自訂項目，存檔會保留原設定）'
      : `${h(label(x))}${String(x.id).startsWith('c-') ? '（自訂）' : ''}${x.__deleted ? '（已從庫中刪除）' : ''}`}</option>`).join('');
  };
  // 影片可以好幾部（第 28 條）：一部一列下拉，「＋ 再加一部影片」從 <template> 複製一列新的進來、
  // ✕ 拿掉那一列——兩個都直接改 DOM、不重繪（見 A.addVideoRow 的註解）。
  const videoRow = (currentId) => `
            <div class="vref-row">
              <select name="videoRefs"><option value="">（無）</option>${refOptions(Store.allVideos(), currentId, (id) => Store.videoById(id), (v) => v.title)}</select>
              <button type="button" class="link-btn vref-del" onclick="A.removeVideoRow(this)" aria-label="拿掉這部影片">✕</button>
            </div>`;
  const curVideos = PlanData.itemVideoRefs(it);
  // 心率區間只能選 Zone（第 30 條）。舊資料的「60-70%」換算後預選；換算不了的舊文字保留成一個選項。
  const hrCur = PlanData.fmtHeartRateZone(it.heartRateZone);
  const hrOptions = (hrCur && !PlanData.HR_ZONE_OPTIONS.includes(hrCur)
    ? [`<option value="${h(hrCur)}" selected>${h(hrCur)}（舊寫法，請改選）</option>`] : [])
    .concat(PlanData.HR_ZONE_OPTIONS.map((z) => `<option value="${z}" ${hrCur === z ? 'selected' : ''}>${z}</option>`)).join('');
  const rangeVal = (r) => r ? [r.min, r.max] : ['', ''];
  const [durMin, durMax] = rangeVal(it.duration);
  const [kmMin, kmMax] = rangeVal(it.distanceKm);
  const [rpeMin, rpeMax] = rangeVal(it.rpe);
  const types = VALID_TYPES.includes(it.type) ? VALID_TYPES : [it.type].concat(VALID_TYPES);
  const pair = (label, a, b, nameA, nameB, attrs) => `
          <div class="field"><label class="field-lbl">${label}</label>
            <div class="range-pair"><input name="${nameA}" type="number" ${attrs} value="${h(a)}"><span>–</span><input name="${nameB}" type="number" ${attrs} value="${h(b)}"></div>
          </div>`;

  // 第 52 條：存檔會套用到今天以後用到它的課表，先講清楚範圍
  const usage = tpl.id === 'new' ? null : Store.templateUsage(tpl.id, it).length;
  const usageLine = usage == null ? ''
    : `<div class="tpl-usage">${usage ? `存檔後，今天起用到這個項目的 <b>${usage}</b> 天會跟著改（只改這次改的地方；某天單獨改過的時間不動；今天以前的日子不動）。` : '課表裡今天以後還沒有用到這個項目。'}</div>`;
  return `
    <div class="item coach-editing" id="${formId}">
      <div class="edit-form">
        ${usageLine}
        <div class="field wide"><label class="field-lbl">名稱</label><input name="title" type="text" maxlength="80" value="${h(tpl.name || it.title)}" placeholder="例如：Zone 2 跑"></div>
        <div class="field wide"><label class="field-lbl">類型</label>
          <select name="type">${types.map((t) => `<option value="${t}" ${it.type === t ? 'selected' : ''}>${TYPE_LABELS[t] || t}</option>`).join('')}</select>
        </div>
        <div class="row">
          ${pair('時長（分）', durMin, durMax, 'durationMin', 'durationMax', 'min="0" inputmode="numeric"')}
          ${pair('距離（K）', kmMin, kmMax, 'distanceMin', 'distanceMax', 'min="0" step="0.1" inputmode="decimal"')}
        </div>
        <div class="row">
          <div class="field"><label class="field-lbl">心率</label><select name="heartRateZone"><option value="">（無）</option>${hrOptions}</select></div>
          ${pair('RPE', rpeMin, rpeMax, 'rpeMin', 'rpeMax', 'min="0" max="10" inputmode="numeric"')}
        </div>
        ${renderSegmentEditor(it.segments)}
        <div class="field wide">
          <label class="field-lbl">影片</label>
          <div class="vref-list">${(curVideos.length ? curVideos : [null]).map(videoRow).join('')}</div>
          <template class="vref-tpl">${videoRow(null)}</template>
          <button type="button" class="link-btn vref-add" onclick="A.addVideoRow('${jsq(formId)}')">＋ 再加一部影片</button>
        </div>
        <div class="field wide">
          <label class="field-lbl">動作清單</label>
          <select name="workoutRef"><option value="">（無）</option>${refOptions(Store.allWorkouts(), it.workoutRef, (id) => Store.workoutById(id), (w) => w.name)}</select>
        </div>
        <div class="field wide"><label class="field-lbl">備註</label><textarea name="notes">${h(it.notes || '')}</textarea></div>
        <div class="actions">
          <button class="btn" style="background:var(--warn)" onclick="A.saveTemplateEdit('${jsq(tpl.id)}')">儲存</button>
          <button class="btn secondary" onclick="A.cancelLibraryEdit()">取消</button>
        </div>
      </div>
    </div>
  `;
}

// 常用項目一行說明：類型 · 時長／距離 · 心率 · N 段訓練段落（項目庫列表、課表上的挑選清單共用）
function templateMetaText(item) {
  const segs = PlanData.itemSegments(item);
  return [TYPE_LABELS[item.type] || item.type, PlanData.fmtItemMeta(item), PlanData.fmtHeartRateZone(item.heartRateZone), segs.length ? `${segs.length} 段訓練段落` : '']
    .filter(Boolean).join(' · ');
}

// 課表上點項目名稱（或「＋ 從項目庫加一個」）打開的清單（第 45 條）。target：項目 id，或 'add'。
// current：換的是哪個項目——跟它一模一樣的常用項目打勾。
function renderLibraryPickList(weekNumber, dayIndex, target, current) {
  const templates = Store.libraryList('item');
  const same = current ? Store.libraryItemMatching(current) : null;
  const rows = templates.map((t) => {
    const on = !!(same && same.id === t.id);
    const action = target === 'add'
      ? `A.addItemFromLibrary(${weekNumber},${dayIndex},'${jsq(t.id)}')`
      : `A.swapItemFromLibrary(${weekNumber},${dayIndex},'${jsq(target)}','${jsq(t.id)}')`;
    return `<button type="button" class="pick-row ${on ? 'on' : ''}" onclick="${action}">
        <span class="pick-mark">${on ? ICON.check : ''}</span>
        <span class="pick-text"><span class="pick-name">${h(t.name)}</span><span class="pick-meta">${h(templateMetaText(t.item))}</span></span>
      </button>`;
  }).join('');
  return `
    <div class="pick-list">
      ${rows || `<div class="pick-empty">項目庫還沒有項目。在課表項目下面按「存成常用」，或到「設定 → 常用項目庫」新增。</div>`}
      <button type="button" class="pick-foot link-btn" onclick="A.goTo('settings')">到項目庫新增或修改 ›</button>
    </div>`;
}

// 課表項目卡上的時間（長跑是公里）輸入框（第 45 條）。有距離沒時長的畫距離；其餘畫時長（沒填也畫，才有地方填）。
function renderAmountEdit(weekNumber, dayIndex, item) {
  const box = (name, r, key, unit, step) => `
    <span class="amt-edit" data-amt="${key}">
      <input type="number" min="0" ${step ? `step="${step}" inputmode="decimal"` : 'inputmode="numeric"'} value="${r ? h(r.min) : ''}" aria-label="${name}下限" onchange="A.setItemAmount(${weekNumber},${dayIndex},'${jsq(item.id)}',this)" onkeydown="if(event.key==='Enter')this.blur()">
      <span>–</span>
      <input type="number" min="0" ${step ? `step="${step}" inputmode="decimal"` : 'inputmode="numeric"'} value="${r ? h(r.max) : ''}" aria-label="${name}上限" onchange="A.setItemAmount(${weekNumber},${dayIndex},'${jsq(item.id)}',this)" onkeydown="if(event.key==='Enter')this.blur()">
      <span>${unit}</span>
    </span>`;
  const useKm = !!item.distanceKm && !item.duration;
  const both = !!item.distanceKm && !!item.duration;
  // 焦點離開整組（不是跳到同一組的另一格）＝改完了，收回文字
  return `<span class="amt-group" data-amt-item="${h(item.id)}" onfocusout="A.amountFocusOut(event,this)">${useKm ? '' : box('時長', item.duration, 'duration', '分', null)}${useKm || both ? box('距離', item.distanceKm, 'distanceKm', 'K', '0.1') : ''}</span>`;
}

// 課表項目卡上時間的文字（第 46 條）：點兩下變成輸入框。沒有時間的寫「— 分」，才有地方點。
function renderAmountView(weekNumber, dayIndex, item) {
  const txt = PlanData.fmtItemMeta(item) || '— 分';
  return `<button type="button" class="amt-view ${PlanData.fmtItemMeta(item) ? '' : 'empty'}" onclick="A.amountTap(${weekNumber},${dayIndex},'${jsq(item.id)}')" title="點兩下修改時間" aria-label="時間 ${h(txt)}，點兩下修改">${h(txt)}</button>`;
}

// 附註欄標題旁的「誰看得到」（決策紀錄第 13a 條：分流靠標題，不靠 placeholder）。
function othersLabel() {
  const others = PlanData.users.filter((u) => u.userId !== Store.activeUserId).map((u) => u.displayName);
  return others.length ? `${others.join('、')} 看得到` : '只有你';
}

// 體感強度（決策紀錄第 17 條）：Apple Fitness「Rate Your Effort」的四階梯，十個點，
// 點哪個就是幾分，再點一次清掉。淡色的點是課表要求的 RPE 區間（項目的 rpe 欄位，
// 二擇一取選中的那個）。只有「打得比課表高」才提示——第 0 條：實際比要求吃力是要
// 留意的訊號，不是反過來要往上打。
function renderEffortControl(weekNumber, dayIndex, d, entry) {
  const val = entry && Number.isInteger(entry.effort) ? entry.effort : null;
  const items = d.selectOne
    ? d.items.filter((it) => entry && entry.selectedItemId === it.id)
    : d.items;
  const rpes = items.filter((it) => it.rpe && Number.isFinite(it.rpe.min) && Number.isFinite(it.rpe.max)).map((it) => it.rpe);
  const plan = rpes.length ? { min: Math.min(...rpes.map((r) => r.min)), max: Math.max(...rpes.map((r) => r.max)) } : null;
  const over = val != null && plan && val > plan.max;
  const helpOpen = !!App.state.helpOpen.effort;
  const bands = EFFORT_BANDS.map(([a, z, label], bi) => {
    let dots = '';
    for (let n = a; n <= z; n++) {
      const cls = ['effort-dot', val === n ? 'sel' : '', plan && n >= plan.min && n <= plan.max ? 'plan' : ''].filter(Boolean).join(' ');
      dots += `<button class="${cls}" onclick="A.setEffort(${weekNumber},${dayIndex},${n})" aria-label="${n} ${label}"></button>`;
    }
    // 決策紀錄第 21 條：四組不再靠高度分輕重，等高＋各自的底色（CSS 的 .b0-.b3）就夠分辨。
    return `<div class="effort-band b${bi}">${dots}</div>`;
  }).join('');
  return `
    <div class="effort">
      <div class="effort-head">
        <span class="rec-lbl" style="margin:0">體感強度</span>
        <span class="effort-val">${val != null ? `<b>${val}</b> · ${effortLabel(val)}` : '<span class="muted">練完點一下</span>'}</span>
        <button class="help-btn ${helpOpen ? 'on' : ''}" onclick="A.toggleHelp('effort')" aria-label="說明">${ICON.help}</button>
      </div>
      <div class="effort-bar">${bands}</div>
      <div class="effort-legend">${EFFORT_BANDS.map((b) => `<span>${b[2]}</span>`).join('')}</div>
      ${over ? `<div class="status-hint over">比課表要求（RPE ${plan.min}-${plan.max}）吃力——隔天看狀況，不要硬撐。</div>` : ''}
      ${helpOpen ? `<div class="status-hint">練完自己打 1-10：1-3 輕鬆（可以聊天）、4-6 中等（能講短句）、7-8 困難（只能講幾個字）、9-10 全力。${plan ? `淡綠的點是課表要求的 RPE ${plan.min}-${plan.max}；` : ''}打得比課表高才需要注意，打得低不用追。</div>` : ''}
    </div>`;
}

// 本週回顧：異常旗標天數、體感比課表吃力的天數（第 17 條的 effort vs 項目 rpe，
// 二擇一取選中的那個）、本週已降量的標記。吃力天數只是提醒「下週不要加」，
// 不是叫她補——第 0 條。決策紀錄第 23 條：從週日那一列搬到頂端「本週訓練目標」卡，
// 每天都看得到；沒有異常、沒有吃力、沒有標記降量時整段不顯示。
function renderWeeklyReviewCard(weekNumber, userId) {
  const uid = userId || Store.activeUserId;
  const self = uid === Store.activeUserId; // 看別人（第 53 條）：身體狀況讀不到、降量也不能幫他標
  let flaggedDays = 0, overDays = 0;
  const w = Store.effectiveWeek(weekNumber);
  const order = Store.effectiveDayOrder(weekNumber, uid);
  for (let i = 0; i < 7; i++) {
    const key = PlanData.keyForWeekDay(weekNumber, i);
    const p = self ? Store.privateFor(key) : null;
    if (p && p.flags && (p.flags.leakage || p.flags.pain || p.flags.overTired)) flaggedDays++;
    const e = Store.entryFor(uid, key);
    if (e && Number.isInteger(e.effort)) {
      const d = w.days[order[i]];
      const items = d.selectOne ? d.items.filter((it) => it.id === e.selectedItemId) : d.items;
      const maxes = items.filter((it) => it.rpe && Number.isFinite(it.rpe.max)).map((it) => it.rpe.max);
      if (maxes.length && e.effort > Math.max(...maxes)) overDays++;
    }
  }
  const adj = Store.weekAdjustmentFor(weekNumber, uid);
  // 看 reduced 不看 adj 存不存在：拖曳換過順序（第 18 條）也會產生 weekAdjustments 文件，
  // 那不代表這週有事要回顧——搬到頂端之後，這個判斷錯了會每天掛一句「這週狀況正常」。
  const reduced = !!(adj && adj.reduced);
  if (flaggedDays === 0 && overDays === 0 && !reduced) return '';
  const summary = flaggedDays > 0
    ? `這週有 ${flaggedDays} 天記錄異常。${h(PlanData.plan.safety.weeklySelfCheck)}`
    : (overDays > 0 ? '' : '這週狀況正常。');
  const overLine = overDays > 0 ? `<div style="margin-top:${flaggedDays > 0 ? 6 : 0}px">這週有 ${overDays} 天體感比課表要求吃力——下週照表，不要加。</div>` : '';
  return `
    <div class="banner ${flaggedDays > 0 ? 'warn' : 'info'}">
      ${ICON.flag}
      <div>
        <b>本週回顧</b>
        ${summary}${overLine}
        ${reduced
          ? `<div style="margin-top:6px;font-weight:600">✓ 已標記本週降量${adj.note ? '：' + h(adj.note) : ''}</div>`
          : (self ? `<button class="btn secondary" style="margin-top:8px;width:auto;padding:7px 12px;font-size:12.5px" onclick="A.markWeekReduced(${weekNumber})">標記本週已降量</button>` : '')}
      </div>
    </div>
  `;
}

// ── 頁面 2：週視圖 ───────────────────────────────────────────────────────────
function renderWeekPage(state) {
  const wn = state.weekViewNumber;
  const w = Store.effectiveWeek(wn);
  const phase = PlanData.phaseForWeek(wn);
  // 決策紀錄第 53 條：「在看誰」跟「我是誰」分開。看別人時整頁唯讀：畫那個人的紀錄，改課表的工具收起來
  const viewingId = state.viewingUserId && state.viewingUserId !== Store.activeUserId && PlanData.userById[state.viewingUserId] ? state.viewingUserId : null;
  const uid = viewingId || Store.activeUserId;
  if (viewingId) {
    Sync.subscribeOtherEntries(viewingId, () => window.render && window.render());
    Sync.subscribeOtherWeekAdjustments(viewingId, () => window.render && window.render());
  }
  const coach = Store.coachMode && !viewingId;
  const hasOverride = !!Store.planOverrides[wn];
  const loc = PlanData.locateToday();
  const todayKey = loc.status === 'in-plan' ? loc.key : null;
  // 計畫開始前／結束後 todayKey 是 null，但「過去的日子寫未完成」要用真的今天比
  const todayKeyNow = PlanData.dayKey(PlanData.today());

  const table = Store.weekViewMode === 'table';
  const vol = Store.weekVolume(wn, uid);
  const order = Store.effectiveDayOrder(wn, uid);
  const expanded = state.expandedDay && state.expandedDay.weekNumber === wn ? state.expandedDay.dayIndex : -1;

  // 拖曳換順序（第 18 條）：教練模式下 effectiveDayOrder 一律回傳出廠順序，拖了也不會生效，
  // 所以不畫把手；SortableJS 沒載到（離線、CDN 被擋）也不畫，免得把手看起來像壞了。
  // 決策紀錄第 50 條（取代第 43 條的「只限還沒開始的週」）：教練模式拖到另一天上放開＝兩天的共用課表直接對調
  // （所有人一起變），這週也可以；今天以前的日子鎖住（沒有把手、也不能當落點）。
  // 一般模式拖的照舊是自己的本週順序（第 14、18 條）。
  const canDrag = !table && typeof Sortable !== 'undefined' && !viewingId;

  // 手風琴（決策紀錄第 17 條）：一次只展開一列，展開的列身就是原本「今日」頁的內容。
  const rows = order.map((contentIndex, i) => {
    const d = w.days[contentIndex];
    const status = Store.dayStatus(wn, i, uid);
    const dateLabel = PlanData.dateForWeekDay(wn, i);
    const dateKey = PlanData.keyForWeekDay(wn, i);
    const entry = Store.entryFor(uid, dateKey);
    const isToday = dateKey === todayKey;
    const isOpen = i === expanded;
    const titles = d.items.map((it) => it.title).join(d.selectOne ? ' 或 ' : '、');
    const statusIcon = status === 'done' ? ICON.check : '';
    return `
      <div class="weekday-acc ${isOpen ? 'open' : ''} ${coach && dateKey < todayKeyNow ? 'locked' : ''}" id="day-${wn}-${i}">
        <div class="weekday-row" onclick="A.openDay(${wn},${i})" style="cursor:pointer">
          <div class="weekday-badge ${isToday ? 'today' : ''}">${PlanData.weekdayLabel(i)}<span class="num">${dateLabel.getDate()}</span></div>
          <div class="weekday-status ${status} ${status === 'pending' && dateKey < todayKeyNow ? 'unfinished' : ''}">${statusIcon}</div>
          <div class="weekday-summary">
            <div class="t">${h(titles)}${contentIndex !== i ? `<span class="swap-tag">對調自${PlanData.weekdayLabel(contentIndex)}</span>` : ''}</div>
            <div class="sub">${h(dayStatusText(status, entry, dateKey))}${isToday ? ' · 今天' : ''}</div>
          </div>
          <span class="weekday-chevron">${ICON.chevron}</span>
          ${canDrag && !(coach && dateKey < todayKeyNow) ? `<span class="drag-handle" onclick="event.stopPropagation()" aria-label="${coach ? '按住拖到另一天，兩天對調' : '按住拖曳換順序'}">${ICON.grip}</span>` : ''}
        </div>
        ${isOpen ? `<div class="weekday-body">${renderDayBody(wn, i, uid)}</div>` : ''}
      </div>
    `;
  }).join('');

  const canPrev = wn > 1, canNext = wn < PlanData.plan.totalWeeks;
  const planBanner = loc.status === 'before-start'
    ? `<div class="banner info">${ICON.info}<div>距離開訓還有 ${loc.daysUntilStart} 天（${h(PlanData.plan.startDate)} 起）。</div></div>`
    : loc.status === 'after-plan'
      ? `<div class="banner info">${ICON.check}<div>計畫已結束，已完賽 ${loc.daysSincePlanEnd} 天。到「總覽」看整體回顧。</div></div>`
      : '';
  // 決策紀錄第 35 條：沒登入時看到的是「出廠課表」——教練改過的週、自訂影片、改過的動作清單都存在
  // 雲端，登入才讀得到。使用者在 Safari 分頁（沒登入）跟主畫面 App（有登入）看到不一樣的內容，
  // 以為是 bug：iOS 的 Safari 分頁跟主畫面 App 是兩份分開的儲存空間，登入狀態不共用。
  // 以前只有右上角一顆「點擊登入以同步」，看不出「現在看到的內容不完整」，這裡講清楚。
  // 等 Firebase 回報過一次登入狀態才顯示（已登入的人開 App 時不閃一下、也不把今天那列擠到頂欄底下）。
  // 記憶體裡還留著共用內容（登出之前讀到的）就不能說「出廠課表」，改說「可能不是最新的」。
  const hasSharedInMemory = Object.keys(Store.planOverrides).length > 0 || Object.keys(Store.library).length > 0;
  const signedOutBanner = Sync.authResolved && !Sync.isSignedIn() && Sync.state !== 'signing-in' ? `
    <div class="banner info">${ICON.info}<div><b>${hasSharedInMemory ? '還沒登入，看到的課表可能不是最新的' : '還沒登入，看到的是出廠課表'}</b>教練改過的內容、自訂的影片跟動作清單要登入後才看得到。
      <div><button class="btn secondary lib-add" style="margin-top:8px" onclick="A.signIn()">使用 Google 帳號登入</button></div></div></div>` : '';
  return `
    <div class="section">
      <div class="week-head">
        <button class="navbtn" style="opacity:${canPrev ? 1 : .3}" ${canPrev ? `onclick="A.setWeekView(${wn - 1})"` : 'disabled'}>‹ 上週</button>
        <div style="text-align:center">
          <button type="button" class="week-title-btn" onclick="A.weekTitleTap()" aria-pressed="${coach}">第 ${wn} 週</button>
          <div style="font-size:12px;color:var(--text2)">${h(phase.name)}</div>
        </div>
        <button class="navbtn" style="opacity:${canNext ? 1 : .3}" ${canNext ? `onclick="A.setWeekView(${wn + 1})"` : 'disabled'}>下週 ›</button>
      </div>
      ${viewingId ? `<div class="banner info view-banner">${ICON.info}<div>正在看 <b>${h(PlanData.userById[viewingId].displayName)}</b> 的紀錄（唯讀）。打勾、改課表要回到自己。<div><button class="btn secondary lib-add" style="margin-top:8px" onclick="A.viewWeekOf(null)">回到自己</button></div></div></div>` : ''}
      ${signedOutBanner}
      ${planBanner}
      ${renderWeekVolumeCard(vol, { heading: '本週訓練目標', who: (PlanData.userById[uid] || {}).displayName || uid, whoMenu: Sync.isSignedIn() ? renderViewPicker(state, uid) : null, title: '跑量', footer: renderWeeklyReviewCard(wn, uid), showSafetyAlert: true })}
      <div class="view-toggle">
        <button class="${table ? '' : 'active'}" onclick="A.setWeekViewMode('cards')">卡片</button>
        <button class="${table ? 'active' : ''}" onclick="A.setWeekViewMode('table')">表格（課表｜實際）</button>
      </div>
      ${table ? renderWeekTable(wn, w, order, todayKey, uid) : `<div class="card" ${canDrag ? `data-daylist="${wn}" data-coach="${coach ? 1 : 0}"` : ''}>${rows}</div>`}
      ${viewingId ? '' : (!coach ? renderDayOrderHint(wn, order, canDrag) : renderCoachDragHint(canDrag))}
      ${coach ? renderWeekCoachPanel(wn, w, hasOverride, vol) : ''}
    </div>
  `;
}

// 決策紀錄第 14、18 條：環境因素讓這週某天跟另一天對調，課表項目不變，只是重新標籤。
// 對調本身靠拖曳列上的把手；這裡只剩一行提示，跟對調過之後的「已對調＋還原」。
// 教練模式開著時整行不顯示（那個模式下 effectiveDayOrder 一律回傳出廠順序）。
function renderCoachDragHint(canDrag) {
  if (!canDrag) return '';
  return `<div class="day-order-hint"><span>教練模式：按住 ⋮⋮ 拖到另一天上放開，兩天的課表直接對調（<b>所有人的共用課表</b>）。今天以前的日子不能動。</span></div>`;
}

function renderDayOrderHint(wn, order, canDrag) {
  const swapped = order.map((v, i) => v !== i ? `${PlanData.weekdayLabel(i)}顯示${PlanData.weekdayLabel(v)}的內容` : null).filter(Boolean);
  if (!swapped.length && !canDrag) return '';
  return `
    <div class="day-order-hint">
      <span>${swapped.length
        ? `已對調（只有你自己看得到）：${h(swapped.join('、'))}`
        : '按住 ⋮⋮ 拖曳可換這週的順序，課表內容不變（只有你自己看得到）'}</span>
      ${swapped.length ? `<button class="link-btn" onclick="A.resetDayOrder(${wn})">還原順序</button>` : ''}
    </div>
  `;
}

function fmtKmRange(t) { return t.min === t.max ? `${t.min}` : `${t.min}–${t.max}`; }

// 週視圖列的第二行文字：狀態，更換項目時帶類型（「更換項目·重訓」），有體感就帶上。
// 過去的日子沒記錄寫「未完成」，今天和未來寫「待完成」（dayStatusLabel）。
function dayStatusText(status, entry, dateKey) {
  let s = dayStatusLabel(status, dateKey);
  if (status === 'substituted' && entry && SUBSTITUTE_LABELS[entry.substituteType]) s += '·' + SUBSTITUTE_LABELS[entry.substituteType];
  if (entry && Number.isInteger(entry.effort) && status !== 'rested' && status !== 'expired') s += ` · 體感 ${entry.effort}`;
  return s;
}

// 本週跑量：目標 vs 實際。目標預設是課表跑步項目的加總（Store.weekVolume 的註解有算法）。
// 進度條的 100% 點是目標**下限**——目標是區間，碰到下限就是滿格，超過下限不再畫「多出來」；
// 超過上限改成警示文字。「填滿」型的條會催人往上限跑，這是第 0 條要防的方向。
// 已標記降量的週不畫條、不比對，只顯示實際（第 0 條：降量週縮小分母）。
function renderWeekVolumeCard(vol, opts) {
  opts = opts || {};
  // 本週頁頂端是「本週訓練目標」（決策紀錄第 23 條）：跑量變成其中一項，底下接本週回顧。
  // 總覽頁用同一張卡但不帶 heading／footer。
  // opts.who：現在是誰的紀錄（使用者要的：標題前面放名字，才知道目前是誰）。
  // opts.whoMenu：登入後名字可以點開，選要看誰（第 53 條）；選單本身由 renderViewPicker 畫
  const whoChip = !opts.who ? ''
    : opts.whoMenu != null
      ? `<button type="button" class="vol-who pick" onclick="A.toggleViewMenu()" aria-expanded="${!!App.state.viewMenuOpen}">${h(opts.who)}${ICON.chevronDown}</button>`
      : `<span class="vol-who">${h(opts.who)}</span>`;
  const heading = opts.heading ? `<div class="vol-heading">
    <span class="vol-heading-text">${whoChip}${h(opts.heading)}</span>
    ${opts.showSafetyAlert ? `<button class="icon-btn alert" onclick="A.openModal('safety')" aria-label="安全提醒" title="開始前 / 安全提醒">${ICON.alert}</button>` : ''}
  </div>` : '';
  const footer = opts.footer || '';
  const whoMenu = opts.whoMenu && App.state.viewMenuOpen ? opts.whoMenu : '';
  const t = vol.target, actual = vol.actual;
  const anchor = t.min > 0 ? t.min : t.max;
  const reached = actual != null && anchor > 0 && actual >= anchor;
  // 「超過上限」只在目標是真距離時才有意義。以時間計的項目換算出來的 max 本來就是刻意
  // 低估的約略值（見下面 how 的文字），拿它當硬上限會冤枉完全照表、只是配速比 9 分速快
  // 的人——Phase 1-4 的 Zone 2 跑幾乎每週都只有時長沒有公里，timeBased 這條路一直是 true，
  // 審查實測：照表跑滿分鐘、用原文自己的 8 分速記公里，W1-W8 全部會被判「超過」。
  const over = actual != null && t.max > 0 && !t.timeBased && actual > t.max;
  const pct = anchor > 0 && actual != null ? Math.min(100, Math.round((actual / anchor) * 100)) : 0;
  const pace = PlanData.plan.timeBasedRunPaceMinPerKm;
  const how = `預計＝本週課表跑步項目的加總${t.timeBased ? `（以時間計的項目用 ${pace} 分速換算，約略值、偏低）` : ''}。${vol.goal ? '目標跑量是教練另外設的數字，不影響進度條。' : ''}`;
  const goalLine = vol.goal ? `<div class="vol-sub">目標跑量 ${fmtKmRange(vol.goal)} km</div>` : '';
  const actualStr = actual == null ? '—' : `${actual}${vol.estimated ? '<span class="approx">約</span>' : ''}`;
  const raceLine = vol.race ? `<div class="vol-sub">週日比賽 ${vol.race.planned} km 另計${vol.race.actual != null ? `（已記錄 ${vol.race.actual} km）` : ''}。</div>` : '';
  // 說明文字收進「？」（使用者要的）：卡片平常只留數字跟進度條。
  const helpOpen = !!App.state.helpOpen.vol;
  const helpBtn = `<button class="help-btn ${helpOpen ? 'on' : ''}" onclick="A.toggleHelp('vol')" aria-label="說明">${ICON.help}</button>`;
  const helpText = helpOpen ? `<div class="vol-sub">${h(how)}實際＝各天「實際公里」的加總${vol.estimated ? '（沒填公里、只填分鐘的日子用同一個分速換算）' : ''}。預計下限＝進度條滿格；超過預計上限會提醒，不會畫「多出來」。</div>` : '';
  if (vol.reduced) {
    return `
      <div class="card vol-card">
        ${heading}
        ${whoMenu}
        <div class="vol-head">
          <span class="vol-title">${h(opts.title || '本週跑量')}</span>
          <span class="vol-nums"><b>${actualStr}</b> km</span>
          ${helpBtn}
        </div>
        <div class="vol-sub">本週已標記降量——只記錄實際，不比對目標（原定 ${fmtKmRange(t)} km）。</div>
        ${goalLine}
        ${helpText}
        ${raceLine}
        ${footer}
      </div>`;
  }
  return `
    <div class="card vol-card">
      ${heading}
      ${whoMenu}
      <div class="vol-head">
        <span class="vol-title">${h(opts.title || '本週跑量')}</span>
        <span class="vol-nums"><b>${actualStr}</b> / ${fmtKmRange(t)} km${reached && !over ? ' ✓' : ''}</span>
        ${helpBtn}
      </div>
      <div class="progress-track"><div class="progress-fill ${reached ? 'reached' : ''}" style="width:${pct}%"></div></div>
      ${over ? `<div class="vol-sub over">已超過本週課表上限（${t.max} km）——下週不要再加。</div>` : ''}
      ${goalLine}
      ${helpText}
      ${raceLine}
      ${footer}
    </div>
  `;
}

// 決策紀錄第 53 條：本週訓練目標前面的名字點開＝選要看誰的紀錄（自己可以打勾；別人唯讀）
function renderViewPicker(state, uid) {
  return `<div class="pick-list view-pick">${PlanData.users.map((u) => {
    const self = u.userId === Store.activeUserId;
    const on = u.userId === uid;
    return `<button type="button" class="pick-row ${on ? 'on' : ''}" onclick="A.viewWeekOf(${self ? 'null' : `'${jsq(u.userId)}'`})">
        <span class="pick-mark">${on ? ICON.check : ''}</span>
        <span class="pick-text"><span class="pick-name">${h(u.displayName)}${self ? '（自己）' : ''}</span><span class="pick-meta">${self ? '可以打勾、記紀錄' : '看每天的紀錄（唯讀）'}</span></span>
      </button>`;
  }).join('')}</div>`;
}

// 表格模式：課表｜實際 並排，模仿舊 Notion 課表那張表——給回顧用；手機上打勾用卡片模式。
function renderWeekTable(wn, w, order, todayKey, userId) {
  const uid = userId || Store.activeUserId;
  const rows = order.map((contentIndex, i) => {
    const d = w.days[contentIndex];
    const status = Store.dayStatus(wn, i, uid);
    const dateLabel = PlanData.dateForWeekDay(wn, i);
    const dateKey = PlanData.keyForWeekDay(wn, i);
    const entry = Store.entryFor(uid, dateKey);
    const planCell = (contentIndex !== i ? `<span class="swap-tag">對調自${PlanData.weekdayLabel(contentIndex)}</span>` : '') +
      d.items.map((it) => {
        const meta = [PlanData.fmtItemMeta(it), PlanData.fmtHeartRateZone(it.heartRateZone)].filter(Boolean).join(' · ');
        return `<div class="wt-item"><span class="wt-title">${h(it.title)}</span>${meta ? `<span class="wt-meta">${h(meta)}</span>` : ''}</div>`;
      }).join(d.selectOne ? '<div class="wt-or">或</div>' : '');
    const bits = [];
    const label = dayStatusLabel(status, dateKey);
    if (status !== 'pending' || label === DAY_STATUS_LABELS.unfinished) bits.push(`<span class="wt-status ${status === 'pending' ? 'unfinished' : status}">${h(label + (status === 'substituted' && entry && SUBSTITUTE_LABELS[entry.substituteType] ? '·' + SUBSTITUTE_LABELS[entry.substituteType] : ''))}</span>`);
    const nums = [];
    if (entry && entry.actualDurationMinutes != null) nums.push(`${entry.actualDurationMinutes} 分`);
    if (entry && entry.actualDistanceKm != null) nums.push(`${entry.actualDistanceKm} km`);
    if (entry && Number.isInteger(entry.effort) && status !== 'rested') nums.push(`體感 ${entry.effort} ${effortLabel(entry.effort)}`);
    if (nums.length) bits.push(`<span class="wt-nums">${h(nums.join(' · '))}</span>`);
    if (entry && entry.actualNote) bits.push(`<div class="wt-note">${h(entry.actualNote)}</div>`);
    return `
      <tr class="${dateKey === todayKey ? 'today' : ''}" onclick="A.openDay(${wn},${i})">
        <td class="wt-day">${PlanData.weekdayLabel(i)}<span class="num">${dateLabel.getDate()}</span></td>
        <td class="wt-plan">${planCell}</td>
        <td class="wt-actual">${bits.length ? bits.join(' ') : '<span class="wt-empty">—</span>'}</td>
      </tr>`;
  }).join('');
  return `
    <div class="card week-table-wrap">
      <table class="week-table">
        <thead><tr><th></th><th>課表</th><th>實際</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// 本週課表設定（教練模式）。決策紀錄第 49 條：「目標跑量」是教練自己訂的數字（不連動、不限制、不影響進度條）；
// 「預計跑量」＝課表加總，唯讀。以前只有一組「週跑量目標」而且只能往下調，被課表加總卡死。
function renderWeekCoachPanel(wn, w, hasOverride, vol) {
  const goal = vol.goal;
  // planOnly：純課表加總，不看任何人的 entries。planOverrides 是三人共用的一份文件，
  // 「課表加總」這個字眼講的是課表本身，不能取決於「誰的手機正在看這頁」。
  const auto = Store.weekTargetAuto(wn, Store.activeUserId, { planOnly: true });
  const stale = hasOverride && (w.basePlanVersion || 3) < PlanData.plan.planVersion;
  return `
    <div class="card" style="margin-top:12px;border-color:var(--warn)">
      <div style="font-weight:700;font-size:12.5px;color:var(--warn);margin-bottom:10px">🛠 本週課表設定</div>
      ${stale ? `<div class="banner warn" style="margin-bottom:10px">${ICON.warn}<div><b>這週的調整是基於舊版出廠課表（v${w.basePlanVersion || 3}）</b>出廠課表已更新到 v${PlanData.plan.planVersion}（例如走跑改成 Zone 2 跑），這週不會自動跟上。要套用新版請按下面「還原本週為出廠預設值」再重新調整。</div></div>` : ''}
      <div class="edit-form">
        <div class="row">
          <div class="field">
            <label class="field-lbl">長跑計量單位</label>
            <select onchange="A.setLongRunMetric(${wn}, this.value)">
              <option value="" ${!w.longRunMetric ? 'selected' : ''}>（無長跑）</option>
              <option value="time" ${w.longRunMetric === 'time' ? 'selected' : ''}>以時間計</option>
              <option value="distance" ${w.longRunMetric === 'distance' ? 'selected' : ''}>以距離計</option>
            </select>
          </div>
        </div>
        <div class="field wide">
          <label class="field-lbl">目標跑量（K）</label>
          <div class="range-pair"><input id="wv-min-${wn}" type="number" min="0" step="0.5" value="${goal ? goal.min : ''}"><span>–</span><input id="wv-max-${wn}" type="number" min="0" step="0.5" value="${goal ? goal.max : ''}"></div>
        </div>
        <div class="wk-plan-line"><span>預計跑量</span><b>${fmtKmRange(auto)} K</b></div>
        <div class="actions">
          <button class="btn" style="background:var(--warn);width:auto;padding:8px 14px;font-size:13px"
            onclick="A.setWeeklyVolume(${wn}, document.getElementById('wv-min-${wn}').value, document.getElementById('wv-max-${wn}').value)">設定目標跑量</button>
          ${goal ? `<button class="btn secondary" style="width:auto;padding:8px 14px;font-size:13px" onclick="A.clearWeeklyVolume(${wn})">清除目標</button>` : ''}
        </div>
        <div style="font-size:11.5px;color:var(--text3)">目標跑量是教練自己訂的數字，不會限制或改變課表，也不影響進度條。預計跑量是這週課表跑步項目的加總，改課表項目會跟著變。</div>
      </div>
      ${hasOverride ? `
        <div class="actions" style="margin-top:14px;padding-top:14px;border-top:1px dashed var(--warn)">
          <button class="btn danger" style="width:auto;padding:8px 14px;font-size:13px" onclick="A.resetWeekOverride(${wn})">還原本週為出廠預設值</button>
        </div>
        <div style="font-size:11.5px;color:var(--text3);margin-top:6px">這週已經被教練模式改過。</div>
      ` : `<div style="font-size:11.5px;color:var(--text3);margin-top:10px">這週目前是出廠預設值。</div>`}
    </div>
  `;
}

// 階段時間軸：26 週一週一格，照階段分組（組寬＝週數，組間留空隙）。過去的週填滿、這週亮起來，
// 階段名稱在格子下面、目前的階段加粗。取代原本「階段色塊＋塊內進度＋另一條整體進度條」——
// 那版塊內進度是一塊比底色還深的色塊蓋在字上，而且設了 480px 最小寬度，手機上要左右捲、
// 最後的「賽週」被切掉；兩條進度條講的又是同一件事。
function renderPhaseTimeline(loc, wn, phase) {
  const phases = PlanData.plan.phases;
  const total = PlanData.plan.totalWeeks;
  // 已經過完的週：計畫進行中＝這週之前；結束後＝全部；還沒開始＝沒有
  const doneBefore = loc.status === 'in-plan' ? wn : (loc.status === 'after-plan' ? total + 1 : 1);
  const isNow = (w) => loc.status === 'in-plan' && w === wn;
  const groups = phases.map((ph) => {
    const [a, b] = ph.weekRange;
    const cells = [];
    for (let w = a; w <= b; w++) {
      cells.push(`<span class="ptl-cell ${isNow(w) ? 'now' : (w < doneBefore ? 'done' : '')}"></span>`);
    }
    const cls = loc.status === 'in-plan' && ph.phaseId === phase.phaseId ? 'current' : (b < doneBefore ? 'past' : '');
    return `
      <div class="ptl-group ${cls}" style="flex-grow:${b - a + 1}" title="${h(ph.name)}：第 ${a}–${b} 週">
        <div class="ptl-cells">${cells.join('')}</div>
        <div class="ptl-name">${h(ph.name)}</div>
      </div>`;
  }).join('');

  const span = phase.weekRange[1] - phase.weekRange[0] + 1;
  const idx = phases.findIndex((ph) => ph.phaseId === phase.phaseId);
  const next = phases[idx + 1];
  let head, foot;
  if (loc.status === 'before-start') {
    head = `<span class="ptl-phase">還沒開訓</span><span class="ptl-weeks">${loc.daysUntilStart} 天後開始</span>`;
    foot = `第一階段：${h(phases[0].name)}（第 ${phases[0].weekRange[0]}–${phases[0].weekRange[1]} 週）`;
  } else if (loc.status === 'after-plan') {
    head = `<span class="ptl-phase">計畫已完成</span><span class="ptl-weeks">共 ${total} 週</span>`;
    foot = '';
  } else {
    head = `<span class="ptl-phase">${h(phase.name)}</span><span class="ptl-weeks">${span > 1 ? `本階段第 ${wn - phase.weekRange[0] + 1} 週／共 ${span} 週` : '最後一週'}</span>`;
    foot = next ? `下一階段：${h(next.name)}，第 ${next.weekRange[0]} 週開始` : '';
  }
  return `
    <div class="ptl">
      <div class="ptl-head">${head}</div>
      <div class="ptl-track">${groups}</div>
      ${foot ? `<div class="ptl-foot">${foot}</div>` : ''}
    </div>`;
}

// ── 頁面 3：整體進度總覽 ─────────────────────────────────────────────────────
function renderOverviewPage(state) {
  const loc = PlanData.locateToday();
  const wn = loc.status === 'in-plan' ? loc.weekNumber : (loc.status === 'before-start' ? 1 : PlanData.plan.totalWeeks);
  const phase = PlanData.phaseForWeek(wn);
  const dr = PlanData.daysUntilRace();
  const viewingUserId = state.viewingUserId || Store.activeUserId;
  const viewingUser = PlanData.userById[viewingUserId];
  const isSelf = viewingUserId === Store.activeUserId;
  // 決策紀錄第 48 條：已經過完的週（有填實際公里的）平均
  const avgVol = Store.averageWeeklyVolume(viewingUserId);

  const stats = `
    <div class="stat-row">
      <div class="stat-tile"><div class="n">${wn}</div><div class="l">目前週次 / ${PlanData.plan.totalWeeks}</div></div>
      <div class="stat-tile"><div class="n">${dr >= 0 ? dr : 0}</div><div class="l">距離比賽（天）</div></div>
      <div class="stat-tile"><div class="n">${pct(Store.weekCompletionRate(wn, viewingUserId))}</div><div class="l">本週完成率</div></div>
      <div class="stat-tile"><div class="n">${avgVol ? avgVol.km : '—'}</div><div class="l">平均週跑量 km${avgVol ? `（${avgVol.weeks} 週）` : ''}</div></div>
    </div>
  `;

  const phaseStrip = renderPhaseTimeline(loc, wn, phase);

  const trend = renderLongRunTrend(viewingUserId);
  const phaseTargetsBlock = renderPhaseTargetsCard(phase, viewingUserId, isSelf, viewingUser, state);
  const goalsBlock = renderGoalsCard(viewingUserId, isSelf, viewingUser);
  const volumeBlock = renderVolumeOverview(wn, viewingUserId);

  const others = PlanData.users.filter((u) => u.userId !== Store.activeUserId);
  const othersBlock = others.length ? `
    <div class="section">
      <div class="section-title">查看別人的進度（唯讀）</div>
      <div class="card">
        <div class="otheruser-row" style="cursor:pointer;${isSelf ? 'font-weight:700' : ''}" onclick="A.viewProgress('${jsq(Store.activeUserId)}')">
          <div class="avatar">${h((PlanData.userById[Store.activeUserId] || {}).displayName || '?').slice(0, 1)}</div>
          <div class="name">我自己</div>
          <div class="pct">${pct(Store.weekCompletionRate(wn, Store.activeUserId))}</div>
        </div>
        ${others.map((u) => {
          Sync.subscribeOtherEntries(u.userId, () => window.render && window.render());
          Sync.subscribeOtherProfile(u.userId, () => window.render && window.render());
          Sync.subscribeOtherWeekAdjustments(u.userId, () => window.render && window.render());
          return `
          <div class="otheruser-row" style="cursor:pointer" onclick="A.viewProgress('${jsq(u.userId)}')">
            <div class="avatar">${h(u.displayName).slice(0, 1)}</div>
            <div class="name">${h(u.displayName)}</div>
            <div class="pct">${pct(Store.weekCompletionRate(wn, u.userId))}</div>
          </div>`;
        }).join('')}
      </div>
      <div class="share-box" style="margin-top:10px">同一個網址，對方用自己的 Google 帳號登入就會自動選成自己；沒有自動選到的話，到「設定」選自己的名字。不需要 GitHub 帳號。</div>
    </div>
  ` : '';

  return `
    <div class="app--desktop-grid">
      <div>
        <div class="section">
          <div class="section-title">${isSelf ? '我的進度' : `${h(viewingUser ? viewingUser.displayName : viewingUserId)} 的進度（唯讀）`}</div>
          ${!isSelf ? `<button class="btn secondary lib-add" style="margin-bottom:10px" onclick="A.viewWeekOf('${jsq(viewingUserId)}', true)">看 ${h(viewingUser ? viewingUser.displayName : viewingUserId)} 每天的紀錄 ›</button>` : ''}
          ${stats}
          ${phaseStrip}
        </div>
        ${phaseTargetsBlock}
        ${goalsBlock}
        ${volumeBlock}
      </div>
      <div>
        <div class="section">
          <div class="section-title">長跑距離趨勢</div>
          <div class="card">${trend}</div>
        </div>
        ${othersBlock}
      </div>
    </div>
  `;
}

// 訓練目標（users/{userId}/profile/goals）：比賽目標一句 + 自訂目標清單。
// 自己的隨時可以編輯；教練模式開著時也能編輯別人的（決策紀錄第 15 條：跟教練模式改
// 課表同一套「白名單內任何人都能做」哲學，不限定某一人是教練）。目標不會改變任何一天
// 的課表內容（第 0 條）。
function renderGoalsCard(userId, isSelf, user) {
  const g = Store.goalsFor(userId) || { raceGoal: '', items: [] };
  const editable = isSelf || Store.coachMode;
  if (!editable) {
    const title = `${h(user ? user.displayName : userId)} 的目標`;
    const empty = !g.raceGoal && !g.items.length;
    return `
      <div class="section">
        <div class="section-title">${title}</div>
        <div class="card">
          ${g.raceGoal ? `<div class="goal-race">🏁 ${h(g.raceGoal)}</div>` : ''}
          ${g.items.map((it) => `<div class="goal-row ${it.done ? 'done' : ''}"><span class="goal-check">${ICON.check}</span><span class="goal-text">${h(it.text)}</span></div>`).join('')}
          ${empty ? `<div style="color:var(--text3);font-size:13px">還沒設定目標</div>` : ''}
        </div>
      </div>`;
  }
  const uid = jsq(userId);
  const title = isSelf ? '我的目標' : `${h(user ? user.displayName : userId)} 的目標`;
  return `
    <div class="section">
      <div class="section-title">${title}${!isSelf ? ' <span class="coach-tag">教練模式編輯</span>' : ''}</div>
      <div class="card goals-card">
        <label class="field-label">比賽目標</label>
        <input class="goal-input" type="text" placeholder="例如：安全完賽、5 小時內、全程不走路" value="${h(g.raceGoal)}" onchange="A.setRaceGoal(this.value,'${uid}')">
        <label class="field-label" style="margin-top:14px">訓練目標</label>
        ${g.items.map((it) => `
          <div class="goal-row ${it.done ? 'done' : ''}">
            <button class="goal-check" onclick="A.toggleGoal('${jsq(it.id)}','${uid}')" aria-label="達成">${ICON.check}</button>
            <input class="goal-text-input" type="text" value="${h(it.text)}" onchange="A.setGoalText('${jsq(it.id)}',this.value,'${uid}')">
            <button class="goal-del" onclick="A.removeGoal('${jsq(it.id)}','${uid}')" aria-label="刪除">×</button>
          </div>`).join('')}
        <div class="goal-add">
          <input id="goal-new" type="text" placeholder="例如：W8 結束可以連續跑 40 分不喘" onkeydown="if(event.key==='Enter'&&!event.isComposing){A.addGoal('${uid}')}">
          <button class="btn secondary" style="width:auto;padding:8px 12px;font-size:13px;flex:none" onclick="A.addGoal('${uid}')">新增</button>
        </div>
        <div style="font-size:11.5px;color:var(--text3);margin-top:10px;line-height:1.5">${isSelf ? '寫給自己（跟一起練的人）看的。' : `以教練模式編輯，${h(user ? user.displayName : userId)} 看得到。`}目標不會改變任何一天的課表內容。</div>
      </div>
    </div>`;
}

// 這個階段第一個「Zone 2 跑」項目的 RPE／體感——findZone2Reference 只找 type==='run'
// 且標題含「Zone 2」的項目（跟 long-run/tempo 不一樣，不能混用），找到就停，
// 純粹當背景參考文字，不是計算依據。用 Store.effectiveWeek 而不是出廠 plan.json，
// 教練若把這階段的 Zone 2 項目改過（例如改了 RPE），這裡要跟著變。
function findZone2Reference(phase) {
  for (let wn = phase.weekRange[0]; wn <= phase.weekRange[1]; wn++) {
    const w = Store.effectiveWeek(wn);
    for (const d of w.days) {
      for (const it of d.items) {
        if (it.type === 'run' && /Zone\s*2/i.test(it.title || '') && (it.rpe || it.intensityNote)) return it;
      }
    }
  }
  return null;
}

// 階段性目標（決策紀錄第 22 條）：Zone 2 配速、跑量、5K 技術指標（Cadence/VO/GCT/步幅）
// 依訓練階段各自設定。跟訓練目標卡同一套編輯權限（isSelf || 教練模式）。只有跑量目標
// 有「累積實際 vs 目標」的比對（沿用 weekVolume 的算法加總），其餘五項純參考不追蹤實際——
// 這是這一版刻意的範圍（配速／技術指標要不要比對實際留到之後再討論）。
// 六個欄位一次存（一顆按鈕，讀整份表單），不是六次個別寫入——跟教練模式的項目編輯表單
// 同一種「整份讀、整份存」模式。
function renderPhaseTargetsCard(currentPhase, viewingUserId, isSelf, viewingUser, state) {
  const phases = PlanData.plan.phases;
  const shownPhaseId = (state.overviewPhaseId && phases.some((p) => p.phaseId === state.overviewPhaseId))
    ? state.overviewPhaseId : currentPhase.phaseId;
  const phase = phases.find((p) => p.phaseId === shownPhaseId) || currentPhase;
  const editable = isSelf || Store.coachMode;
  const targets = Store.phaseTargetsFor(viewingUserId)[phase.phaseId] || {};

  const phaseSelect = `
    <select onchange="A.setOverviewPhase(this.value)">
      ${phases.map((p) => `<option value="${p.phaseId}" ${p.phaseId === shownPhaseId ? 'selected' : ''}>${h(p.name)}${p.phaseId === currentPhase.phaseId ? '（目前）' : ''}</option>`).join('')}
    </select>`;

  // 決策紀錄第 48 條：跑量拆成三行。
  //   目標跑量：教練填的數字，不跟任何東西連動、不比對、不提醒（以前輸入框的灰字是課表加總，看起來像目標就是課表）
  //   預計跑量：課表這階段每週自動目標的加總（phaseVolumeAutoRange）
  //   實際跑量：這階段已經填的實際公里加總（phaseVolumeActual，沒有任何紀錄寫 —，第 0 條：沒資料不是 0）
  const volMeta = PHASE_TARGET_META[1]; // volumeKm
  const volTarget = targets.volumeKm;
  const volPlan = Store.phaseVolumeAutoRange(phase.phaseId, viewingUserId);
  const volActual = Store.phaseVolumeActual(phase.phaseId, viewingUserId);
  const kmLabel = (text) => `<span class="ptgt-label">${h(text)}<span class="muted"> km</span></span>`;
  const targetRow = editable ? `
    <div class="ptgt-row">
      ${kmLabel(volMeta.label)}
      <div class="ptgt-inputs">
        <input name="volumeKm_min" type="number" step="${volMeta.step}" min="0" value="${volTarget ? volTarget.min : ''}">
        <span class="muted">–</span>
        <input name="volumeKm_max" type="number" step="${volMeta.step}" min="0" value="${volTarget ? volTarget.max : ''}">
      </div>
    </div>` : (volTarget ? `<div class="ptgt-row">${kmLabel(volMeta.label)}<span class="ptgt-val">${fmtKmRange(volTarget)}</span></div>` : '');
  const planRow = volPlan ? `<div class="ptgt-row">${kmLabel('預計跑量')}<span class="ptgt-val">${fmtKmRange(volPlan)}</span></div>` : '';
  const actualRow = `<div class="ptgt-row">${kmLabel('實際跑量')}<span class="ptgt-val">${volActual == null ? '—' : volActual}</span></div>`;

  // 這階段 Zone 2 的體感（RPE／強度說明）：配速目標旁邊的背景參考（決策紀錄第 22 條——配速
  // 沒有像跑量那樣的自動天花板可以卡，只能提供這個當安全邊界的提醒，不擋存檔）。
  // 第 30 條之後心率只寫 Zone，「Zone 2 對應心率 Zone 2」沒有資訊，改成講體感。
  const zone2Ref = findZone2Reference(phase);
  const zone2Feel = zone2Ref ? [zone2Ref.rpe ? `RPE ${zone2Ref.rpe.min}-${zone2Ref.rpe.max}` : '', zone2Ref.intensityNote || ''].filter(Boolean).join('、') : '';
  const zone2Hint = zone2Feel ? `這階段的 Zone 2 體感：${h(zone2Feel)}。` : '';

  // 其餘五項：Zone 2 配速＋四個 5K 技術指標，純參考／純目標，不比對實際。
  const otherRows = PHASE_TARGET_META.filter((m) => m.key !== 'volumeKm').map((m) => {
    const r = targets[m.key];
    const hint = m.key === 'zone2Pace' && zone2Hint ? `<div class="ptgt-hint">${zone2Hint}</div>` : '';
    if (!editable) {
      return r ? `<div class="ptgt-row"><span class="ptgt-label">${h(m.label)}</span><span class="ptgt-val">${fmtTargetRange(r, m)} ${h(m.unit)}</span></div>${hint}` : '';
    }
    const minVal = m.kind === 'pace' ? (r ? fmtPace(r.min) : '') : (r ? r.min : '');
    const maxVal = m.kind === 'pace' ? (r ? fmtPace(r.max) : '') : (r ? r.max : '');
    const inputAttrs = m.kind === 'pace' ? `type="text" placeholder="6:30"` : `type="number" step="${m.step}" min="0"`;
    return `
      <div class="ptgt-row">
        <span class="ptgt-label">${h(m.label)}<span class="muted"> ${h(m.unit)}</span></span>
        <div class="ptgt-inputs">
          <input name="${m.key}_min" ${inputAttrs} value="${h(minVal)}">
          <span class="muted">–</span>
          <input name="${m.key}_max" ${inputAttrs} value="${h(maxVal)}">
        </div>
      </div>${hint}`;
  }).join('');

  const editHint = editable ? `<div class="ptgt-note">目標由教練依訓練階段自己判斷，不會被自動限制或比對。預計跑量＝課表這階段的加總；實際跑量＝這階段已填的實際公里加總。</div>` : '';
  const saveBtn = editable ? `<div class="actions" style="margin-top:10px"><button class="btn secondary" style="width:auto;padding:7px 14px;font-size:13px" onclick="A.savePhaseTargets('${jsq(phase.phaseId)}','${jsq(viewingUserId)}')">儲存本階段目標</button></div>` : '';
  const noTargets = !volTarget && PHASE_TARGET_META.every((m) => m.key === 'volumeKm' || !targets[m.key]);

  return `
    <div class="section">
      <div class="section-title">階段目標${!isSelf ? `（${h(viewingUser ? viewingUser.displayName : viewingUserId)}）` : ''}</div>
      <div class="card ptgt-card">
        <div class="ptgt-head">${phaseSelect}</div>
        <form id="ptgt-form" onsubmit="return false">
          ${targetRow}
          ${planRow}
          ${actualRow}
          ${otherRows}
        </form>
        ${!editable && noTargets ? `<div class="muted" style="font-size:13px;margin-top:6px">教練還沒設定這階段的目標</div>` : ''}
        ${editHint}
        ${saveBtn}
      </div>
    </div>
  `;
}

// 週跑量總覽：本週的數字 + 26 週的「目標區間 vs 實際」圖。
// y 軸上限釘在課表目標的最高點（W21-22 約 39K），實際若超過就貼著上緣畫——
// 不讓某一週的離群值把其他 25 週壓成底部一條線。
function renderVolumeOverview(wn, userId) {
  const cur = Store.weekVolume(wn, userId);
  const points = [];
  for (let n = 1; n <= PlanData.plan.totalWeeks; n++) {
    const v = Store.weekVolume(n, userId);
    points.push({ wn: n, min: v.target.min, max: v.target.max, actual: v.actual });
  }
  const w = 520, ht = 150, pad = 24, bottom = 22;
  const maxKm = Math.max(...points.map((p) => p.max), 5) * 1.05;
  const x = (i) => pad + (i / (points.length - 1)) * (w - pad * 2);
  const y = (v) => ht - bottom - (Math.min(v, maxKm) / maxKm) * (ht - bottom - 12);
  const band = points.map((p, i) => `${x(i)},${y(p.max)}`).join(' ') + ' ' +
    points.slice().reverse().map((p) => `${x(points.indexOf(p))},${y(p.min)}`).join(' ');
  const actualPts = points.filter((p) => p.actual != null);
  const actualPath = actualPts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(points.indexOf(p))},${y(p.actual)}`).join(' ');
  const ticks = PlanData.plan.phases.map((ph) => ph.weekRange[0]).concat([PlanData.plan.totalWeeks]);
  return `
    <div class="section">
      <div class="section-title">週跑量</div>
      ${renderWeekVolumeCard(cur, { title: `本週（第 ${wn} 週）` })}
      <div class="card">
        <svg class="trend-chart" viewBox="0 0 ${w} ${ht}" preserveAspectRatio="none">
          <polygon points="${band}" fill="var(--track)" stroke="var(--text3)" stroke-width="0.5" stroke-opacity="0.6"/>
          <line x1="${pad}" y1="${ht - bottom}" x2="${w - pad}" y2="${ht - bottom}" stroke="var(--line)" stroke-width="1"/>
          ${ticks.map((t) => `<text x="${x(t - 1)}" y="${ht - 6}" font-size="10" text-anchor="middle" fill="var(--text3)">W${t}</text>`).join('')}
          ${actualPath ? `<path d="${actualPath}" fill="none" stroke="var(--accent2)" stroke-width="2.5"/>` : ''}
          ${actualPts.map((p) => `<circle cx="${x(points.indexOf(p))}" cy="${y(p.actual)}" r="3" fill="var(--accent2)"/>`).join('')}
        </svg>
        <div class="trend-legend">
          <span><span class="sw" style="background:var(--track)"></span>課表目標區間</span>
          <span><span class="sw" style="background:var(--accent2)"></span>實際</span>
        </div>
      </div>
    </div>`;
}

function renderLongRunTrend(userId) {
  const points = [];
  for (let wn = 1; wn <= PlanData.plan.totalWeeks; wn++) {
    const w = Store.effectiveWeek(wn);
    const longIdx = w.days.findIndex((d) => !d.selectOne && d.items.some((it) => it.type === 'long-run' || it.type === 'race'));
    if (longIdx === -1) continue;
    const item = w.days[longIdx].items.find((it) => it.type === 'long-run' || it.type === 'race');
    if (w.longRunMetric !== 'distance' || !item.distanceKm) continue; // 只畫有公里數的部分（Phase 1 以時間計，不在這張圖裡）
    // longIdx 是出廠課表裡長跑的位置；如果這個人這週對調過日曆順序（決策紀錄第 14 條），
    // 她實際跑的那天不是 longIdx，是「顯示 longIdx 內容」的那個日曆格子——反查 order。
    const order = Store.effectiveDayOrder(wn, userId);
    const calendarSlot = order.indexOf(longIdx);
    const dateKey = PlanData.keyForWeekDay(wn, calendarSlot);
    const entry = Store.entryFor(userId, dateKey);
    points.push({
      wn,
      planned: (item.distanceKm.min + item.distanceKm.max) / 2,
      actual: entry && entry.actualDistanceKm != null ? entry.actualDistanceKm : null,
    });
  }
  if (points.length === 0) return `<div class="empty-state">${ICON.chart}<div>Phase 1 以時間計，還沒有公里數資料</div></div>`;

  const w = 500, ht = 140, pad = 24;
  const maxKm = Math.max(...points.map((p) => Math.max(p.planned, p.actual || 0)), 5);
  const x = (i) => pad + (i / (points.length - 1 || 1)) * (w - pad * 2);
  const y = (v) => ht - 20 - (v / maxKm) * (ht - 40);
  const plannedPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.planned)}`).join(' ');
  const actualPts = points.filter((p) => p.actual != null);
  const actualPathFixed = actualPts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(points.indexOf(p))},${y(p.actual)}`).join(' ');

  return `
    <svg class="trend-chart" viewBox="0 0 ${w} ${ht}" preserveAspectRatio="none">
      <line x1="${pad}" y1="${ht - 20}" x2="${w - pad}" y2="${ht - 20}" stroke="var(--line)" stroke-width="1"/>
      <path d="${plannedPath}" fill="none" stroke="var(--text3)" stroke-width="2" stroke-dasharray="4 3"/>
      ${actualPathFixed ? `<path d="${actualPathFixed}" fill="none" stroke="var(--accent2)" stroke-width="2.5"/>` : ''}
      ${actualPts.map((p) => `<circle cx="${x(points.indexOf(p))}" cy="${y(p.actual)}" r="3" fill="var(--accent2)"/>`).join('')}
    </svg>
    <div class="trend-legend">
      <span><span class="sw" style="background:var(--text3)"></span>課表目標</span>
      <span><span class="sw" style="background:var(--accent2)"></span>實際完成</span>
    </div>
  `;
}

// ── 頁面 4：使用者切換 / 分享設定 ────────────────────────────────────────────
// ── 常用項目庫（決策紀錄第 26 條）─────────────────────────────────────────────
// 教練模式開著時出現在設定頁。三區：
//   常用項目——從課表上任何一個項目按「存成常用」而來；這裡改名、改內容、刪除
//   動作清單——內建 4 份（data/workouts.json）＋自訂的；都能改，改動從今天起生效（第 33 條）
//   影片——內建 8 支（data/videos.json）＋自訂的；同上
// 帶入是複製：改範本不會改到已經排好的日子（使用者選的是複製式）。
function renderLibraryPanel(state) {
  const edit = state.libraryEdit;
  const banners = [
    Sync.libraryDenied ? `<div class="banner warn">${ICON.warn}<div><b>常用項目庫還沒開通</b>Firebase 上的規則還沒加上常用項目庫——請把 firestore.rules.local 整份重新貼到 Firebase Console 發布。<div><button class="btn secondary lib-add" style="margin-top:8px" onclick="A.retrySync()">發布好了，重新讀取</button></div></div></div>` : '',
    !Sync.isSignedIn() ? `<div class="banner info">${ICON.info}<div>還沒登入：存進常用項目庫的東西先留在這台裝置，登入後會自動同步給其他人；登入前重新整理就不見了。</div></div>` : '',
  ].join('');
  const isEditing = (kind, id) => edit && edit.kind === kind && edit.id === id;
  const row = (doc, main, meta) => `
    <div class="lib-row">
      <div class="lib-row-main"><div class="lib-name">${main}</div>${meta ? `<div class="lib-meta">${meta}</div>` : ''}</div>
      <div class="lib-actions">
        <button class="link-btn" onclick="A.startLibraryEdit('${doc.kind}','${jsq(doc.id)}')">編輯</button>
        <button class="link-btn" onclick="A.duplicateLibraryDoc('${doc.kind}','${jsq(doc.id)}')">複製</button>
        <button class="link-btn lib-del" onclick="A.deleteLibraryDoc('${jsq(doc.id)}')">刪除</button>
      </div>
    </div>`;

  const items = Store.libraryList('item');
  const itemRows = items.map((t) => isEditing('item', t.id)
    ? renderTemplateForm(t)
    : row(t, h(t.name), h(templateMetaText(t.item)))).join('');
  // 第 43 條：直接在項目庫新增常用項目（原本只能從課表上某個項目「存成常用」）
  const newItemForm = isEditing('item', 'new')
    ? renderTemplateForm(edit.prefill ? { id: 'new', ...edit.prefill } : { id: 'new', name: '', item: { type: 'run', title: '', duration: null, distanceKm: null, heartRateZone: '', rpe: null, intensityNote: '', segments: null, videoRefs: [], videoRef: null, workoutRef: null, notes: '' } })
    : `<button class="btn secondary lib-add" onclick="A.startLibraryEdit('item','new')">＋ 新增常用項目</button>`;

  // 內建內容（第 33 條）：一列一份，標「內建」／「內建·已修改」，按鈕是「編輯」＋改過才有的「還原內建」
  const usageText = (kind, id) => {
    const u = Store.libraryUsage(kind, id);
    return u.total ? `用在 ${u.total} 天（今天起 ${u.upcoming} 天）` : '課表裡目前沒用到';
  };
  const builtinRow = (kind, id, main, meta) => {
    const modified = Store.builtinModified(kind, id);
    return `
    <div class="lib-row">
      <div class="lib-row-main">
        <div class="lib-name">${main} <span class="lib-tag ${modified ? 'mod' : ''}">${modified ? '內建·已修改' : '內建'}</span></div>
        <div class="lib-meta">${meta}</div>
      </div>
      <div class="lib-actions">
        <button class="link-btn" onclick="A.startLibraryEdit('${kind}','${jsq(id)}')">編輯</button>
        <button class="link-btn" onclick="A.duplicateLibraryDoc('${kind}','${jsq(id)}')">複製</button>
        ${modified ? `<button class="link-btn" onclick="A.restoreBuiltin('${kind}','${jsq(id)}')">還原內建</button>` : ''}
        <button class="link-btn lib-del" onclick="A.deleteBuiltin('${kind}','${jsq(id)}')">刪除</button>
      </div>
    </div>`;
  };
  // 已刪除的內建（第 39 條）：一行一個，按「恢復」放回常用項目庫
  const removedBuiltins = (kind) => {
    const list = (kind === 'workout' ? PlanData.workouts : PlanData.videos).filter((b) => Store.builtinRemoved(kind, b.id));
    if (!list.length) return '';
    return `<div class="lib-removed"><div class="lib-note">已刪除的內建（已經排進課表的日子照樣顯示）：</div>${list.map((b) => {
      const cur = kind === 'workout' ? Store.workoutFor(b.id) : Store.videoFor(b.id);
      return `<div class="lib-removed-row"><span>${h(kind === 'workout' ? cur.name : cur.title)}</span><button class="link-btn" onclick="A.undeleteBuiltin('${kind}','${jsq(b.id)}')">恢復</button></div>`;
    }).join('')}</div>`;
  };
  const workoutMeta = (w) => `${w.exercises.length} 個動作：${h(w.exercises.map((ex) => ex.name).join('、'))}`;

  const builtinWorkoutRows = PlanData.workouts.filter((b) => !Store.builtinRemoved('workout', b.id)).map((b) => isEditing('workout', b.id) && !edit.origin
    ? renderWorkoutEditor(edit)
    : (() => { const w = Store.workoutFor(b.id); return builtinRow('workout', b.id, h(w.name), `${workoutMeta(w)}<br>${usageText('workout', b.id)}`); })()).join('');
  const workouts = Store.libraryList('workout');
  const workoutRows = workouts.map((w) => isEditing('workout', w.id) && !edit.origin
    ? renderWorkoutEditor(edit)
    : row(w, h(w.name), `${workoutMeta(w)}<br>${usageText('workout', w.id)}`)).join('');

  const videoMeta = (v) => v.linkType === 'video' ? '貼上的影片網址' : (v.linkType === 'none' ? '只顯示文字，沒有連結' : `搜尋「${h(v.searchQuery)}」`);
  const builtinVideoRows = PlanData.videos.filter((b) => !Store.builtinRemoved('video', b.id)).map((b) => isEditing('video', b.id)
    ? renderVideoEditor(edit)
    : (() => { const v = Store.videoFor(b.id); return builtinRow('video', b.id, `${ICON.playCircle}${h(v.title)}`, `${videoMeta(v)}<br>${usageText('video', b.id)}`); })()).join('');
  const videos = Store.libraryList('video');
  const videoRows = videos.map((v) => isEditing('video', v.id)
    ? renderVideoEditor(edit)
    : row(v, `${ICON.playCircle}${h(v.title)}`, `${videoMeta(v)}<br>${usageText('video', v.id)}`)).join('');

  return `
    <div class="section">
      <div class="section-title">常用項目庫 <span class="coach-tag">三人共用</span></div>
      ${state.libFlash ? `<div class="banner info">${ICON.check}<div>${h(state.libFlash)}</div></div>` : ''}
      ${banners}
      <div class="card lib-card">
        <div class="lib-group">
          <div class="lib-head">常用項目</div>
          <div class="lib-note">可以直接在這裡新增（跑步項目的訓練段落、間歇範本都在表單裡），或在「本週」教練模式的項目下面按「存成常用」。「複製」會做一份一樣的，改一改就是新的項目。項目的內容只在這裡設定；課表上點項目名稱就能換成這裡的項目。改這裡會套用到今天以後用到它的日子，今天以前的日子不動。</div>
          ${itemRows || (isEditing('item', 'new') ? '' : '<div class="lib-empty">還沒有常用項目。</div>')}
          ${newItemForm}
        </div>
        <div class="lib-group">
          <div class="lib-head">動作清單</div>
          <div class="lib-note">內建的也可以改或刪除。改的內容從今天起生效，今天以前的日子維持原樣；「還原內建」也一樣只從今天起。刪除是從這裡跟下拉選單拿掉，已經排進課表的日子照樣顯示。</div>
          ${builtinWorkoutRows}
          ${workoutRows}
          ${removedBuiltins('workout')}
          ${isEditing('workout', 'new') ? renderWorkoutEditor(edit) : `<button class="btn secondary lib-add" onclick="A.startLibraryEdit('workout','new')">＋ 新增動作清單</button>`}
        </div>
        <div class="lib-group">
          <div class="lib-head">影片</div>
          <div class="lib-note">內建的也可以改或刪除，改的內容一樣從今天起生效。可以存搜尋關鍵字，或直接貼上 YouTube 網址。</div>
          ${builtinVideoRows}
          ${videoRows}
          ${removedBuiltins('video')}
          ${isEditing('video', 'new') ? renderVideoEditor(edit) : `<button class="btn secondary lib-add" onclick="A.startLibraryEdit('video','new')">＋ 新增影片</button>`}
        </div>
      </div>
    </div>`;
}

// 編輯器最上面的說明（第 33 條）：這份是內建還是自訂、存檔會影響哪些天、內建的要登入才能存。
// 回傳 { head, canSave }。新增的（id==='new'）沒有影響範圍可講。
function libraryEditorHead(edit, kind) {
  if (edit.id === 'new') return { head: '', canSave: true };
  const u = Store.libraryUsage(kind, edit.id);
  const t = PlanData.today();
  const todayLabel = `${t.getMonth() + 1}/${t.getDate()}`;
  const what = kind === 'workout' ? '動作清單' : '影片';
  const lines = [];
  const scope = u.total === 0
    ? `課表裡目前沒有用到這份${what}；之後排進課表的日子會用存檔後的內容。`
    : `存檔後，今天（${todayLabel}）起用到它的 <b>${u.upcoming}</b> 天會換成新內容${u.total > u.upcoming ? `；今天以前的 ${u.total - u.upcoming} 天維持原樣` : ''}。`;
  lines.push(`${edit.builtin ? `這是<b>內建</b>的${what}。` : ''}${scope}`);
  let canSave = true;
  if (edit.builtin && !Sync.isSignedIn()) {
    canSave = false;
    lines.push(`<b>要先登入才能存</b>——內建內容是三個人共用的，不能只存在這台手機。`);
  } else if (edit.builtin && Sync.libraryDenied) {
    canSave = false;
    lines.push(`<b>現在存不了</b>——Firebase 上的規則還沒加上常用項目庫，請把 firestore.rules.local 整份重新貼到 Firebase Console 發布。`);
  }
  if (edit.builtin && edit.builtinNotes) lines.push(`內建說明：${h(edit.builtinNotes)}`);
  return { head: `<div class="edit-provenance">${lines.join('<br>')}</div>`, canSave };
}

// 動作清單的編輯器（自訂跟內建共用）。欄位值存在 App.state.libraryEdit.draft：每個欄位 onchange 只更新
// draft、不重繪（重繪會把使用者緊接著點的「儲存」「新增一個動作」吞掉）；只有會改變
// 版面的操作（切換次數／秒數、新增／移除／上下移動作）才重繪。
// 內建清單的 safetyNote 顯示在最上面、不能改（第 33 條：畫面一律從 data/workouts.json 拿）。
function renderWorkoutEditor(edit) {
  const d = edit.draft;
  const { head, canSave } = libraryEditorHead(edit, 'workout');
  const n = d.exercises.length;
  // 份量一行讀起來就是「5 組 × 30 秒」（第 45 條）。以前拆成 組數／算法／秒數下限／上限 四格，
  // 「30 秒」被填進組數（上限 20）存不進去，看起來像不能同時設時間跟組數。後面那格只有範圍（8–10 次）才填。
  const rows = d.exercises.map((ex, i) => `
    <div class="ex-row">
      <div class="row ex-head">
        <div class="field wide"><label class="field-lbl">動作 ${i + 1}</label><input type="text" maxlength="80" value="${h(ex.name)}" placeholder="例如：死蟲式 Dead Bug" onchange="A.libDraftExercise(${i},'name',this.value)"></div>
        <div class="ex-move">
          <button type="button" class="link-btn" ${i === 0 ? 'disabled' : ''} onclick="A.moveLibExercise(${i},-1)" aria-label="往上移">↑</button>
          <button type="button" class="link-btn" ${i === n - 1 ? 'disabled' : ''} onclick="A.moveLibExercise(${i},1)" aria-label="往下移">↓</button>
        </div>
      </div>
      <div class="field wide">
        <label class="field-lbl">份量</label>
        <div class="ex-qty">
          <input class="ex-num" type="number" inputmode="numeric" min="1" max="20" value="${h(ex.sets)}" aria-label="組數" onchange="A.libDraftExercise(${i},'sets',this.value)">
          <span>組 ×</span>
          <input class="ex-num" type="number" inputmode="numeric" min="1" value="${h(ex.min)}" aria-label="每組${ex.qty === 'hold' ? '秒數' : '次數'}" onchange="A.libDraftExercise(${i},'min',this.value)">
          <span>–</span>
          <input class="ex-num" type="number" inputmode="numeric" min="1" value="${h(ex.max)}" placeholder="上限" aria-label="上限（選填）" onchange="A.libDraftExercise(${i},'max',this.value)">
          <select class="ex-unit" aria-label="次或秒" onchange="A.libDraftExercise(${i},'qty',this.value,true)"><option value="reps" ${ex.qty !== 'hold' ? 'selected' : ''}>次</option><option value="hold" ${ex.qty === 'hold' ? 'selected' : ''}>秒</option></select>
        </div>
      </div>
      <div class="field wide"><textarea class="ex-notes" rows="2" maxlength="200" placeholder="動作要領／備註（選填，最多 200 字）" onchange="A.libDraftExercise(${i},'notes',this.value)">${h(ex.notes)}</textarea></div>
      <div class="row ex-foot">
        <label class="ex-perside"><input type="checkbox" ${ex.perSide ? 'checked' : ''} onchange="A.libDraftExercise(${i},'perSide',this.checked)"> 每邊</label>
        <button class="link-btn lib-del" onclick="A.removeLibExercise(${i})">移除</button>
      </div>
    </div>`).join('');
  return `
    <div class="item coach-editing">
      <div class="edit-form">
        ${edit.origin ? `<div class="lib-head">編輯動作清單${edit.builtin ? ' <span class="lib-tag">內建</span>' : ''}</div>` : ''}
        ${head}
        ${edit.safetyNote ? `<div class="wo-safety locked">固定的安全提醒（不能改）：${h(edit.safetyNote)}</div>` : ''}
        <div class="field wide"><label class="field-lbl">動作清單名稱</label><input type="text" maxlength="80" value="${h(d.name)}" placeholder="例如：產後核心（Phase 2 版）" onchange="A.libDraft('name',this.value)"></div>
        <div class="field wide"><label class="field-lbl">負荷說明（選填，會顯示在每天的「查看動作」最上面）</label><textarea rows="2" maxlength="200" placeholder="例如：全程徒手，做到有感覺就停" onchange="A.libDraft('loadGuidance',this.value)">${h(d.loadGuidance)}</textarea></div>
        ${rows}
        <button class="btn secondary lib-add" onclick="A.addLibExercise()">＋ 新增一個動作</button>
        <div class="actions">
          <button class="btn" style="background:var(--warn)" ${canSave ? '' : 'disabled'} onclick="A.saveLibraryWorkout()">儲存動作清單</button>
          <button class="btn secondary" onclick="A.cancelLibraryEdit()">取消</button>
        </div>
      </div>
    </div>`;
}

// 影片的編輯器（自訂跟內建共用，同上 draft 模式）。網址只收 https://（Store 端也會再擋一次）。
// data/videos.json 的規則是「不要生成 YouTube 網址」——這裡的網址是教練自己貼上的真實網址，
// 不是程式產生的，不違反那條。linkType none＝只顯示文字、不給按鈕（內建的「死蟲式＋鳥狗式」）。
function renderVideoEditor(edit) {
  const d = edit.draft;
  const { head, canSave } = libraryEditorHead(edit, 'video');
  const lt = d.linkType === 'video' || d.linkType === 'none' ? d.linkType : 'search';
  return `
    <div class="item coach-editing">
      <div class="edit-form">
        ${head}
        <div class="field wide"><label class="field-lbl">標題</label><input type="text" maxlength="120" value="${h(d.title)}" placeholder="例如：產後骨盆底放鬆" onchange="A.libDraft('title',this.value)"></div>
        <div class="field wide"><label class="field-lbl">作者／頻道（選填）</label><input type="text" maxlength="60" value="${h(d.creator)}" onchange="A.libDraft('creator',this.value)"></div>
        <div class="field wide"><label class="field-lbl">連結方式</label>
          <select onchange="A.libDraft('linkType',this.value,true)">
            <option value="search" ${lt === 'search' ? 'selected' : ''}>用關鍵字搜尋 YouTube</option>
            <option value="video" ${lt === 'video' ? 'selected' : ''}>貼上影片網址</option>
            <option value="none" ${lt === 'none' ? 'selected' : ''}>不需要連結（只是說明）</option>
          </select>
        </div>
        ${lt === 'video'
          ? `<div class="field wide"><label class="field-lbl">影片網址</label><input type="url" inputmode="url" maxlength="500" value="${h(d.url)}" placeholder="https://www.youtube.com/watch?v=…" onchange="A.libDraft('url',this.value)"></div>`
          : lt === 'search'
            ? `<div class="field wide"><label class="field-lbl">搜尋關鍵字</label><input type="text" maxlength="200" value="${h(d.searchQuery)}" placeholder="例如：Pamela Reif 10 min ab workout" onchange="A.libDraft('searchQuery',this.value)"></div>`
            : ''}
        <div class="field wide"><label class="field-lbl">備註（選填）</label><input type="text" maxlength="300" value="${h(d.notes)}" onchange="A.libDraft('notes',this.value)"></div>
        <div class="actions">
          <button class="btn" style="background:var(--warn)" ${canSave ? '' : 'disabled'} onclick="A.saveLibraryVideo()">儲存影片</button>
          <button class="btn secondary" onclick="A.cancelLibraryEdit()">取消</button>
        </div>
      </div>
    </div>`;
}

function renderSettingsPage(state) {
  const users = PlanData.users;
  return `
    <div class="section">
      <div class="section-title">我是誰</div>
      <div class="userlist">
        ${users.map((u) => `
          <div class="user-opt ${u.userId === Store.activeUserId ? 'active' : ''} ${Sync.isSignedIn() && Sync.detectedUserId && u.userId !== Sync.detectedUserId ? 'locked' : ''}" onclick="A.switchIdentity('${jsq(u.userId)}')">
            <div class="avatar">${h(u.displayName).slice(0, 1)}</div>
            <div class="name">${h(u.displayName)}${Sync.detectedUserId === u.userId ? ' <span class="lib-tag">登入的帳號</span>' : ''}</div>
            ${u.userId === Store.activeUserId ? `<span class="check">${ICON.check}</span>` : ''}
          </div>
        `).join('')}
      </div>
      <div class="share-box" style="margin-top:10px">${Sync.isSignedIn() && Sync.detectedUserId
        ? '登入之後固定是登入的帳號，不能切成別人（切了也寫不進去）。要看別人的進度，到「總覽 → 查看別人的進度」。'
        : '登入 Google 帳號後會自動選成那個帳號的人。沒登入時，這裡決定打勾記在誰的名下；要看別人的進度用總覽頁「查看別人的進度」。'}</div>
    </div>

    <div class="section">
      <div class="section-title">同步</div>
      <div class="card">
        ${Sync.isSignedIn() ? `
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
            ${Sync.user.photoURL ? `<img src="${h(Sync.user.photoURL)}" style="width:36px;height:36px;border-radius:50%">` : ''}
            <div>
              <div style="font-weight:700;font-size:14px">${h(Sync.user.displayName || Sync.user.email)}</div>
              <div style="font-size:12px;color:var(--text2)">${h(Sync.user.email)}</div>
            </div>
          </div>
          <button class="btn secondary" onclick="A.signOut()">登出</button>
        ` : `
          <p style="font-size:13.5px;color:var(--text2);margin-bottom:12px">登入 Google 帳號才能在多裝置間同步紀錄。不登入也能用，資料只留在這支裝置。</p>
          <button class="btn" onclick="A.signIn()">${Sync.state === 'signing-in' ? '登入中…（再點一次可重開視窗）' : '使用 Google 帳號登入'}</button>
        `}
        ${!Sync.isSignedIn() && Sync.state === 'fail' ? `<div class="banner crit" style="margin-top:12px">${ICON.warn}<div><b>登入沒有完成</b>${h(Sync.message)}</div></div>` : ''}
        ${Sync.state === 'unauthorized' ? `<div class="banner crit" style="margin-top:12px">${ICON.warn}<div><b>未授權</b>${h(Sync.message)}</div></div>` : ''}
        ${Sync.state === 'wrong-identity' ? `<div class="banner warn" style="margin-top:12px">${ICON.warn}<div>${h(Sync.message)}</div></div>` : ''}
        ${Sync.persistenceDisabled ? `<div class="banner info" style="margin-top:12px">${ICON.info}<div>這台裝置的離線快取沒有啟用（可能是私密瀏覽模式）。離線時請避免關閉分頁，尚未送出的紀錄可能會遺失。</div></div>` : ''}
      </div>
    </div>

    <div class="section">
      <div class="section-title">分享連結</div>
      <div class="share-box">
        同一個網址分享給對方，對方登入自己的 Google 帳號後會自動選成自己；沒有自動選到（例如沒網路）再到這頁選自己的名字。不需要對方有 GitHub 帳號。<br>
        目前網址：<code>${h(location.href.split('#')[0])}</code>
      </div>
    </div>

    <div class="section">
      <div class="section-title">教練模式</div>
      <div class="coach-toggle-row">
        <div>
          <div style="font-weight:700;font-size:14px">編輯課表內容</div>
          <div style="font-size:12px;color:var(--text2);margin-top:2px">開啟後可以在「本週」直接調整項目、順序、二擇一，改的是所有人共用的課表。</div>
        </div>
        <label class="switch"><input type="checkbox" ${Store.coachMode ? 'checked' : ''} onchange="A.toggleCoachMode()"><span class="slider"></span></label>
      </div>
    </div>
    ${Store.coachMode ? renderLibraryPanel(state) : ''}

    <div class="section">
      <div class="section-title">外觀</div>
      <div class="card" style="display:flex;gap:10px">
        ${['system', 'day', 'night'].map((t) => `
          <button class="btn ${Store.theme === t ? '' : 'secondary'}" style="flex:1" onclick="A.setTheme('${t}')">${{ system: '跟隨系統', day: '日間', night: '夜間' }[t]}</button>
        `).join('')}
      </div>
    </div>

    <div class="section" style="font-size:11.5px;color:var(--text3);text-align:center;padding-bottom:20px">
      ${h(APP_VERSION)}
    </div>
  `;
}
