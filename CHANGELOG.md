# CHANGELOG

版本號規則：功能完成 = 中位數，bug fix = 末位數。每個 Checkpoint 完成時 bump 中位數。

---

## v0.4.1 — 2026-09-11 · PlanData 查找表修正 + 教練模式

### 修正：PlanData.userById/videoById/workoutById 永遠是空物件

三個查找表用 shorthand property 回傳，在 IIFE 執行的那一刻（`load()` 還沒跑）就把值
凍結成初始空物件，之後 `load()` 重新指派本地變數不會反映到已經回傳出去的物件上——
跟 `plan/videos/workouts/users` 不一樣，那四個當時就寫成 getter。影響：影片連結、
動作清單、總覽頁的頭像姓名縮寫全部靜默不見，不拋錯，很難發現。改成 getter，跟其他
四個一致。同時加入 Annlin、Phoebe 兩位使用者（`data/users.json` + `firestore.rules.local`
的 `ownerEmail` 對照）。

### 新增：教練模式

三個白名單成員都能切換進一個編輯模式，直接在 UI 上調整共用課表——新增/刪除/調整
順序項目、切換二擇一、編輯週跑量參考、還原成出廠預設值。範圍與取捨見
[決策紀錄第 11 條](docs/決策紀錄.md#11-教練模式課表從共用唯讀改成三人皆可寫)。

**架構**：出廠課表（`data/plan.json`）不變，教練模式的修改存進 Firestore 新集合
`planOverrides/{weekNumber}`，疊加在出廠值上面（`Store.effectiveWeek()`）。每個項目
多了固定 `id`（出廠課表用 `"{週次}-{星期}-{序號}"`，教練新增的項目用
`crypto.randomUUID()`），完成紀錄從「陣列位置對應」（`itemsDone`/`selectedChoice`）
換成「id 對應」（`entries.done`/`selectedItemId`）——這是新增/刪除/排序項目時，
舊的打勾紀錄不會對到錯的項目上的前提。`planVersion`/`schemaVersion` bump 到 3。

### 教練模式程式碼審查：18 個代理、12 條發現通過查證（2 blocker、4 major）

同樣的流程：五維度平行審查 + 逐條查證，實際重現每條發現（不只讀碼），修掉全部：

- **blocker**：`planOverrides` 寫入零 schema 驗證，一份殘缺文件（缺 `days`）會讓
  「總覽」與該週「本週」頁對所有人同時當機——連「還原成出廠預設值」這個自救按鈕
  都畫在會當機的頁面裡，按不到。修法兩層：`Store.saveWeekOverride` 存檔前擋、
  `Store.effectiveWeek` 讀取時也擋（壞資料當作不存在，退回出廠值）；`main.js` 的
  `render()` 也包一層 try/catch 當最後防線。
- **blocker**：教練能直接刪除二擇一日唯一的休息選項，把「可以完全休息」變成
  「一定要做點什麼」，違反決策紀錄第 0 條。`deleteItem` 加兩道防呆：selectOne
  少於 2 個選項擋下、刪除後不再有 `rest` 類型的選項也擋下。
- **major**：教練刪掉使用者已選的選項後，舊的 `selectedItemId` 懸空卻仍被算成
  「完成」，把完成率灌水。`dayStatus`/`weekCompletionRate` 改成先確認選中的 id
  還存在於目前的項目清單裡。
- **major**：整週覆寫（`merge:false`）沒有任何版本比對，兩人幾乎同時編輯同一週時
  後寫的會靜默蓋掉先寫的。改用 Firestore transaction 比對 `baseUpdatedAt`，偵測到
  衝突就中止並提示重新整理，不會無聲覆蓋。
- **major**：時長/距離/RPE 輸入沒有上下限，HTML 的 `min`/`max` 只是裝飾，手滑
  打錯會直接存進所有人共用的課表。存檔前加範圍檢查（時長 0-300 分、距離 0-100K、
  RPE 0-10）。
- 其餘 minor/nit：`toggleDaySelectOne` 開啟二擇一時也檢查至少 2 個選項；還原失敗
  時回滾本機狀態並告知使用者；清空週跑量時補上 `weeklyVolumeNullReason`，避免
  「兩個 null 同時代表不同意思」；決策紀錄補第 11 條記錄這個功能的取捨。

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

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
