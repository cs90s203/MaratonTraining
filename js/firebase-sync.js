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
let unsubEntries = null, unsubPrivate = null, unsubWeekAdj = null, unsubOtherEntries = {};

function normEmail(e) { return String(e || '').trim().toLowerCase(); }

const Sync = {
  state: 'idle', // idle | signing-in | syncing | done | fail | unauthorized | wrong-identity | write-denied
  message: '',
  user: null, // {email, displayName, photoURL}
  persistenceDisabled: false,
  // 三個集合分開追蹤「本機已存、雲端還沒確認」，renderSyncPill 用 OR 合併判斷——
  // 只看 entries 的話，單獨改身體狀況備註或標記本週降量時，畫面會誤顯示「已同步」
  // （那兩者走的是 private/weekAdjustments 集合，之前沒被算進去）。
  pendingByCollection: { entries: false, private: false, weekAdjustments: false },
  get hasPendingWrites() {
    return this.pendingByCollection.entries || this.pendingByCollection.private || this.pendingByCollection.weekAdjustments;
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
  isWriteFailed(kind, docId) { return this.failedWrites.has(`${kind}:${docId}`); },

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

    Store._cloudPush = (kind, docId, data) => this.pushDoc(kind, docId, data);

    fbAuth.onAuthStateChanged((user) => {
      if (!user) {
        this.user = null;
        this._detachListeners();
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
      this._backfillLocal(Store.activeUserId);
    });

    // ITP/彈窗被擋時的 redirect 結果（若上次用了 signInWithRedirect）
    fbAuth.getRedirectResult().catch(() => {});
  },

  async signIn() {
    this._set('signing-in', '登入中…');
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      await fbAuth.signInWithPopup(provider);
    } catch (e) {
      if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/cancelled-popup-request')) {
        try {
          const provider = new firebase.auth.GoogleAuthProvider();
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
    Object.values(unsubOtherEntries).forEach((fn) => fn && fn());
    unsubEntries = unsubPrivate = unsubWeekAdj = null;
    unsubOtherEntries = {};
  },

  // 使用者切換裝置上的「我是誰」時重新訂閱（Store.setActiveUser 會呼叫這個）。
  resubscribe() {
    if (!this.isSignedIn()) return;
    this._detachListeners();
    this.pendingByCollection = { entries: false, private: false, weekAdjustments: false };
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
          Store.mergeRemoteWeekAdjustment(c.doc.id, c.doc.data());
        });
        this._notify();
      }, (err) => this._handleSnapErr(err, 'weekAdjustments'));
  },

  // 讀取「其他人」的 entries（總覽頁唯讀查看用），跟自己的訂閱分開管理，
  // 用完（切換走）要記得取消，不然裝置上會一直掛著好幾個人的即時監聽。
  subscribeOtherEntries(otherUserId, onData) {
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

  pushDoc(kind, docId, data) {
    if (!this.isSignedIn()) return; // 未登入：純本機模式，不同步
    const userId = Store.activeUserId;
    const key = `${kind}:${docId}`;
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
      // 最常見的原因：這個 Google 帳號沒有被授權寫入 activeUserId 這個身分
      // （firestore.rules 的 ownerEmail() 對不上）。不要讓使用者以為資料存好了。
      this._set('write-denied',
        `這個 Google 帳號不能寫入「${userId}」的紀錄。請確認登入的帳號跟裝置上選的身分一致。`);
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
      await this._backfillCollection(userId, 'weekAdjustments', Store.weekAdjustments);
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
