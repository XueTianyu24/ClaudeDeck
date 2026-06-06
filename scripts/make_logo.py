"""ClaudeDeck logo 母图（精修质感版）。1024x1024，4x 超采样。
深蓝灰 squircle 面板 + 顶部柔光 + 暖橙活跃行发光 + 元素球面高光。"""
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

# 背景：深蓝灰竖直渐变（顶部带一点蓝调，底部近黑）
bg = vgrad(W, W, (44, 50, 70), (12, 14, 21)).convert("RGBA")
img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
img.paste(bg, (0, 0), mask)

# 顶部柔和高光（光从上方打下来的立体感）
hl = Image.new("RGBA", (W, W), (0, 0, 0, 0))
ImageDraw.Draw(hl).ellipse([W * 0.10, -W * 0.34, W * 0.90, W * 0.44], fill=(255, 255, 255, 50))
hl = hl.filter(ImageFilter.GaussianBlur(95 * S))
hl.putalpha(ImageChops.multiply(hl.getchannel("A"), mask))
img = Image.alpha_composite(img, hl)

# 元素几何
dot_cx = 305 * S
dot_r = 42 * S
bar_x0 = 410 * S
bar_h = 74 * S
ORANGE = (240, 158, 114)
rows = [(384, 795, True), (512, 690, False), (640, 600, False)]

# 暖橙活跃行的发光光晕（叠两层增强）
glow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
for cy, x1, active in rows:
    if not active:
        continue
    cyy, x1s = cy * S, x1 * S
    gd.ellipse([dot_cx - dot_r, cyy - dot_r, dot_cx + dot_r, cyy + dot_r], fill=ORANGE + (255,))
    gd.rounded_rectangle([bar_x0, cyy - bar_h // 2, x1s, cyy + bar_h // 2],
                         radius=bar_h // 2, fill=ORANGE + (255,))
glow = glow.filter(ImageFilter.GaussianBlur(40 * S))
glow.putalpha(ImageChops.multiply(glow.getchannel("A"), mask))
img = Image.alpha_composite(img, glow)
img = Image.alpha_composite(img, glow)

# 实心元素 + 球面/厚度高光
d = ImageDraw.Draw(img, "RGBA")


def pill(x0, cy, x1, col, hi):
    d.rounded_rectangle([x0, cy - bar_h // 2, x1, cy + bar_h // 2], radius=bar_h // 2, fill=col)
    d.rounded_rectangle([x0 + bar_h * 0.16, cy - bar_h * 0.34, x1 - bar_h * 0.16, cy - bar_h * 0.06],
                        radius=bar_h * 0.14, fill=hi)


def dot(cx, cy, r, col, hi):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col)
    d.ellipse([cx - r * 0.5, cy - r * 0.72, cx + r * 0.32, cy - r * 0.02], fill=hi)


for cy, x1, active in rows:
    cyy, x1s = cy * S, x1 * S
    if active:
        col, hi = ORANGE + (255,), (255, 226, 206, 95)
    else:
        col, hi = (226, 230, 240, 235), (255, 255, 255, 65)
    dot(dot_cx, cyy, dot_r, col, hi)
    pill(bar_x0, cyy, x1s, col, hi)

# 细亮内描边（squircle 边缘光，提升精致感）
ring = squircle(W, 88 * S, n=4.2)
ring_in = squircle(W, 88 * S + 4 * S, n=4.2)
edge_a = ImageChops.subtract(ring, ring_in)
edge = Image.new("RGBA", (W, W), (255, 255, 255, 0))
edge.putalpha(edge_a.point(lambda v: int(v * 0.28)))
img = Image.alpha_composite(img, edge)

img.resize((1024, 1024), Image.LANCZOS).save(os.path.join(out_dir, "logo_master.png"))
print("saved refined logo (squircle + glow + highlights)")
