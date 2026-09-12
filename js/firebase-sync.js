// Firebase Auth（Google 登入）+ Firestore 即時監聽同步。
// 跟 babylog 同一套模式（見 ~/Documents/Projects/babylog/docs/sync.md），但只有一個
// 身分空間（不像 babylog 要切換多個 family）——所有白名單成員共用同一個 Firestore 專案，
// 各自的資料活在 users/{userId}/... 底下。
//
// 身分模型（重要，跟 babylog 不一樣的地方）：
//   Store.activeUserId 是「我是誰」——data/users.json 裡的人類可讀字串（例如 "mick"），
//   跟 Firebase Auth 的 uid（登入產生的隨機字串）是兩個不同的識別系統，天生不相等。
//   firestore.rules 用 email → userId 的對照表（isSelf()）接起兩者，不是用 uid。
//
// 真正的防線一定是 Security Rules，前端這裡的白名單檢查只是體驗優化——
// 不符合就能立刻顯示「此帳號未被授權」，而不是讓使用者看到一堆 permission-denied。

let fbApp = null, fbAuth = null, fbDb = null;
let unsubEntries = null, unsubPrivate = null, unsubWeekAdj = null, unsubProfile = null;
let unsubOtherEntries = {}, unsubOtherProfile = {}, unsubOtherWeekAdj = {};
let unsubPlanOverrides = null; // 跟上面三個不一樣：這個是共用資源，只在登入/登出時掛/拆，不隨切換身分重訂

function normEmail(e) { return String(e || '').trim().toLowerCase(); }

// ⚠️ 登入流程以 babylog（~/Documents/Projects/babylog/js/firebase-sync.js）為準，不要再自己發明：
// 同一套架構（GitHub Pages 靜態站 + firebaseapp.com authDomain + compat SDK 12.17.0 +
// iOS「加入主畫面」模式）在 babylog 與日文學習 App 上登入、同步都正常。
// v0.4.2～v0.6.2 三個版本先後加了「Safari 改用 redirect」「iOS/Firefox 一律 redirect」
// 「主畫面模式直接不讓登入」——全部是根據網路搜尋推論出來的假設，沒有一個對，最後
// 一個更是把原本能用的主畫面模式整個擋掉。Firebase 自己的文件也寫明：在會擋第三方
// 資料的瀏覽器上，signInWithRedirect 會導回來拿到空使用者，建議的做法就是用
// signInWithPopup。所以：popup 優先、只有被瀏覽器擋掉彈窗（auth/popup-blocked）才退回
// redirect——跟 babylog 一字不差。不做任何瀏覽器／裝置判斷。

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
      // babylog 2026-08-02 的事故（同一支手機、同樣的網路）：某些行動網路／代理會放行
      // 一般 HTTPS，卻悄悄弄斷 Firestore 即時監聽用的串流連線，SDK 永遠停在「離線快取」。
      // 這個設定讓 SDK 偵測到之後自動退回 long-polling；串流正常的網路完全不受影響。
      // 一定要在任何其他 Firestore 呼叫之前設。
      fbDb.settings({ experimentalAutoDetectLongPolling: true, merge: true });
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
        // ⚠️ 「未授權」是 _handleSnapErr 先設好狀態再呼叫 signOut() 走到這裡的——
        // 這時不能把狀態洗回 idle，否則畫面會回到「點擊登入以同步」，使用者看到的是
        // 「登入完全沒發生」，而不是真正的原因（這個 Google 帳號不在白名單／規則沒發布）。
        if (this.state === 'unauthorized') { this._notify(); return; }
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

    // 只有 popup 被瀏覽器擋掉、退回 signInWithRedirect 時才會有結果；平常 resolve 成
    // { user: null }，不是錯誤。跟 babylog 一樣只記警告。
    fbAuth.getRedirectResult().catch((err) => {
      if (err && err.code && err.code !== 'auth/no-auth-event') console.warn('getRedirectResult:', err.code);
    });
  },

  // 跟 babylog 的 signInWithGoogle() 一字不差（見檔頭的說明）：popup 優先，只有
  // auth/popup-blocked 才退回 redirect。不做瀏覽器／裝置判斷。
  signIn() {
    if (!fbAuth) { this._set('fail', 'Firebase 尚未載入，請重新整理後再試'); return; }
    this._set('signing-in', '登入中…');
    const provider = new firebase.auth.GoogleAuthProvider();
    fbAuth.signInWithPopup(provider).catch((err) => {
      if (err && err.code === 'auth/popup-blocked') {
        fbAuth.signInWithRedirect(provider).catch((e) => this._set('fail', '登入失敗：' + (e.code || e.message)));
      } else if (err && err.code === 'auth/popup-closed-by-user') {
        this._set('idle', '');
      } else {
        this._set('fail', '登入失敗：' + ((err && (err.code || err.message)) || err));
      }
    });
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
        // write-denied 也不能洗回「已同步」：被拒的那筆寫入 SDK 會回滾，回滾本身就會再觸發
        // 一次這個快照（includeMetadataChanges），沒排除的話膠囊會在使用者來得及點之前變回
        // 「已同步」。要等那些 key 重寫成功（pushDoc 的 then）才回到 done。
        if (!['fail', 'unauthorized', 'wrong-identity', 'write-denied'].includes(this.state)) this._set('done', '已同步');
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
        // isSelf(userId)（userId 對 authEmail() 的對照）——三個訂閱裡只有這個
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
      // 跟 babylog 一樣把被拒絕的 email 寫出來：「未授權」四個字跟「登入壞了」分不出來，
      // 看到實際字串才知道是打錯字、登錯帳號、還是 firestore.rules.local 改了沒發布。
      const rejected = (this.user && this.user.email) || '';
      this._set('unauthorized', `此 Google 帳號未被授權使用${rejected ? '：' + rejected : ''}` +
        '。請確認它在 firestore.rules.local 的 isMember() 名單裡，而且規則已經在 Firebase Console 發布。');
      // 白名單檢查失敗（entries/weekAdjustments 都讀不到）：跟 babylog 同樣的處理——
      // 直接登出，避免使用者卡在一堆看不懂的 permission-denied 錯誤裡。
      // onAuthStateChanged 的 null 分支會保留 'unauthorized' 狀態不洗成 idle。
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
        .then(() => {
          if (!this.failedWrites.delete(key)) return;
          // 之前被拒的那筆現在寫成功了：全部都補上就解除「寫入被拒」，否則只重繪
          if (this.state === 'write-denied' && this.failedWrites.size === 0) this._set('done', '已同步');
          else this._notify();
        })
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
      } else if (kind === 'profile') {
        // profile/goals 從 v0.6.0 起也是 isMember()（決策紀錄第 15 條：教練幫別人設目標）。
        // 被拒最可能是 Firebase Console 上還是舊規則（只允許本人寫）——不是帳號跟身分不一致，
        // 那個建議在「幫別人設目標」這個情境下根本無從照做。
        this._set('write-denied',
          `「${userId}」的訓練目標寫入被拒。Firebase 上的規則可能還是舊版（只允許本人寫自己的目標）——請把 firestore.rules.local 整份重新貼到 Firebase Console 發布。`);
      } else {
        // 最常見的原因：這個 Google 帳號沒有被授權寫入 activeUserId 這個身分
        // （firestore.rules 的 isSelf() 對不上）。不要讓使用者以為資料存好了。
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
