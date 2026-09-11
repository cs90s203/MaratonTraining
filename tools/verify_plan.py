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
import os
import sys
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEEKDAY = "一二三四五六日"
VALID_TYPES = {"recovery", "walk-run", "run", "long-run", "tempo",
               "form-drill", "strength", "rest", "race"}

# 安全性文字的獨立基準。**故意不從 build_plan.py import**——那樣等於拿產生器檢查自己。
# 這四段是 docs/計畫原文/訓練計畫.md 第 6、180、176、28 行的逐字內容；改一個標點就會失敗。
SAFETY_SHA = {
    "prerequisite": "c93ea00259c5b4914bda51a19f9f1d9badea67448b4a5a29fcb8471ecab1a3e8",
    "disclaimer": "866e45895315b4944b49b6aa7223a47a8de40d83e1920daeaf32d45a289210b5",
    "weeklySelfCheck": "c37c5fdc21b3763d7cdb76f129f26419e4423dbd8e60d554b00031e1c19c67d2",
    "intensityPrinciple": "38d562721382285f0ad1de8d20c951f0958761147241d7365f56e9b4bee59861",
}

# 第二節的項目類型 → 心率區間。原文第八節:175 指定強度以第二節為準。
EXPECTED_HR = {
    "walk-run": "50-60%",   # 第二節:32 恢復跑/走跑交替
    "run": None,            # 可能是 Zone 2 跑(60-70%)或輕鬆跑(50-60%)，不硬性綁
    "long-run": "65-72%",   # 第二節:34 長跑
    "tempo": "70-75%",      # 內插值，標 intensityDerived
}

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
    bad = [f'W{a}D{b} → {it["videoRef"]}' for a, b, it in items
           if it["videoRef"] and it["videoRef"] not in vids]
    check("videoRef 全部找得到", not bad, str(bad[:5]))
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
        n = kinds.count("long-run") + kinds.count("race")
        # 二擇一的長跑不存在，所以這裡直接數；Phase 1 前 6 週長跑記成 walk-run
        if w["weekNumber"] <= 6:
            n += sum(1 for d in w["days"] for it in d["items"]
                     if it["type"] == "walk-run" and "長跑" in it["title"])
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
           if EXPECTED_HR.get(it["type"]) and it["heartRateZone"] != EXPECTED_HR[it["type"]]]
    check("強度符合第二節對照表", not bad, str(bad[:4]))
    # 走跑交替絕對不可以出現 65-72%（第一版就是這樣錯的：Phase 1 長跑被標成長跑強度）
    bad = [f'W{a}D{b} {it["title"]}' for a, b, it in items
           if it["type"] == "walk-run" and it["heartRateZone"] != "50-60%"]
    check("走跑交替一律 50-60%", not bad, str(bad[:4]))
    # 內插出來的強度必須標記
    bad = [f'W{a}D{b} {it["title"]}' for a, b, it in items
           if it["heartRateZone"] == "70-75%" and not it["intensityDerived"]]
    check("內插強度有標 intensityDerived", not bad, str(bad[:4]))

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

    # B6 週跑量是參考值，不可被誤讀成 days 的加總
    bad = [w["weekNumber"] for w in weeks
           if w["weeklyVolumeKm"] and w["weeklyVolumeKm"].get("kind") != "reference"]
    check("weeklyVolumeKm 標明 kind=reference", not bad, str(bad[:4]))
    bad = [w["weekNumber"] for w in weeks
           if not w["weeklyVolumeKm"] and not w.get("weeklyVolumeNullReason")]
    check("沒有週跑量的週都寫了理由", not bad, f"未說明的週：{bad[:6]}")

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
