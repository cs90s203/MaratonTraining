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

// ── 頂層外殼 ─────────────────────────────────────────────────────────────────
function renderApp(state) {
  const dr = PlanData.daysUntilRace();
  const raceLine = dr > 0 ? `距離比賽還有 ${dr} 天` : dr === 0 ? '今天是比賽日！' : `已完賽 ${-dr} 天`;
  return `
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
  const w = PlanData.week(weekNumber);
  const d = w.days[dayIndex];
  const phase = PlanData.phaseForWeek(weekNumber);
  const dateKey = PlanData.keyForWeekDay(weekNumber, dayIndex);
  const isExpired = PlanData.isExpired(weekNumber, dayIndex);
  const entry = Store.entryFor(Store.activeUserId, dateKey);
  const dateLabel = PlanData.dateForWeekDay(weekNumber, dayIndex);
  const dateStr = `${dateLabel.getMonth() + 1}/${dateLabel.getDate()}（${PlanData.weekdayLabel(dayIndex)}）`;

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

  if (d.dayNotes) {
    html += `<div class="banner info">${ICON.info}<div>${h(d.dayNotes)}</div></div>`;
  }

  if (d.selectOne) {
    html += d.items.map((item, i) => renderItemCard(weekNumber, dayIndex, item, i, entry, true, isExpired)).join(
      `<div class="choice-or">或</div>`);
  } else {
    html += d.items.map((item, i) => renderItemCard(weekNumber, dayIndex, item, i, entry, false, isExpired)).join('');
  }

  if (opts.allowFlags && !isExpired) {
    html += renderFlagsBox(dateKey);
  }

  html += `</div>`;
  if (opts.showWeekHeader) html += renderSafetyCard();
  return html;
}

function renderItemCard(weekNumber, dayIndex, item, itemIndex, entry, isSelectOne, isExpired) {
  const itemCount = isSelectOne ? null : (PlanData.day(weekNumber, dayIndex).items.length);
  const done = isSelectOne
    ? (entry && entry.selectedChoice === itemIndex && entry.itemsDone && entry.itemsDone[itemIndex])
    : (entry && entry.itemsDone && entry.itemsDone[itemIndex]);
  const chosen = isSelectOne && entry && entry.selectedChoice === itemIndex;
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
      ? `onclick="A.selectChoice(${weekNumber},${dayIndex},${itemIndex})"`
      : `onclick="A.toggleItem(${weekNumber},${dayIndex},${itemIndex},${itemCount})"`);

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
          ${!isExpired && (item.duration || item.distanceKm) ? renderActualInput(weekNumber, dayIndex, item, entry) : ''}
          ${isSelectOne && chosen ? `<div class="choice-note">✓ 這次選了這個</div>` : ''}
        </div>
      </div>
    </div>
  `;
}

function renderActualInput(weekNumber, dayIndex, item, entry) {
  const durVal = entry && entry.actualDurationMinutes != null ? entry.actualDurationMinutes : '';
  const kmVal = entry && entry.actualDistanceKm != null ? entry.actualDistanceKm : '';
  const fields = [];
  if (item.duration) fields.push(`<label class="actual-field">實際分鐘<input type="number" inputmode="decimal" min="0" value="${h(durVal)}" onclick="event.stopPropagation()" onchange="A.setActualStats(${weekNumber},${dayIndex},'duration',this.value)"></label>`);
  if (item.distanceKm) fields.push(`<label class="actual-field">實際公里<input type="number" inputmode="decimal" min="0" step="0.1" value="${h(kmVal)}" onclick="event.stopPropagation()" onchange="A.setActualStats(${weekNumber},${dayIndex},'distance',this.value)"></label>`);
  return `<div class="actual-row" onclick="event.stopPropagation()">${fields.join('')}</div>`;
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

function renderFlagsBox(dateKey) {
  const priv = Store.privateFor(dateKey) || { flags: {}, note: '' };
  return `
    <details class="flagsbox card" style="margin-top:12px">
      <summary>身體狀況備註</summary>
      <div class="flag-row">
        ${Object.keys(FLAG_LABELS).map((k) => `
          <button class="flag-chip ${priv.flags && priv.flags[k] ? 'active' : ''}" onclick="A.toggleFlag('${dateKey}','${k}')">${FLAG_LABELS[k]}</button>
        `).join('')}
      </div>
      <textarea class="note-input" placeholder="自由文字（選填）" onchange="A.setNote('${dateKey}', this.value)">${h(priv.note)}</textarea>
    </details>
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
  const w = PlanData.week(wn);
  const phase = PlanData.phaseForWeek(wn);
  const loc = PlanData.locateToday();
  const todayKey = loc.status === 'in-plan' ? loc.key : null;

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
          <div class="sub">${status === 'expired' ? '已過期' : status === 'partial' ? '部分完成' : status === 'done' ? '已完成' : '待完成'}</div>
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
      <div class="card">${rows}</div>
      ${w.weeklyVolumeKm ? `
        <div class="banner info" style="margin-top:12px">${ICON.info}<div>本週跑量參考上限 ${w.weeklyVolumeKm.min}-${w.weeklyVolumeKm.max}K（第四節數字，是參考值，不是本週課表加總）</div></div>
      ` : (w.weeklyVolumeNullReason ? `<div class="banner info" style="margin-top:12px">${ICON.info}<div>${h(w.weeklyVolumeNullReason)}</div></div>` : '')}
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
        <div class="section">
          <div class="section-title">長跑距離趨勢</div>
          <div class="card">${trend}</div>
        </div>
      </div>
      <div>${othersBlock}</div>
    </div>
  `;
}

function renderLongRunTrend(userId) {
  const points = [];
  for (let wn = 1; wn <= PlanData.plan.totalWeeks; wn++) {
    const w = PlanData.week(wn);
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
