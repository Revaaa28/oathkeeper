#!/usr/bin/env python3
"""Generate 4 OATHKEEPER logo concepts as standalone SVGs + a preview sheet."""
import os

OUT = os.path.expanduser("~/workspace/oathkeeper/assets/logo/concepts")
os.makedirs(OUT, exist_ok=True)

GOLD = "#D9A441"
GOLD2 = "#F0BE5C"
NAVY = "#0C1425"
PAPER = "#EDE6D6"

def mark_a(c1=GOLD, c2=GOLD2):
    return f'''<circle cx="120" cy="120" r="104" fill="none" stroke="{c1}" stroke-width="9"/>
<circle cx="120" cy="120" r="88" fill="none" stroke="{c1}" stroke-width="3"/>
<path d="M84 74 H156 V116 C156 138 140 149 120 159 C100 149 84 138 84 116 Z" fill="none" stroke="{c1}" stroke-width="9" stroke-linejoin="round"/>
<path d="M99 113 L114 128 L143 95" fill="none" stroke="{c2}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>'''

def mark_b(c1=GOLD, c2=GOLD2):
    return f'''<circle cx="120" cy="124" r="90" fill="none" stroke="{c1}" stroke-width="14"/>
<path d="M120 8 L140 28 L120 48 L100 28 Z" fill="{c2}"/>
<path d="M90 126 L112 148 L152 102" fill="none" stroke="{c2}" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>'''

def mark_c(c1=GOLD, cut=NAVY):
    return f'''<path d="M120 32 L190 55 V118 C190 161 159 187 120 206 C81 187 50 161 50 118 V55 Z" fill="{c1}"/>
<path d="M87 118 L110 141 L155 91" fill="none" stroke="{cut}" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>'''

def mark_d(c1=GOLD, c2=GOLD2):
    return f'''<circle cx="120" cy="120" r="102" fill="none" stroke="{c1}" stroke-width="10"/>
<path d="M95 76 V164" stroke="{c1}" stroke-width="13" stroke-linecap="round"/>
<path d="M140 80 L99 118" stroke="{c2}" stroke-width="12" stroke-linecap="round"/>
<path d="M104 122 L144 164" stroke="{c2}" stroke-width="12" stroke-linecap="round"/>'''

CONCEPTS = {
    "concept-a-seal": mark_a(),
    "concept-b-oathband": mark_b(),
    "concept-c-solidshield": mark_c(),
    "concept-d-monogram": mark_d(),
}

for name, inner in CONCEPTS.items():
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240">
{inner}
</svg>
'''
    with open(os.path.join(OUT, name + ".svg"), "w") as f:
        f.write(svg)
    print("wrote", name)

labels = [
    ("concept-a-seal", "A — Segel Perisai", "klasik, resmi, paling “seal of approval”"),
    ("concept-b-oathband", "B — Simpul Sumpah", "cincin utuh + berlian, janji yang nggak putus"),
    ("concept-c-solidshield", "C — Perisai Solid", "paling bold & simpel, enak di ukuran kecil"),
    ("concept-d-monogram", "D — Monogram OK", "huruf K di dalam cincin, paling brandable"),
]

cells = ""
for name, title, desc in labels:
    with open(os.path.join(OUT, name + ".svg")) as f:
        svg = f.read()
    cells += f'''
    <div class="cell">
      <div class="mark">{svg}</div>
      <div class="name">OATHKEEPER</div>
      <div class="title">{title}</div>
      <div class="desc">{desc}</div>
    </div>'''

html = f'''<!doctype html>
<html><head><meta charset="utf-8">
<style>
  body{{margin:0;background:{NAVY};color:{PAPER};font-family:Georgia,serif}}
  .grid{{display:grid;grid-template-columns:1fr 1fr;gap:2px;background:#26314D;padding:2px}}
  .cell{{background:#0A101E;padding:38px 30px 30px;text-align:center}}
  .mark svg{{width:190px;height:190px}}
  .name{{font-family:Marcellus,Georgia,serif;font-size:27px;letter-spacing:.32em;margin-top:24px;text-indent:.32em}}
  .title{{font-family:Arial,sans-serif;font-size:16px;color:{GOLD2};margin-top:12px;font-weight:bold}}
  .desc{{font-family:Arial,sans-serif;font-size:13.5px;color:#93A0BC;margin-top:5px}}
</style></head>
<body><div class="grid">{cells}</div></body></html>'''

with open(os.path.join(OUT, "preview.html"), "w") as f:
    f.write(html)
print("wrote preview.html")
