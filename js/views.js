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
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V4l14 6-14 6"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
};

const FLAG_LABELS = { leakage: '漏尿', pain: '疼痛', overTired: '過度疲勞' };

// 教練模式編輯表單的 type 下拉選單。⚠️ 跟 tools/verify_plan.py 的 VALID_TYPES 必須
// 保持一致——那支腳本管出廠課表，這裡管教練模式的即時編輯，是兩個不同的執行環境
// （Python / 瀏覽器 JS），沒辦法共用同一份常數，只能靠這條註解互相提醒同步改。
const VALID_TYPES = ['recovery', 'run', 'long-run', 'tempo', 'form-drill', 'strength', 'rest', 'race'];
const TYPE_LABELS = {
  recovery: '恢復', run: '跑步', 'long-run': '長跑',
  tempo: '節奏跑', 'form-drill': '跑姿訓練', strength: '重量訓練', rest: '休息', race: '比賽',
  'walk-run': '走跑交替（舊類型，請改選）', // v3 舊覆寫文件裡可能還有；只供顯示，不在 VALID_TYPES 下拉
};
// Store.dayStatus() 的七種回傳值 → 畫面文字
const DAY_STATUS_LABELS = {
  expired: '已過期', substituted: '改做', missed: '錯過', rested: '主動休息',
  done: '已完成', partial: '部分完成', pending: '待完成',
};
// 三顆可按的狀態 chip。「照表」（status=null）不是 chip，是 renderActualBox 右上角的
// 唯讀文字——它是「沒有覆寫」而不是一個選項，見決策紀錄第 13b 條。
const DAY_STATUS_CHIPS = [['substituted', '改做'], ['missed', '錯過'], ['rested', '主動休息']];
const DAY_STATUS_HINTS = {
  substituted: '改做只是記錄，不算補做，也不會把原本的量搬到別天。',
  missed: '錯過就是錯過，不需要補做。',
  rested: '主動休息不計入完成率——休息不是失敗。',
};

// ── 頂層外殼 ─────────────────────────────────────────────────────────────────
function renderApp(state) {
  const dr = PlanData.daysUntilRace();
  const raceLine = dr > 0 ? `距離比賽還有 ${dr} 天` : dr === 0 ? '今天是比賽日！' : `已完賽 ${-dr} 天`;
  return `
    ${Store.coachMode ? `<div class="coach-banner">🛠 教練模式——這裡改的是所有人共用的課表，不是你自己的紀錄</div>` : ''}
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
  `;
}

function renderSyncPill() {
  // ⚠️ 明確的錯誤狀態要排在 hasPendingWrites 之前檢查。hasPendingWrites 只在
  // 「上一次成功的 snapshot」裡被設過值，訂閱真的失敗之後它不會自動清成 false——
  // 如果查詢順序反過來，一個曾經有 pending 寫入、後來訂閱失敗的畫面會卡在
  // 「同步中」，蓋掉使用者真正需要看到的失敗/未授權/身分不符訊息。
  if (!Sync.isSignedIn()) {
    return `<button class="sync-pill off" onclick="A.signIn()"><span class="dot"></span>點擊登入以同步</button>`;
  }
  if (Sync.state === 'unauthorized') {
    return `<button class="sync-pill off" onclick="A.signIn()"><span class="dot"></span>未授權</button>`;
  }
  if (Sync.state === 'wrong-identity') {
    return `<button class="sync-pill off" title="${h(Sync.message)}" onclick="A.goTo('settings')"><span class="dot"></span>身分不符</button>`;
  }
  if (Sync.state === 'write-denied') {
    return `<button class="sync-pill off" title="${h(Sync.message)}"><span class="dot"></span>寫入被拒</button>`;
  }
  if (Sync.state === 'fail') {
    return `<button class="sync-pill off" onclick="A.retrySync()"><span class="dot"></span>離線，點擊重試</button>`;
  }
  if (Sync.hasPendingWrites) {
    return `<span class="sync-pill busy"><span class="dot"></span>本機已存，同步中…</span>`;
  }
  return `<span class="sync-pill ok"><span class="dot"></span>已同步</span>`;
}

function renderDesktopNav(state) {
  const tabs = [['today', '今日'], ['week', '本週'], ['overview', '總覽'], ['settings', '設定']];
  return `<div class="desktopnav">${tabs.map(([id, label]) =>
    `<button class="${state.page === id ? 'active' : ''}" onclick="A.goTo('${id}')">${label}</button>`).join('')}</div>`;
}

function renderBottomNav(state) {
  const tabs = [['today', '今日', ICON.today], ['week', '本週', ICON.week], ['overview', '總覽', ICON.chart], ['settings', '設定', ICON.user]];
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
  if (state.page === 'week') return renderWeekPage(state);
  if (state.page === 'overview') return renderOverviewPage(state);
  if (state.page === 'settings') return renderSettingsPage(state);
  return renderTodayPage(state);
}

// ── 頁面 1：今日視圖 ─────────────────────────────────────────────────────────
function renderTodayPage(state) {
  const loc = PlanData.locateToday();

  if (loc.status === 'before-start') {
    return `
      <div class="section">
        <div class="empty-state card">
          ${ICON.today}
          <div style="font-weight:700;font-size:16px;margin-bottom:4px">還沒開始</div>
          <div>距離開訓還有 ${loc.daysUntilStart} 天（${h(PlanData.plan.startDate)} 起）</div>
        </div>
      </div>
      ${renderSafetyCard()}
    `;
  }
  if (loc.status === 'after-plan') {
    return `
      <div class="section">
        <div class="empty-state card">
          ${ICON.check}
          <div style="font-weight:700;font-size:16px;margin-bottom:4px">計畫已結束</div>
          <div>已完賽 ${loc.daysSincePlanEnd} 天。到「總覽」看整體回顧。</div>
        </div>
      </div>
    `;
  }

  if (state.focusDay) {
    const isRealToday = loc.status === 'in-plan' && loc.weekNumber === state.focusDay.weekNumber && loc.dayIndex === state.focusDay.dayIndex;
    return (isRealToday ? '' : `
      <div class="section" style="padding-bottom:0">
        <button class="btn secondary" style="width:auto;padding:8px 14px;font-size:13px" onclick="A.goTo('today')">← 回到今天</button>
      </div>
    `) + renderDayDetail(state.focusDay.weekNumber, state.focusDay.dayIndex, { showWeekHeader: true, allowFlags: true });
  }

  const { weekNumber, dayIndex } = loc;
  return renderDayDetail(weekNumber, dayIndex, { showWeekHeader: true, allowFlags: true });
}

function renderDayDetail(weekNumber, dayIndex, opts) {
  opts = opts || {};
  const w = Store.effectiveWeek(weekNumber);
  const d = w.days[dayIndex];
  const phase = PlanData.phaseForWeek(weekNumber);
  const dateKey = PlanData.keyForWeekDay(weekNumber, dayIndex);
  const isExpired = PlanData.isExpired(weekNumber, dayIndex);
  const entry = Store.entryFor(Store.activeUserId, dateKey);
  const dateLabel = PlanData.dateForWeekDay(weekNumber, dayIndex);
  const dateStr = `${dateLabel.getMonth() + 1}/${dateLabel.getDate()}（${PlanData.weekdayLabel(dayIndex)}）`;
  const coach = Store.coachMode;

  let html = `<div class="section">`;

  if (opts.showWeekHeader) {
    html += `
      <div class="today-head">
        <span class="wk">第 ${weekNumber} 週 · 第 ${dayIndex + 1} 天</span>
        <span class="ph">${h(phase.name)}</span>
      </div>
      <div class="today-date">${dateStr}</div>
    `;
  }

  if (isExpired) {
    html += `<div class="banner info">${ICON.info}<div><b>這天已過期</b>起算日修正後，${h(PlanData.plan.expiredBefore)} 之前的日期不計入完成率，也不需要補做。</div></div>`;
  }

  if (opts.allowFlags) {
    const priv = Store.privateFor(dateKey);
    if (priv && priv.flags && (priv.flags.leakage || priv.flags.pain || priv.flags.overTired)) {
      const active = Object.keys(priv.flags).filter((k) => priv.flags[k]).map((k) => FLAG_LABELS[k]).join('、');
      html += `<div class="banner crit">${ICON.warn}<div><b>今天記錄了異常：${h(active)}</b>建議明天視狀況減量或休息。若持續出現，${h(PlanData.plan.safety.disclaimer)}</div></div>`;
    }
  }

  if (dayIndex === 6 && opts.showWeekHeader && !isExpired) {
    html += renderWeeklyReviewCard(weekNumber);
  }

  if (coach) {
    html += `
      <div class="day-coach-row">
        <label class="toggle-switch">
          <span class="switch"><input type="checkbox" ${d.selectOne ? 'checked' : ''} onchange="A.toggleDaySelectOne(${weekNumber},${dayIndex})"><span class="slider"></span></span>
          這天是「二擇一」
        </label>
      </div>
      <textarea class="edit-form daynotes-edit" placeholder="這天的備註（選填，例如二擇一的說明）" onchange="A.setDayNotes(${weekNumber},${dayIndex},this.value)">${h(d.dayNotes || '')}</textarea>
    `;
  } else if (d.dayNotes) {
    html += `<div class="banner info">${ICON.info}<div>${h(d.dayNotes)}</div></div>`;
  }

  const editing = App.state.editingItem;
  const isEditingThisDay = editing && editing.weekNumber === weekNumber && editing.dayIndex === dayIndex;

  if (d.selectOne) {
    html += d.items.map((item, i) => renderItemCard(weekNumber, dayIndex, item, i, d.items.length, entry, true, isExpired)).join(
      `<div class="choice-or">或</div>`);
  } else {
    html += d.items.map((item, i) => renderItemCard(weekNumber, dayIndex, item, i, d.items.length, entry, false, isExpired)).join('');
  }

  if (coach && isEditingThisDay && editing.itemId === 'new') {
    html += renderItemEditForm(weekNumber, dayIndex, null);
  } else if (coach) {
    html += `<div class="coach-add-row"><button class="btn coach-add-row" onclick="A.startAddItem(${weekNumber},${dayIndex})">+ 新增項目</button></div>`;
  }

  if (!isExpired) {
    html += renderActualBox(weekNumber, dayIndex, d, entry);
  }
  if (opts.allowFlags && !isExpired) {
    html += renderFlagsBox(dateKey);
  }

  html += `</div>`;
  if (opts.showWeekHeader) html += renderSafetyCard();
  return html;
}

function renderItemCard(weekNumber, dayIndex, item, itemIndexInDay, itemCountInDay, entry, isSelectOne, isExpired) {
  const coach = Store.coachMode;
  const editing = App.state.editingItem;
  const isEditingThis = coach && editing && editing.weekNumber === weekNumber && editing.dayIndex === dayIndex && editing.itemId === item.id;
  if (isEditingThis) return renderItemEditForm(weekNumber, dayIndex, item);

  const done = isSelectOne
    ? (entry && entry.selectedItemId === item.id && entry.done && entry.done[item.id])
    : (entry && entry.done && entry.done[item.id]);
  const chosen = isSelectOne && entry && entry.selectedItemId === item.id;
  const dateKey = PlanData.keyForWeekDay(weekNumber, dayIndex);
  // 樂觀寫入被 Firestore 拒絕時不回滾這個打勾（見決策紀錄第 0 條：不該因為權限問題
  // 懲罰使用者剛完成的動作），但要讓使用者看得出「這筆沒有真的存到雲端」，
  // 不能讓它看起來跟正常同步過的紀錄一樣。
  const unsynced = Sync.isSignedIn() && Sync.isWriteFailed('entries', dateKey);

  const meta = [];
  const metaStr = PlanData.fmtItemMeta(item);
  if (metaStr) meta.push(metaStr);
  if (item.heartRateZone) meta.push(`<span class="zone">${h(item.heartRateZone)}${item.intensityDerived ? '（內插）' : ''}</span>`);
  if (item.rpe) meta.push(`RPE ${item.rpe.min}-${item.rpe.max}`);

  const clickAttr = isExpired ? '' :
    (isSelectOne
      ? `onclick="A.selectChoice(${weekNumber},${dayIndex},'${jsq(item.id)}')"`
      : `onclick="A.toggleItem(${weekNumber},${dayIndex},'${jsq(item.id)}')"`);

  const links = [];
  if (item.videoRef) {
    const v = PlanData.videoById[item.videoRef];
    if (v && v.linkType === 'video' && v.url) {
      links.push(`<a class="item-link" href="${h(v.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${ICON.play} 看影片</a>`);
    } else if (v && v.linkType === 'search') {
      const q = encodeURIComponent(v.searchQuery || v.title);
      links.push(`<a class="item-link" href="https://www.youtube.com/results?search_query=${q}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${ICON.search} 搜尋「${h(v.creator ? v.creator + ' ' : '')}${h(v.title)}」</a>`);
    }
  }
  let workoutBlock = '';
  if (item.workoutRef) {
    const wo = PlanData.workoutById[item.workoutRef];
    if (wo) {
      workoutBlock = `
        <details style="margin-top:8px" onclick="event.stopPropagation()">
          <summary style="cursor:pointer;font-size:12.5px;font-weight:600;color:var(--accent2)">查看動作（${wo.exercises.length}）</summary>
          <div style="margin-top:8px;font-size:13px;color:var(--text2);line-height:1.7">
            ${wo.exercises.map((ex) => {
              const qty = ex.reps ? PlanData.fmtRange(ex.reps, ' 次') : (ex.holdSeconds ? PlanData.fmtRange(ex.holdSeconds, ' 秒') : '');
              return `<div>· ${h(ex.name)} · ${ex.sets} 組 × ${qty}${ex.perSide ? '（每邊）' : ''}${ex.notes ? '　' + h(ex.notes) : ''}</div>`;
            }).join('')}
            ${wo.derived ? `<div style="margin-top:4px;color:var(--warn)">推導值：${h(wo.derivedNote)}</div>` : ''}
          </div>
        </details>`;
    }
  }

  const coachToolbar = coach ? `
    <div class="coach-toolbar" onclick="event.stopPropagation()">
      <button onclick="A.startEditItem(${weekNumber},${dayIndex},'${jsq(item.id)}')">${ICON.chevron} 編輯</button>
      <button ${itemIndexInDay === 0 ? 'disabled' : ''} onclick="A.moveItem(${weekNumber},${dayIndex},'${jsq(item.id)}',-1)">↑</button>
      <button ${itemIndexInDay === itemCountInDay - 1 ? 'disabled' : ''} onclick="A.moveItem(${weekNumber},${dayIndex},'${jsq(item.id)}',1)">↓</button>
      <button class="danger" ${itemCountInDay <= 1 ? 'disabled' : ''} onclick="A.deleteItem(${weekNumber},${dayIndex},'${jsq(item.id)}')">刪除</button>
    </div>
  ` : '';

  return `
    <div class="item ${done ? 'done' : ''} ${isExpired ? 'expired' : ''} ${item.derived ? 'derived' : ''}" ${!isExpired ? clickAttr : ''}>
      <div class="item-row">
        <div class="item-check">${ICON.check}</div>
        <div class="item-body">
          <div class="item-title">${h(item.title)}${item.type === 'race' ? ' 🏁' : ''}${unsynced ? ' <span style="font-size:10px;font-weight:600;color:var(--warn);background:var(--warnBg);border-radius:5px;padding:1px 5px;vertical-align:2px">尚未同步</span>' : ''}</div>
          ${meta.length ? `<div class="item-meta">${meta.join('')}</div>` : ''}
          ${item.notes ? `<div class="item-notes">${h(item.notes)}</div>` : ''}
          ${links.length ? `<div class="item-links">${links.join('')}</div>` : ''}
          ${workoutBlock}
          ${isSelectOne && chosen ? `<div class="choice-note">✓ 這次選了這個</div>` : ''}
          ${coachToolbar}
        </div>
      </div>
    </div>
  `;
}

// 教練模式的項目編輯表單。item 為 null 時是「新增項目」。用 scoped querySelector
// 讀值（A.saveItemEdit 會找 #item-edit-... 容器內的 [name=...]），不是把每個欄位
// 塞進 onclick 參數——12 個欄位塞進 inline onclick 字串太脆弱（引號/特殊字元）。
function renderItemEditForm(weekNumber, dayIndex, item) {
  const isNew = !item;
  const it = item || { type: 'recovery', title: '', duration: null, distanceKm: null, heartRateZone: '', rpe: null, intensityNote: '', intensityDerived: false, videoRef: null, workoutRef: null, notes: '', derived: false };
  const formId = `item-edit-${weekNumber}-${dayIndex}-${isNew ? 'new' : it.id}`;
  const rangeVal = (r) => r ? [r.min, r.max] : ['', ''];
  const [durMin, durMax] = rangeVal(it.duration);
  const [kmMin, kmMax] = rangeVal(it.distanceKm);
  const [rpeMin, rpeMax] = rangeVal(it.rpe);

  return `
    <div class="item coach-editing" id="${formId}">
      <div class="edit-form">
        <div class="row">
          <div class="field">
            <label class="field-lbl">類型</label>
            <select name="type">${(VALID_TYPES.includes(it.type) ? VALID_TYPES : [it.type].concat(VALID_TYPES)).map((t) => `<option value="${t}" ${it.type === t ? 'selected' : ''}>${TYPE_LABELS[t] || t}</option>`).join('')}</select>
          </div>
          <div class="field wide">
            <label class="field-lbl">標題</label>
            <input name="title" type="text" value="${h(it.title)}" placeholder="例如：Zone 2 跑">
          </div>
        </div>
        <div class="row">
          <div class="field"><label class="field-lbl">時長下限（分）</label><input name="durationMin" type="number" min="0" value="${h(durMin)}"></div>
          <div class="field"><label class="field-lbl">時長上限（分）</label><input name="durationMax" type="number" min="0" value="${h(durMax)}"></div>
          <div class="field"><label class="field-lbl">距離下限（K）</label><input name="distanceMin" type="number" min="0" step="0.1" value="${h(kmMin)}"></div>
          <div class="field"><label class="field-lbl">距離上限（K）</label><input name="distanceMax" type="number" min="0" step="0.1" value="${h(kmMax)}"></div>
        </div>
        <div class="row">
          <div class="field"><label class="field-lbl">心率區間</label><input name="heartRateZone" type="text" placeholder="例如 60-70%" value="${h(it.heartRateZone || '')}"></div>
          <div class="field"><label class="field-lbl">RPE 下限</label><input name="rpeMin" type="number" min="0" max="10" value="${h(rpeMin)}"></div>
          <div class="field"><label class="field-lbl">RPE 上限</label><input name="rpeMax" type="number" min="0" max="10" value="${h(rpeMax)}"></div>
        </div>
        <div class="field wide"><label class="field-lbl">強度說明</label><input name="intensityNote" type="text" value="${h(it.intensityNote || '')}"></div>
        <div class="row">
          <div class="field">
            <label class="field-lbl">影片參照</label>
            <select name="videoRef"><option value="">（無）</option>${PlanData.videos.map((v) => `<option value="${v.id}" ${it.videoRef === v.id ? 'selected' : ''}>${h(v.title)}</option>`).join('')}</select>
          </div>
          <div class="field">
            <label class="field-lbl">動作參照</label>
            <select name="workoutRef"><option value="">（無）</option>${PlanData.workouts.map((w) => `<option value="${w.id}" ${it.workoutRef === w.id ? 'selected' : ''}>${h(w.name)}</option>`).join('')}</select>
          </div>
        </div>
        <div class="field wide"><label class="field-lbl">備註</label><textarea name="notes">${h(it.notes || '')}</textarea></div>
        <div class="row">
          <label class="checkrow"><input type="checkbox" name="intensityDerived" ${it.intensityDerived ? 'checked' : ''}> 強度是內插值</label>
          <label class="checkrow"><input type="checkbox" name="derived" ${it.derived ? 'checked' : ''}> 內容是推導值</label>
        </div>
        <div class="actions">
          <button class="btn" style="background:var(--warn)" onclick="A.saveItemEdit(${weekNumber},${dayIndex},'${isNew ? 'new' : jsq(it.id)}')">儲存</button>
          <button class="btn secondary" onclick="A.cancelEditItem()">取消</button>
        </div>
      </div>
    </div>
  `;
}

// 當天的「實際操作」方塊——Notion 舊課表那欄「實際操作（完成度）」的對應物。
// 一天一個（不是一項目一個）：entries 的 actualDurationMinutes / actualDistanceKm 本來就是
// 一天一筆，之前畫在每張項目卡片上，一天有兩個有時長的項目時，兩個輸入框綁的是同一個值。
// 狀態四顆 chip：照表（status=null，由打勾推導）／改做／錯過／主動休息。
// 實際公里只在當天有跑步類項目時出現（Phase 1 全部以時間計，但實際跑了幾公里還是要記——
// 週跑量的「實際」就是從這裡加總的）。
// 「誰看得到」做進標題，不只放在 placeholder：這欄跟下面的私密欄長得很像，
// 她以前在 Notion 是一格混寫身體感受的，寫錯框 Security Rules 擋不了。
function othersLabel() {
  const others = PlanData.users.filter((u) => u.userId !== Store.activeUserId).map((u) => u.displayName);
  return others.length ? `${others.join('、')} 看得到` : '只有你';
}

function renderActualBox(weekNumber, dayIndex, d, entry) {
  const dateKey = PlanData.keyForWeekDay(weekNumber, dayIndex);
  const st = entry && DAY_STATUS_OVERRIDES.includes(entry.status) ? entry.status : null;
  const derived = Store.dayStatus(weekNumber, dayIndex);
  const isAllRest = d.items.every((it) => it.type === 'rest');
  const chosenIsRest = d.selectOne && entry && entry.selectedItemId &&
    d.items.some((it) => it.id === entry.selectedItemId && it.type === 'rest');
  const isFuture = dateKey > PlanData.dayKey(PlanData.today());
  const hasRun = d.items.some((it) => isRunType(it.type) || it.type === 'race');
  const hasDuration = d.items.some((it) => it.duration);
  const showMinutes = st === 'substituted' || (!st && hasDuration);
  const showKm = st === 'substituted' || (!st && hasRun);
  const durVal = entry && entry.actualDurationMinutes != null ? entry.actualDurationMinutes : '';
  const kmVal = entry && entry.actualDistanceKm != null ? entry.actualDistanceKm : '';
  // 純休息日不放狀態 chip——在休息日提供「改做」等於 App 主動遞出「用訓練取代休息」的按鈕。
  // 二擇一已選「完全休息」的日子不放「主動休息」——兩種休息只留一條路。
  const chips = isAllRest ? [] : DAY_STATUS_CHIPS.filter(([k]) => !(k === 'rested' && chosenIsRest));
  const hint = st ? DAY_STATUS_HINTS[st]
    : (isAllRest ? '休息日。有做針灸、伸展之類的可以記在下面。'
      : '完成用上面的打勾記錄；改做／錯過／主動休息才點下面的狀態。');
  return `
    <div class="card actual-box">
      <div class="actual-box-head">
        <span class="actual-box-title">實際操作 <span class="vis-tag">${h(othersLabel())}</span></span>
        ${!isAllRest ? `<span class="derived-status ${derived}">${st ? '' : '照表 · '}${h(DAY_STATUS_LABELS[derived] || '')}</span>` : ''}
      </div>
      ${chips.length ? `<div class="status-row">
        ${chips.map(([k, label]) => {
          const disabled = isFuture && k !== 'rested';
          return `<button class="status-chip ${k} ${st === k ? 'active' : ''}" ${disabled ? 'disabled title="未來的日子只能預先排休息"' : ''} onclick="A.setDayStatus(${weekNumber},${dayIndex},'${k}')">${label}</button>`;
        }).join('')}
      </div>` : ''}
      <div class="status-hint">${h(hint)}</div>
      ${(showMinutes || showKm) ? `<div class="actual-row">
        ${showMinutes ? `<label class="actual-field">實際分鐘<input type="number" inputmode="decimal" min="0" value="${h(durVal)}" onchange="A.setActualStats(${weekNumber},${dayIndex},'duration',this.value)"></label>` : ''}
        ${showKm ? `<label class="actual-field">實際公里<input type="number" inputmode="decimal" min="0" step="0.1" value="${h(kmVal)}" onchange="A.setActualStats(${weekNumber},${dayIndex},'distance',this.value)"></label>` : ''}
      </div>` : ''}
      <textarea class="note-input" placeholder="例如：照表完成／改成快走 25 分／改騎飛輪 40 分" onchange="A.setActualNote('${dateKey}', this.value)">${h(entry && entry.actualNote || '')}</textarea>
    </div>`;
}

function renderWeeklyReviewCard(weekNumber) {
  let flaggedDays = 0;
  for (let i = 0; i < 7; i++) {
    const key = PlanData.keyForWeekDay(weekNumber, i);
    const p = Store.privateFor(key);
    if (p && p.flags && (p.flags.leakage || p.flags.pain || p.flags.overTired)) flaggedDays++;
  }
  const adj = Store.weekAdjustmentFor(weekNumber);
  if (flaggedDays === 0 && !adj) return '';
  return `
    <div class="banner ${flaggedDays > 0 ? 'warn' : 'info'}">
      ${ICON.flag}
      <div>
        <b>本週回顧</b>
        ${flaggedDays > 0 ? `這週有 ${flaggedDays} 天記錄異常。${h(PlanData.plan.safety.weeklySelfCheck)}` : '這週狀況正常。'}
        ${adj && adj.reduced
          ? `<div style="margin-top:6px;font-weight:600">✓ 已標記本週降量${adj.note ? '：' + h(adj.note) : ''}</div>`
          : `<button class="btn secondary" style="margin-top:8px;width:auto;padding:7px 12px;font-size:12.5px" onclick="A.markWeekReduced(${weekNumber})">標記本週已降量</button>`}
      </div>
    </div>
  `;
}

// 預設展開（不是收合的 <details>）：兩個文字框都看得到，身體狀況才會分流到這裡，
// 而不是照 Notion 的習慣全部打進上面那個別人看得到的框。
function renderFlagsBox(dateKey) {
  const priv = Store.privateFor(dateKey) || { flags: {}, note: '' };
  return `
    <div class="card flagsbox private-box">
      <div class="actual-box-title">🔒 身體狀況 <span class="vis-tag private">只有你看得到</span></div>
      <div class="flag-row">
        ${Object.keys(FLAG_LABELS).map((k) => `
          <button class="flag-chip ${priv.flags && priv.flags[k] ? 'active' : ''}" onclick="A.toggleFlag('${dateKey}','${k}')">${FLAG_LABELS[k]}</button>
        `).join('')}
      </div>
      <textarea class="note-input" placeholder="例如：小腿有點緊、下墜感（選填）" onchange="A.setNote('${dateKey}', this.value)">${h(priv.note)}</textarea>
    </div>
  `;
}

function renderSafetyCard() {
  const s = PlanData.plan.safety;
  return `
    <details class="card" style="margin-top:14px">
      <summary style="cursor:pointer;font-weight:700;font-size:13px;color:var(--text2)">⚠️ 開始前 / 安全提醒</summary>
      <div style="margin-top:10px;font-size:13px;color:var(--text2);line-height:1.65">
        <p style="margin-bottom:10px">${h(s.prerequisite)}</p>
        <p style="margin-bottom:10px">${h(s.intensityPrinciple)}</p>
        <p style="margin-bottom:10px">${h(s.weeklySelfCheck)}</p>
        <p style="font-style:italic">${h(s.disclaimer)}</p>
      </div>
    </details>
  `;
}

// ── 頁面 2：週視圖 ───────────────────────────────────────────────────────────
function renderWeekPage(state) {
  const wn = state.weekViewNumber;
  const w = Store.effectiveWeek(wn);
  const phase = PlanData.phaseForWeek(wn);
  const coach = Store.coachMode;
  const hasOverride = !!Store.planOverrides[wn];
  const loc = PlanData.locateToday();
  const todayKey = loc.status === 'in-plan' ? loc.key : null;

  const table = Store.weekViewMode === 'table';
  const vol = Store.weekVolume(wn, Store.activeUserId);

  const rows = w.days.map((d, i) => {
    const status = Store.dayStatus(wn, i);
    const dateLabel = PlanData.dateForWeekDay(wn, i);
    const dateKey = PlanData.keyForWeekDay(wn, i);
    const isToday = dateKey === todayKey;
    const titles = d.items.map((it) => it.title).join(d.selectOne ? ' 或 ' : '、');
    const statusIcon = status === 'done' ? ICON.check : '';
    return `
      <div class="weekday-row" onclick="A.openDay(${wn},${i})" style="cursor:pointer">
        <div class="weekday-badge ${isToday ? 'today' : ''}">${PlanData.weekdayLabel(i)}<span class="num">${dateLabel.getDate()}</span></div>
        <div class="weekday-status ${status}">${statusIcon}</div>
        <div class="weekday-summary">
          <div class="t">${h(titles)}</div>
          <div class="sub">${DAY_STATUS_LABELS[status] || '待完成'}</div>
        </div>
      </div>
    `;
  }).join('');

  const canPrev = wn > 1, canNext = wn < PlanData.plan.totalWeeks;
  return `
    <div class="section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <button class="navbtn" style="opacity:${canPrev ? 1 : .3}" ${canPrev ? `onclick="A.setWeekView(${wn - 1})"` : 'disabled'}>‹ 上週</button>
        <div style="text-align:center">
          <div style="font-weight:800;font-size:17px">第 ${wn} 週</div>
          <div style="font-size:12px;color:var(--text2)">${h(phase.name)}</div>
        </div>
        <button class="navbtn" style="opacity:${canNext ? 1 : .3}" ${canNext ? `onclick="A.setWeekView(${wn + 1})"` : 'disabled'}>下週 ›</button>
      </div>
      ${renderWeekVolumeCard(vol)}
      <div class="view-toggle">
        <button class="${table ? '' : 'active'}" onclick="A.setWeekViewMode('cards')">卡片</button>
        <button class="${table ? 'active' : ''}" onclick="A.setWeekViewMode('table')">表格（課表｜實際）</button>
      </div>
      ${table ? renderWeekTable(wn, w, todayKey) : `<div class="card">${rows}</div>`}
      ${coach ? renderWeekCoachPanel(wn, w, hasOverride, vol) : ''}
    </div>
  `;
}

function fmtKmRange(t) { return t.min === t.max ? `${t.min}` : `${t.min}–${t.max}`; }

// 本週跑量：目標 vs 實際。目標預設是課表跑步項目的加總（Store.weekVolume 的註解有算法）。
// 進度條的 100% 點是目標**下限**——目標是區間，碰到下限就是滿格，超過下限不再畫「多出來」；
// 超過上限改成警示文字。「填滿」型的條會催人往上限跑，這是第 0 條要防的方向。
// 已標記降量的週不畫條、不比對，只顯示實際（第 0 條：降量週縮小分母）。
function renderWeekVolumeCard(vol, opts) {
  opts = opts || {};
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
  const how = t.source === 'coach'
    ? '目標由教練模式設定。'
    : `目標＝本週課表跑步項目的加總${t.timeBased ? `（以時間計的項目用 ${pace} 分速換算，約略值、偏低）` : ''}。`;
  const actualStr = actual == null ? '—' : `${actual}${vol.estimated ? '<span class="approx">約</span>' : ''}`;
  const raceLine = vol.race ? `<div class="vol-sub">週日比賽 ${vol.race.planned} km 另計${vol.race.actual != null ? `（已記錄 ${vol.race.actual} km）` : ''}。</div>` : '';
  if (vol.reduced) {
    return `
      <div class="card vol-card">
        <div class="vol-head">
          <span class="vol-title">${h(opts.title || '本週跑量')}</span>
          <span class="vol-nums"><b>${actualStr}</b> km</span>
        </div>
        <div class="vol-sub">本週已標記降量——只記錄實際，不比對目標（原定 ${fmtKmRange(t)} km）。</div>
        ${raceLine}
      </div>`;
  }
  return `
    <div class="card vol-card">
      <div class="vol-head">
        <span class="vol-title">${h(opts.title || '本週跑量')}</span>
        <span class="vol-nums"><b>${actualStr}</b> / ${fmtKmRange(t)} km${reached && !over ? ' ✓' : ''}</span>
      </div>
      <div class="progress-track"><div class="progress-fill ${reached ? 'reached' : ''}" style="width:${pct}%"></div></div>
      ${over ? `<div class="vol-sub over">已超過本週課表上限（${t.max} km）——下週不要再加。</div>` : ''}
      <div class="vol-sub">${h(how)}實際＝各天「實際公里」的加總${vol.estimated ? '（沒填公里、只填分鐘的日子用同一個分速換算）' : ''}。</div>
      ${raceLine}
    </div>
  `;
}

// 表格模式：課表｜實際 並排，模仿舊 Notion 課表那張表——給回顧用；手機上打勾用卡片模式。
function renderWeekTable(wn, w, todayKey) {
  const rows = w.days.map((d, i) => {
    const status = Store.dayStatus(wn, i);
    const dateLabel = PlanData.dateForWeekDay(wn, i);
    const dateKey = PlanData.keyForWeekDay(wn, i);
    const entry = Store.entryFor(Store.activeUserId, dateKey);
    const planCell = d.items.map((it) => {
      const meta = [PlanData.fmtItemMeta(it), it.heartRateZone || ''].filter(Boolean).join(' · ');
      return `<div class="wt-item"><span class="wt-title">${h(it.title)}</span>${meta ? `<span class="wt-meta">${h(meta)}</span>` : ''}</div>`;
    }).join(d.selectOne ? '<div class="wt-or">或</div>' : '');
    const bits = [];
    if (status !== 'pending') bits.push(`<span class="wt-status ${status}">${DAY_STATUS_LABELS[status]}</span>`);
    const nums = [];
    if (entry && entry.actualDurationMinutes != null) nums.push(`${entry.actualDurationMinutes} 分`);
    if (entry && entry.actualDistanceKm != null) nums.push(`${entry.actualDistanceKm} km`);
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

function renderWeekCoachPanel(wn, w, hasOverride, vol) {
  const coachSet = vol.target.source === 'coach';
  // planOnly：純課表加總，不看任何人的 entries。planOverrides 是三人共用的一份文件，
  // 「課表加總」這個字眼講的是課表本身，不能取決於「誰的手機正在看這頁」——如果用
  // Store.activeUserId 的個人紀錄過濾（例如教練自己那天標了主動休息），上限跟著縮小，
  // 同樣的目標對別人來說卻是合法的，而且面板文字會講出一個不是課表真實加總的數字。
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
        <div class="row">
          <div class="field"><label class="field-lbl">週跑量目標下限（K）</label><input id="wv-min-${wn}" type="number" min="0" step="0.5" value="${coachSet ? vol.target.min : ''}" placeholder="${auto.min}"></div>
          <div class="field"><label class="field-lbl">週跑量目標上限（K）</label><input id="wv-max-${wn}" type="number" min="0" step="0.5" value="${coachSet ? vol.target.max : ''}" placeholder="${auto.max}"></div>
        </div>
        <div class="actions">
          <button class="btn" style="background:var(--warn);width:auto;padding:8px 14px;font-size:13px"
            onclick="A.setWeeklyVolume(${wn}, document.getElementById('wv-min-${wn}').value, document.getElementById('wv-max-${wn}').value)">設定週跑量目標</button>
          ${coachSet ? `<button class="btn secondary" style="width:auto;padding:8px 14px;font-size:13px" onclick="A.clearWeeklyVolume(${wn})">改回自動加總</button>` : ''}
        </div>
        <div style="font-size:11.5px;color:var(--text3)">${coachSet ? `目前是教練手動設定的目標（課表加總是 ${auto.min}–${auto.max} K）。` : `目前依課表跑步項目自動加總（${auto.min}–${auto.max} K）；改了項目目標會跟著變。`}手動目標只能往下調，上限不能高於課表加總——要加量請改課表項目。</div>
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

// ── 頁面 3：整體進度總覽 ─────────────────────────────────────────────────────
function renderOverviewPage(state) {
  const loc = PlanData.locateToday();
  const wn = loc.status === 'in-plan' ? loc.weekNumber : (loc.status === 'before-start' ? 1 : PlanData.plan.totalWeeks);
  const phase = PlanData.phaseForWeek(wn);
  const dr = PlanData.daysUntilRace();
  const viewingUserId = state.viewingUserId || Store.activeUserId;
  const viewingUser = PlanData.userById[viewingUserId];
  const isSelf = viewingUserId === Store.activeUserId;

  const totalDays = PlanData.plan.totalWeeks * 7;
  const elapsedDays = loc.status === 'in-plan' ? (wn - 1) * 7 + loc.dayIndex + 1 : (loc.status === 'after-plan' ? totalDays : 0);
  const overallPct = elapsedDays / totalDays;

  const stats = `
    <div class="stat-row">
      <div class="stat-tile"><div class="n">${wn}</div><div class="l">目前週次 / ${PlanData.plan.totalWeeks}</div></div>
      <div class="stat-tile"><div class="n">${dr >= 0 ? dr : 0}</div><div class="l">距離比賽（天）</div></div>
      <div class="stat-tile"><div class="n">${pct(Store.weekCompletionRate(wn, viewingUserId))}</div><div class="l">本週完成率</div></div>
    </div>
  `;

  const phaseStrip = `
    <div class="phase-strip-scroll"><div class="phase-strip">
      ${PlanData.plan.phases.map((ph) => {
        const width = ph.weekRange[1] - ph.weekRange[0] + 1;
        return `<div class="phase-seg ${phase.phaseId === ph.phaseId ? 'current' : ''}" style="flex-grow:${width}"><div class="bar" style="width:${phase.phaseId === ph.phaseId ? Math.round(((wn - ph.weekRange[0] + 1) / width) * 100) : (wn > ph.weekRange[1] ? 100 : 0)}%"></div><div class="lbl">${h(ph.name)}</div></div>`;
      }).join('')}
    </div></div>
    <div class="progress-track"><div class="progress-fill" style="width:${Math.round(overallPct * 100)}%"></div></div>
  `;

  const trend = renderLongRunTrend(viewingUserId);
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
          return `
          <div class="otheruser-row" style="cursor:pointer" onclick="A.viewProgress('${jsq(u.userId)}')">
            <div class="avatar">${h(u.displayName).slice(0, 1)}</div>
            <div class="name">${h(u.displayName)}</div>
            <div class="pct">${pct(Store.weekCompletionRate(wn, u.userId))}</div>
          </div>`;
        }).join('')}
      </div>
      <div class="share-box" style="margin-top:10px">同一個網址，對方自己在「設定」選自己的名字即可，不需要 GitHub 帳號。</div>
    </div>
  ` : '';

  return `
    <div class="app--desktop-grid">
      <div>
        <div class="section">
          <div class="section-title">${isSelf ? '我的進度' : `${h(viewingUser ? viewingUser.displayName : viewingUserId)} 的進度（唯讀）`}</div>
          ${stats}
          ${phaseStrip}
        </div>
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
// 自己的可以編輯；看別人的是唯讀。目標不會改變任何一天的課表（決策紀錄第 0 條）。
function renderGoalsCard(userId, isSelf, user) {
  const g = Store.goalsFor(userId) || { raceGoal: '', items: [] };
  const title = isSelf ? '我的目標' : `${h(user ? user.displayName : userId)} 的目標`;
  if (!isSelf) {
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
  return `
    <div class="section">
      <div class="section-title">我的目標</div>
      <div class="card goals-card">
        <label class="field-label">比賽目標</label>
        <input class="goal-input" type="text" placeholder="例如：安全完賽、5 小時內、全程不走路" value="${h(g.raceGoal)}" onchange="A.setRaceGoal(this.value)">
        <label class="field-label" style="margin-top:14px">訓練目標</label>
        ${g.items.map((it) => `
          <div class="goal-row ${it.done ? 'done' : ''}">
            <button class="goal-check" onclick="A.toggleGoal('${jsq(it.id)}')" aria-label="達成">${ICON.check}</button>
            <input class="goal-text-input" type="text" value="${h(it.text)}" onchange="A.setGoalText('${jsq(it.id)}', this.value)">
            <button class="goal-del" onclick="A.removeGoal('${jsq(it.id)}')" aria-label="刪除">×</button>
          </div>`).join('')}
        <div class="goal-add">
          <input id="goal-new" type="text" placeholder="例如：W8 結束可以連續跑 40 分不喘" onkeydown="if(event.key==='Enter'&&!event.isComposing){A.addGoal()}">
          <button class="btn secondary" style="width:auto;padding:8px 12px;font-size:13px;flex:none" onclick="A.addGoal()">新增</button>
        </div>
        <div style="font-size:11.5px;color:var(--text3);margin-top:10px;line-height:1.5">寫給自己（跟一起練的人）看的。目標不會改變任何一天的課表內容。</div>
      </div>
    </div>`;
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
    const dateKey = PlanData.keyForWeekDay(wn, longIdx);
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
function renderSettingsPage(state) {
  const users = PlanData.users;
  return `
    <div class="section">
      <div class="section-title">我是誰</div>
      <div class="userlist">
        ${users.map((u) => `
          <div class="user-opt ${u.userId === Store.activeUserId ? 'active' : ''}" onclick="A.switchIdentity('${jsq(u.userId)}')">
            <div class="avatar">${h(u.displayName).slice(0, 1)}</div>
            <div class="name">${h(u.displayName)}</div>
            ${u.userId === Store.activeUserId ? `<span class="check">${ICON.check}</span>` : ''}
          </div>
        `).join('')}
      </div>
      <div class="share-box" style="margin-top:10px">切換身分決定你打勾寫進哪個人的紀錄——久久才換一次，跟總覽頁「查看別人進度」是分開的功能。</div>
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
          <button class="btn" onclick="A.signIn()">使用 Google 帳號登入</button>
        `}
        ${Sync.state === 'unauthorized' ? `<div class="banner crit" style="margin-top:12px">${ICON.warn}<div>此帳號未被授權存取。請確認登入的 Google 帳號在白名單裡。</div></div>` : ''}
        ${Sync.state === 'wrong-identity' ? `<div class="banner warn" style="margin-top:12px">${ICON.warn}<div>${h(Sync.message)}</div></div>` : ''}
        ${Sync.persistenceDisabled ? `<div class="banner info" style="margin-top:12px">${ICON.info}<div>這台裝置的離線快取沒有啟用（可能是私密瀏覽模式）。離線時請避免關閉分頁，尚未送出的紀錄可能會遺失。</div></div>` : ''}
      </div>
    </div>

    <div class="section">
      <div class="section-title">分享連結</div>
      <div class="share-box">
        同一個網址分享給對方，對方登入自己的 Google 帳號後，在這頁選自己的名字即可——不需要對方有 GitHub 帳號。<br>
        目前網址：<code>${h(location.href.split('#')[0])}</code>
      </div>
    </div>

    <div class="section">
      <div class="section-title">教練模式</div>
      <div class="coach-toggle-row">
        <div>
          <div style="font-weight:700;font-size:14px">編輯課表內容</div>
          <div style="font-size:12px;color:var(--text2);margin-top:2px">開啟後可以在「今日」「本週」直接調整項目、順序、二擇一，改的是所有人共用的課表。</div>
        </div>
        <label class="switch"><input type="checkbox" ${Store.coachMode ? 'checked' : ''} onchange="A.toggleCoachMode()"><span class="slider"></span></label>
      </div>
    </div>

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
