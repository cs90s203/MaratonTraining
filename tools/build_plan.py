#!/usr/bin/env python3
"""從每週模板產生 data/plan.json。

為什麼是產生器而不是手打 JSON：182 天 × 每天多個項目，手打必錯，而且改一次模板
要改 8 次（Phase 1 有 8 週共用同一張模板）。這裡模板是**唯一來源**，JSON 是產出。
改課表 = 改這個檔 → 重跑 → 跑 verify_plan.py。

資料來源：docs/計畫原文/訓練計畫.md（本機限定，不在 repo）
裁決依據：docs/決策紀錄.md
日期基準：docs/日曆基準.md

⚠️ 不產生 date 與 dayOfWeek 欄位。那兩個由 startDate + weekNumber + dayIndex 推導，
   寫進資料檔就會出現「兩個必須互相對應的數字」——原規格書就是這樣錯的
   （"date": "2026-09-10" 配 "dayOfWeek": "一"，那天其實是週四）。
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "data", "plan.json")

START_DATE = "2026-09-07"      # 週一
RACE_DATE = "2027-03-07"       # 週日，第 26 週第 7 天
EXPIRED_BEFORE = "2026-09-10"  # 9/07-9/09 已成過去式；決策紀錄第 5 條

# --- 安全性文字（訓練計畫.md 逐字，勿改一個字）---------------------------------
# 原文是 gitignore 的本機單一副本；這四段是它唯一會跟著進 App 的載體。
# verify_plan.py 有一條斷言做**逐字比對**——不是檢查非空，因為填成空白字元也會過關。
SAFETY = {
    "prerequisite":
        "雖然已產後 3 個月,但這份計畫仍假設妳已取得醫生/婦產科的運動許可,且沒有明顯的"
        "腹直肌分離(diastasis recti)或骨盆底功能異常。若還沒做過產後檢查,或運動中出現漏尿、"
        "下墜感、疼痛、分離超過2指寬等狀況,建議先找骨盆底物理治療師評估,再逐步提升強度。"
        "這份課表是訓練架構建議,不是醫療建議。",
    "disclaimer":
        "本計畫為訓練架構建議,非醫療處方。如有疼痛、漏尿、腹直肌分離未癒合等狀況,"
        "請諮詢婦產科醫師或骨盆底物理治療師調整強度。",
    "weeklySelfCheck":
        "每週日快速回顧:身體有無異常(漏尿、疼痛、過度疲勞)→ 有就該週降量,而不是硬照表操課",
    "intensityPrinciple":
        "產後前 3-6 個月心血管系統、韌帶(鬆弛素影響)、骨盆底都還在恢復,"
        "寧可\"心率壓低、時間拉長\",也不要為了配速硬撐。有心率錶的話,建議 Zone 2 上限先抓保守一點。",
    "_source": "docs/計畫原文/訓練計畫.md 第 6、180、176、28 行逐字。",
}

# --- 強度對照（訓練計畫第二節）-------------------------------------------------
# 裁決：**第二節的項目類型對照表是強度的唯一真相來源**，第三節模板的「心率/強度」欄
# 只是粗標籤。依據是原文第八節自己寫的操作順序（訓練計畫.md:175）：
#   「跑步日 → 對照第四節長跑進度表確認距離/時間,用第二節心率區間確認強度」
# 原文 Phase 1 的「走跑交替」（第二節:32，恢復檔）已依使用者指示整個拿掉
# （決策紀錄第 12 條：「走跑太含糊」），Phase 1 一律是 Zone 2 跑。
#
# 心率一律寫成 Zone（決策紀錄第 30 條，使用者指示）。原文第二節是「佔最大心率」的百分比，
# 換算照五區：Zone 1 50-60%、Zone 2 60-70%、Zone 3 70-80%、Zone 4 80-90%、Zone 5 90-100%；
# 上限剛好在邊界上不算進下一區，跨區寫「Zone 2-3」。跟 js/plan-data.js 的 fmtHeartRateZone
# 同一套規則（那邊負責把 Firestore 裡還沒改的舊百分比換算來顯示）。
#   恢復 50-60% → Zone 1；Zone 2 60-70% → Zone 2；長跑 65-72% → Zone 2-3；MP 75-80% → Zone 3
Z = {
    "recovery": {"hr": "Zone 1", "rpe": [2, 3], "feel": "非常輕鬆，像散步", "derived": False},
    "zone2":    {"hr": "Zone 2", "rpe": [4, 5], "feel": "輕鬆對話", "derived": False},
    "long":     {"hr": "Zone 2-3", "rpe": [5, 6], "feel": "後段稍吃力但仍能斷句對話", "derived": False},
    "mp":       {"hr": "Zone 3", "rpe": [6, 7], "feel": "可以講短句", "derived": False},
    # 第二節沒有「稍快於 Zone 2」這一檔。模板第 73 行寫「中等」、「稍快於 Zone2」，
    # 取往上一區的 Zone 3（跟 MP 同一區，靠 RPE 5-6 vs 6-7 區分）。這是推導的，標 derived。
    "tempo":    {"hr": "Zone 3", "rpe": [5, 6], "feel": "稍快於 Zone 2，仍能講短句", "derived": True},
    "none":     {"hr": None, "rpe": None, "feel": "以動作品質為主", "derived": False},
}


def item(type_, title, zone="none", dur=None, km=None, video=None, workout=None,
         notes=None, derived=False, segments=None):
    """一個訓練項目。dur/km 都是 [min, max] 或 None——原計畫幾乎全是區間，
    壓成單一數字等於在轉檔時偷偷替使用者做訓練決策。"""
    z = Z[zone]
    return {
        "type": type_,
        "title": title,
        "duration": {"min": dur[0], "max": dur[1]} if dur else None,
        "distanceKm": {"min": km[0], "max": km[1]} if km else None,
        "heartRateZone": z["hr"],
        "rpe": {"min": z["rpe"][0], "max": z["rpe"][1]} if z["rpe"] else None,
        "intensityNote": z["feel"],
        "intensityDerived": z["derived"],
        "videoRef": video,
        "workoutRef": workout,
        "notes": notes,
        "derived": derived,
        **({"segments": segments} if segments else {}),
    }


def day(*items, notes=None):
    """一般的一天：所有項目都要做。"""
    return {"selectOne": False, "dayNotes": notes, "items": list(items)}


def choice(*items, notes=None):
    """二擇一的一天（原文的「A 或 B」）。

    為什麼要有這個：原本編成「必做項目 + optional 的休息」，等於把休息變成要額外選的加購，
    預設是做。那違反決策紀錄第 0 條——調整不該變相增加強度，而「預設做、休息要自己選」
    正是把負荷設成預設值。selectOne 讓兩邊地位相等，UI 顯示成選擇題，完成任一即算完成。
    """
    assert len(items) >= 2, "選擇題至少要兩個選項"
    return {"selectOne": True, "dayNotes": notes, "items": list(items)}


# --- 長跑與週跑量（訓練計畫第四節＝唯一真相來源；決策紀錄第 4 條）----------------
LONG_RUN = {
    1: ("time", [20, 25]), 2: ("time", [20, 25]),
    3: ("time", [30, 30]), 4: ("time", [30, 30]),
    5: ("time", [35, 35]), 6: ("time", [35, 35]),
    7: ("time", [40, 40]), 8: ("time", [40, 40]),     # 第四節:93「40分鐘 全跑」——不再是走跑交替
    9: ("distance", [8, 8]), 10: ("distance", [8, 8]),
    11: ("distance", [10, 10]), 12: ("distance", [10, 10]),
    13: ("distance", [12, 12]), 14: ("distance", [12, 12]),
    15: ("distance", [14, 16]), 16: ("distance", [14, 16]),
    17: ("distance", [18, 18]), 18: ("distance", [18, 18]),
    19: ("distance", [22, 22]), 20: ("distance", [22, 22]),
    21: ("distance", [26, 28]), 22: ("distance", [26, 28]),  # 上限取 28K，決策紀錄第 4 條
    23: ("distance", [20, 20]), 24: ("distance", [12, 12]), 25: ("distance", [8, 8]),
    # W26 沒有長跑——賽週是喚醒跑 + 比賽本身，寫在 week_race()。
}

# 第四節的「週跑量參考」欄**不再進資料檔**（決策紀錄第 13 條，取代第 8 條）。
# 那欄是原文的參考上限，課表本身加總達不到它（W13 課表 15-17K、欄位卻寫 22-25K）——
# 拿它當「目標」跟「實際」比，等於用一個照表練也達不到的數字催使用者加跑，違反第 0 條。
# 週跑量目標現在由 App 執行期從該週的跑步項目即時加總（js/store.js weekVolume），
# 只有時長沒有距離的項目（Phase 1 全部以時間計）用下面這個配速換算。
# ⚠️ 方向：公里 = 分鐘 ÷ 分速，**分速數字越大換出來的公里越少**。原文寫 Zone 2 約 8-9 分速，
# 取慢的那一端 9——目標寧可低估不高估（第一版寫 8 還註解成「偏低」，方向抄反，
# W7-8 算出 10-11.9K 直接超過原文自己的參考上限 8-10K）。verify_plan.py 守下限 ≥ 9。
TIME_BASED_RUN_PACE_MIN_PER_KM = 9

# --- 跑姿訓練（第七節）---------------------------------------------------------
# 第七節:166 的產後提醒：核心/骨盆底沒練起來之前不建議做太多跳躍類(Skip、彈跳)，
# 建議放 Phase 2 中後段。所以 A-Skip/B-Skip 延到 W13 之後。
FORM_CUE = ("骨盆維持中立(產後核心弱化容易骨盆前傾)、避免過度跨步(overstride)、"
            "上身微前傾、手臂自然擺動不過度用力")
JUMP_WARNING = ("產後提醒：骨盆穩定度是跑姿訓練的第一優先。核心/骨盆底沒練起來之前，"
                "不要做太多跳躍類(Skip、彈跳)，以免增加骨盆底負擔。")


def drill_sets(*names):
    """原文第七節「各 2 組 x 20 公尺」寫成訓練段落（決策紀錄第 42 條）：每個動作一組「重複 2 次、20 公尺」。
    原文沒寫組間休息、暖身，這裡也不補。"""
    return [{"kind": "repeat", "times": 2,
             "steps": [{"kind": "drill", "amount": {"unit": "m", "min": 20, "max": 20}, "zone": None, "note": n}]}
            for n in names]


def form_drill(w):
    """回傳 (備註, 訓練段落)。原文有寫組數距離的（W9-16）放進段落。
    備註**保留**原本的組數距離文字：還開著舊版網頁（不認得 segments）的裝置存這個項目時會把段落洗掉，
    文字留著至少指示不會整個消失（對抗式審查抓到；跟第 28 條 videoRef 兩個都寫同一個道理）。"""
    if w <= 12:
        return ("重點：姿勢重建、觸地方式。高抬腿、後踢腿各 2 組 x 20 公尺。"
                f"（跳躍類延後到 W13 之後）{FORM_CUE}"), drill_sets("高抬腿", "後踢腿")
    if w <= 16:
        return ("重點：步頻與觸地時間。A-Skip、B-Skip 各 2 組 x 20 公尺；"
                f"節拍器抓步頻（目標 170-180 spm）、原地小跳步。{JUMP_WARNING} {FORM_CUE}"), drill_sets("A-Skip", "B-Skip")
    return ("重點：力量轉換效率。上坡衝刺（短距離、低強度版）、彈跳訓練（輕量）。"
            f"{JUMP_WARNING} {FORM_CUE}"), None


# --- 每週模板 -----------------------------------------------------------------
def week_p1(w):
    """Phase 1 W1-8 恢復奠基。週四改用產後專門課程（決策紀錄第 3 條）。

    原文這階段的跑步日與 W1-6 長跑都是「走跑交替」（Zone 1）。使用者裁定拿掉
    （決策紀錄第 12 條：走跑太含糊），全部改成 Zone 2 跑。
    W1-6 的長跑跟著用 Zone 2，**不**跳到第二節「長跑」的 Zone 2-3——那會比原本高兩級；
    W7-8 第四節寫「40分鐘 全跑」，才適用 Zone 2-3。verify_plan.py 有斷言綁住這條。
    """
    _, lr = LONG_RUN[w]
    if w <= 6:
        long_item = item("long-run", "長跑（Zone 2）", "zone2", dur=lr,
                         notes="這階段的「長跑」以時間而非距離計，全程維持 Zone 2。"
                               "若骨盆有下墜感就縮短當天時間，不要硬撐。")
    else:
        # 出處：第四節 W7-8「40分鐘 全跑」才進 Zone 2-3
        long_item = item("long-run", "長跑", "long", dur=lr,
                         notes="這個階段最後兩週，長跑強度可以進到 Zone 2-3。一樣以時間計。")
    return [
        day(item("recovery", "產後核心/骨盆底啟動", "recovery", dur=[10, 15],
                 workout="pelvic-core-basic",
                 notes="死蟲式、鳥狗式、橋式呼吸。重點是「連結」不是「燃燒」。")),
        day(item("run", "Zone 2 跑", "zone2", dur=[20, 25],
                 notes="心率壓在 Zone 2，配速不重要；沒有心率錶就用講話測試：能完整講一句話但微喘。"
                       "Zone 2 上限先抓保守一點。若跑起來骨盆有下墜感就縮短當天時間。")),
        day(item("strength", "重量訓練 A（下肢＋核心）", "none", dur=[30, 30],
                 workout="strength-a",  # 出處：第五節末「Phase 1 全部用徒手或極輕負荷」
                 notes="這個階段全部徒手或用極輕的重量，重點是動作品質跟核心連結，不追求痠痛感。")),
        day(item("recovery", "產後骨盆底／腹直肌專門課程", "recovery", dur=[10, 15],
                 video="fitnessblender-postpartum",
                 # 出處：第六節——Pamela Reif 沒有產後專門系列，最初期建議用專門課程，Phase 2（醫生放行後）再換
                 # 審查抓到：寫「到基礎期再換成一般影片」，但基礎期這一格沒有排影片，跑者可能自己多加一支（第 0 條）
                 notes="產後初期先用專門的產後課程重建骨盆底跟核心。醫生放行一般運動強度之前，"
                       "先不要換成一般的居家訓練影片。")),
        day(item("run", "Zone 2 跑", "zone2", dur=[20, 30],
                 notes="逐週拉長時間，心率不變。Zone 2 上限先抓保守一點。")),
        day(long_item),
        choice(item("rest", "完全休息", "none"),
               item("recovery", "散步＋伸展", "recovery", dur=[10, 10],
                    video="pamela-daily-stretch"),
               notes="骨盆底／核心當週練 3 次即可，不需每天。"),
    ]


def week_p2(w):
    """Phase 2 W9-16 基礎期。重訓每週 2 次（第五節的「每週 2 次」對應這個階段）。"""
    _, lr = LONG_RUN[w]
    return [
        day(item("recovery", "核心／骨盆底進階", "recovery", dur=[15, 15],
                 workout="pelvic-core-advanced")),
        day(item("run", "Zone 2 跑", "zone2", dur=[30, 40])),
        day(item("strength", "重量訓練 A（下肢主導）", "none", dur=[30, 30],
                 workout="strength-a", derived=True,  # 時長 30 分沿用 Phase 1（原文未給），所以標 derived
                 notes="從這個階段開始可以加輕的啞鈴。時間 30 分鐘是比照恢復奠基期排的。")),
        day(item("form-drill", "跑姿訓練日", "zone2", dur=[15, 20], notes=form_drill(w)[0], segments=form_drill(w)[1]),
            item("recovery", "核心", "recovery", dur=[10, 10], workout="pelvic-core-advanced",
                 notes="10 分鐘版：從「查看動作」裡挑 3 項做就好。")),
        day(item("strength", "重量訓練 B（全身／上肢＋核心）", "none", dur=[30, 30],
                 workout="strength-b", derived=True,  # 時長 30 分沿用 Phase 1（原文未給），所以標 derived
                 notes="時間 30 分鐘是比照恢復奠基期排的。")),  # 第 9 條：標 derived 要寫明哪裡是推導的
        day(item("long-run", "長跑", "long", km=lr,
                 # 第四節為準：本階段上限 16K（模板另寫「上限約 16-18K」，衝突時以第四節為準）
                 notes="每兩週拉長一次，這個階段最長到 16K。")),
        choice(item("rest", "完全休息", "none"),
               item("recovery", "瑜珈／伸展", "recovery", dur=[20, 20], video="pamela-abs-yoga")),
    ]


def week_p3(w):
    """Phase 3 W17-22 賽前期。重訓轉維持，每週 1 次。"""
    _, lr = LONG_RUN[w]
    return [
        day(item("recovery", "核心＋骨盆底維持", "recovery", dur=[10, 10],
                 workout="pelvic-core-advanced",
                 notes="10 分鐘版：從「查看動作」裡挑 3 項做就好。")),
        day(item("run", "Zone 2 跑", "zone2", dur=[40, 50])),
        # 原文:72 只寫「重量訓練(維持,強度不加量)」，沒指定 A 或 B。
        # 逕自解成 A 會讓訓練 B 在最後 10 週整份消失，所以做成選擇題並標 derived。
        choice(item("strength", "重量訓練 A（維持）", "none", dur=[30, 30],
                    workout="strength-a", derived=True),
               item("strength", "重量訓練 B（維持）", "none", dur=[30, 30],
                    workout="strength-b", derived=True),
               notes="這個階段重訓只維持：重量、組數都不再往上加。每週挑 A 或 B 其中一份做，下週換另一份。"),
        day(item("form-drill", "跑姿訓練", "zone2", dur=[15, 20], notes=form_drill(w)[0], segments=form_drill(w)[1]),
            item("tempo", "節奏跑", "tempo", dur=[10, 15],
                 notes="比 Zone 2 稍快一點，量少就好；這個階段才開始有節奏跑。")),  # 原文「稍快於 Zone 2」
        choice(item("run", "輕鬆跑", "recovery", dur=[30, 30]),
               item("rest", "完全休息", "none"),
               notes="看身體狀況，兩邊地位相等。"),
        day(item("long-run", "長跑主軸", "long", km=lr,
                 notes="可分段插入幾公里 MP 配速（Zone 3）。"
                       "上限 28K——不做到 32K+ 的高強度全馬課表。")),
        day(item("rest", "完全休息", "none")),
    ]


def week_p4(w):
    """Phase 4 W23-25 減量期。原計畫只有三條 bullet，沒有每日模板——
    以 Phase 3 結構縮減推導，全部標 derived=True（決策紀錄第 4 條）。"""
    _, lr = LONG_RUN[w]
    d = True
    return [
        day(item("recovery", "核心＋骨盆底維持", "recovery", dur=[10, 10],
                 workout="pelvic-core-advanced", derived=d,
                 notes="減量期每週 2 次即可。10 分鐘版：挑 3 項。")),
        day(item("run", "Zone 2 跑（遞減）", "zone2", dur=[30, 40], derived=d,
                 notes="跑量每週遞減約 20-30%。")),
        day(item("strength", "重量訓練（喚醒）", "none", dur=[20, 20], workout="strength-a",
                 derived=d, notes="極輕量，只做動作喚醒，不追求進步。")),
        day(item("recovery", "核心＋骨盆底（本週第 2 次）", "recovery", dur=[10, 10],
                 workout="pelvic-core-advanced", derived=d, notes="10 分鐘版：挑 3 項。")),
        choice(item("run", "輕鬆跑", "recovery", dur=[20, 30], derived=d),
               item("rest", "完全休息", "none", derived=d),
               notes="避免賽前疲勞，休息不扣分。"),
        day(item("long-run", "長跑（遞減）", "long", km=lr, derived=d)),
        day(item("rest", "完全休息", "none", derived=d)),
    ]


def week_race(w):
    """W26 賽週。原計畫只有「3-5K 喚醒跑 / 3/7 比賽日」一行，其餘推導。"""
    d = True
    return [
        choice(item("rest", "完全休息", "none", derived=d),
               item("recovery", "散步", "recovery", dur=[15, 20], derived=d)),
        day(item("run", "輕鬆跑", "recovery", dur=[20, 30], derived=d)),
        day(item("recovery", "核心／骨盆底（極輕）", "recovery", dur=[10, 10],
                 workout="pelvic-core-basic", derived=d,
                 notes="賽週做這份輕的就好，不要換回前幾週那份比較難的。")),  # basic＝pelvic-core-basic
        day(item("run", "喚醒跑", "zone2", km=[3, 5], derived=d,
                 notes="賽週的喚醒跑 3-5K，中間放 2-3 段稍快的找感覺，不要累積疲勞。")),  # 出處：第四節
        day(item("rest", "完全休息", "none", derived=d)),
        day(item("rest", "完全休息", "none", derived=d,
                 notes="賽前一天：確認裝備、補給、交通與起跑區。")),
        day(item("race", "東京馬拉松 2027", "long", km=[42.195, 42.195], derived=d,
                 # 第二節沒有比賽日的心率檔位，沿用「長跑」Zone 2-3（決策紀錄第 6 條）
                 notes="比賽日。心率照長跑的 Zone 2-3；用 Zone 2 的配速起跑，前 10K 寧可慢。")),
    ]


PHASES = [
    {"phaseId": "p1", "name": "恢復奠基期", "weekRange": [1, 8], "builder": week_p1,
     "goal": "核心／骨盆底重建、Zone 2 慢跑起步、建立跑步習慣、輕重量適應",
     "loadGuidance": "全部用徒手或極輕負荷，重點是動作品質與核心連結。"},
    {"phaseId": "p2", "name": "基礎期", "weekRange": [9, 16], "builder": week_p2,
     "goal": "提升 Zone 2 跑量、穩定長跑、重訓進階、跑姿定型",
     "loadGuidance": "可加輕啞鈴。跑姿訓練每週一次，避開長跑後隔天。"},
    {"phaseId": "p3", "name": "賽前期", "weekRange": [17, 22], "builder": week_p3,
     "goal": "長跑拉到 28K、少量配速跑、重訓轉維持",
     "loadGuidance": "重訓維持不加量。長跑上限 28K。"},
    {"phaseId": "p4", "name": "減量期", "weekRange": [23, 25], "builder": week_p4,
     "goal": "跑量遞減、保留強度感覺、多休息",
     "loadGuidance": "重訓極輕量、只做動作喚醒。核心／骨盆底每週 2 次即可。"},
    {"phaseId": "race-week", "name": "賽週", "weekRange": [26, 26], "builder": week_race,
     "goal": "完全減量、比賽日",
     "loadGuidance": "不要在賽前一週嘗試任何新東西。"},
]


def build():
    weeks = []
    for ph in PHASES:
        a, b = ph["weekRange"]
        for w in range(a, b + 1):
            days = []
            for i, entry in enumerate(ph["builder"](w)):
                entry["dayIndex"] = i
                # 每個項目一個固定 id（"{週次}-{星期}-{在當天的序號}"）。這是教練模式
                # 存在的前提：完成紀錄（Store.entries[...].done）用 id 對應項目，不是用
                # 陣列位置——教練在 UI 上新增/刪除/調整順序時，位置會變但 id 不會變，
                # 舊的打勾紀錄才不會悄悄對到錯的項目上。verify_plan.py 有斷言檢查
                # 全域 id 唯一。
                for j, it in enumerate(entry["items"]):
                    it["id"] = f"{w}-{i}-{j}"
                days.append(entry)
            assert len(days) == 7, f"W{w} 不是 7 天"
            weeks.append({
                "weekNumber": w,
                "longRunMetric": LONG_RUN[w][0] if w in LONG_RUN else None,
                "days": days,
            })

    return {
        "planId": "tokyo-marathon-2027",
        "planVersion": 4,
        # v3：每個項目多了固定 id（教練模式用，見上方 build() 註解）
        # v4：拿掉 walk-run 類型與 weeklyVolumeKm/weeklyVolumeNullReason 欄位，
        #     新增 timeBasedRunPaceMinPerKm（決策紀錄第 12、13 條）
        "schemaVersion": 4,
        "startDate": START_DATE,
        "raceDate": RACE_DATE,
        "expiredBefore": EXPIRED_BEFORE,
        "expiredBeforeReason": ("起算日從 2026-09-10 改成 2026-09-07 之後，9/07-9/09 已成過去式。"
                                "這三天不計入完成率分母，也不提示補做——要求補做等於第一週就加量，"
                                "違反決策紀錄第 0 條。"),
        "totalWeeks": 26,
        "timeBasedRunPaceMinPerKm": TIME_BASED_RUN_PACE_MIN_PER_KM,
        "safety": SAFETY,
        "_note": ("date 與 dayOfWeek 刻意不存在本檔。由 startDate + (weekNumber-1)*7 + dayIndex "
                  "推導，見 docs/日曆基準.md。週跑量目標也刻意不存在本檔——由 App 從該週的"
                  "跑步項目即時加總（只有時長的項目用 timeBasedRunPaceMinPerKm 換算），"
                  "教練模式改了項目目標就跟著變，不會有兩個必須互相對應的數字。"),
        "phases": [{k: v for k, v in ph.items() if k != "builder"} for ph in PHASES],
        "weeks": weeks,
    }


if __name__ == "__main__":
    plan = build()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(plan, f, ensure_ascii=False, indent=2)
        f.write("\n")
    items = [it for w in plan["weeks"] for d in w["days"] for it in d["items"]]
    n_choice = sum(1 for w in plan["weeks"] for d in w["days"] if d["selectOne"])
    n_derived = sum(1 for it in items if it["derived"])
    print(f"✓ {OUT}")
    print(f"  {len(plan['weeks'])} 週 · {len(plan['weeks'])*7} 天 · {len(items)} 個項目"
          f"（{n_derived} 個推導值）· {n_choice} 個二擇一日")
