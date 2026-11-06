"""Erzeugt symbols/tfis/index.json: Wegeschlüssel (z. B. „01-0A0-00“) → Signaturnummer und Name.
Die App (marks.js) findet damit das Wegzeichen-Bild (symbols/tfis/<Signaturnummer>.svg) zu einer Wegenummer.

Quelle: GeoPackage aus dem TFIS-Paket von Geobasis NRW (wird im Pages-Workflow geladen).
Geprüft im Actions-Lauf vom 6.11.2026 (Protokoll): Datei „Freizeitdaten_NRW_GeoPackage.gpkg“, Tabelle
„wanderwege“ (8396 Zeilen) mit den Spalten fid, geom, id, uuid, scl, snr, kat, nam, bez, wvi, wgv, art, sva, svh,
pkt, olg, agl, dtk, info_ext. Annahme (ungeprüft, wird mit den Beispielzeilen unten im Protokoll belegt):
scl = Schlüssel, snr = Signaturnummer, nam = Name.
Die Beispiel-Wegenummern des Nutzers standen nicht wörtlich in der Tabelle – verglichen wird daher ohne
Bindestriche/Leerzeichen (nur Buchstaben und Ziffern, groß). Die App normalisiert genauso.

Aufruf: python3 tfis_index.py <ausgabe.json> <datei.gpkg> [...]
Ausgabe: {"010A000": {"k": "01-0A0-00", "s": ["123"], "n": "Eggeweg"}, ...}
  Schlüssel = normalisierte Wegenummer, k = Schreibweise in TFIS, s = Signaturnummer(n), n = Name
"""
import json
import os
import re
import sqlite3
import sys

PROBES = ("01-0A0-00", "00-0A8-00")   # Beispiele des Nutzers (Eggeweg, E1)


def norm(v):
    return re.sub(r"[^0-9A-Z]", "", str(v).upper())


def main(out_path, files):
    index = {}
    probes = {norm(p): p for p in PROBES}
    for path in files:
        db = sqlite3.connect(path)
        tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        if "wanderwege" not in tables:
            print(f"{path}: keine Tabelle wanderwege ({len(tables)} Tabellen)")
            continue
        cols = [r[1] for r in db.execute('PRAGMA table_info("wanderwege")')]
        print(f"{path}: wanderwege {cols}")
        show = [c for c in ("scl", "snr", "kat", "nam", "bez", "wvi", "art", "sva") if c in cols]
        for row in db.execute(f'SELECT {", ".join(show)} FROM wanderwege LIMIT 5'):
            print("  Beispiel:", dict(zip(show, row)))
        if "scl" not in cols or "snr" not in cols:
            print("  Spalten scl/snr fehlen")
            continue
        name_col = "nam" if "nam" in cols else ("bez" if "bez" in cols else None)
        q = 'SELECT scl, snr, ' + (name_col or "NULL") + ' FROM wanderwege'
        rows = 0
        for k, s, nm in db.execute(q):
            if k is None or s is None:
                continue
            nk = norm(k)
            s = str(s).strip()
            if s.endswith(".0"):
                s = s[:-2]
            if not nk or not s.isdigit():
                continue
            e = index.setdefault(nk, {"k": str(k).strip(), "s": [], "n": ""})
            if s not in e["s"]:
                e["s"].append(s)
            if nm and not e["n"]:
                e["n"] = str(nm).strip()
            rows += 1
            if nk in probes:
                print(f"  FUND {probes[nk]}: scl={k!r}, snr={s}, {name_col}={nm!r}")
        print(f"  {rows} Zeilen übernommen")
        db.close()
    print(f"Wegeschlüssel: {len(index)}; Beispiele: {list(index.items())[:5]}")
    for p in PROBES:
        print(f"  {p}: {index.get(norm(p))}")
    if not index:
        if os.path.exists(out_path):
            os.remove(out_path)
        sys.exit("Keine Zuordnung Wegeschlüssel → Signaturnummer gefunden.")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
