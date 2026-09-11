// 啟動、全域重繪、主題套用。

function applyTheme() {
  const sysDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const resolved = Store.theme === 'system' ? (sysDark ? 'night' : 'day') : Store.theme;
  document.documentElement.setAttribute('data-theme', resolved);
}

function render() {
  document.getElementById('root').innerHTML = renderApp(App.state);
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
