#!/usr/bin/env python3
"""驗證 data/*.json。改課表之後一定要重跑。

為什麼要有這支：原規格書把 182 筆日期的品保寫成「人工檢查一次」，而它自己的
三行範例就已經有兩個日期錯誤（起算日差三天、dayOfWeek 標錯）。人工檢查 182 個
日期本來就不可靠。全域 CLAUDE.md 第 5 條：被違反過一次的警告要升級成可執行的守衛。

用法：python3 tools/verify_plan.py     （全部通過回傳 0，有錯回傳 1）
"""
import json
import os
import sys
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEEKDAY = "一二三四五六日"
VALID_TYPES = {"recovery", "walk-run", "run", "long-run", "tempo",
               "form-drill", "strength", "rest", "race"}

fails = []
checks = []


def check(name, ok, detail=""):
    checks.append((name, ok, detail))
    if not ok:
        fails.append(f"{name}: {detail}")


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

    # 1. 起算日是週一、比賽日是週日
    check("起算日是週一", start.weekday() == 0,
          f"{start} 是週{WEEKDAY[start.weekday()]}")
    check("比賽日是週日", race.weekday() == 6,
          f"{race} 是週{WEEKDAY[race.weekday()]}")

    # 2. 週數與天數
    check("剛好 26 週", len(weeks) == 26, f"實際 {len(weeks)} 週")
    check("週次 1..26 連續無缺無重",
          [w["weekNumber"] for w in weeks] == list(range(1, 27)),
          str([w["weekNumber"] for w in weeks]))
    bad = [w["weekNumber"] for w in weeks if len(w["days"]) != 7]
    check("每週剛好 7 天", not bad, f"不是 7 天的週：{bad}")
    bad = [w["weekNumber"] for w in weeks
           if [d["dayIndex"] for d in w["days"]] != list(range(7))]
    check("每週 dayIndex 為 0..6", not bad, f"異常的週：{bad}")

    # 3. 攤平後是連續日期、總數 182、最後一天就是比賽日
    days = [start + timedelta(days=(w["weekNumber"] - 1) * 7 + d["dayIndex"])
            for w in weeks for d in w["days"]]
    check("總天數 182", len(days) == 182, f"實際 {len(days)}")
    check("日期無重複", len(set(days)) == len(days),
          f"重複 {len(days) - len(set(days))} 筆")
    gaps = [str(days[i]) for i in range(1, len(days))
            if (days[i] - days[i - 1]).days != 1]
    check("日期連續無跳號", not gaps, f"斷點：{gaps[:5]}")
    check("最後一天等於 raceDate", days[-1] == race, f"最後一天 {days[-1]}，raceDate {race}")

    # 4. phases 涵蓋 1..26、無重疊、無空洞
    covered = []
    for ph in plan["phases"]:
        a, b = ph["weekRange"]
        covered += list(range(a, b + 1))
    check("phases 涵蓋 W1-26 且無重疊無空洞",
          sorted(covered) == list(range(1, 27)),
          f"涵蓋 {sorted(covered)}")

    # 5. 衍生欄位不可以偷偷長回來（原規格書就是死在這裡）
    raw = json.dumps(plan, ensure_ascii=False)
    check('資料檔不含 "date" 欄位', '"date"' not in raw,
          "課表 JSON 不該存 date，應由 startDate+weekNumber+dayIndex 推導")
    check('資料檔不含 "dayOfWeek" 欄位', '"dayOfWeek"' not in raw,
          "課表 JSON 不該存 dayOfWeek，應由 dayIndex 推導")
    check("weeks 不含 phaseId", not any("phaseId" in w for w in weeks),
          "階段歸屬的唯一真相來源是 phases[].weekRange")

    # 6. 參照完整性
    vids = {v["id"] for v in videos["videos"]}
    wkts = {w["id"] for w in workouts["workouts"]}
    items = [(w["weekNumber"], d["dayIndex"], it)
             for w in weeks for d in w["days"] for it in d["items"]]
    bad = [f'W{wn}D{di} → {it["videoRef"]}' for wn, di, it in items
           if it["videoRef"] and it["videoRef"] not in vids]
    check("videoRef 全部找得到", not bad, str(bad[:5]))
    bad = [f'W{wn}D{di} → {it["workoutRef"]}' for wn, di, it in items
           if it["workoutRef"] and it["workoutRef"] not in wkts]
    check("workoutRef 全部找得到", not bad, str(bad[:5]))

    # 7. 每個項目的基本合法性
    bad = [f'W{wn}D{di} {it["type"]}' for wn, di, it in items
           if it["type"] not in VALID_TYPES]
    check("type 全部在列舉內", not bad, str(bad[:5]))
    bad = [f'W{wn}D{di} {it["title"]}' for wn, di, it in items
           if (it["duration"] and it["duration"]["min"] > it["duration"]["max"])
           or (it["distanceKm"] and it["distanceKm"]["min"] > it["distanceKm"]["max"])]
    check("區間的 min <= max", not bad, str(bad[:5]))
    empty = [f'W{w["weekNumber"]}D{d["dayIndex"]}'
             for w in weeks for d in w["days"] if not d["items"]]
    check("每天至少一個項目", not empty, str(empty[:5]))
    allopt = [f'W{w["weekNumber"]}D{d["dayIndex"]}'
              for w in weeks for d in w["days"]
              if d["items"] and all(it["optional"] for it in d["items"])]
    check("沒有整天都是選配的日子", not allopt, str(allopt[:5]))

    # 8. 每週恰好一次長跑（賽週改成比賽本身）
    bad = []
    for w in weeks:
        kinds = [it["type"] for d in w["days"] for it in d["items"]]
        n = kinds.count("long-run") + kinds.count("race")
        if n != 1:
            bad.append(f'W{w["weekNumber"]}={n}')
    check("每週恰好一次長跑或比賽", not bad, str(bad))

    # 9. 比賽日就是最後一天，且標成 race
    last = weeks[-1]["days"][-1]
    check("最後一天是 race", any(it["type"] == "race" for it in last["items"]),
          f'最後一天的 type：{[it["type"] for it in last["items"]]}')

    # 10. expiredBefore 落在第 1 週內
    exp = date.fromisoformat(plan["expiredBefore"])
    check("expiredBefore 落在第 1 週內", start <= exp < start + timedelta(days=7),
          f"{exp} 不在 {start} ~ {start + timedelta(days=6)} 之間")

    # --- 輸出 ---
    width = max(len(n) for n, _, _ in checks)
    for name, ok, detail in checks:
        mark = "  ok  " if ok else " FAIL "
        line = f"[{mark}] {name.ljust(width)}"
        if not ok and detail:
            line += f"   ← {detail}"
        print(line)

    n_derived = sum(1 for _, _, it in items if it["derived"])
    print()
    print(f"{len(weeks)} 週 · {len(days)} 天 · {len(items)} 個項目"
          f"（{n_derived} 個推導值）· {start} → {race}")

    if fails:
        print(f"\n✗ {len(fails)} 項未通過")
        return 1
    print(f"\n✓ 全部 {len(checks)} 項通過")
    return 0


if __name__ == "__main__":
    sys.exit(main())
