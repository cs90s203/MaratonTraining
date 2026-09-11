// Firebase 專案設定。
//
// 這組值**本來就是公開的**，放進 public repo 沒問題——它識別專案，不授權任何事。
// 真正的防線是 firestore.rules 的 email 白名單（babylog docs/sync.md:23：
// 「真正的防線一定是 Security Rules，前端檢查只是體驗優化。」）。
// 不能進 repo 的是 service account 金鑰，那個 .gitignore 已經擋了。
//
// 專案：mtrain-c655c（2026-09-11 建立，MarathonTrain 專用）
// ⚠️ 這個 Firebase 專案只給這個 App 用，不要塞第二個 App 進來——
//    Firestore 的 Security Rules 是整個專案共用一份的，兩個 App 共存時
//    任何一邊改規則都可能把另一邊鎖死。
//
// 用 compat SDK（全域 firebase namespace），不是 npm / ES modules——本專案零建置工具。
// SDK 由 index.html 的 <script src> 載入，版本寫死在網址裡。

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCQ_SvHjPSmCE7P7L8El8wrcwpdxvnXQ5o",
  authDomain: "mtrain-c655c.firebaseapp.com",
  projectId: "mtrain-c655c",
  storageBucket: "mtrain-c655c.firebasestorage.app",
  messagingSenderId: "36720295279",
  appId: "1:36720295279:web:19e757c718d26440023c9a"
  // measurementId 省略：不用 Analytics，少載一個 SDK
};
