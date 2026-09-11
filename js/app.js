// 所有使用者互動的「動作」（window.A），呼叫 Store/Sync，然後觸發重繪。
// 跟 babylog 同一套：inline onclick="A.xxx()"，動作本身不碰 DOM，只改 state 再重繪。

const App = {
  state: {
    page: 'today',
    weekViewNumber: 1,
    viewingUserId: null,   // null = 預設看自己；總覽頁「查看別人」用，跟 Store.activeUserId（寫入身分）分開
    focusDay: null,        // {weekNumber,dayIndex}：週視圖點某一天要跳去看時用；null = 顯示真正的「今天」
  },

  goTo(page) {
    this.state.page = page;
    if (page === 'today') this.state.focusDay = null; // 點「今日」永遠跳回真正的今天
    if (page === 'week' && !this.state.focusDay) {
      const loc = PlanData.locateToday();
      this.state.weekViewNumber = loc.status === 'in-plan' ? loc.weekNumber
        : (loc.status === 'before-start' ? 1 : PlanData.plan.totalWeeks);
    }
    render();
  },

  openDay(weekNumber, dayIndex) {
    this.state.focusDay = { weekNumber, dayIndex };
    this.state.page = 'today';
    render();
  },

  setWeekView(weekNumber) {
    this.state.weekViewNumber = weekNumber;
    render();
  },

  viewProgress(userId) {
    this.state.viewingUserId = userId;
    render();
  },

  toggleItem(weekNumber, dayIndex, itemIndex, itemCount) {
    const dateKey = PlanData.keyForWeekDay(weekNumber, dayIndex);
    Store.toggleItemDone(dateKey, itemIndex, itemCount);
    render();
  },

  selectChoice(weekNumber, dayIndex, itemIndex) {
    const dateKey = PlanData.keyForWeekDay(weekNumber, dayIndex);
    // 選了選項就直接算完成——選擇題的「選」跟「做完」在 UI 上是同一個點擊，
    // 避免多一次操作。Store.setSelectedChoice 自己處理 itemsDone 的重建，
    // 不要在這裡另外呼叫 toggleItemDone（那會把選項間切換弄壞既有的完成紀錄）。
    const itemCount = PlanData.day(weekNumber, dayIndex).items.length;
    Store.setSelectedChoice(dateKey, itemIndex, itemCount);
    render();
  },

  setActualStats(weekNumber, dayIndex, field, value) {
    const dateKey = PlanData.keyForWeekDay(weekNumber, dayIndex);
    const num = value === '' ? null : Number(value);
    Store.setActualStats(dateKey, field === 'duration' ? { durationMinutes: num } : { distanceKm: num });
    render();
  },

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
  retrySync() { Sync.resubscribe(); render(); },
};
const A = App; // 給 inline onclick="A.xxx()" 用的短名
