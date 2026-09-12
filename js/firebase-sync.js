// Firebase Auth（Google 登入）+ Firestore 即時監聽同步。
// 跟 babylog 同一套模式（見 ~/Documents/Projects/babylog/docs/sync.md），但只有一個
// 身分空間（不像 babylog 要切換多個 family）——所有白名單成員共用同一個 Firestore 專案，
// 各自的資料活在 users/{userId}/... 底下。
//
// 身分模型（重要，跟 babylog 不一樣的地方）：
//   Store.activeUserId 是「我是誰」——data/users.json 裡的人類可讀字串（例如 "mick"），
//   跟 Firebase Auth 的 uid（登入產生的隨機字串）是兩個不同的識別系統，天生不相等。
//   firestore.rules 用 email → userId 的對照表（ownerEmail()）接起兩者，不是用 uid。
//
// 真正的防線一定是 Security Rules，前端這裡的白名單檢查只是體驗優化——
// 不符合就能立刻顯示「此帳號未被授權」，而不是讓使用者看到一堆 permission-denied。

let fbApp = null, fbAuth = null, fbDb = null;
let unsubEntries = null, unsubPrivate = null, unsubWeekAdj = null, unsubProfile = null;
let unsubOtherEntries = {}, unsubOtherProfile = {}, unsubOtherWeekAdj = {};
let unsubPlanOverrides = null; // 跟上面三個不一樣：這個是共用資源，只在登入/登出時掛/拆，不隨切換身分重訂

function normEmail(e) { return String(e || '').trim().toLowerCase(); }

// 排除 Chrome／Android WebView／iOS 上的 Chrome(CriOS)／Firefox(FxiOS)／Edge——
// 這些的 UA 都含 "Safari" 字串，但不是真的 Safari，走 popup 沒問題。
function isSafariBrowser() {
  const ua = navigator.userAgent || '';
  return /^((?!chrome|crios|fxios|edg|android).)*safari/i.test(ua);
}

// 教練模式新增項目時要給一個不會跟出廠課表（"{週}-{天}-{序}" 格式）撞到的 id。
// 跟 babylog js/store.js 的 uid() 同一套寫法：crypto.randomUUID() 不支援時退回時間戳+亂數。
function newItemId() {
  if (window.crypto && crypto.randomUUID) return 'c-' + crypto.randomUUID();
  return 'c-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
window.newItemId = newItemId;

const Sync = {
  state: 'idle', // idle | signing-in | syncing | done | fail | unauthorized | wrong-identity | write-denied
  message: '',
  user: null, // {email, displayName, photoURL}
  persistenceDisabled: false,
  // 四個集合分開追蹤「本機已存、雲端還沒確認」，renderSyncPill 用 OR 合併判斷——
  // 只看 entries 的話，單獨改身體狀況備註、標記本週降量或改訓練目標時，畫面會誤顯示
  // 「已同步」（那些走的是 private/weekAdjustments/profile 集合，之前沒被算進去）。
  pendingByCollection: { entries: false, private: false, weekAdjustments: false, profile: false },
  get hasPendingWrites() {
    const p = this.pendingByCollection;
    return p.entries || p.private || p.weekAdjustments || p.profile;
  },
  // 樂觀寫入被 Firestore 拒絕時，不回滾使用者剛打的勾（那等於因為權限問題懲罰使用者
  // 剛完成的動作，跟決策紀錄第 0 條的精神相反），但要讓 UI 能標出「這筆沒真的存到雲端」，
  // 不能讓它看起來跟正常同步過的紀錄一樣。key 是 "collection:docId"。
  failedWrites: new Set(),
  _backfilledUserIds: new Set(),
  listeners: [],
  onChange(fn) { this.listeners.push(fn); },
  _set(state, message) { this.state = state; this.message = message || ''; this.listeners.forEach((fn) => fn()); },
  _notify() { this.listeners.forEach((fn) => fn()); },

  isSignedIn() { return !!this.user; },
  // targetUserId 只在「幫別人寫」時傳（見 pushDoc 的註解）；自己的寫入不傳，跟原本的
  // key 格式一致，不影響既有呼叫端。
  isWriteFailed(kind, docId, targetUserId) {
    const key = (targetUserId && targetUserId !== Store.activeUserId) ? `${kind}:${docId}:${targetUserId}` : `${kind}:${docId}`;
    return this.failedWrites.has(key);
  },

  init() {
    try {
      if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      fbAuth = firebase.auth();
      fbDb = firebase.firestore();
      fbDb.enablePersistence({ synchronizeTabs: true }).catch((e) => {
        // multiple-tabs / 瀏覽器不支援 IndexedDB（例如 Safari 私密瀏覽）：離線快取關閉，
        // 其餘功能不受影響，但「離線時關分頁會遺失還沒送出的寫入」這個風險變高了——
        // 不能悄悄吞掉，要讓使用者在設定頁看得到。
        this.persistenceDisabled = true;
        console.warn('Firestore persistence 未啟用：', e && e.code);
        this._notify();
      });
    } catch (e) {
      this._set('fail', '初始化失敗：' + e.message);
      return;
    }

    // ⚠️ 用 bind 而不是重寫一次參數簽名。之前這裡寫成 `(weekNumber, data) => this.pushPlanOverride(weekNumber, data)`，
    // 少接了 store.js 傳來的第三個參數 baseUpdatedAt——結果版本比對永遠拿到 undefined，
    // 同一週第二次編輯必定被判成「剛被別人改過」而丟掉；deletePlanOverride 同樣少接
    // backup，還原失敗時本機永遠不會回滾。bind 讓參數數量不可能再對不上。
    Store._cloudPush = this.pushDoc.bind(this);
    Store._cloudPushPlanOverride = this.pushPlanOverride.bind(this);
    Store._cloudDeletePlanOverride = this.deletePlanOverride.bind(this);

    fbAuth.onAuthStateChanged((user) => {
      if (!user) {
        this.user = null;
        this._detachListeners();
        this._detachPlanOverrides();
        this._set('idle', '');
        return;
      }
      // 這裡刻意不做「白名單」的前端預先檢查——那份清單只存在 firestore.rules.local
      // （gitignore，不進公開的 repo），這是這個專案跟 babylog 不同的地方：babylog
      // 把白名單直接寫進公開的 firebase-sync.js，這裡不重複那個選擇。未授權的帳號會在
      // 訂閱 Firestore 時被 rules 拒絕，走 _handleSnapErr 的 permission-denied 分支。
      const email = normEmail(user.email);
      this.user = { email, displayName: user.displayName, photoURL: user.photoURL };
      this._set('syncing', '同步中…');
      this._attachListeners();
      this._attachPlanOverrides();
      this._backfillLocal(Store.activeUserId);
    });

    // Safari／彈窗被擋時的 redirect 結果（若上次用了 signInWithRedirect 導回來）。
    // 沒有等待中的 redirect 時，這裡會正常 resolve 成 { user: null }，不是錯誤——
    // 只有真的失敗（例如帳號被拒絕）才要顯示失敗狀態，不能整個吞掉，否則使用者
    // 從 Google 導回來卻什麼都沒發生時，會完全不知道發生了什麼事。
    fbAuth.getRedirectResult().catch((err) => {
      if (err && err.code && err.code !== 'auth/no-auth-event') {
        this._set('fail', '登入失敗：' + (err.code || err.message));
      }
    });
  },

  async signIn() {
    this._set('signing-in', '登入中…');
    const provider = new firebase.auth.GoogleAuthProvider();
    // ⚠️ Safari（含 iOS）不要走 popup。彈出視窗登入成功後，結果要透過一個
    // firebaseapp.com 網域的中繼頁面傳回主頁面，這條路徑會被 Safari 的 ITP
    // （防止跨網站追蹤）當成跨站儲存擋掉——使用者在彈出視窗裡把帳號選完、
    // Google 那邊確實登入成功了，但主頁面永遠收不到結果，畫面停在「未登入」，
    // 而且不會拋出任何錯誤（不是 auth/popup-blocked 那種可以 catch 到的失敗）。
    // babylog 的 firebase-sync.js 開頭註解特別記過這個坑。改成在 Safari 上直接用
    // 整頁跳轉（signInWithRedirect）：整個頁面導到 Google 登入頁再導回來，
    // 用的是一般的第一方導覽，不會踩到 ITP 擋跨站儲存這件事。
    if (isSafariBrowser()) {
      try {
        await fbAuth.signInWithRedirect(provider);
      } catch (e) {
        this._set('fail', '登入失敗：' + (e && e.message));
      }
      return;
    }
    try {
      await fbAuth.signInWithPopup(provider);
    } catch (e) {
      if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/cancelled-popup-request')) {
        try {
          await fbAuth.signInWithRedirect(provider);
          return;
        } catch (e2) { this._set('fail', '登入失敗：' + e2.message); return; }
      }
      if (e && e.code === 'auth/popup-closed-by-user') { this._set('idle', ''); return; }
      this._set('fail', '登入失敗：' + e.message);
    }
  },

  async signOut() {
    await fbAuth.signOut();
  },

  _detachListeners() {
    if (unsubEntries) unsubEntries();
    if (unsubPrivate) unsubPrivate();
    if (unsubWeekAdj) unsubWeekAdj();
    if (unsubProfile) unsubProfile();
    Object.values(unsubOtherEntries).forEach((fn) => fn && fn());
    Object.values(unsubOtherProfile).forEach((fn) => fn && fn());
    Object.values(unsubOtherWeekAdj).forEach((fn) => fn && fn());
    unsubEntries = unsubPrivate = unsubWeekAdj = unsubProfile = null;
    unsubOtherEntries = {};
    unsubOtherProfile = {};
    unsubOtherWeekAdj = {};
  },

  // 使用者切換裝置上的「我是誰」時重新訂閱（Store.setActiveUser 會呼叫這個）。
  resubscribe() {
    if (!this.isSignedIn()) return;
    this._detachListeners();
    this.pendingByCollection = { entries: false, private: false, weekAdjustments: false, profile: false };
    this._attachListeners();
    this._backfillLocal(Store.activeUserId);
  },

  _attachListeners() {
    const userId = Store.activeUserId;
    if (!userId) return;

    unsubEntries = fbDb.collection(`users/${userId}/entries`)
      .onSnapshot({ includeMetadataChanges: true }, (snap) => {
        this.pendingByCollection.entries = snap.metadata.hasPendingWrites;
        snap.docChanges().forEach((c) => {
          if (c.type === 'removed') return;
          Store.mergeRemoteEntry(userId, c.doc.id, c.doc.data());
        });
        if (!['fail', 'unauthorized', 'wrong-identity'].includes(this.state)) this._set('done', '已同步');
        else this._notify();
      }, (err) => this._handleSnapErr(err, 'entries'));

    unsubPrivate = fbDb.collection(`users/${userId}/private`)
      .onSnapshot({ includeMetadataChanges: true }, (snap) => {
        this.pendingByCollection.private = snap.metadata.hasPendingWrites;
        snap.docChanges().forEach((c) => {
          if (c.type === 'removed') return;
          Store.mergeRemotePrivate(c.doc.id, c.doc.data());
        });
        this._notify();
      }, (err) => this._handleSnapErr(err, 'private'));

    unsubWeekAdj = fbDb.collection(`users/${userId}/weekAdjustments`)
      .onSnapshot({ includeMetadataChanges: true }, (snap) => {
        this.pendingByCollection.weekAdjustments = snap.metadata.hasPendingWrites;
        snap.docChanges().forEach((c) => {
          if (c.type === 'removed') return;
          Store.mergeRemoteWeekAdjustment(userId, c.doc.id, c.doc.data());
        });
        this._notify();
      }, (err) => this._handleSnapErr(err, 'weekAdjustments'));

    // profile 集合目前只有一份文件 goals（訓練目標）；用 collection 訂閱而不是單一 doc，
    // 跟其他三個一致，之後 profile 多一份文件也不用改這裡。
    unsubProfile = fbDb.collection(`users/${userId}/profile`)
      .onSnapshot({ includeMetadataChanges: true }, (snap) => {
        this.pendingByCollection.profile = snap.metadata.hasPendingWrites;
        snap.docChanges().forEach((c) => {
          if (c.type === 'removed' || c.doc.id !== 'goals') return;
          Store.mergeRemoteGoals(userId, c.doc.data());
        });
        this._notify();
      }, (err) => this._handleSnapErr(err, 'profile'));
  },

  // 教練模式的共用覆寫層：只在登入/登出時掛/拆一次，跟 Store.activeUserId 切換
  // 無關（不像 _attachListeners 那三個，那些是「這個人自己的資料」，這個是
  // 「大家共用的課表」）。
  _attachPlanOverrides() {
    if (unsubPlanOverrides) return; // 已經訂閱過
    unsubPlanOverrides = fbDb.collection('planOverrides')
      .onSnapshot((snap) => {
        snap.docChanges().forEach((c) => {
          const weekNumber = Number(c.doc.id);
          if (c.type === 'removed') { Store.clearRemoteWeekOverride(weekNumber); return; }
          Store.mergeRemoteWeekOverride(weekNumber, c.doc.data());
        });
      }, (err) => this._handleSnapErr(err, 'planOverrides'));
  },

  _detachPlanOverrides() {
    if (unsubPlanOverrides) unsubPlanOverrides();
    unsubPlanOverrides = null;
  },

  // 三個白名單成員都能寫同一份共用課表，所以「兩人幾乎同時編輯同一週」是真的會
  // 發生的情境，不是理論案例。整份 set(merge:false) 沒有任何版本比對的話，後寫的
  // 人會用「他打開編輯畫面那一刻看到的舊版本」整份蓋掉先寫的人的修改，而且兩邊都
  // 顯示「已同步」——用 transaction 做寫入前比對：baseUpdatedAt 是 app.js 的
  // _cloneEffectiveWeek 記下「這次編輯是從哪個版本開始改的」，跟 transaction 裡
  // 讀到的最新版本不一致就中止，不要靜默覆蓋。
  pushPlanOverride(weekNumber, weekObj, baseUpdatedAt) {
    if (!this.isSignedIn()) return;
    const key = `planOverrides:${weekNumber}`;
    const clean = JSON.parse(JSON.stringify(weekObj)); // 深層清掉 undefined（教練模式表單可能留下沒填的欄位）
    const ref = fbDb.collection('planOverrides').doc(String(weekNumber));
    fbDb.runTransaction((tx) => tx.get(ref).then((snap) => {
      const remoteAt = snap.exists ? (snap.data() || {}).updatedAt || null : null;
      if (remoteAt && remoteAt !== (baseUpdatedAt || null)) {
        const err = new Error('plan-conflict'); err.code = 'plan-conflict'; throw err;
      }
      tx.set(ref, clean);
    })).then(() => { if (this.failedWrites.delete(key)) this._notify(); })
      .catch((err) => {
        if (err && err.code === 'plan-conflict') {
          this.failedWrites.add(key);
          this._set('fail', `第 ${weekNumber} 週剛被別人改過，你這次的修改沒有存進去，請重新整理後再編輯。`);
          // 用遠端最新版本蓋掉本機剛剛的樂觀更新，避免這台裝置的畫面跟雲端分岔。
          ref.get().then((snap) => { if (snap.exists) Store.mergeRemoteWeekOverride(weekNumber, snap.data()); });
          return;
        }
        this._onWriteError('planOverrides', String(weekNumber), '(共用課表)', key, err);
      });
  },

  deletePlanOverride(weekNumber, backupForRollback) {
    if (!this.isSignedIn()) return;
    fbDb.collection('planOverrides').doc(String(weekNumber)).delete()
      .catch((err) => {
        // 還原失敗（離線／權限被收回）：不能讓「這台裝置看起來已還原、其他人的裝置
        // 其實沒變」這種分岔在沒有任何提示下發生——把本機剛清掉的覆寫層放回去。
        Store.rollbackResetWeekOverride(weekNumber, backupForRollback);
        this._set('fail', `第 ${weekNumber} 週還原失敗（可能離線或沒有權限），課表沒有改變，請重試。` +
          (err && err.message ? ` (${err.message})` : ''));
      });
  },

  // 讀取「其他人」的 entries（總覽頁唯讀查看用），跟自己的訂閱分開管理，
  // 用完（切換走）要記得取消，不然裝置上會一直掛著好幾個人的即時監聽。
  subscribeOtherEntries(otherUserId, onData) {
    if (!this.isSignedIn() || !fbDb) return;
    if (unsubOtherEntries[otherUserId]) return; // 已經訂閱過
    unsubOtherEntries[otherUserId] = fbDb.collection(`users/${otherUserId}/entries`)
      .onSnapshot((snap) => {
        snap.docChanges().forEach((c) => {
          if (c.type === 'removed') return;
          Store.mergeRemoteEntry(otherUserId, c.doc.id, c.doc.data());
        });
        onData && onData();
      }, () => {}); // 讀不到（不在白名單）就悄悄放棄，總覽頁顯示「尚無資料」
  },

  // 別人的訓練目標（總覽頁「查看別人的進度」唯讀用，教練模式下也用這份資料編輯），
  // 跟上面同一套管理方式。
  subscribeOtherProfile(otherUserId, onData) {
    if (!this.isSignedIn() || !fbDb) return;
    if (unsubOtherProfile[otherUserId]) return;
    unsubOtherProfile[otherUserId] = fbDb.collection(`users/${otherUserId}/profile`)
      .onSnapshot((snap) => {
        snap.docChanges().forEach((c) => {
          if (c.type === 'removed' || c.doc.id !== 'goals') return;
          Store.mergeRemoteGoals(otherUserId, c.doc.data());
        });
        onData && onData();
      }, () => {});
  },

  // 別人的週調整（含決策紀錄第 14 條的顯示順序對調）——總覽頁算別人的完成率／週跑量
  // 時，要用「那個人自己」的對調順序才算得對：對調換的是內容跟日曆格子的對應，
  // 每個人各自獨立，不知道對方的順序就會拿錯的內容去對他的打勾紀錄。
  subscribeOtherWeekAdjustments(otherUserId, onData) {
    if (!this.isSignedIn() || !fbDb) return;
    if (unsubOtherWeekAdj[otherUserId]) return;
    unsubOtherWeekAdj[otherUserId] = fbDb.collection(`users/${otherUserId}/weekAdjustments`)
      .onSnapshot((snap) => {
        snap.docChanges().forEach((c) => {
          if (c.type === 'removed') return;
          Store.mergeRemoteWeekAdjustment(otherUserId, c.doc.id, c.doc.data());
        });
        onData && onData();
      }, () => {});
  },

  _handleSnapErr(err, collectionName) {
    if (err && err.code === 'permission-denied') {
      if (collectionName === 'private') {
        // entries 跟 weekAdjustments 只需要 isMember() 就能讀，private 卻要
        // isSelf(userId)（authEmail() == ownerEmail(userId)）——三個訂閱裡只有這個
        // 會在「白名單內的成員切到不是自己的身分」時單獨失敗。這不是「未授權」，
        // 是「選錯身分」，不該把整個帳號登出（之前這裡跟 entries 共用同一個
        // permission-denied 分支，會誤判成未授權並強制 signOut，使用者連原因都
        // 看不到訊息就被登出了）。
        this.pendingByCollection.private = false;
        const u = PlanData.userById[Store.activeUserId];
        this._set('wrong-identity',
          `這個 Google 帳號不是「${u ? u.displayName : Store.activeUserId}」本人，看不到私人備註。` +
          `請確認登入的帳號跟裝置上選的身分一致。`);
        return;
      }
      this._set('unauthorized', '此帳號未被授權存取這份資料');
      // 白名單檢查失敗（entries/weekAdjustments 都讀不到）：跟 babylog 同樣的處理——
      // 直接登出，避免使用者卡在一堆看不懂的 permission-denied 錯誤裡。
      fbAuth.signOut();
      return;
    }
    this._set('fail', '同步發生錯誤：' + (err ? err.message : ''));
  },

  // targetUserId：決策紀錄第 15 條，教練模式下可以幫別人寫 profile/goals——多數呼叫
  // 不傳這個參數，寫自己的（userId = Store.activeUserId，key 維持原格式，不影響其他
  // 呼叫端）。傳了才走「幫別人寫」的路徑，key 額外帶 userId 避免跟自己的紀錄撞在一起
  // （例如同時幫 Annlin 跟自己都改 profile/goals，兩者的失敗狀態不能互相蓋掉）。
  pushDoc(kind, docId, data, targetUserId) {
    if (!this.isSignedIn()) return; // 未登入：純本機模式，不同步
    const userId = targetUserId || Store.activeUserId;
    const key = (targetUserId && targetUserId !== Store.activeUserId) ? `${kind}:${docId}:${userId}` : `${kind}:${docId}`;
    // 防禦性清理：Firestore 對值為 undefined 的欄位是**同步丟例外**，不是 Promise
    // reject——一旦漏過上游檢查，那個例外會在這裡的呼叫當下就炸穿整條呼叫鏈，連下面
    // 的 .catch() 都接不到，直接讓呼叫端的整個 action 中斷、畫面也不會重繪。
    // Store 層已經修過源頭（setActualStats 不再送出 undefined 欄位），這裡多一層
    // 防禦，避免以後又有地方不小心送出 undefined。
    const clean = {};
    Object.keys(data).forEach((k) => { if (data[k] !== undefined) clean[k] = data[k]; });
    try {
      fbDb.collection(`users/${userId}/${kind}`).doc(docId).set(clean, { merge: true })
        .then(() => { if (this.failedWrites.delete(key)) this._notify(); })
        .catch((err) => this._onWriteError(kind, docId, userId, key, err));
    } catch (err) {
      this._onWriteError(kind, docId, userId, key, err);
    }
  },

  _onWriteError(kind, docId, userId, key, err) {
    this.failedWrites.add(key);
    if (err && err.code === 'permission-denied') {
      if (kind === 'planOverrides') {
        // 這個集合任何白名單成員都能寫（isMember()），跟 userId 身分無關——
        // 會被拒絕只可能是這個帳號根本不在白名單裡。
        this._set('write-denied', '這個 Google 帳號不在白名單裡，無法編輯共用課表。');
      } else {
        // 最常見的原因：這個 Google 帳號沒有被授權寫入 activeUserId 這個身分
        // （firestore.rules 的 ownerEmail() 對不上）。不要讓使用者以為資料存好了。
        this._set('write-denied',
          `這個 Google 帳號不能寫入「${userId}」的紀錄。請確認登入的帳號跟裝置上選的身分一致。`);
      }
    } else {
      this._set('fail', '寫入失敗：' + (err ? err.message : ''));
    }
  },

  // 未登入期間累積的本機紀錄，登入後單向補推一次上雲——否則只有「之後又被手動改過」
  // 的那幾筆才會觸發 _cloudPush，沒被動過的舊資料永遠不會出現在雲端，換裝置登入
  // 同一帳號時會發現歷史整段消失（其實是雲端本來就沒收到，不是遺失）。
  //
  // 每個 userId 這個 session 只補推一次（_backfilledUserIds 記錄），且每筆都先跟
  // 遠端現有版本比較 updatedAt，遠端不比本機舊才補——不能無條件覆蓋，否則會拿本機
  // 的舊版本蓋掉另一台裝置剛寫的新版本。
  async _backfillLocal(userId) {
    if (!userId || this._backfilledUserIds.has(userId)) return;
    this._backfilledUserIds.add(userId);
    await this._backfillCollection(userId, 'entries', Store.entries[userId] || {});
    if (userId === Store.activeUserId) {
      await this._backfillCollection(userId, 'private', Store.privateData);
      await this._backfillCollection(userId, 'weekAdjustments', Store.weekAdjustments[userId] || {});
      if (Store.goals[userId]) await this._backfillCollection(userId, 'profile', { goals: Store.goals[userId] });
    }
  },

  async _backfillCollection(userId, kind, localDocs) {
    const keys = Object.keys(localDocs || {});
    if (!keys.length) return;
    let remoteSnap;
    try {
      remoteSnap = await fbDb.collection(`users/${userId}/${kind}`).get();
    } catch (e) { return; } // 讀不到（例如未授權）就放棄補推，訂閱的錯誤處理會另外接手
    const remoteUpdatedAt = {};
    remoteSnap.forEach((doc) => { remoteUpdatedAt[doc.id] = (doc.data() || {}).updatedAt || ''; });
    keys.forEach((docId) => {
      const local = localDocs[docId];
      const remoteAt = remoteUpdatedAt[docId];
      if (remoteAt !== undefined && remoteAt >= (local.updatedAt || '')) return; // 遠端不比本機舊，不用補
      const clean = {};
      Object.keys(local).forEach((k) => { if (local[k] !== undefined) clean[k] = local[k]; });
      fbDb.collection(`users/${userId}/${kind}`).doc(docId).set(clean, { merge: true }).catch(() => {});
    });
  },
};
