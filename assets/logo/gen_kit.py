#!/usr/bin/env python3
"""Build the final OATHKEEPER logo kit from approved concept D (Monogram OK)."""
import os
import cairosvg

BASE = os.path.expanduser("~/workspace/oathkeeper/assets/logo")
os.makedirs(BASE, exist_ok=True)

GOLD = "#D9A441"
GOLD2 = "#F0BE5C"
NAVY = "#0C1425"
PAPER = "#EDE6D6"
SLATE = "#5B6B8C"

def mark_inner(c_ring, c_stem, c_diag):
    return f'''<circle cx="120" cy="120" r="102" fill="none" stroke="{c_ring}" stroke-width="10"/>
<path d="M95 76 V164" stroke="{c_stem}" stroke-width="13" stroke-linecap="round"/>
<path d="M140 80 L99 118" stroke="{c_diag}" stroke-width="12" stroke-linecap="round"/>
<path d="M104 122 L144 164" stroke="{c_diag}" stroke-width="12" stroke-linecap="round"/>'''

def svg_doc(viewbox, inner, w=None, h=None):
    size = f' width="{w}" height="{h}"' if w else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{viewbox}"{size}>\n{inner}\n</svg>\n'

def save(name, content):
    p = os.path.join(BASE, name)
    with open(p, "w") as f:
        f.write(content)
    print("wrote", name)
    return p

def png(svg_path, out_name, w, h=None):
    out = os.path.join(BASE, out_name)
    cairosvg.svg2png(url=svg_path, write_to=out, output_width=w, output_height=h)
    print("wrote", out_name)

# --- Marks ---
p_gold = save("oathkeeper-mark.svg", svg_doc("0 0 240 240", mark_inner(GOLD, GOLD, GOLD2), 240, 240))
p_paper = save("oathkeeper-mark-paper.svg", svg_doc("0 0 240 240", mark_inner(PAPER, PAPER, PAPER), 240, 240))
p_navy = save("oathkeeper-mark-navy.svg", svg_doc("0 0 240 240", mark_inner(NAVY, NAVY, NAVY), 240, 240))

coin_inner = f'''<circle cx="120" cy="120" r="120" fill="{NAVY}"/>
<g transform="translate(14.4 14.4) scale(0.88)">{mark_inner(GOLD, GOLD, GOLD2)}</g>'''
p_coin = save("oathkeeper-coin.svg", svg_doc("0 0 240 240", coin_inner, 240, 240))

# --- Lockups ---
def lockup(text_fill, tag_fill, fname):
    inner = f'''<g>{mark_inner(GOLD, GOLD, GOLD2)}</g>
<text x="282" y="117" font-family="Marcellus, Georgia, serif" font-size="62" letter-spacing="13" fill="{text_fill}">OATHKEEPER</text>
<text x="286" y="158" font-family="'IBM Plex Mono', monospace" font-size="20.5" letter-spacing="6.5" fill="{tag_fill}">PROOF OF OBEDIENCE</text>'''
    return save(fname, svg_doc("0 0 1000 240", inner, 1000, 240))

p_lock_dark = lockup(PAPER, "#93A0BC", "oathkeeper-lockup.svg")
p_lock_light = lockup(NAVY, SLATE, "oathkeeper-lockup-navy.svg")

stacked_inner = f'''<g transform="translate(120 0)">{mark_inner(GOLD, GOLD, GOLD2)}</g>
<text x="240" y="305" text-anchor="middle" font-family="Marcellus, Georgia, serif" font-size="47" letter-spacing="11" fill="{PAPER}">OATHKEEPER</text>
<text x="240" y="345" text-anchor="middle" font-family="'IBM Plex Mono', monospace" font-size="16.5" letter-spacing="5.5" fill="#93A0BC">PROOF OF OBEDIENCE</text>'''
p_stacked = save("oathkeeper-lockup-stacked.svg", svg_doc("0 0 480 370", stacked_inner, 480, 370))

# --- PNG exports ---
for s in (1024, 512, 256, 128):
    png(p_gold, f"oathkeeper-mark-{s}.png", s, s)
    png(p_coin, f"oathkeeper-coin-{s}.png", s, s)
png(p_lock_dark, "oathkeeper-lockup-1800.png", 1800)
png(p_stacked, "oathkeeper-lockup-stacked-960.png", 960)
png(p_coin, "favicon-48.png", 48, 48)
png(p_coin, "favicon-32.png", 32, 32)
png(p_coin, "favicon-16.png", 16, 16)
png(p_coin, "apple-touch-icon.png", 180, 180)

# --- Brand sheet preview ---
def inline(path):
    with open(path) as f:
        s = f.read()
    return s.replace(' width="240" height="240"', "").replace(' width="1000" height="240"', "").replace(' width="480" height="370"', "")

sheet = f'''<!doctype html><html><head><meta charset="utf-8"><style>
body{{margin:0;font-family:Arial,sans-serif}}
.dark{{background:{NAVY};padding:44px 54px 30px}}
.light{{background:{PAPER};padding:36px 54px 40px}}
.lock svg{{width:760px}}
.row{{display:flex;align-items:flex-end;gap:34px;margin-top:30px}}
.row .m svg{{display:block}}
.lbl{{color:#93A0BC;font-size:12.5px;letter-spacing:.18em;margin-top:26px}}
.lbl2{{color:{SLATE};font-size:12.5px;letter-spacing:.18em;margin-bottom:14px}}
.coin svg{{border-radius:50%}}
</style></head><body>
<div class="dark">
  <div class="lock">{inline(p_lock_dark)}</div>
  <div class="lbl">MARK — ACTUAL SIZES</div>
  <div class="row">
    <div class="m" style="width:128px">{inline(p_gold)}</div>
    <div class="m" style="width:64px">{inline(p_gold)}</div>
    <div class="m" style="width:32px">{inline(p_gold)}</div>
    <div class="m coin" style="width:96px">{inline(p_coin)}</div>
    <div class="m coin" style="width:48px">{inline(p_coin)}</div>
  </div>
</div>
<div class="light">
  <div class="lbl2">ON LIGHT — NAVY VARIANT</div>
  <div class="row" style="margin-top:0">
    <div class="m" style="width:150px">{inline(p_navy)}</div>
    <div class="m" style="width:150px">{inline(p_gold)}</div>
  </div>
</div>
</body></html>'''
with open(os.path.join(BASE, "brand-sheet.html"), "w") as f:
    f.write(sheet)
print("wrote brand-sheet.html")
