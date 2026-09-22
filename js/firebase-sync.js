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
let unsubLibrary = null; // 常用項目庫（第 26 條）：共用資源，登入/登出時掛/拆
let unsubPlanOverrides = null; // v0.25 以前三人共用的課表（現在唯讀），只在登入/登出時掛/拆，不隨切換身分重訂
let unsubPlanWeeks = {}; // 決策紀錄第 56 條：每個人的課表，三個人都訂（總覽要算別人的完成率、教練要排別人的課表），登入/登出時掛/拆

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
    // 決策紀錄第 64 條：網路恢復時把還沒存進雲端的課表補送（babylog 也是連上之後補送）
    if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('online', () => this.retryUnsavedPlanWeeks());
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
      this.authResolved = true;
      this._set('fail', '初始化失敗：' + e.message);
      return;
    }

    // ⚠️ 用 bind 而不是重寫一次參數簽名。之前這裡寫成 `(weekNumber, data) => this.pushPlanOverride(weekNumber, data)`，
    // 少接了 store.js 傳來的第三個參數 baseUpdatedAt——結果版本比對永遠拿到 undefined，
    // 同一週第二次編輯必定被判成「剛被別人改過」而丟掉；deletePlanOverride 同樣少接
    // backup，還原失敗時本機永遠不會回滾。bind 讓參數數量不可能再對不上。
    Store._cloudPush = this.pushDoc.bind(this);
    Store._cloudPushPlanWeek = this.pushPlanWeek.bind(this);
    Store._cloudPushLibrary = this.pushLibrary.bind(this);
    Store._cloudPushLibraryOverride = this.pushLibraryOverride.bind(this);

    fbAuth.onAuthStateChanged((user) => {
      this.authResolved = true; // 第 35 條：沒登入的提示要等這裡回來過一次才顯示，不然每次開 App 都會閃一下
      if (!user) {
        this.user = null;
        this.detectedUserId = null;
        this._identityProbeSeq++; // 還在跑的身分偵測結果作廢
        // 這次是自動選過去的身分：登出時把那個人的身體狀況快取清掉（共用裝置上下一個人看不到）
        if (this._autoSelectedUserId) { Store.clearPrivateCache(this._autoSelectedUserId); this._autoSelectedUserId = null; }
        this._detachListeners();
        this._detachPlanOverrides();
        this._detachPlanWeeks();
        clearTimeout(this._planRetryTimer); this._planRetryTimer = null;
        // 第 64 條：還沒存上去的、雲端版本這些只屬於剛登出的帳號（手機本機另外留著，同一個帳號再登入時還原）
        Store.resetPlanSyncState(); this._planResult = {}; this._planSession++; this._quietPlan = {}; this._failSources = {};
        clearTimeout(this._unsavedRetryTimer); this._unsavedRetryTimer = null; this._unsavedRetryStep = 0;
        this._detachLibrary();
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
      this.detectedUserId = null;
      this._set('syncing', '同步中…');
      this._attachListeners();
      this._attachPlanOverrides();
      this.planWeeksDenied = false; // 上一次登入時被拒的旗子不帶過來（重新訂閱，被拒會再設回來）
      if (this._restoreUnsaved()) setTimeout(() => this.retryUnsavedPlanWeeks(), 0); // 上次沒存上去的（第 64 條）
      this._noticeLocalOnly(); // 沒登入時在這台改的：講一次「不會上傳」（審查抓到：雲端沒有那一週時，以前完全沒人講）
      this._attachPlanWeeks();
      this._attachLibrary();
      // 本機補推要等「這個帳號是誰」確認完再做（決策紀錄第 41 條）：裝置上選的身分如果不是這個帳號，
      // 先補推只會送出注定被 rules 拒絕的寫入，還會把那個人記成「這次已經補推過」；登入前記的紀錄
      // 也要先搬到正確的人名下，補推才推得上去。
      this._detectIdentity();
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

  // 登入後自動選身分（決策紀錄第 41 條）。email → userId 的對照只存在 firestore.rules.local 的 isSelf()
  // （repo 是 public，不能把第三人的 email 寫進程式碼——babylog 把名單寫在 js 裡，這裡刻意不跟）。
  // 所以不在前端另存一份對照，直接問 rules：每個 userId 的 private（身體狀況）只有本人讀得到，
  // 對每個人各讀一次（limit 1、一定走伺服器，不能用離線快取——快取不看 rules），讀得到的那一個就是這個帳號。
  // 只有「剛好一個讀得到、其他都明確被拒」才切換；離線、rules 對到零個或好幾個，一律維持裝置上原本選的。
  // 對照表只有一份（rules），加人的時候不會有第二個地方忘了改。
  detectedUserId: null,
  _identityProbeSeq: 0,
  _detectIdentity() {
    const seq = ++this._identityProbeSeq;
    const email = this.user && this.user.email;
    const users = PlanData.users.map((u) => u.userId);
    const probe = (uid) => fbDb.collection('users').doc(uid).collection('private').limit(1).get({ source: 'server' })
      .then(() => ({ uid, ok: true, denied: false }))
      .catch((err) => ({ uid, ok: false, denied: !!(err && err.code === 'permission-denied') }));
    return Promise.all(users.map(probe)).then((results) => {
      // 等結果的期間登出、換了帳號、或又觸發了一次偵測：這次的結果作廢
      if (seq !== this._identityProbeSeq || !this.user || this.user.email !== email) return null;
      const mine = results.filter((r) => r.ok).map((r) => r.uid);
      const decided = mine.length === 1 && results.every((r) => r.ok || r.denied);
      this.detectedUserId = decided ? mine[0] : null;
      if (this.detectedUserId && this.detectedUserId !== Store.activeUserId) {
        const prev = Store.activeUserId;
        // 這台裝置從沒選過身分、預設的那個人也從沒在這台同步過：本機紀錄一定是登入前記的，搬給登入的人。
        // 不搬的話，那些紀錄會留在預設的人名下，切過去之後畫面上看不到、也永遠不會上傳（審查抓到）。
        const moved = !Store.activeUserExplicit && !Store.userEverSynced(prev) ? Store.migrateLocalRecords(prev, this.detectedUserId) : 0;
        this._autoSelectedUserId = this.detectedUserId;
        Store.setActiveUser(this.detectedUserId); // 會呼叫 resubscribe(true)，清掉上一個身分的錯誤狀態、補推新身分的本機紀錄
        if (moved && typeof alert === 'function') {
          const from = PlanData.userById[prev], to = PlanData.userById[this.detectedUserId];
          setTimeout(() => alert(`登入前在這台裝置記的 ${moved} 天紀錄，原本記在「${from ? from.displayName : prev}」名下，已經移到「${to ? to.displayName : this.detectedUserId}」並上傳。`), 0);
        }
      } else {
        this._backfillLocal(Store.activeUserId);
        this._notify();
      }
      return this.detectedUserId;
    });
  },

  // 使用者切換裝置上的「我是誰」時重新訂閱（Store.setActiveUser 會呼叫這個）。
  // identityChanged：換了身分（Store.setActiveUser 傳 true）。跟上一個身分綁在一起的狀態要清掉——
  // 「身分不符」、那個身分被拒絕的寫入（failedWrites 裡沒有第三段 userId 的 entries／private／weekAdjustments），
  // 不然膠囊會一直掛著上一個人的錯誤訊息，這個人的同一天也被標成「尚未同步」（第 41 條審查）。
  // 「身分不符」在任何重新訂閱時都先清掉：身分還是錯的話，private 訂閱會馬上再設回來。
  // 決策紀錄第 51 條：身分每換一次加一。寫入的結果（成功／被拒）是伺服器晚一點才回來的——
  // 切成別人又切回來，上一個身分被拒的那筆才回來，會把現在這個身分蓋成「寫入被拒」、訊息寫的還是別人的名字。
  _identitySeq: 0,
  resubscribe(identityChanged) {
    if (identityChanged) this._identitySeq++;
    if (!this.isSignedIn()) return;
    if (identityChanged) {
      [...this.failedWrites].forEach((k) => {
        const parts = k.split(':');
        if (parts.length === 2 && ['entries', 'private', 'weekAdjustments'].includes(parts[0])) this.failedWrites.delete(k);
      });
    }
    if (this.state === 'wrong-identity' || (identityChanged && this.state === 'write-denied' && this.failedWrites.size === 0)) {
      this.state = 'syncing';
      this.message = '同步中…';
    }
    this._detachListeners();
    this.pendingByCollection = { entries: false, private: false, weekAdjustments: false, profile: false };
    this._attachListeners();
    // 常用項目庫的訂閱出錯時會自己拆掉（見 _handleSnapErr）；重試時要一起重掛，不然
    // 教練發布完規則後，「還沒開通」的提示跟舊的庫會一直留到重新整理。
    this._detachLibrary();
    this.libraryDenied = false;
    this._attachLibrary();
    // 每人一份課表（第 56 條）的訂閱被規則拒絕時也會自己拆掉；教練發布完規則按「重新讀取」要重掛
    this._detachPlanWeeks();
    this.planWeeksDenied = false;
    this._attachPlanWeeks();
    this._attachPlanOverrides(); // 斷掉過就重掛（還在的話什麼都不做）
    this._backfillLocal(Store.activeUserId);
  },

  _attachListeners() {
    const userId = Store.activeUserId;
    if (!userId) return;

    unsubEntries = fbDb.collection(`users/${userId}/entries`)
      .onSnapshot({ includeMetadataChanges: true }, (snap) => {
        this.pendingByCollection.entries = snap.metadata.hasPendingWrites;
        if (!snap.metadata.fromCache) Store.markUserSynced(userId); // 第 41 條：這台收過這個人的雲端資料
        snap.docChanges().forEach((c) => {
          if (c.type === 'removed') return;
          Store.mergeRemoteEntry(userId, c.doc.id, c.doc.data());
        });
        // write-denied 也不能洗回「已同步」：被拒的那筆寫入 SDK 會回滾，回滾本身就會再觸發
        // 一次這個快照（includeMetadataChanges），沒排除的話膠囊會在使用者來得及點之前變回
        // 「已同步」。要等那些 key 重寫成功（pushDoc 的 then）才回到 done。
        this._clearSnapFail('entries', snap);
        if (!['fail', 'unauthorized', 'wrong-identity', 'write-denied'].includes(this.state)) this._set('done', '已同步');
        else this._notify();
      }, (err) => this._handleSnapErr(err, 'entries'));

    unsubPrivate = fbDb.collection(`users/${userId}/private`)
      .onSnapshot({ includeMetadataChanges: true }, (snap) => {
        this.pendingByCollection.private = snap.metadata.hasPendingWrites;
        this._clearSnapFail('private', snap);
        snap.docChanges().forEach((c) => {
          if (c.type === 'removed') return;
          Store.mergeRemotePrivate(c.doc.id, c.doc.data());
        });
        this._notify();
      }, (err) => this._handleSnapErr(err, 'private'));

    unsubWeekAdj = fbDb.collection(`users/${userId}/weekAdjustments`)
      .onSnapshot({ includeMetadataChanges: true }, (snap) => {
        this.pendingByCollection.weekAdjustments = snap.metadata.hasPendingWrites;
        this._clearSnapFail('weekAdjustments', snap);
        snap.docChanges().forEach((c) => {
          if (c.type === 'removed') return;
          Store.mergeRemoteWeekAdjustment(userId, c.doc.id, c.doc.data());
        });
        this._notify();
      }, (err) => this._handleSnapErr(err, 'weekAdjustments'));

    // profile 集合用 collection 訂閱而不是單一 doc，跟其他三個一致——目前有兩份文件
    // （goals 訓練目標、phaseTargets 階段性目標，決策紀錄第 22 條），docChanges 裡逐一分派。
    unsubProfile = fbDb.collection(`users/${userId}/profile`)
      .onSnapshot({ includeMetadataChanges: true }, (snap) => {
        this.pendingByCollection.profile = snap.metadata.hasPendingWrites;
        this._clearSnapFail('profile', snap);
        snap.docChanges().forEach((c) => {
          if (c.type === 'removed') return;
          if (c.doc.id === 'goals') Store.mergeRemoteGoals(userId, c.doc.data());
          else if (c.doc.id === 'phaseTargets') Store.mergeRemotePhaseTargets(userId, c.doc.data());
        });
        this._notify();
      }, (err) => this._handleSnapErr(err, 'profile'));
  },

  // v0.25 以前三人共用的課表（第 56 條之後唯讀）：某人某週還沒有自己那份時讀它。只在登入/登出時掛/拆一次，
  // 跟 Store.activeUserId 切換無關。
  _attachPlanOverrides() {
    if (unsubPlanOverrides || !fbDb) return; // 已經訂閱過（訂閱出錯會先拆掉，見 _handleSnapErr，才能重掛）
    unsubPlanOverrides = fbDb.collection('planOverrides')
      .onSnapshot((snap) => {
        this._clearSnapFail('planOverrides', snap);
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

  // 決策紀錄第 56 條：每個人一份課表（users/{userId}/planWeeks/{週次}）。三個人都訂：總覽算別人的完成率、
  // 唯讀看別人的紀錄、教練排別人的課表都要用那個人的課表。
  // planWeeksDenied 的意思同 libraryDenied：讀取被 rules 拒絕＝Firebase Console 上還是舊規則（沒有 planWeeks 那一段）。
  // 不能走 _handleSnapErr 的通用分支（會判成帳號未授權、整個登出）。讀不到的期間照舊讀共用課表／出廠，畫面跟以前一樣。
  // 訂閱出錯會自己拆掉（見 _handleSnapErr）；之後自動重掛（一分鐘後、App 切回前景時），不用等重新整理——
  // 不然規則發布之前就打開 App 的人，會一直讀舊的共用課表，教練幫她排的都看不到（審查抓到）。
  planWeeksDenied: false,
  _planWeeksLoaded: {}, // 這次登入收過她的課表快照了沒（複製課表前要兩邊都讀到）
  _planRetryTimer: null,
  planWeeksLoaded(userId) { return !!this._planWeeksLoaded[userId]; },
  _attachPlanWeeks() {
    PlanData.users.forEach((u) => {
      const uid = u.userId;
      if (unsubPlanWeeks[uid]) return;
      // includeMetadataChanges：離線快取先送來的那份不算「讀到了」，要等伺服器確認過的（審查抓到：複製課表拿它判斷來源是不是最新的）
      unsubPlanWeeks[uid] = fbDb.collection(`users/${uid}/planWeeks`)
        .onSnapshot({ includeMetadataChanges: true }, (snap) => {
          if (!snap.metadata.fromCache) this._planWeeksLoaded[uid] = true;
          this._clearSnapFail(`planWeeks:${uid}`, snap);
          const wasDenied = this.planWeeksDenied;
          this.planWeeksDenied = false; // 讀得到了＝規則發布好了
          // 第一個快照會一次送來她所有改過的週：一份一份重畫整頁（三個人加起來可能幾十次）會讓手機卡一下，
          // 全部收完再重畫一次
          const changes = snap.docChanges();
          changes.forEach((c) => {
            const weekNumber = Number(c.doc.id);
            if (!Number.isInteger(weekNumber)) return;
            if (c.type === 'removed') { Store.clearRemotePlanWeek(uid, weekNumber, true); return; }
            // 第 64 條：這台沒存上去的修改被別台的新版本換掉了——當下講，不能只寫在小字裡
            this._mergeRemote(uid, weekNumber, c.doc.data(), true, snap.metadata.fromCache);
          });
          if (changes.length) this._planSettled(); // 寫進去的（快照送來這台那份）從手機本機拿掉、同步狀態跟著變
          if (changes.length || wasDenied) Store._notify();
        }, (err) => this._handleSnapErr(err, 'planWeeks', uid));
    });
  },

  _detachPlanWeeks() {
    Object.values(unsubPlanWeeks).forEach((fn) => fn && fn());
    unsubPlanWeeks = {};
    this._planWeeksLoaded = {};
  },

  // 有拆掉的課表訂閱就重掛（main.js 在 App 切回前景時呼叫；出錯後一分鐘也會自己試一次）
  ensurePlanWeeks() {
    if (this.isSignedIn() && fbDb) { this._attachPlanWeeks(); this.retryUnsavedPlanWeeks(); }
  },
  _schedulePlanRetry() {
    if (this._planRetryTimer) return;
    this._planRetryTimer = setTimeout(() => { this._planRetryTimer = null; this.ensurePlanWeeks(); }, 60000);
  },

  // 複製課表之前（第 56 條）問一次伺服器：對方哪幾週自己對調過順序（整週跳過）、哪幾天已經先記了東西
  // （那天不動）——訂閱可能還沒送到。回傳 Promise<boolean>：false＝沒登入或沒連上（呼叫端就不要複製）。
  fetchCopyGuards(userId) {
    if (!this.isSignedIn() || !fbDb) return Promise.resolve(false);
    // 一次收完再合併、只重畫一次（一份一份合併的話，計畫後段她有一百多天的紀錄，按一下會重畫一百多次）
    const docsOf = (snap) => { const out = []; snap.forEach((doc) => out.push({ id: doc.id, data: doc.data() })); return out; };
    const adj = fbDb.collection(`users/${userId}/weekAdjustments`).get({ source: 'server' })
      .then((snap) => Store.mergeRemoteWeekAdjustments(userId, docsOf(snap)));
    const entries = fbDb.collection(`users/${userId}/entries`).get({ source: 'server' })
      .then((snap) => Store.mergeRemoteEntries(userId, docsOf(snap)));
    return Promise.all([adj, entries]).then(() => true, () => false);
  },

  // 常用項目庫（決策紀錄第 26 條）。libraryDenied：讀取被 rules 拒絕——最可能是 Firebase
  // Console 上的規則還沒加上 library 那一段。這**不能**走 _handleSnapErr 的通用分支：那條會
  // 判成「帳號未授權」直接登出，結果只是規則少貼一段，三個人全部被踢出去。
  libraryDenied: false,
  authResolved: false, // Firebase 回報過一次登入狀態了沒（開 App 時要等一下下才知道有沒有登入）
  _attachLibrary() {
    if (unsubLibrary) return;
    let backfilled = false;
    // includeMetadataChanges：要等到「伺服器確認過」的快照才補推（見 _backfillLibrary）。
    // 第一個快照常常是離線快取，拿快取比較時間戳可能用本機比較舊的欄位蓋掉雲端比較新的。
    unsubLibrary = fbDb.collection('library')
      .onSnapshot({ includeMetadataChanges: true }, (snap) => {
        const wasDenied = this.libraryDenied;
        this.libraryDenied = false;
        this._clearSnapFail('library', snap);
        let removed = false;
        // docChanges() 不帶參數＝不含「只有 metadata 變」的文件（快取→伺服器確認、寫入中→寫完）
        snap.docChanges().forEach((c) => {
          if (c.type === 'removed') { delete Store.library[c.doc.id]; delete Store._libraryServer[c.doc.id]; removed = true; return; }
          const data = c.doc.data() || {};
          // 內建內容的修改版整份取代，不逐欄位合併（第 33 條，見 Store.replaceRemoteLibrary）
          if (data.kind === 'workoutOverride' || data.kind === 'videoOverride') Store.replaceRemoteLibrary(c.doc.id, data);
          else Store.mergeRemoteLibrary(c.doc.id, data); // 這兩個自己會 notify
        });
        if (!backfilled && !snap.metadata.fromCache) { backfilled = true; this._backfillLibrary(snap); }
        // 決策紀錄第 29 條：只在畫面看得到的東西變了才重繪。以前每個快照都 _notify()——
        // includeMetadataChanges 讓只有 metadata 變的快照也會進來，開 App 大約一秒後（快取→伺服器）
        // 整頁無故重畫一次。庫的快照不影響同步膠囊，沒有理由為了 metadata 重繪。
        if (wasDenied || removed) this._notify();
      }, (err) => this._handleSnapErr(err, 'library'));
  },

  // 沒登入時存進庫裡的東西（那時 pushLibrary 直接略過）在第一次拿到伺服器快照時補推：
  // 雲端沒有的整份推；雲端有的只推「本機時間戳比較新」的欄位——整份推會拿本機比較舊的
  // 欄位蓋掉別人剛改的（逐欄位合併，決策紀錄第 13 條同一個原則）。快照已經先合併進
  // Store.library，所以「雲端比較新」的欄位本機時間戳已經跟雲端一樣，不會被推。
  _backfillLibrary(snap) {
    const remote = {};
    snap.forEach((doc) => { remote[doc.id] = doc.data() || {}; });
    Object.keys(Store.library).forEach((id) => {
      const local = Store.library[id];
      if (!local) return;
      // 修改版只能在登入時用 transaction 存（pushLibraryOverride），不會有「沒登入時存的」要補推
      if (local.kind === 'workoutOverride' || local.kind === 'videoOverride') return;
      const r = remote[id];
      if (!r) { this.pushLibrary(id, local); return; }
      const keys = Object.keys(local).filter((k) => k !== 'fieldAt' && k !== 'updatedAt' && fieldTime(local, k) > fieldTime(r, k));
      if (!keys.length) return;
      const push = { updatedAt: [local.updatedAt || '', r.updatedAt || ''].sort().pop(), fieldAt: {} };
      keys.forEach((k) => { push[k] = local[k]; push.fieldAt[k] = fieldTime(local, k); });
      this.pushLibrary(id, push);
    });
  },

  _detachLibrary() {
    if (unsubLibrary) unsubLibrary();
    unsubLibrary = null;
  },

  pushLibrary(docId, data) {
    if (!this.isSignedIn()) return;
    const key = `library:${docId}`;
    const clean = JSON.parse(JSON.stringify(data)); // 深層清掉 undefined（exercises 陣列裡的欄位）
    try {
      fbDb.collection('library').doc(docId).set(clean, { merge: true })
        .then(() => {
          if (!this.failedWrites.delete(key)) return;
          if (this.state === 'write-denied' && this.failedWrites.size === 0) this._set('done', '已同步');
          else this._notify();
        })
        .catch((err) => this._onWriteError('library', docId, '(常用項目庫)', key, err));
    } catch (err) {
      this._onWriteError('library', docId, '(常用項目庫)', key, err);
    }
  },

  // 內建動作清單／影片的修改版（決策紀錄第 33 條）。跟 pushPlanWeek 同一套：transaction 讀雲端
  // 最新的 updatedAt，跟打開編輯器那一刻的 baseUpdatedAt 比對，不一致就中止——兩個人同時改同一份
  // 內建清單時，後存的人不能靜默蓋掉先存的。整份文件 set（不 merge），content 跟 history 必須一起對。
  // 結果一律回報 onResult(ok, 訊息)；失敗時 Store 退回雲端確認過的版本，這裡再重新讀一次雲端校正。
  // 衝突不改同步膠囊的狀態（不是離線，不該顯示「離線，點擊重試」），訊息交給畫面直接跳出來。
  pushLibraryOverride(docId, doc, baseUpdatedAt, onResult) {
    const report = (ok, msg) => { if (onResult) onResult(ok, msg); };
    if (!this.isSignedIn()) {
      report(false, '要先登入才能改內建的動作清單或影片（三個人共用的內容），這次沒有存。');
      return;
    }
    const key = `library:${docId}`;
    const clean = JSON.parse(JSON.stringify(doc));
    const ref = fbDb.collection('library').doc(docId);
    const resync = () => ref.get()
      .then((snap) => Store.replaceRemoteLibrary(docId, snap.exists ? snap.data() : null))
      .catch(() => {});
    fbDb.runTransaction((tx) => tx.get(ref).then((snap) => {
      const remoteAt = snap.exists ? (snap.data() || {}).updatedAt || null : null;
      if (remoteAt !== (baseUpdatedAt || null)) {
        const err = new Error('library-conflict'); err.code = 'library-conflict'; throw err;
      }
      tx.set(ref, clean);
    })).then(() => {
      Store._libraryServer[docId] = clean; // 雲端確認過了（快照稍後也會送來同一份）
      const hadFail = this.failedWrites.delete(key);
      if (this._overrideFailed && this.state === 'fail') { this._overrideFailed = false; this._set('done', '已同步'); }
      else if (hadFail && this.state === 'write-denied' && this.failedWrites.size === 0) this._set('done', '已同步');
      else if (hadFail) this._notify();
      report(true, '');
    }).catch((err) => {
      if (err && err.code === 'library-conflict') {
        resync();
        report(false, '這份內容剛被別人改過，你這次的修改沒有存進去。');
        return;
      }
      if (err && err.code === 'permission-denied') {
        this._onWriteError('library', docId, '(常用項目庫)', key, err);
        report(false, this.message || '寫入被拒，這次的修改沒有存進去。');
        return;
      }
      // 沒網路（transaction 需要連線）或其他錯誤
      this.failedWrites.add(key);
      this._overrideFailed = true;
      this._set('fail', '沒有連上網路，內建內容的修改沒有存進去。');
      resync();
      report(false, '沒有連上網路（或連線不穩），這次的修改沒有存進去。');
    });
  },

  // 決策紀錄第 56 條：存某個人某一週的課表（users/{userId}/planWeeks/{週次}）。Mick 跟 Annlin 可能同時在改
  // Annlin 的課表，所以「兩人幾乎同時編輯同一週」是真的會發生的情境。整份 set 沒有任何版本比對的話，後寫的人
  // 會用「他打開畫面那一刻看到的舊版本」整份蓋掉先寫的人的修改，而且兩邊都顯示「已同步」——用 transaction
  // 做寫入前比對：baseUpdatedAt 是 app.js 的 _cloneEffectiveWeek 記下「這次編輯是從哪個版本開始改的」
  // （還沒有自己那份＝null），跟 transaction 裡讀到的最新版本不一致就中止，不要靜默覆蓋。
  // onFail：衝突以外的失敗（離線、被拒）時呼叫——「還原本週」用它退回原本的內容。
  //
  // 同一個人同一週的存檔排隊（審查抓到）：比對的基準是「上一次存的那份」的 updatedAt。上一筆還沒寫進雲端，
  // 下一筆就開始比對的話，雲端還是更舊的那份，會被誤判成「剛被別人改過」——連點兩下 ↓、複製完馬上微調都會中。
  // 排隊之後下一筆等上一筆寫完才比對，雲端就是上一筆，對得上。
  _planQueue: {},
  _planSession: 0, // 登出一次加一：上一個帳號還在路上的存檔，結果回來時不動這個帳號的狀態
  pushPlanWeek(userId, weekNumber, weekObj, baseUpdatedAt, onFail) {
    const qkey = `${userId}:${weekNumber}`;
    // 沒登入：只存在這台（跟以前一樣），不送雲端——也不算「還沒存進雲端」（登入之後不會把它補送上去）
    if (!this.isSignedIn()) {
      const c = Store._planChainOf.get(weekObj);
      if (c) c.localOnly = true; // 只在這台，不算「還沒存進雲端」、也不會補送上去；登入後雲端有別的版本時換掉並講（審查抓到）
      this._planResult[`planWeeks:${weekNumber}:${userId}`] = 'signed-out';
      return Promise.resolve();
    }
    this._planResult[`planWeeks:${weekNumber}:${userId}`] = 'queued';
    Store._planInFlight[qkey] = (Store._planInFlight[qkey] || 0) + 1;
    this._persistUnsaved(); // 存的當下就留在手機本機：送的期間關掉 App 也不會丟（審查抓到：以前送失敗才存）
    const session = this._planSession;
    const run = () => this._pushPlanWeekNow(userId, weekNumber, weekObj, baseUpdatedAt, onFail, session);
    const next = (this._planQueue[qkey] || Promise.resolve()).then(run, run);
    this._planQueue[qkey] = next;
    next.then(() => { if (this._planQueue[qkey] === next) delete this._planQueue[qkey]; });
    return next;
  },
  // 決策紀錄第 63 條：等這幾週排隊中的存檔都跑完，回傳哪幾週沒存進去（被拒、版本對不上、沒連上）。一定 resolve。
  // 複製課表用：以前按完沒有任何結果提示，寫入被退回時只有右上角的同步狀態會講，看起來就像「按了沒反應」。
  // 回傳沒存進去的週 [{ weekNumber, kind }]，kind：'conflict'（別人剛改過，已退回雲端的版本）、'denied'（規則擋下）、
  // 'network'（沒連上，這台留著、會自動補存）、'signed-out'。看的是這一次排隊跑完的結果（_planResult）。
  settlePlanWeeks(userId, weekNumbers, depth) {
    const waits = weekNumbers.map((wn) => this._planQueue[`${userId}:${wn}`] || Promise.resolve());
    return Promise.all(waits).then(() => {
      // 等的期間又被排進去送（補送）：再等一次（最多五輪，不然一直斷線會等不完）
      const again = weekNumbers.filter((wn) => this._planQueue[`${userId}:${wn}`]);
      if (again.length && (depth || 0) < 5) return this.settlePlanWeeks(userId, weekNumbers, (depth || 0) + 1);
      return weekNumbers.map((wn) => {
        const r = this._planResult[`planWeeks:${wn}:${userId}`];
        // 最後照「雲端有沒有這一份」講（審查抓到：只看 _planResult，登出清掉、或補送重排成 queued，會把沒送到的講成已經複製好了）
        if (Store.planDirty(userId, wn) || this._planQueue[`${userId}:${wn}`]) return { weekNumber: wn, kind: r === 'denied' ? 'denied' : 'network' };
        return { weekNumber: wn, kind: r === 'conflict' || r === 'signed-out' ? r : 'ok' };
      }).filter((x) => x.kind !== 'ok');
    });
  },
  _planResult: {},
  // 複製課表自己講結果：那幾週「沒存進去」的視窗先不跳（不然同一件事講兩次）。不帶參數＝結束
  _quietPlan: {},
  quietPlanWeeks(userId, weekNumbers) {
    if (!userId) { this._quietPlan = {}; return; }
    weekNumbers.forEach((wn) => { this._quietPlan[`planWeeks:${wn}:${userId}`] = true; });
  },
  // 決策紀錄第 64 條：修改沒存進去（別人剛改過、別台改過、還原沒成功）一律當下跳視窗講，不放在同步狀態等她點
  //（審查抓到：放在小字裡，好幾週的只看得到最後一筆，看過就一起清掉）。同一輪好幾週的合成一個視窗。
  _lost: {},
  _lostTimer: null,
  _reportLost(userId, weekNumber, text) {
    const key = `planWeeks:${weekNumber}:${userId}`;
    if (this._quietPlan[key]) return;
    this._lost[key] = text;
    if (this._lostTimer) return;
    this._lostTimer = setTimeout(() => {
      this._lostTimer = null;
      const msgs = Object.values(this._lost);
      this._lost = {};
      if (msgs.length && typeof alert === 'function') alert(msgs.join('\n'));
    }, 0);
  },
  _who(userId) { return (PlanData.userById[userId] || {}).displayName || userId; },
  // 沒登入的時候在這台改的課表：登入時講一次就好（不會上傳、重新整理就不見），講完當成一般的本機內容，不要一直掛在同步狀態上
  _noticeLocalOnly() {
    Store.planLocalOnlyWeeks().forEach(({ userId, weekNumber }) => {
      this._reportLost(userId, weekNumber, `沒登入的時候在這台改的第 ${weekNumber} 週（${this._who(userId)}）不會上傳，重新整理就會不見——要留下來的話，現在再改一次。`);
      const doc = Store.planWeeks[userId][weekNumber];
      if (doc) Store._planChainOf.delete(doc);
    });
  },
  // 收雲端那一份（快照、讀回來的、送的期間先放著的）：合併，然後照結果講。只有這裡把合併結果變成提示，不散在各處
  _mergeRemote(userId, weekNumber, doc, silent, fromCache) {
    const st = doc ? Store.mergeRemotePlanWeek(userId, weekNumber, doc, silent, fromCache)
      : (Store.clearRemotePlanWeek(userId, weekNumber, silent), 'ok');
    if (st === 'dropped') {
      // 這台那份被換掉了：結果要記成「沒存進去」，不能留著 'network'（複製課表看這個講結果，會說「會自動補存」——不會了）
      this._planResult[`planWeeks:${weekNumber}:${userId}`] = 'conflict';
      this._reportLost(userId, weekNumber, `${this._who(userId)} 的第 ${weekNumber} 週剛在別的地方被改過，這台還沒存進雲端的修改沒有存進去，畫面換成雲端上最新的。`);
    } else if (st === 'dropped-local') {
      this._reportLost(userId, weekNumber, `沒登入的時候在這台改的第 ${weekNumber} 週（${this._who(userId)}），登入之後換成雲端上的——沒登入時改的不會上傳。`);
    }
    return st;
  },
  planDeniedMsg(userId) { return this._planDeniedMsg(userId); },
  _planDeniedMsg(userId) {
    const who = this._who(userId);
    const coach = Store.coachUser();
    const republish = '請把 firestore.rules.local 整份重新貼到 Firebase Console 發布。';
    // 規則檔只在教練的電腦上：不是教練的人叫她請教練發布（審查抓到）
    const coachName = coach ? coach.displayName : '教練';
    const fix = Store.canEditLibrary() ? republish : `規則檔在 ${coachName} 的電腦上，請 ${coachName} 重新發布。`;
    // 能不能寫是 Firebase 的規則（看登入的帳號）決定的，不是這台選的「我是誰」——兩種可能都講（審查抓到：以前照這台的身分講，會講錯）
    return `${who} 的課表寫入被拒。可能是 Firebase 上的規則還是舊版（還沒有「每人一份課表」）——${fix}也可能是這個 Google 帳號不能改 ${who} 的課表。`;
  },
  // 同步狀態點了講的全部原因：課表沒存上去的（算出來的）＋別的同步問題（訂閱斷了、紀錄寫入被拒）——
  // 審查抓到：以前課表那段排在前面又用 ||，另一個問題一個字都看不到
  syncMessage() {
    const other = (this.state === 'fail' || this.state === 'write-denied') && this.message ? this.message : '';
    return [this.planIssueMessage(), other].filter(Boolean).join('\n');
  },
  // 課表「還沒存進雲端」的原因：一週一行，照現在還沒存上去的（Store.planUnsavedWeeks）算，不另外記
  planIssueMessage() {
    return Store.planUnsavedWeeks().map(({ userId, weekNumber }) => {
      const r = this._planResult[`planWeeks:${weekNumber}:${userId}`];
      if (r === 'denied') return `第 ${weekNumber} 週：${this._planDeniedMsg(userId)}這台手機上的修改還在，存得進去的時候會自動補存。`;
      return `${this._who(userId)} 的第 ${weekNumber} 週還沒存進雲端${r === 'network' ? '（沒有連上網路）' : ''}。這台手機上的修改還在，連上網路會自動補存。`;
    }).join('\n');
  },
  // 決策紀錄第 64 條（照 babylog 的「連上之後補送」）：網路斷掉、被拒而沒存進雲端的課表，連上網路、切回 App、
  // 按同步狀態、或過一陣子，就把這台現在的那份再送一次。比對用那份的 chain，不會被誤判成「別人改過」。
  retryUnsavedPlanWeeks() {
    if (!this.isSignedIn() || !fbDb) return;
    // 送出去讓規則決定（審查抓到：以前看這台選的「我是誰」，教練把身分切成別人就會把他改到一半、其實寫得進去的那週直接丟掉）。
    // 真的被拒就留著、講原因（同步狀態：寫入被拒要發布規則），規則發布或換回身分之後自動補送。
    Store.planUnsavedWeeks().forEach(({ userId, weekNumber }) => this.pushPlanWeek(userId, weekNumber, Store.planWeeks[userId][weekNumber], null));
  },
  _reloadPlanWeek(userId, weekNumber) {
    return fbDb.collection(`users/${userId}/planWeeks`).doc(String(weekNumber)).get()
      .then((snap) => {
        const cached = !!(snap.metadata && snap.metadata.fromCache);
        if (snap.exists) this._mergeRemote(userId, weekNumber, snap.data(), false, cached);
        else if (!cached) this._mergeRemote(userId, weekNumber, null);
      })
      .catch(() => {});
  },
  // 決策紀錄第 64 條：還沒存進雲端的課表（Store.planDirty，正在送的也算）存在手機本機（照登入的帳號分開），
  // 關掉 App 再開、同一個帳號登入時還原再補送。跟 babylog 一樣「寫入不因為關掉 App 而消失」——
  // babylog 靠 Firestore 的離線佇列，課表用的 transaction 沒有，要自己留。每次都照現在的狀態整份重寫，不會跟畫面對不上。
  _UNSAVED_KEY: 'mt_plan_unsaved_v1',
  _persistUnsaved() {
    const acct = this.user && this.user.email;
    if (!acct) return;
    let all = {};
    try { all = JSON.parse(localStorage.getItem(this._UNSAVED_KEY) || '{}') || {}; } catch (e) { all = {}; }
    const mine = {};
    Object.keys(Store.planWeeks).forEach((uid) => Object.keys(Store.planWeeks[uid] || {}).forEach((w) => {
      if (!Store.planDirty(uid, Number(w))) return;
      const doc = Store.planWeeks[uid][w];
      const chain = Store._planChainOf.get(doc);
      mine[`${uid}:${w}`] = { doc, base: chain.base, mine: chain.mine };
    }));
    // 只動這個分頁自己寫過的 key：同一台電腦開兩個分頁時，整份覆寫會把另一個分頁的離線修改抹掉（審查抓到）
    const bucket = { ...(all[acct] || {}), ...mine };
    (this._myUnsaved || []).forEach((k) => { if (!mine[k]) delete bucket[k]; });
    this._myUnsaved = Object.keys(mine);
    if (Object.keys(bucket).length) all[acct] = bucket; else delete all[acct];
    try { localStorage.setItem(this._UNSAVED_KEY, JSON.stringify(all)); } catch (e) { /* 存不了就只留在記憶體 */ }
  },
  _restoreUnsaved() {
    const acct = this.user && this.user.email;
    if (!acct) return 0;
    let all = {};
    try { all = JSON.parse(localStorage.getItem(this._UNSAVED_KEY) || '{}') || {}; } catch (e) { return 0; }
    const mine = all[acct] || {};
    let n = 0;
    Object.keys(mine).forEach((k) => {
      const { doc, base, mine: list } = mine[k] || {};
      const [uid, wnStr] = k.split(':');
      const wn = Number(wnStr);
      if (!doc || !Number.isInteger(wn) || !PlanData.userById[uid] || !Store._isValidWeekShape(doc) && !doc.isFactory) return;
      if (!Store.planWeeks[uid]) Store.planWeeks[uid] = {};
      const cur = Store.planWeeks[uid][wn];
      // 畫面上是別的內容（例如沒登入時在這台改的）：換成上次沒存進雲端的那份，但要講（審查抓到：以前無聲換掉）
      if (cur && cur.updatedAt !== doc.updatedAt) {
        this._reportLost(uid, wn, `${this._who(uid)} 的第 ${wn} 週換成上次還沒存進雲端的那份了（沒登入時在這台改的不會上傳）。`);
      }
      Store.planWeeks[uid][wn] = doc;
      const chain = { base: base == null ? null : base, mine: Array.isArray(list) && list.length ? list : [doc.updatedAt], dead: false };
      Store._planChainCur[k] = chain;
      Store._planChainOf.set(doc, chain); // 雲端版本還不知道＝還沒存進雲端（planDirty），快照來了再比
      n++;
    });
    return n;
  },
  _unsavedRetryTimer: null,
  _unsavedRetryStep: 0,
  _scheduleUnsavedRetry() {
    if (this._unsavedRetryTimer || !Store.planUnsavedWeeks().length) return;
    const delays = [15000, 60000, 180000];
    const d = delays[Math.min(this._unsavedRetryStep, delays.length - 1)];
    this._unsavedRetryStep++;
    this._unsavedRetryTimer = setTimeout(() => { this._unsavedRetryTimer = null; this.retryUnsavedPlanWeeks(); }, d);
  },
  // 課表有東西變了（存完、失敗、快照）：手機本機那份照現在的重寫、重畫（同步狀態是算出來的）、還有沒存上去的就排補送
  _planSettled() {
    this._persistUnsaved();
    if (Store.planUnsavedWeeks().length) this._scheduleUnsavedRetry(); else this._unsavedRetryStep = 0;
    this._notify();
  },
  // 送完一筆：送的期間雲端來了別人的版本（Store._planDeferred），最後一筆送完再比
  _planSent(userId, weekNumber) {
    const k = `${userId}:${weekNumber}`;
    Store._planInFlight[k] = Math.max(0, (Store._planInFlight[k] || 0) - 1);
    if (Store._planInFlight[k]) return;
    delete Store._planInFlight[k];
    if (!Object.prototype.hasOwnProperty.call(Store._planDeferred, k)) return;
    const doc = Store._planDeferred[k];
    delete Store._planDeferred[k];
    this._mergeRemote(userId, weekNumber, doc);
  },
  // 一定 resolve、不 reject（排在後面的要接著跑）
  _pushPlanWeekNow(userId, weekNumber, weekObj, baseUpdatedAt, onFail, session) {
    const key = `planWeeks:${weekNumber}:${userId}`;
    const pendKey = `${userId}:${weekNumber}`;
    const clean = JSON.parse(JSON.stringify(weekObj)); // 深層清掉 undefined
    const ref = fbDb.collection(`users/${userId}/planWeeks`).doc(String(weekNumber));
    const who = this._who(userId);
    const stale = () => session !== this._planSession; // 已經登出（或換了帳號）：結果不動現在的狀態
    // 決策紀錄第 64 條：這一份是從雲端哪一版開始改的（chain.base）、這台之後自己存的每一版（chain.mine）——
    // 雲端還是其中一版就不算衝突（前一筆沒存上去、或其實存上去了只是回應沒收到，都不會被誤判成「別人改過」）；
    // 不是＝別人（別台）改過，擋下。衝突之後這條 chain 作廢，排在後面、照舊內容改的存檔也一起擋下，不會蓋掉別人的。
    const chain = Store._planChainOf.get(weekObj);
    const allowed = chain ? [chain.base, ...chain.mine] : [baseUpdatedAt || null];
    return fbDb.runTransaction((tx) => tx.get(ref).then((snap) => {
      const remoteAt = snap.exists ? (snap.data() || {}).updatedAt || null : null;
      if ((chain && chain.dead) || (remoteAt && !allowed.includes(remoteAt))) {
        const err = new Error('plan-conflict'); err.code = 'plan-conflict'; throw err;
      }
      tx.set(ref, clean);
    })).then(() => {
      if (stale()) return;
      // 雲端現在是這一份（這台之後又改的，planDirty 照樣算還沒存上去）。回應回來之前畫面已經收了別人更新的版本，就不動（那才是雲端最新的）
      const own = Store.planWeeks[userId] && Store.planWeeks[userId][weekNumber];
      if (!chain || (own && Store._planChainOf.get(own) === chain)) Store._planCloudAt[pendKey] = clean.updatedAt;
      this._planResult[key] = 'ok';
      this._planSent(userId, weekNumber);
      this._planSettled();
    }).catch((err) => {
      if (stale()) return null;
      const conflict = err && err.code === 'plan-conflict';
      const denied = err && err.code === 'permission-denied';
      this._planResult[key] = conflict ? 'conflict' : denied ? 'denied' : 'network';
      if (conflict) {
        const first = !(chain && chain.dead && chain.reported);
        if (chain) { chain.dead = true; chain.reported = true; } // 排在後面、照舊內容改的也作廢；同一條只講一次
        if (first) this._reportLost(userId, weekNumber, `${who} 的第 ${weekNumber} 週剛被別人改過，你這次的修改沒有存進去，畫面換成雲端上最新的。確認一下你要改的還在不在。`);
        delete Store._planDeferred[pendKey]; // 下面直接讀雲端最新的
        this._planSent(userId, weekNumber);
        // 用遠端最新版本蓋掉本機剛剛的樂觀更新，避免這台裝置的畫面跟雲端分岔。
        return this._reloadPlanWeek(userId, weekNumber).then(() => this._planSettled());
      }
      if (onFail) {
        // 還原本週這種有自己退回方式的：照它的，當下講（畫面跳回去卻沒說，會以為按了沒反應）。
        // 期間又改過就退不回來（審查抓到：那時畫面是「還原之後又改的」，之後會補存上去，不能說「退回原本的內容」）
        const rolledBack = onFail() !== false;
        const why = denied ? this._planDeniedMsg(userId) : '沒有連上網路';
        const when = denied ? '存得進去的時候' : '連上網路';
        this._reportLost(userId, weekNumber, rolledBack
          ? `${who} 的第 ${weekNumber} 週沒有還原成功（${why}），畫面退回原本的內容。`
          : `${who} 的第 ${weekNumber} 週的還原沒有存進雲端（${why}），但你在那之後又改了這一週，畫面上是還原之後再改的內容，${when}會自動補存。`);
      }
      // 一般的存檔：畫面上留著、手機本機留著（Store.planDirty 算得出來），同步狀態講「還沒存進雲端」，之後自動補送
      this._planSent(userId, weekNumber);
      this._planSettled();
      return null;
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

  // 別人的訓練目標／階段性目標（總覽頁「查看別人的進度」唯讀用，教練模式下也用這份
  // 資料編輯），跟上面同一套管理方式、同一個 docChanges 分派邏輯。
  subscribeOtherProfile(otherUserId, onData) {
    if (!this.isSignedIn() || !fbDb) return;
    if (unsubOtherProfile[otherUserId]) return;
    unsubOtherProfile[otherUserId] = fbDb.collection(`users/${otherUserId}/profile`)
      .onSnapshot((snap) => {
        snap.docChanges().forEach((c) => {
          if (c.type === 'removed') return;
          if (c.doc.id === 'goals') Store.mergeRemoteGoals(otherUserId, c.doc.data());
          else if (c.doc.id === 'phaseTargets') Store.mergeRemotePhaseTargets(otherUserId, c.doc.data());
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

  _handleSnapErr(err, collectionName, ownerId) {
    if (collectionName === 'planWeeks') {
      // 見 _attachPlanWeeks 的註解：每人一份課表讀不到，最可能是規則還沒發布——不登出，退回讀共用課表／出廠
      console.warn('課表訂閱失敗：', ownerId, err && (err.code || err.message));
      if (unsubPlanWeeks[ownerId]) { unsubPlanWeeks[ownerId](); delete unsubPlanWeeks[ownerId]; }
      delete this._planWeeksLoaded[ownerId]; // 訂閱斷了：她的課表不再是最新的
      if (err && err.code === 'permission-denied') {
        this.planWeeksDenied = true;
        this._notify();
      } else {
        this._failSources[`planWeeks:${ownerId}`] = true;
        this._set('fail', '同步發生錯誤（課表）：' + (err ? err.message : '')); // 其他錯誤要看得到（膠囊會寫「離線，點擊重試」）
      }
      this._schedulePlanRetry(); // 一分鐘後自己再試（規則發布好了就讀得到）
      return;
    }
    if (collectionName === 'library') {
      // 見 _attachLibrary 的註解：常用項目庫讀不到只影響這個功能，不登出、不改整體同步狀態。
      console.warn('常用項目庫訂閱失敗：', err && (err.code || err.message));
      if (err && err.code === 'permission-denied') this.libraryDenied = true;
      this._detachLibrary();
      this._notify();
      return;
    }
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
    if (collectionName === 'planOverrides') this._detachPlanOverrides(); // 拆掉才重掛得了（不然它設的「同步有問題」永遠清不掉）
    this._failSources[collectionName] = true;
    this._set('fail', '同步發生錯誤：' + (err ? err.message : ''));
  },
  // 哪些訂閱現在是斷的（審查抓到：只記一個的話，會自己重掛的課表一恢復就把紀錄那邊還斷著的洗成「已同步」）
  _failSources: {},
  // 某個訂閱恢復了：全部都回來了才回到「已同步」。只有伺服器確認過的快照算數——
  // 離線時重掛，Firestore 會馬上用快取送一份回來，那不代表連上了（審查抓到）
  _clearSnapFail(source, snap) {
    if (snap && snap.metadata && snap.metadata.fromCache) return;
    delete this._failSources[source];
    if (this.state !== 'fail' || Object.keys(this._failSources).length || this.failedWrites.size) return;
    this._set('done', '已同步');
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
    // 寫自己的紀錄（沒有 targetUserId）：結果回來時身分已經換過，就跟現在這個身分無關，不動狀態（第 51 條）
    const seq = this._identitySeq;
    const stale = () => !targetUserId && seq !== this._identitySeq;
    try {
      fbDb.collection(`users/${userId}/${kind}`).doc(docId).set(clean, { merge: true })
        .then(() => {
          if (stale()) return;
          if (!this.failedWrites.delete(key)) return;
          // 之前被拒的那筆現在寫成功了：全部都補上就解除「寫入被拒」，否則只重繪
          if (this.state === 'write-denied' && this.failedWrites.size === 0) this._set('done', '已同步');
          else this._notify();
        })
        .catch((err) => { if (!stale()) this._onWriteError(kind, docId, userId, key, err); });
    } catch (err) {
      this._onWriteError(kind, docId, userId, key, err);
    }
  },

  _onWriteError(kind, docId, userId, key, err) {
    this.failedWrites.add(key);
    if (err && err.code === 'permission-denied') {
      // 第 56 條：課表、訓練目標是「本人或教練」能寫，常用項目庫只有教練能寫（isCoach()）。畫面上本來就不給沒有權限的人改，
      // 會被拒最可能是 Firebase Console 上還是舊規則——講清楚要怎麼做。
      const who = (PlanData.userById[userId] || {}).displayName || userId;
      const coach = Store.coachUser();
      const coachName = coach ? coach.displayName : '教練';
      const republish = '請把 firestore.rules.local 整份重新貼到 Firebase Console 發布。';
      if (kind === 'library') {
        this._set('write-denied', Store.canEditLibrary()
          ? `常用項目庫寫入被拒。Firebase 上的規則可能還是舊版——${republish}`
          : `常用項目庫只有 ${coachName} 能改，這次沒有存。`);
      } else if (kind === 'profile') { // 課表（planWeeks）不走這裡：它的原因是算出來的（planIssueMessage、_planDeniedMsg）
        const fix = Store.canEditLibrary() ? republish : `新的規則還沒發布，請 ${coachName} 發布之後再改一次。`;
        this._set('write-denied', Store.canEditGoalsOf(userId)
          ? `${who} 的訓練目標寫入被拒。Firebase 上的規則可能還是舊版——${fix}`
          : `別人的目標只有 ${coachName} 能改，${who} 的目標沒有改到。`);
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
      const profileDocs = {};
      if (Store.goals[userId]) profileDocs.goals = Store.goals[userId];
      if (Store.phaseTargets[userId]) profileDocs.phaseTargets = Store.phaseTargets[userId];
      if (Object.keys(profileDocs).length) await this._backfillCollection(userId, 'profile', profileDocs);
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
