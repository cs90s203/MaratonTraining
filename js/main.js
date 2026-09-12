// 啟動、全域重繪、主題套用。

function applyTheme() {
  const sysDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const resolved = Store.theme === 'system' ? (sysDark ? 'night' : 'day') : Store.theme;
  document.documentElement.setAttribute('data-theme', resolved);
}

let renderDeferred = false;
function isTypingInRoot() {
  const el = document.activeElement;
  if (!el || !document.getElementById('root').contains(el)) return false;
  const tag = el.tagName;
  return tag === 'TEXTAREA' || (tag === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes(el.type));
}

function render() {
  // 使用者正在文字欄位打字時不重繪：整個 #root 換掉會把打到一半的字清掉、鍵盤收起——
  // 登入後每筆寫入有兩次 Firestore 快照（本機 pending、伺服器 ack），第二次常常剛好落在
  // 她點完狀態、開始打備註的那一秒。改成等欄位失焦後再補畫一次。
  if (isTypingInRoot()) {
    if (!renderDeferred) {
      renderDeferred = true;
      document.activeElement.addEventListener('focusout', () => {
        setTimeout(() => { renderDeferred = false; render(); }, 250);
      }, { once: true });
    }
    return;
  }
  // Store.effectiveWeek 已經擋掉形狀不對的覆寫文件（見 store.js 的
  // _isValidWeekShape），這裡是第二道防線：任何沒被那道檢查涵蓋到的例外
  // （不管是哪個頁面、哪個原因），都不能讓畫面停在半個舊畫面上不動——那看起來
  // 像「按鈕壞了」，使用者連「教練模式」的重試/還原按鈕都不知道還在不在。
  try {
    document.getElementById('root').innerHTML = renderApp(App.state);
    App.afterRender(); // 本週頁的拖曳把手要在新 DOM 上重新掛（見 app.js）
  } catch (e) {
    console.error('render() 失敗：', e);
    document.getElementById('root').innerHTML = `
      <div class="wrap" style="padding-top:60px">
        <div class="card" style="text-align:center">
          <div style="font-weight:700;margin-bottom:8px">畫面渲染失敗</div>
          <div style="color:var(--text2);font-size:13px;margin-bottom:14px">${h(String(e && e.message || e))}</div>
          <button class="btn secondary" onclick="A.goTo('week')">回到本週</button>
        </div>
      </div>`;
  }
}
window.render = render; // views.js 的「查看別人進度」訂閱回呼要用

async function boot() {
  try {
    await PlanData.load();
  } catch (e) {
    document.getElementById('root').innerHTML = `
      <div class="wrap" style="padding-top:60px">
        <div class="card" style="text-align:center">
          <div style="font-weight:700;margin-bottom:8px">課表資料載入失敗</div>
          <div style="color:var(--text2);font-size:13px">${String(e)}</div>
        </div>
      </div>`;
    return;
  }

  Store.init();
  applyTheme();
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (Store.theme === 'system') { applyTheme(); render(); }
    });
  }

  Store.onChange(render);
  Sync.onChange(render);
  Sync.init();

  App._focusToday();
  render();
  // 今天那一列在第一次畫面上要看得到：它可能排在週四以後，被上面的跑量卡推到螢幕外。
  // 只在啟動時捲一次；之後使用者自己點列展開時不捲（那時列本來就在她手指底下）。
  const e = App.state.expandedDay;
  if (e) {
    const el = document.getElementById(`day-${e.weekNumber}-${e.dayIndex}`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start' });
  }
}

document.addEventListener('DOMContentLoaded', boot);
