# 東京馬拉松 2027 訓練追蹤

26 週訓練課表的手機/電腦 web app。打開直接跳到今天，打勾標記完成、記身體狀況，
多裝置與多人各自追蹤自己的進度。

- **比賽日**：2027-03-07（週日）
- **起算日**：2026-09-07（週一）— 182 天 = 26 週整
- **日期的單一真相來源**：[docs/日曆基準.md](docs/日曆基準.md)
- **架構與待決事項的定案**：[docs/決策紀錄.md](docs/決策紀錄.md)

## 最高原則

> **休息或受傷的調整，不應該變相增加強度。**

任何「調整」功能寫完之後都要問一次：使用者用了它，之後某一天的負荷會不會比原本高？
會，就是做錯了。細節見決策紀錄第 0 條。

## 架構

純前端，沒有自己的伺服器。**Firebase（Authentication + Firestore）當後端。**

```
課表 + 影片 + 動作清單   靜態 JSON，bundle 進前端（帶 ?v= 版本號）
使用者完成紀錄            Firestore，一天一筆文件
身分                     Firebase Auth（Google 登入）+ Security Rules email 白名單
```

> 規格書原本寫的是「GitHub Contents API 當儲存後端」，那是 babylog **已經廢棄**的架構
> （見 `~/Documents/Projects/babylog/docs/sync.md`）。不要照那份做。

技術棧沿用 babylog：純 HTML/JS + CSS，**不使用任何建置工具**，模組切法照
`store.js`（狀態與持久化）／`views.js`（純渲染）／`app.js`（動作）／`main.js`（啟動）。

## 什麼東西不進 repo

**這個 repo 是 public**（GitHub Pages 免費版的必要條件），所以裡面的東西等於公開。

| | 放哪 | 為什麼 |
|---|---|---|
| 程式碼、課表 JSON | 這個 repo | 只有訓練結構（「走跑交替 20-25 分鐘」），不含個人狀況 |
| 原始訓練計畫 md | **只在本機** `docs/計畫原文/`（已 gitignore） | 含產後週數、配速、漏尿/腹直肌分離的個人健康狀況 |
| 完成紀錄、漏尿/疼痛/備註 | **Firestore**，永遠不進 repo | 敏感健康資料，且 `private/` 子集合只有本人可讀 |
| `firebaseConfig` | 這個 repo，可以放心 commit | 這組本來就是公開值，安全性由 Security Rules 把關 |
| Firebase service account 金鑰 | **哪裡都不要放**（已 gitignore） | 那個才是真的密鑰 |

## 本機開發

不需要任何建置工具：

```bash
python3 tools/serve.py
# 開瀏覽器 http://localhost:8772
```

Port **8772** 已登記在 `~/Documents/Projects/CLAUDE.md` 的 Port 註冊表。不要改成別的號碼。

## 部署

GitHub Pages：Settings → Pages → Source 選 `main` / root。網址會是
`https://cs90s203.github.io/MaratonTraining/`。

改課表或改功能時**一定要 bump 版本號**並更新所有 `?v=` querystring——
檔案伺服器不送 Cache-Control header，不改 URL 的話手機會靜默跑舊版
（babylog 在這件事上出過事，見它的 `index.html` 註解）。

## 進度

- [x] **CP0** 專案骨架、port 登記、架構與待決事項定案、日期修正
- [x] **CP1** 課表轉 JSON + `tools/verify_plan.py` 驗證腳本通過（39 項）
- [x] **CP2** 今日視圖
- [x] **CP3** 接 Firestore + 離線與失敗狀態
- [x] **CP4** 週視圖、總覽、使用者切換
- [x] **教練模式** 三人皆可切換編輯共用課表（設定頁開關），見
      [決策紀錄第 11 條](docs/決策紀錄.md#11-教練模式課表從共用唯讀改成三人皆可寫)
- [ ] **CP5** 部署到 GitHub Pages + 邀請其他共用者（填 `data/users.json` +
      `firestore.rules.local` 的 `isMember()`／`ownerEmail()`）

完整的規格審查報告（36 條發現）見 CHANGELOG 的 v0.1.0 條目。
