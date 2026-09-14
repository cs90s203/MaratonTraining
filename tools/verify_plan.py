#!/usr/bin/env python3
"""驗證 data/*.json。改課表之後一定要重跑。

為什麼要有這支：原規格書把 182 筆日期的品保寫成「人工檢查一次」，而它自己的
三行範例就已經有兩個日期錯誤（起算日差三天、dayOfWeek 標錯）。人工檢查 182 個
日期本來就不可靠。全域 CLAUDE.md 第 5 條：被違反過一次的警告要升級成可執行的守衛。

這裡的斷言分兩類：
  A. 形狀檢查——週數、日期連續、參照完整性、欄位合法性
  B. **綁到決策的檢查**——安全性文字逐字未被竄改、強度規則、derived 標記、第 0 條
     （B 類是第一版漏掉的。第一版 23 條全是 A 類，所以安全性文字整段消失也照樣全綠。）

用法：python3 tools/verify_plan.py     （全部通過回傳 0，有錯回傳 1）
"""
import hashlib
import json
import re
import os
import sys
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEEKDAY = "一二三四五六日"
VALID_TYPES = {"recovery", "run", "long-run", "tempo", "interval",
               "form-drill", "strength", "rest", "race"}  # interval＝間歇跑（決策紀錄第 40 條，出廠課表目前沒有）
# 週跑量目標只算這幾種（js/store.js weekVolume 用同一組；兩邊是不同執行環境，靠註解同步）。
# race 刻意不在裡面：比賽是整份計畫的終點，不是「賽週的跑量目標」——算進去會讓賽週目標
# 變成 47K+，進度條整週停在 10%，26 週的圖也被那一根拉到看不出其他週的差異。
RUN_TYPES = {"run", "long-run", "tempo", "interval"}

# 安全性文字的獨立基準。**故意不從 build_plan.py import**——那樣等於拿產生器檢查自己。
# 這四段是 docs/計畫原文/訓練計畫.md 第 6、180、176、28 行的逐字內容；改一個標點就會失敗。
SAFETY_SHA = {
    "prerequisite": "c93ea00259c5b4914bda51a19f9f1d9badea67448b4a5a29fcb8471ecab1a3e8",
    "disclaimer": "866e45895315b4944b49b6aa7223a47a8de40d83e1920daeaf32d45a289210b5",
    "weeklySelfCheck": "c37c5fdc21b3763d7cdb76f129f26419e4423dbd8e60d554b00031e1c19c67d2",
    "intensityPrinciple": "38d562721382285f0ad1de8d20c951f0958761147241d7365f56e9b4bee59861",
}

# 第二節的項目類型 → 心率區間。原文第八節:175 指定強度以第二節為準。
# 決策紀錄第 30 條：心率一律寫成 Zone（原文百分比照五區換算，見 build_plan.py 的 Z 表）。
EXPECTED_HR = {
    "run": None,            # 可能是 Zone 2 跑或輕鬆跑(Zone 1)，不硬性綁
    "long-run": None,       # 分兩段檢查：W1-6 是 Zone 2、W7 起 Zone 2-3（見 B2）
    "tempo": "Zone 3",      # 推導的（「稍快於 Zone 2」取往上一區），標 intensityDerived
}
ZONE_RE = re.compile(r"^Zone [1-5](-[1-5])?$")
# 原文第二節的五個百分比寫法。第 30 條之後資料檔裡一個都不能出現——不管在心率欄還是備註裡。
HR_PERCENT_STRINGS = ["50-60%", "60-70%", "65-72%", "70-75%", "75-80%"]

fails = []
checks = []


def check(name, ok, detail=""):
    checks.append((name, ok, detail))
    if not ok:
        fails.append(name)


def load(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return json.load(f)


def main():
    plan = load("data/plan.json")
    videos = load("data/videos.json")
    workouts = load("data/workouts.json")

    start = date.fromisoformat(plan["startDate"])
    race = date.fromisoformat(plan["raceDate"])
    weeks = plan["weeks"]
    days_all = [(w, d) for w in weeks for d in w["days"]]
    items = [(w["weekNumber"], d["dayIndex"], it) for w, d in days_all for it in d["items"]]

    # ══ A. 形狀 ═══════════════════════════════════════════════════════════════
    check("起算日是週一", start.weekday() == 0, f"{start} 是週{WEEKDAY[start.weekday()]}")
    check("比賽日是週日", race.weekday() == 6, f"{race} 是週{WEEKDAY[race.weekday()]}")
    check("剛好 26 週", len(weeks) == 26, f"實際 {len(weeks)} 週")
    check("週次 1..26 連續無缺無重",
          [w["weekNumber"] for w in weeks] == list(range(1, 27)))
    bad = [w["weekNumber"] for w in weeks if len(w["days"]) != 7]
    check("每週剛好 7 天", not bad, f"不是 7 天的週：{bad}")
    bad = [w["weekNumber"] for w in weeks
           if [d["dayIndex"] for d in w["days"]] != list(range(7))]
    check("每週 dayIndex 為 0..6", not bad, f"異常的週：{bad}")

    days = [start + timedelta(days=(w["weekNumber"] - 1) * 7 + d["dayIndex"])
            for w, d in days_all]
    check("總天數 182", len(days) == 182, f"實際 {len(days)}")
    check("日期無重複", len(set(days)) == len(days))
    gaps = [str(days[i]) for i in range(1, len(days)) if (days[i] - days[i - 1]).days != 1]
    check("日期連續無跳號", not gaps, f"斷點：{gaps[:5]}")
    check("最後一天等於 raceDate", days[-1] == race, f"最後一天 {days[-1]}")

    covered = []
    for ph in plan["phases"]:
        a, b = ph["weekRange"]
        covered += list(range(a, b + 1))
    check("phases 涵蓋 W1-26 無重疊無空洞", sorted(covered) == list(range(1, 27)))

    raw = json.dumps(plan, ensure_ascii=False)
    check('資料檔不含 "date" 欄位', '"date"' not in raw,
          "應由 startDate+weekNumber+dayIndex 推導")
    check('資料檔不含 "dayOfWeek" 欄位', '"dayOfWeek"' not in raw, "應由 dayIndex 推導")
    check("weeks 不含 phaseId", not any("phaseId" in w for w in weeks),
          "階段歸屬的唯一真相來源是 phases[].weekRange")

    vids = {v["id"] for v in videos["videos"]}
    wkts = {w["id"] for w in workouts["workouts"]}
    # 決策紀錄第 28 條：影片可以是單一 videoRef（舊格式）或 videoRefs 陣列，兩個都要查
    bad = [f'W{a}D{b} → {ref}' for a, b, it in items
           for ref in ([it["videoRef"]] if it.get("videoRef") else []) + list(it.get("videoRefs") or [])
           if ref not in vids]
    check("videoRef／videoRefs 全部找得到", not bad, str(bad[:5]))
    bad = [f'W{a}D{b} → {it["workoutRef"]}' for a, b, it in items
           if it["workoutRef"] and it["workoutRef"] not in wkts]
    check("workoutRef 全部找得到", not bad, str(bad[:5]))

    bad = [f'W{a}D{b} {it["type"]}' for a, b, it in items if it["type"] not in VALID_TYPES]
    check("type 全部在列舉內", not bad, str(bad[:5]))
    bad = [f'W{a}D{b} {it["title"]}' for a, b, it in items
           if (it["duration"] and it["duration"]["min"] > it["duration"]["max"])
           or (it["distanceKm"] and it["distanceKm"]["min"] > it["distanceKm"]["max"])]
    check("區間的 min <= max", not bad, str(bad[:5]))
    empty = [f'W{w["weekNumber"]}D{d["dayIndex"]}' for w, d in days_all if not d["items"]]
    check("每天至少一個項目", not empty, str(empty[:5]))

    # 教練模式的前提：完成紀錄用 item.id 對應，不是陣列位置——id 一定要存在且全域唯一，
    # 否則兩個不同項目共用一個 id，其中一個打勾會誤標到另一個。
    missing_id = [f'W{a}D{b} {it["title"]}' for a, b, it in items if not it.get("id")]
    check("每個項目都有 id", not missing_id, str(missing_id[:5]))
    all_ids = [it["id"] for _, _, it in items if it.get("id")]
    dup_ids = {x for x in all_ids if all_ids.count(x) > 1}
    check("項目 id 全域唯一", not dup_ids, str(list(dup_ids)[:5]))

    bad = []
    for w in weeks:
        kinds = [it["type"] for d in w["days"] for it in d["items"]]
        n = kinds.count("long-run") + kinds.count("race")  # 二擇一的長跑不存在，直接數
        if n != 1:
            bad.append(f'W{w["weekNumber"]}={n}')
    check("每週恰好一次長跑或比賽", not bad, str(bad))
    check("最後一天是 race",
          any(it["type"] == "race" for it in weeks[-1]["days"][-1]["items"]))

    # ══ B. 綁到決策的檢查 ══════════════════════════════════════════════════════
    # B1 安全性文字逐字未被竄改（決策依據：原文第 6/180/176/28 行）
    safety = plan.get("safety") or {}
    missing = [k for k in SAFETY_SHA if not safety.get(k)]
    check("safety 四個欄位都存在", not missing, f"缺：{missing}")
    tampered = [k for k, h in SAFETY_SHA.items()
                if safety.get(k) and hashlib.sha256(safety[k].encode()).hexdigest() != h]
    check("safety 文字逐字未被竄改", not tampered,
          f"與原文不符：{tampered}（改一個標點就會失敗，這是刻意的）")
    # 若本機還有原文，再做一次真正的來源比對
    src_path = os.path.join(ROOT, "docs/計畫原文/訓練計畫.md")
    if os.path.exists(src_path):
        src = open(src_path, encoding="utf-8").read()
        notin = [k for k in SAFETY_SHA if safety.get(k) and safety[k] not in src]
        check("safety 文字確實出自原文", not notin, f"查無此字串：{notin}")

    # B2 強度規則：第二節的項目類型表是唯一真相來源（原文第八節:175）
    bad = [f'W{a}D{b} {it["title"]} = {it["heartRateZone"]}' for a, b, it in items
           if it["heartRateZone"] is not None and not ZONE_RE.match(it["heartRateZone"])]
    check("心率區間一律是 Zone 格式（第 30 條）", not bad, str(bad[:4]))
    found = [p for p in HR_PERCENT_STRINGS if p in raw]
    check("資料檔不含心率百分比（第 30 條）", not found, str(found))
    bad = [f'W{a}D{b} {it["title"]} = {it["heartRateZone"]}' for a, b, it in items
           if EXPECTED_HR.get(it["type"]) and it["heartRateZone"] != EXPECTED_HR[it["type"]]]
    check("強度符合第二節對照表", not bad, str(bad[:4]))
    # 決策紀錄第 12 條：走跑整個拿掉，Phase 1 一律 Zone 2 跑。W1-6 的長跑原本是走跑
    # Zone 1，改成 Zone 2 跑之後**只能**進到 Zone 2，不可以順手標成第二節「長跑」的
    # Zone 2-3（那是連跳兩級，違反第 0 條）；W7-8 原文寫「40分鐘 全跑」才是 Zone 2-3。
    bad = [f'W{a}D{b} {it["title"]} = {it["heartRateZone"]}' for a, b, it in items
           if it["type"] == "long-run" and it["heartRateZone"] != ("Zone 2" if a <= 6 else "Zone 2-3")]
    check("長跑強度：W1-6 Zone 2、W7 起 Zone 2-3", not bad, str(bad[:4]))
    bad = [f'W{a}D{b} {it["title"]}' for a, b, it in items if it["type"] == "walk-run"]
    check("沒有 walk-run 類型（第 12 條）", not bad, str(bad[:4]))
    bad = [f'W{a}D{b} {it["title"]}' for a, b, it in items
           if "走跑" in (it["title"] or "") or "走跑" in (it["notes"] or "")]
    check("標題與備註不含「走跑」字樣", not bad, str(bad[:4]))
    # Phase 1 所有跑步類項目都是 Zone 2（不是 Zone 1 也不是 Zone 2-3）——W7-8 長跑除外
    bad = [f'W{a}D{b} {it["title"]} = {it["heartRateZone"]}' for a, b, it in items
           if a <= 8 and it["type"] == "run" and it["heartRateZone"] != "Zone 2"]
    check("Phase 1 的 run 一律 Zone 2", not bad, str(bad[:4]))
    # 推導出來的強度必須標記。第 30 條之後 tempo 跟 MP 都是 Zone 3，不能再用心率字串認，改認類型
    bad = [f'W{a}D{b} {it["title"]}' for a, b, it in items
           if it["type"] == "tempo" and not it["intensityDerived"]]
    check("推導強度（tempo）有標 intensityDerived", not bad, str(bad[:4]))

    # B3 決策紀錄第 4 條：W23-26 原文沒有每日模板，每一筆都要標 derived
    bad = [f'W{a}D{b} {it["title"]}' for a, b, it in items if a >= 23 and not it["derived"]]
    check("W23-26 每一筆都標 derived", not bad, str(bad[:4]))
    # 反向：W1-22 照原文抄的不該亂標 derived（除非是補的時長／未指定 A/B）
    check("有推導值且數量合理", 0 < sum(1 for _, _, it in items if it["derived"]) < len(items))

    # B4 決策紀錄第 0 條：休息不該是「要額外選的加購」
    # 原文的「A 或 B」必須編成 selectOne，不能編成「必做 + optional 休息」。
    check("沒有 optional 欄位殘留", "optional" not in raw,
          "二擇一要用 selectOne，不是把休息標成 optional")
    bad = [f'W{w["weekNumber"]}D{d["dayIndex"]}' for w, d in days_all
           if d["selectOne"] and len(d["items"]) < 2]
    check("selectOne 的日子至少兩個選項", not bad, str(bad[:4]))
    # 二擇一若其中一個是完全休息，另一個不可以被標成 derived 而休息沒標（會造成顯示不對等）
    bad = [f'W{w["weekNumber"]}D{d["dayIndex"]}' for w, d in days_all
           if d["selectOne"] and len({it["derived"] for it in d["items"]}) > 1]
    check("二擇一的選項 derived 標記一致", not bad, str(bad[:4]))

    # B5 決策紀錄第 5 條：expiredBefore 必須正好是 2026-09-10（不是「落在第 1 週內」就好）
    check("expiredBefore 正好是 2026-09-10", plan["expiredBefore"] == "2026-09-10",
          f'實際 {plan["expiredBefore"]}；改成別的值等於改變哪幾天不計入分母')
    check("expiredBefore 有寫理由", bool(plan.get("expiredBeforeReason")))

    # B5b 自編的動作清單必須標 derived + 寫明哪裡是推導的
    bad = [w["id"] for w in workouts["workouts"] if "derived" not in w]
    check("每份 workout 都標了 derived", not bad, f"未標：{bad}")
    bad = [w["id"] for w in workouts["workouts"]
           if w.get("derived") and not w.get("derivedNote")]
    check("derived 的 workout 有寫理由", not bad, f"未說明：{bad}")
    bad = [f'{w["id"]}/{e["name"]}' for w in workouts["workouts"] for e in w["exercises"]
           if isinstance(e.get("holdSeconds"), int) or isinstance(e.get("reps"), int)]
    check("reps/holdSeconds 一律用 {min,max}", not bad, str(bad[:4]))
    # 決策紀錄第 42 條：訓練段落的形狀（跟 js/plan-data.js cleanSegments 同一套規則；形狀不對的段 App 會直接丟掉，
    # 出廠資料不能靠 App 幫忙丟）
    SEG_KINDS = {"warmup", "main", "recover", "drill", "cooldown"}
    SEG_UNIT_CAPS = {"min": 300, "sec": 3600, "m": 50000, "km": 100}  # 跟 plan-data.js SEGMENT_UNIT_CAPS 一致
    HR_ZONES = {"Zone 1", "Zone 1-2", "Zone 2", "Zone 2-3", "Zone 3", "Zone 3-4", "Zone 4", "Zone 4-5", "Zone 5"}
    def step_ok(st):
        a = st.get("amount")
        amount_ok = a is None or (a.get("unit") in SEG_UNIT_CAPS and 0 < a["min"] <= a["max"] <= SEG_UNIT_CAPS[a["unit"]])
        note = st.get("note") or ""
        zone_ok = st.get("zone") is None or st.get("zone") in HR_ZONES
        has_content = a is not None or note.strip() or st.get("zone")
        return (st.get("kind") in SEG_KINDS and amount_ok and zone_ok and bool(has_content)
                and note == note.strip() and len(note) <= 60)
    bad = []
    for a_, b_, it in items:
        segs = it.get("segments") or []
        if len(segs) > 20:
            bad.append(f"W{a_}D{b_} {it['title']}（超過 20 段）")
        for sg in segs:
            if sg.get("kind") == "repeat":
                if not (isinstance(sg.get("times"), int) and 1 <= sg["times"] <= 50 and sg.get("steps")
                        and len(sg["steps"]) <= 10 and all(step_ok(x) for x in sg["steps"])):
                    bad.append(f"W{a_}D{b_} {it['title']}")
            elif not step_ok(sg):
                bad.append(f"W{a_}D{b_} {it['title']}")
    check("訓練段落形狀正確（第 42 條）", not bad, str(bad[:4]))
    drill_days = [(a_, it) for a_, b_, it in items if it["type"] == "form-drill" and 9 <= a_ <= 16]
    check("W9-16 跑姿訓練的動作寫進訓練段落（原文第七節有組數距離）",
          bool(drill_days) and all(it.get("segments") for _, it in drill_days))
    # 決策紀錄第 33 條：內建動作清單可以被教練在 App 裡改，safetyNote 是改不掉的那一段——
    # 畫面一律從這個檔案拿。這裡守「每份都有、而且真的講到漏尿／下墜感」。
    bad = [w["id"] for w in workouts["workouts"]
           if not w.get("safetyNote") or "漏尿" not in w["safetyNote"] or "下墜感" not in w["safetyNote"]]
    check("每份 workout 都有固定的安全提醒（第 33 條）", not bad, f"缺：{bad}")
    basic = next((w for w in workouts["workouts"] if w["id"] == "pelvic-core-basic"), None)
    adv = next((w for w in workouts["workouts"] if w["id"] == "pelvic-core-advanced"), None)
    check("進階版的安全提醒指得到基礎版的名稱",
          bool(basic and adv and basic["name"] in adv.get("safetyNote", "")),
          "改了 pelvic-core-basic 的名稱要一起改 pelvic-core-advanced 的 safetyNote")
    # 內建內容的修改版用「同一個 id」存在 Firestore（第 33 條），自訂的 id 一律 c- 開頭。
    # 內建 id 以 c- 開頭、或動作清單跟影片撞 id，修改版就會蓋錯東西。
    clash = sorted(i for i in (vids | wkts) if i.startswith("c-")) + sorted(vids & wkts)
    check("內建 id 不以 c- 開頭、影片跟動作清單不撞 id（第 33 條）", not clash, str(clash))

    # B6 決策紀錄第 13 條：週跑量目標由 App 從跑步項目即時加總，資料檔不存那個數字
    # （存了就是「兩個必須互相對應的數字」——教練改項目後它會過時）。
    check('資料檔不含 "weeklyVolumeKm" 欄位', '"weeklyVolumeKm"' not in raw,
          "週跑量目標由 js/store.js weekVolume 從項目加總，不存進 plan.json")
    # 公里 = 分鐘 ÷ 分速：分速數字越小，換出來的目標越高。要守的是下限（原文 Zone 2 約 8-9
    # 分速，取慢端 9 才是低估）；上限只是防打錯字。
    pace = plan.get("timeBasedRunPaceMinPerKm")
    check("timeBasedRunPaceMinPerKm 是 9-12 之間的數字（越小目標越高，下限才是要守的邊）",
          isinstance(pace, (int, float)) and 9 <= pace <= 12, f"實際 {pace!r}")
    # 賽週（W26）扣掉比賽日仍要有跑步類項目，否則賽週目標算不出來
    w26 = weeks[-1]
    check("賽週扣掉比賽日仍有跑步類項目",
          any(it["type"] in RUN_TYPES for d in w26["days"] for it in d["items"]))
    # 每週都算得出目標的前提：每週（扣掉過期日）至少一個跑步類項目
    expired_before = date.fromisoformat(plan["expiredBefore"])
    bad = []
    for w in weeks:
        has_run = any(it["type"] in RUN_TYPES
                      for d in w["days"] for it in d["items"]
                      if start + timedelta(days=(w["weekNumber"] - 1) * 7 + d["dayIndex"]) >= expired_before)
        if not has_run:
            bad.append(w["weekNumber"])
    check("每週（扣掉過期日）至少一個跑步類項目", not bad, f"沒有跑步的週：{bad}")
    # 只有時長沒距離的跑步項目，換算配速才用得上；有距離的不該再被換算——
    # 這裡守的是「每個跑步項目至少有 duration 或 distanceKm 其中之一」，否則目標會少算它。
    bad = [f'W{a}D{b} {it["title"]}' for a, b, it in items
           if it["type"] in RUN_TYPES and not it["duration"] and not it["distanceKm"]]
    check("跑步類項目都有時長或距離（目標加總的前提）", not bad, str(bad[:4]))

    # ── 輸出 ──
    width = max(len(n) for n, _, _ in checks)
    for name, ok, detail in checks:
        print(f'[{"  ok  " if ok else " FAIL "}] {name.ljust(width)}'
              + (f"   ← {detail}" if not ok and detail else ""))

    n_derived = sum(1 for _, _, it in items if it["derived"])
    n_choice = sum(1 for _, d in days_all if d["selectOne"])
    print(f"\n{len(weeks)} 週 · {len(days)} 天 · {len(items)} 個項目"
          f"（{n_derived} 推導值）· {n_choice} 個二擇一日 · {start} → {race}")

    if fails:
        print(f"\n✗ {len(fails)} 項未通過：{'、'.join(fails)}")
        return 1
    print(f"\n✓ 全部 {len(checks)} 項通過")
    return 0


if __name__ == "__main__":
    sys.exit(main())
