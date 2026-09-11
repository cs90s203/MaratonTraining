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

START_DATE = "2026-09-07"   # 週一
RACE_DATE = "2027-03-07"    # 週日，第 26 週第 7 天
EXPIRED_BEFORE = "2026-09-10"  # 9/07-9/09 已成過去式；決策紀錄第 5 條

# --- 強度對照（訓練計畫第二節）-------------------------------------------------
Z = {
    "recovery": {"hr": "50-60%", "rpe": [2, 3], "feel": "非常輕鬆，像散步"},
    "zone2":    {"hr": "60-70%", "rpe": [4, 5], "feel": "輕鬆對話"},
    "long":     {"hr": "65-72%", "rpe": [5, 6], "feel": "後段稍吃力但仍能斷句對話"},
    "mp":       {"hr": "75-80%", "rpe": [6, 7], "feel": "可以講短句"},
    "none":     {"hr": None, "rpe": None, "feel": "以動作品質為主"},
}


def item(type_, title, zone="none", dur=None, km=None, video=None, workout=None,
         optional=False, notes=None, derived=False):
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
        "videoRef": video,
        "workoutRef": workout,
        "optional": optional,
        "notes": notes,
        "derived": derived,
    }


# --- 長跑與週跑量（訓練計畫第四節＝唯一真相來源；決策紀錄第 4 條）----------------
# metric 明確標示單位：Phase 1 用時間，Week 9 起用距離。不要讓 UI 靠猜。
LONG_RUN = {
    1: ("time", [20, 25]), 2: ("time", [20, 25]),
    3: ("time", [30, 30]), 4: ("time", [30, 30]),
    5: ("time", [35, 35]), 6: ("time", [35, 35]),
    7: ("time", [40, 40]), 8: ("time", [40, 40]),
    9: ("distance", [8, 8]), 10: ("distance", [8, 8]),
    11: ("distance", [10, 10]), 12: ("distance", [10, 10]),
    13: ("distance", [12, 12]), 14: ("distance", [12, 12]),
    15: ("distance", [14, 16]), 16: ("distance", [14, 16]),
    17: ("distance", [18, 18]), 18: ("distance", [18, 18]),
    19: ("distance", [22, 22]), 20: ("distance", [22, 22]),
    21: ("distance", [26, 28]), 22: ("distance", [26, 28]),   # 上限取 28K，決策紀錄第 4 條
    23: ("distance", [20, 20]), 24: ("distance", [12, 12]), 25: ("distance", [8, 8]),
    26: ("distance", [3, 5]),   # 賽週喚醒跑；比賽日本身另計
}

WEEKLY_VOLUME = {
    7: [8, 10], 8: [8, 10],
    9: [15, 18], 10: [15, 18], 11: [18, 22], 12: [18, 22],
    13: [22, 25], 14: [22, 25], 15: [25, 28], 16: [25, 28],
    17: [30, 33], 18: [30, 33], 19: [33, 36], 20: [33, 36],
    21: [36, 40], 22: [36, 40],
}

# --- 跑姿訓練內容（第七節；跳躍類延後到 Phase 2 後半，決策紀錄附註）--------------
def form_drill(w):
    if w <= 12:
        return "高抬腿、後踢腿，各 2 組 x 20 公尺"
    if w <= 16:
        return "A-Skip、B-Skip 各 2 組 x 20 公尺；節拍器抓步頻（目標 170-180 spm）、原地小跳步"
    return "上坡衝刺（短距離、低強度版）、彈跳訓練（輕量）"


# --- 每週模板 -----------------------------------------------------------------
def week_p1(w):
    """Phase 1 W1-8 恢復奠基。週四改用產後專門課程（決策紀錄第 3 條）。"""
    _, lr = LONG_RUN[w]
    return [
        [item("recovery", "產後核心/骨盆底啟動", "recovery", dur=[10, 15],
              workout="pelvic-core-basic",
              notes="死蟲式、鳥狗式、橋式呼吸。重點是「連結」不是「燃燒」。")],
        [item("walk-run", "走跑交替", "zone2", dur=[20, 25],
              notes="跑 1 分／走 1 分 x 8-10 組。若跑起來骨盆有下墜感就縮短跑段。")],
        [item("strength", "重量訓練 A（下肢＋核心）", "none", dur=[30, 30],
              workout="strength-a", notes="Phase 1 全部用徒手或極輕負荷，不追求痠痛感。")],
        [item("recovery", "產後骨盆底／腹直肌專門課程", "recovery", dur=[10, 15],
              video="fitnessblender-postpartum",
              notes="原計畫第六節：Pamela Reif 沒有產後專門系列，最初期建議用專門課程，"
                    "Phase 2 之後再換。")],
        [item("walk-run", "走跑交替", "zone2", dur=[20, 30],
              notes="逐步拉長跑段比例。")],
        [item("long-run", "長跑（走跑交替起步）", "long", dur=lr,
              notes="這階段的「長跑」以時間而非距離計。")],
        [item("rest", "完全休息", "none"),
         item("recovery", "散步＋伸展", "recovery", dur=[10, 10], optional=True,
              video="pamela-daily-stretch",
              notes="二擇一。骨盆底／核心當週練 3 次即可，不需每天。")],
    ]


def week_p2(w):
    """Phase 2 W9-16 基礎期。重訓每週 2 次（第五節的「每週 2 次」對應這個階段）。"""
    _, lr = LONG_RUN[w]
    return [
        [item("recovery", "核心／骨盆底進階", "recovery", dur=[15, 15],
              workout="pelvic-core-advanced")],
        [item("run", "Zone 2 跑", "zone2", dur=[30, 40],
              notes="全程跑，不再走跑交替。")],
        [item("strength", "重量訓練 A（下肢主導）", "none", dur=[30, 30],
              workout="strength-a", notes="Phase 2 開始可加輕啞鈴。")],
        [item("form-drill", "跑姿訓練日", "zone2", dur=[15, 20], notes=form_drill(w)),
         item("recovery", "核心", "recovery", dur=[10, 10], workout="pelvic-core-advanced")],
        [item("strength", "重量訓練 B（全身／上肢＋核心）", "none", dur=[30, 30],
              workout="strength-b")],
        [item("long-run", "長跑", "long", km=lr,
              notes="從 8K 起步逐週 +1-1.5K，上限約 16-18K。")],
        [item("rest", "完全休息", "none"),
         item("recovery", "瑜珈／伸展", "recovery", dur=[20, 20], optional=True,
              video="pamela-abs-yoga", notes="二擇一。")],
    ]


def week_p3(w):
    """Phase 3 W17-22 賽前期。重訓轉維持，每週 1 次。"""
    _, lr = LONG_RUN[w]
    return [
        [item("recovery", "核心＋骨盆底維持", "recovery", dur=[10, 10],
              workout="pelvic-core-advanced")],
        [item("run", "Zone 2 跑", "zone2", dur=[40, 50])],
        [item("strength", "重量訓練（維持）", "none", dur=[30, 30],
              workout="strength-a", notes="強度不加量，維持即可。")],
        [item("form-drill", "跑姿訓練", "zone2", dur=[15, 20], notes=form_drill(w)),
         item("tempo", "節奏跑", "mp", dur=[10, 15], notes="稍快於 Zone 2，量少即可。")],
        [item("run", "輕鬆跑", "recovery", dur=[30, 30]),
         item("rest", "完全休息", "none", optional=True, notes="二擇一，看身體狀況。")],
        [item("long-run", "長跑主軸", "long", km=lr,
              notes="可分段插入幾公里 MP 配速。上限 28K——不做到 32K+ 的高強度全馬課表。")],
        [item("rest", "完全休息", "none")],
    ]


def week_p4(w):
    """Phase 4 W23-25 減量期。原計畫只有三條 bullet，沒有每日模板——
    以 Phase 3 結構縮減推導，全部標 derived=True（決策紀錄第 4 條）。"""
    _, lr = LONG_RUN[w]
    d = True
    return [
        [item("recovery", "核心＋骨盆底維持", "recovery", dur=[10, 10],
              workout="pelvic-core-advanced", derived=d, notes="減量期每週 2 次即可。")],
        [item("run", "Zone 2 跑（遞減）", "zone2", dur=[30, 40], derived=d,
              notes="跑量每週遞減約 20-30%。")],
        [item("strength", "重量訓練（喚醒）", "none", dur=[20, 20], workout="strength-a",
              derived=d, notes="極輕量，只做動作喚醒，不追求進步。")],
        [item("recovery", "核心＋骨盆底（本週第 2 次）", "recovery", dur=[10, 10],
              workout="pelvic-core-advanced", derived=d)],
        [item("run", "輕鬆跑", "recovery", dur=[20, 30], derived=d),
         item("rest", "完全休息", "none", optional=True, derived=d, notes="二擇一，避免賽前疲勞。")],
        [item("long-run", "長跑（遞減）", "long", km=lr, derived=d)],
        [item("rest", "完全休息", "none", derived=d)],
    ]


def week_race(w):
    """W26 賽週。原計畫只有「3-5K 喚醒跑 / 3/7 比賽日」一行，其餘推導。"""
    d = True
    return [
        [item("rest", "完全休息", "none", derived=d),
         item("recovery", "散步", "recovery", dur=[15, 20], optional=True, derived=d)],
        [item("run", "輕鬆跑", "recovery", dur=[20, 30], derived=d)],
        [item("recovery", "核心／骨盆底（極輕）", "recovery", dur=[10, 10],
              workout="pelvic-core-advanced", derived=d)],
        [item("run", "喚醒跑", "zone2", km=[3, 5], derived=d,
              notes="含 2-3 段比賽配速，找感覺用，不累積疲勞。")],
        [item("rest", "完全休息", "none", derived=d)],
        [item("rest", "完全休息", "none", derived=d,
              notes="賽前一天：確認裝備、補給、交通與起跑區。")],
        [item("race", "東京馬拉松 2027", "mp", km=[42.195, 42.195], derived=d,
              notes="比賽日。配速照 Zone 2 起跑，前 10K 寧可慢。")],
    ]


PHASES = [
    {"phaseId": "p1", "name": "恢復奠基期", "weekRange": [1, 8], "builder": week_p1,
     "goal": "核心／骨盆底重建、走跑交替、建立跑步習慣、輕重量適應",
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
            metric, _ = LONG_RUN[w]
            days = [{"dayIndex": i, "items": items}
                    for i, items in enumerate(ph["builder"](w))]
            assert len(days) == 7, f"W{w} 不是 7 天"
            weeks.append({
                "weekNumber": w,
                "longRunMetric": metric,
                "weeklyVolumeKm": ({"min": WEEKLY_VOLUME[w][0], "max": WEEKLY_VOLUME[w][1]}
                                   if w in WEEKLY_VOLUME else None),
                "days": days,
            })

    return {
        "planId": "tokyo-marathon-2027",
        "planVersion": 1,
        "schemaVersion": 1,
        "startDate": START_DATE,
        "raceDate": RACE_DATE,
        "expiredBefore": EXPIRED_BEFORE,
        "totalWeeks": 26,
        "_note": ("date 與 dayOfWeek 刻意不存在本檔。由 startDate + (weekNumber-1)*7 + dayIndex "
                  "推導，見 docs/日曆基準.md。"),
        "phases": [{k: v for k, v in ph.items() if k != "builder"} for ph in PHASES],
        "weeks": weeks,
    }


if __name__ == "__main__":
    plan = build()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(plan, f, ensure_ascii=False, indent=2)
        f.write("\n")
    n_items = sum(len(d["items"]) for w in plan["weeks"] for d in w["days"])
    n_derived = sum(1 for w in plan["weeks"] for d in w["days"]
                    for it in d["items"] if it["derived"])
    print(f"✓ {OUT}")
    print(f"  {len(plan['weeks'])} 週 · {len(plan['weeks'])*7} 天 · "
          f"{n_items} 個訓練項目（其中 {n_derived} 個為推導值）")
