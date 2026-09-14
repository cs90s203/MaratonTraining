// 啟動、全域重繪、主題套用。

function applyTheme() {
  const sysDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const resolved = Store.theme === 'system' ? (sysDark ? 'night' : 'day') : Store.theme;
  document.documentElement.setAttribute('data-theme', resolved);
}

let renderDeferred = false;

// 決策紀錄第 31 條：「未來的日子」是 render 當下判斷的——還沒到的日子圓圈停用、「完成」跟數字欄
// 不畫。iOS 會把主畫面 App 整晚留在記憶體，隔天早上打開，畫面還是昨天畫的：今天的圓圈照樣停用、
// 點了沒反應，停用的按鈕也不會觸發任何重繪。所以日期一換就重畫：切回 App（visibilitychange）、
// 頁面從快取恢復（pageshow）、開著跨過午夜（計時器）三個時機都檢查。
let renderedDayKey = null;
function renderIfDayChanged() {
  if (renderedDayKey && renderedDayKey !== PlanData.dayKey(PlanData.today())) render();
}
let midnightTimer = null;
function scheduleMidnightCheck() {
  clearTimeout(midnightTimer);
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
  midnightTimer = setTimeout(() => { renderIfDayChanged(); scheduleMidnightCheck(); }, next - now);
}
function isTypingInRoot() {
  const el = document.activeElement;
  if (!el || !document.getElementById('root').contains(el)) return false;
  const tag = el.tagName;
  return tag === 'TEXTAREA' || (tag === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes(el.type));
}

// 決策紀錄第 36 條起 index.html 的 viewport 固定帶 maximum-scale=1，點欄位本來就不會放大了；
// 下面這支留著當備援（某些 iOS 版本若不理 maximum-scale，放大之後照樣縮得回來）。
// iOS Safari 把 focus 的 input 字型小於 16px 時自動放大畫面（這裡幾乎每個數字欄都比
// 16px 小），失焦後理應自動縮回，但常常縮不回去——因為失焦的原因是「整個 #root 被
// 我們自己的 render() 換掉」，不是使用者悠悠地點別處（跟 babylog 同一個坑，同一個修法：
// ~/Documents/Projects/babylog/js/app.js 的 resetZoom()）。強制把 maximum-scale 壓到
// 1.0 會立刻把畫面縮回來；用完馬上還原，使用者之後還是能正常雙指縮放。
// ⚠️ babylog 只在一個特定時機呼叫這個函式，這裡是每次 render() 都呼叫（頻率高很多）——
// 短時間內疊呼叫會一直把 ', maximum-scale=1.0' 疊加上去、且每次都把「疊過的內容」誤存成
// original，還原時就再也回不去了（縮放永久被鎖住）。用同一個計時器＋只在第一次呼叫時
// 記 original，後續呼叫只延長還原時間，不重複疊加、不重新讀取（已經被污染的）內容。
let zoomResetTimer = null;
let zoomOriginalViewport = null;
function resetZoom() {
  const viewport = document.querySelector('meta[name=viewport]');
  if (!viewport) return;
  if (zoomResetTimer) {
    clearTimeout(zoomResetTimer);
  } else {
    zoomOriginalViewport = viewport.getAttribute('content');
    viewport.setAttribute('content', zoomOriginalViewport + ', maximum-scale=1.0');
  }
  zoomResetTimer = setTimeout(() => {
    viewport.setAttribute('content', zoomOriginalViewport);
    zoomResetTimer = null;
    zoomOriginalViewport = null;
  }, 350);
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
    renderedDayKey = PlanData.dayKey(PlanData.today());
    App.afterRender(); // 本週頁的拖曳把手要在新 DOM 上重新掛（見 app.js）
    resetZoom(); // 每次 #root 被換掉都順手檢查一次；沒放大時這行沒有任何視覺效果
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

  // 決策紀錄第 42 條（審查抓到）：教練的項目表單／常用項目編輯器開著時，同步快照、別人改課表這類「資料變了」
  // 不重畫整頁——表單裡還沒存的字（訓練段落、影片列、下拉選單）都只在 DOM 上，一重畫就沒了。
  // 以前只擋「正在打字的輸入框」，下拉選單跟剛離開輸入框的那一刻擋不到。
  // 使用者自己的動作（存檔、取消、加段）照常直接呼叫 render()；表單關掉的那次 render 會帶上期間所有的新資料。
  // 新增項目的「挑常用項目」那一步（第 44 條）沒有打到一半的東西，照常重畫——剛同步進來、剛按「存成常用」的項目才會出現在清單上。
  const renderFromData = () => {
    const e = App.state.editingItem;
    if ((e && e.step !== 'pick') || App.state.libraryEdit) return;
    render();
  };
  Store.onChange(renderFromData);
  Sync.onChange(renderFromData);
  Sync.init();

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') renderIfDayChanged(); });
  window.addEventListener('pageshow', renderIfDayChanged);
  scheduleMidnightCheck();

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
