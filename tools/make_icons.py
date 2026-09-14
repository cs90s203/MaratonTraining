#!/usr/bin/env python3
"""從一張設計圖產生 App icon 的所有尺寸。

用法：python3 tools/make_icons.py <設計圖.png>

設計圖是「白底上放一個圓角方塊」的樣子（2026-09-14 使用者給的 TOKYO 2027 跑者圖）。
直接縮小整張圖會變成「icon 裡面又有一個小圓角方塊加白邊」——iOS／Android 會自己套圓角遮罩，
所以這裡要：
  1. 找出方塊的範圍裁下來（跟底色差很多的像素的外框）
  2. 方塊四個圓角外面原本是白底／陰影，用鄰近的圖案顏色補滿（不然遮罩圓角比設計圖小一點的
     裝置上會露出白色小角）
  3. 存一張 1024 母版 icons/icon-1024.png，再縮出 index.html 跟 manifest 用到的尺寸

換 icon 之後記得 bump 版本號（index.html 的 ?v=）。已經加到主畫面的 iPhone 不會自動換圖，
要從主畫面移除再重新加入一次。
"""
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS = os.path.join(ROOT, "icons")
# 檔名 → 邊長。index.html：favicon-32、icon-152、icon-167、apple-touch-icon(180)；manifest：192、512
SIZES = {
    "icon-1024.png": 1024,
    "icon-512.png": 512,
    "icon-192.png": 192,
    "apple-touch-icon.png": 180,
    "icon-167.png": 167,
    "icon-152.png": 152,
    "favicon-32.png": 32,
}


def find_square(rgb):
    """方塊的外框：跟左上角底色差 60 以上的像素範圍，取成正方形。"""
    bg = rgb[4, 4].astype(int)
    diff = np.abs(rgb.astype(int) - bg).sum(axis=2)
    ys, xs = np.where(diff > 60)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    side = min(x1 - x0, y1 - y0) + 1
    cx, cy = (x0 + x1 + 1) // 2, (y0 + y1 + 1) // 2
    return cx - side // 2, cy - side // 2, side


def corner_profile(rgb, x0, y0, side):
    """量左上角的圓角形狀：從方塊上緣往下每一列，第一個「圖案」像素離左緣多遠。
    只在左上角量（那裡是藍天，跟白底差很多，量得準），四個角照對稱套用。
    不用「從角落沿著白色往內擴散」的做法——圖案右下的白色跑道線碰到邊緣，會被當成底色吃掉。"""
    bg = rgb[4, 4].astype(int)
    diff = np.abs(rgb.astype(int) - bg).sum(axis=2)
    prof = []
    for dy in range(side // 3):
        row = diff[y0 + dy, x0:x0 + side // 2]
        idx = np.where(row > 60)[0]
        dx = int(idx.min()) if len(idx) else side // 2
        prof.append(dx)
        if dx == 0:
            break
    # 單調化：越往下只能越貼近邊緣（避免圖案裡的淡色像素造成鋸齒）
    for i in range(1, len(prof)):
        prof[i] = min(prof[i], prof[i - 1])
    return np.array(prof)


def outside_mask(side, prof, ring=3):
    """四個角「方塊外面」＋外框一圈反鋸齒像素：到上下緣距離 dy、到左右緣距離 dx，dx < 圓角形狀(dy) 就是外面。"""
    yy, xx = np.mgrid[0:side, 0:side]
    dy = np.minimum(yy, side - 1 - yy)
    dx = np.minimum(xx, side - 1 - xx)
    limit = np.where(dy < len(prof), prof[np.minimum(dy, len(prof) - 1)], 0)
    out = dx < limit + ring
    out |= (dx < ring) | (dy < ring)
    return out


def fill_outside(rgb, outside):
    """外面的像素用裡面像素的模糊平均補上（normalized convolution），由近到遠補三輪。"""
    a = rgb.astype(float)
    filled = a.copy()
    known = ~outside
    for radius in (8, 24, 64):
        m = known.astype(float)
        num = np.stack([_blur(filled[..., c] * m, radius) for c in range(3)], axis=2)
        den = _blur(m, radius)[..., None]
        est = np.where(den > 1e-3, num / np.maximum(den, 1e-3), filled)
        newly = (~known) & (den[..., 0] > 0.02)
        filled[newly] = est[newly]
        known = known | newly
    return np.clip(filled, 0, 255).astype(np.uint8)


def _blur(channel, radius):
    """浮點數的模糊（PIL 的 GaussianBlur 不收浮點影像）：盒狀模糊做三次，近似高斯。"""
    out = channel.astype(float)
    for _ in range(3):
        for axis in (0, 1):
            pad = [(0, 0), (0, 0)]
            pad[axis] = (radius + 1, radius)
            c = np.cumsum(np.pad(out, pad, mode="edge"), axis=axis)
            hi = np.take(c, range(2 * radius + 1, c.shape[axis]), axis=axis)
            lo = np.take(c, range(0, c.shape[axis] - 2 * radius - 1), axis=axis)
            out = (hi - lo) / (2 * radius + 1)
    return out


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    src = Image.open(sys.argv[1]).convert("RGB")
    rgb = np.asarray(src)
    x, y, side = find_square(rgb)
    crop = rgb[y:y + side, x:x + side]
    outside = outside_mask(side, corner_profile(rgb, x, y, side))
    master = Image.fromarray(fill_outside(crop, outside)).resize((1024, 1024), Image.LANCZOS)
    for name, size in SIZES.items():
        out = master if size == 1024 else master.resize((size, size), Image.LANCZOS)
        out.save(os.path.join(ICONS, name), optimize=True)
        print(f"✓ icons/{name}  {size}×{size}")
    print(f"方塊範圍：x={x} y={y} 邊長 {side}px；角落補色 {int(outside.sum())} 個像素")


if __name__ == "__main__":
    main()
