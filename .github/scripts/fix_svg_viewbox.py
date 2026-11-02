"""Ergänzt fehlende viewBox-Attribute in SVG-Dateien.

Ohne viewBox lässt sich ein SVG in einem <img> nicht verlustfrei skalieren
(der Inhalt wird abgeschnitten statt verkleinert). Die Größe wird aus den
width/height-Attributen des <svg>-Elements abgeleitet.
"""
import pathlib
import re
import sys

UNIT_PX = {"": 1.0, "px": 1.0, "pt": 4 / 3, "pc": 16.0, "mm": 96 / 25.4, "cm": 96 / 2.54, "in": 96.0}


def to_px(value):
    m = re.fullmatch(r"\s*([0-9.]+)\s*([a-z]*)\s*", value or "")
    if not m or m.group(2) not in UNIT_PX:
        return None
    return float(m.group(1)) * UNIT_PX[m.group(2)]


def main(folder):
    fixed = skipped = total = 0
    for path in pathlib.Path(folder).glob("*.svg"):
        total += 1
        text = path.read_text(encoding="utf-8", errors="replace")
        m = re.search(r"<svg\b[^>]*>", text)
        if not m or "viewBox" in m.group(0):
            continue
        tag = m.group(0)
        w = re.search(r'\bwidth="([^"]+)"', tag)
        h = re.search(r'\bheight="([^"]+)"', tag)
        wpx = to_px(w.group(1)) if w else None
        hpx = to_px(h.group(1)) if h else None
        if not wpx or not hpx:
            skipped += 1
            continue
        new_tag = tag[:-1].rstrip("/") + f' viewBox="0 0 {wpx:g} {hpx:g}"' + ("/>" if tag.endswith("/>") else ">")
        path.write_text(text.replace(tag, new_tag, 1), encoding="utf-8")
        fixed += 1
    print(f"SVG gesamt: {total}, viewBox ergänzt: {fixed}, ohne verwertbare Größe: {skipped}")


if __name__ == "__main__":
    main(sys.argv[1])
