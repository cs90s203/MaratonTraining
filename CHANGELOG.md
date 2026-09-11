# CHANGELOG

版本號規則：功能完成 = 中位數，bug fix = 末位數。每個 Checkpoint 完成時 bump 中位數。

---

## v0.3.0 — 2026-09-11 · CP2-CP4 今日視圖／週視圖／總覽／使用者切換／Firestore 同步

一次做完四個頁面 + 同步層。純前端 + Firebase compat SDK，零建置工具，inline
onclick="A.xxx()"，跟 babylog 同一套架構（store/views/app/main 四個模組）。

### 修正：firestore.rules 的 userId ≠ uid

寫程式碼之前才發現：規則寫 `request.auth.uid == userId`，但 `userId` 是
`data/users.json` 的人類可讀字串（"mick"），Firebase Auth 的 uid 是登入產生的隨機
字串，兩者永遠不會相等——照原規則寫入權限全部會被拒。改成 `ownerEmail(userId)`
email 對照表，真實 email 只放 `firestore.rules.local`（gitignore）。

### 新增

- `data/users.json`、`icons/`、`manifest.webmanifest`（PWA，iOS 加入主畫面用）
- `js/plan-data.js` — 唯一允許算日期的地方，`startDate+weekNumber+dayIndex` 推導
- `js/store.js` — 狀態 + localStorage，`Store.activeUserId`（寫入身分）跟總覽頁的
  `viewingUserId`（唯讀查看別人）分開，避免切換查看混淆成切換身分
- `js/firebase-sync.js` — Google 登入 + Firestore 訂閱、離線佇列靠 SDK 的
  `enablePersistence()`，不手刻 outbox
- `js/views.js` / `js/app.js` / `js/main.js` — 四個頁面 + 動作層
- `day.selectOne`：原規格書的「A 或 B」用 optional 欄位表示，等於把休息變成要
  額外選的加購（違反決策紀錄第 0 條）；現在兩個選項地位相等，UI 是選擇題

### CP2-4 程式碼審查：18 個代理、12 條發現通過查證（1 blocker、6 major）

跟 CP1 同一套流程：五維度平行審查 + 逐條查證。修掉全部：

- **blocker**：`setActualStats` 送出 `actualDistanceKm: undefined` 給 Firestore，
  `.set()` 對 undefined 欄位是**同步丟例外**（不是 Promise reject），例外會炸穿整條
  呼叫鏈、連 `.catch()` 都接不到——這筆時長/距離資料完全沒送到雲端，UI 卻毫無提示。

  修法兩層：patch 物件不放沒填的欄位；`pushDoc` 加防禦性清理 + try/catch。
- **選擇題 A→B→A 弄壞已完成紀錄**：`selectChoice` 借用 `toggleItemDone` 的「翻轉」
  語意，在兩個選項間切換會把先選的那個翻回 false，UI 顯示「選了這個」但沒打勾，
  週視圖/總覽把已完成的一天算成未完成。改成每次選擇整組重建 `itemsDone`。
- **選錯身分被誤判成未授權，強制整組登出**：白名單成員（伴侶/教練）切到不是自己的
  `userId` 時，`private/` 因 `isSelf()` 失敗噴 permission-denied，舊版把這跟「真的
  不在白名單」用同一個分支處理，直接 `signOut()`。現在只有 entries/weekAdjustments
  失敗才視為真未授權；private 單獨失敗顯示「身分不符」，不登出。
- **hasPendingWrites 只綁 entries**：只改身體狀況備註或標記本週降量時，同步小提示
  列會誤顯示「已同步」。改成三個集合分開追蹤、OR 合併。
- **未登入期間的本機資料，登入後不會補推上雲**：永久孤兒在該裝置。新增
  `_backfillLocal`，登入時一次性補推，且逐筆比對 `updatedAt` 避免蓋掉遠端新版本。
- **樂觀寫入被拒不會回滾，也沒有逐筆提示**：不回滾（決策紀錄第 0 條：不該因權限
  問題懲罰使用者剛完成的動作），但項目卡片會顯示「尚未同步」標籤。
- 其餘 minor/nit：同步小提示列的錯誤狀態被舊的 pending 蓋掉、`enablePersistence`
  失敗沒有 UI 訊號、`onclick` 裡的 `userId` 沒轉義、安全提醒漏了「每週日自檢」
  那一段、跨專案的教訓註解座標寫錯（指向本專案不存在的行號）。

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

---

## v0.1.0 — 2026-09-10 · CP0 專案骨架

### 建立

- `git init`（main 分支）、`.gitignore`、first commit
- Port **8772** 登記進 `~/Documents/Projects/CLAUDE.md` 的 Port 註冊表，
  並寫進 `.claude/launch.json` 與 `tools/serve.py`
- 來源文件從 `~/Downloads` 落地到 `docs/計畫原文/`（本機限定，已 gitignore）
- [docs/日曆基準.md](docs/日曆基準.md) — 26 週日期的單一真相來源
- [docs/決策紀錄.md](docs/決策紀錄.md) — 規格審查留下的待決事項定案

### 修正：日期算術

原始計畫與規格書都宣稱 26 週，實際不是。

| | 原本 | 修正後 |
|---|---|---|
| 起算日 | 2026-09-10（**週四**） | 2026-09-07（週一） |
| 總長度 | 179 天 = 25 週又 4 天 | 182 天 = **26 週整** |
| 比賽日 | 構不到第 26 週 | 第 26 週第 7 天 |
| Phase 4 | 19 天（宣稱 3 週） | 21 天 |
| 賽週 | 6 天（宣稱 1 週） | 7 天 |
| schema 第一筆 | `"date": "2026-09-10"` + `"dayOfWeek": "一"`（那天是週四） | 兩個欄位都不存，由 `startDate + weekNumber + dayIndex` 推導 |

原始計畫的階段邊界全部落在週四，但每週課表模板按「一二三四五六日」排——
兩者衝突時**以模板為準**，因為模板是實際要照著練的東西。

### 決定

1. **儲存後端改 Firebase Auth + Firestore**，不用 GitHub Contents API
   （那是 babylog 已廢棄的架構，廢棄理由是 token 對非工程背景的人不友善）
2. **漏尿/疼痛/備註預設完全不分享**，走 `users/{userId}/private/{date}` 子集合
3. **Phase 1 週四改用產後專門課程**，Pamela Reif 從 Phase 2 才開始
   （原計畫第六節自己就說她沒有產後專門系列）
4. **Week 23-26 從第四節進度表推導**，標 `derived: true`，不留空白也不讓 AI 自由發揮
5. **9/07–9/09 標 `expired`**，不計入分母、不提示補做

### 訂下最高原則

> 休息或受傷的調整，不應該變相增加強度。

降量週縮小分母而不是把量往後推；補做只能取代當天內容不能疊加；中斷回歸往後順延而不壓縮剩餘週數。

### 背景

本次改動來自一次多代理規格審查（84 個代理、七維度平行掃描、每條發現逐字回原檔查證
並經對抗式反駁）。原始 46 條發現中 8 條被駁回，去重後 36 條成立：
3 條 blocker、14 條 major、19 條規格缺口。上面的修正與決定涵蓋了全部 3 條 blocker
與其中 9 條 major。
