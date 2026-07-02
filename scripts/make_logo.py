# -*- coding: utf-8 -*-
"""Beacon logo 母图（菲涅尔透镜信标，曹少选定的 concept2 程序化重绘）。
1024x1024，4x 超采样。深靛夜海 squircle + 底部深海青暗示 + 暖金透镜
（三道棱线）+ 柔和光晕 + 六道光线。改动后跑：
  python scripts/make_logo.py
  npm run tauri icon .tmp/logo_master.png
并更新 src/assets/logo.png（脚本一并输出 256px 版本）。"""
from PIL import Image, ImageDraw, ImageFilter, ImageChops
import os
import math

S = 4
W = 1024 * S
out_dir = r"C:\Users\jccao\Desktop\ClaudeDeck\.tmp"
os.makedirs(out_dir, exist_ok=True)


def vgrad(w, h, top, bot):
    g = Image.new("RGB", (1, h))
    d = ImageDraw.Draw(g)
    for y in range(h):
        t = y / h
        d.point((0, y), fill=tuple(int(top[i] * (1 - t) + bot[i] * t) for i in range(3)))
    return g.resize((w, h))


def squircle(size, inset, n=4.2):
    """超椭圆 mask：|x|^n + |y|^n = 1，n≈4 是 iOS squircle 观感。"""
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    r = (size - 2 * inset) / 2
    cx = cy = size / 2
    pts = []
    for i in range(1440):
        a = 2 * math.pi * i / 1440
        ca, sa = math.cos(a), math.sin(a)
        x = cx + r * math.copysign(abs(ca) ** (2 / n), ca)
        y = cy + r * math.copysign(abs(sa) ** (2 / n), sa)
        pts.append((x, y))
    d.polygon(pts, fill=255)
    return m


mask = squircle(W, 88 * S, n=4.2)

# 背景：深靛夜海竖直渐变（顶部微亮的墨蓝 → 底部近黑）
bg = vgrad(W, W, (22, 32, 58), (9, 14, 26)).convert("RGBA")
img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
img.paste(bg, (0, 0), mask)

# 底部深海青暗示（海图室的另一半身份，很淡）
teal = Image.new("RGBA", (W, W), (0, 0, 0, 0))
ImageDraw.Draw(teal).ellipse(
    [W * 0.30, W * 0.72, W * 1.25, W * 1.45], fill=(15, 123, 122, 70)
)
teal = teal.filter(ImageFilter.GaussianBlur(120 * S))
teal.putalpha(ImageChops.multiply(teal.getchannel("A"), mask))
img = Image.alpha_composite(img, teal)

# 顶部柔和高光（光从上方打下来的立体感，沿用旧版质感手法）
hl = Image.new("RGBA", (W, W), (0, 0, 0, 0))
ImageDraw.Draw(hl).ellipse([W * 0.10, -W * 0.34, W * 0.90, W * 0.40], fill=(255, 255, 255, 34))
hl = hl.filter(ImageFilter.GaussianBlur(95 * S))
hl.putalpha(ImageChops.multiply(hl.getchannel("A"), mask))
img = Image.alpha_composite(img, hl)

# ── 透镜信标 ──────────────────────────────────────────────
CX, CY = 512 * S, 498 * S
R = 206 * S  # 透镜半径
GOLD_LIGHT = (250, 216, 142)  # 透镜浅金
GOLD = (245, 185, 75)  # 品牌金
GOLD_DEEP = (222, 158, 56)  # 棱线/描边深金

# 光晕（收敛：贴着透镜的一圈暖光，别把夜海底色晕浑）
glow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse([CX - R * 1.5, CY - R * 1.5, CX + R * 1.5, CY + R * 1.5], fill=GOLD + (26,))
gd.ellipse([CX - R * 1.18, CY - R * 1.18, CX + R * 1.18, CY + R * 1.18], fill=GOLD + (60,))
glow = glow.filter(ImageFilter.GaussianBlur(40 * S))
glow.putalpha(ImageChops.multiply(glow.getchannel("A"), mask))
img = Image.alpha_composite(img, glow)

d = ImageDraw.Draw(img, "RGBA")

# 六道光线（先画，透镜压上）：水平两道长、斜向四道短，圆头
def ray(angle_deg, gap, length, width):
    a = math.radians(angle_deg)
    x0 = CX + math.cos(a) * (R + gap)
    y0 = CY - math.sin(a) * (R + gap)
    x1 = CX + math.cos(a) * (R + gap + length)
    y1 = CY - math.sin(a) * (R + gap + length)
    d.line([x0, y0, x1, y1], fill=GOLD_LIGHT + (255,), width=width)
    for x, y in [(x0, y0), (x1, y1)]:
        d.ellipse([x - width / 2, y - width / 2, x + width / 2, y + width / 2],
                  fill=GOLD_LIGHT + (255,))


for ang in (0, 180):
    ray(ang, 58 * S, 96 * S, 26 * S)
for ang in (38, 142, 218, 322):
    ray(ang, 52 * S, 66 * S, 24 * S)

# 透镜本体：浅金圆 + 深金描边
d.ellipse([CX - R, CY - R, CX + R, CY + R], fill=GOLD_LIGHT + (255,),
          outline=GOLD_DEEP + (255,), width=int(13 * S))

# 中心更暖的一层（球面感）
core = Image.new("RGBA", (W, W), (0, 0, 0, 0))
ImageDraw.Draw(core).ellipse(
    [CX - R * 0.62, CY - R * 0.62, CX + R * 0.62, CY + R * 0.62], fill=(252, 232, 178, 200)
)
core = core.filter(ImageFilter.GaussianBlur(30 * S))
img = Image.alpha_composite(img, core)
d = ImageDraw.Draw(img, "RGBA")

# 三道菲涅尔棱线：水平贯穿透镜（用弦长裁到圆内）
for fy in (-0.42, 0.0, 0.42):
    y = CY + R * fy
    half = math.sqrt(max(R * R - (R * fy) ** 2, 0)) - 10 * S
    d.line([CX - half, y, CX + half, y], fill=GOLD_DEEP + (255,), width=int(12 * S))

# 细亮内描边（squircle 边缘光）
ring = squircle(W, 88 * S, n=4.2)
ring_in = squircle(W, 88 * S + 4 * S, n=4.2)
edge_a = ImageChops.subtract(ring, ring_in)
edge = Image.new("RGBA", (W, W), (255, 255, 255, 0))
edge.putalpha(edge_a.point(lambda v: int(v * 0.30)))
img = Image.alpha_composite(img, edge)

final = img.resize((1024, 1024), Image.LANCZOS)
final.save(os.path.join(out_dir, "logo_master.png"))
# app 内顶栏 logo（256px 够 2x 显示）
final.resize((256, 256), Image.LANCZOS).save(os.path.join(out_dir, "logo_256.png"))
print("saved Beacon lens logo: logo_master.png / logo_256.png")
