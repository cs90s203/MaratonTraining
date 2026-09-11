// 啟動、全域重繪、主題套用。

function applyTheme() {
  const sysDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const resolved = Store.theme === 'system' ? (sysDark ? 'night' : 'day') : Store.theme;
  document.documentElement.setAttribute('data-theme', resolved);
}

function render() {
  // Store.effectiveWeek 已經擋掉形狀不對的覆寫文件（見 store.js 的
  // _isValidWeekShape），這裡是第二道防線：任何沒被那道檢查涵蓋到的例外
  // （不管是哪個頁面、哪個原因），都不能讓畫面停在半個舊畫面上不動——那看起來
  // 像「按鈕壞了」，使用者連「教練模式」的重試/還原按鈕都不知道還在不在。
  try {
    document.getElementById('root').innerHTML = renderApp(App.state);
  } catch (e) {
    console.error('render() 失敗：', e);
    document.getElementById('root').innerHTML = `
      <div class="wrap" style="padding-top:60px">
        <div class="card" style="text-align:center">
          <div style="font-weight:700;margin-bottom:8px">畫面渲染失敗</div>
          <div style="color:var(--text2);font-size:13px;margin-bottom:14px">${h(String(e && e.message || e))}</div>
          <button class="btn secondary" onclick="A.goTo('today')">回到今日視圖</button>
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

  render();
}

document.addEventListener('DOMContentLoaded', boot);
