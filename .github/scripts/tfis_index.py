"""Erzeugt symbols/tfis/index.json: Wegeschlüssel (z. B. „01-0A0-00“) → Signaturnummer und Name.
Die App (marks.js) findet damit das Wegzeichen-Bild (symbols/tfis/<Signaturnummer>.svg) zu einer Wegenummer.

Quelle: GeoPackage aus dem TFIS-Paket von Geobasis NRW (wird im Pages-Workflow geladen;
geprüft im Lauf vom 6.11.2026: eine Datei „Freizeitdaten_NRW_GeoPackage.gpkg“ mit 81 Tabellen).
Die Spaltennamen der WMS-Sachdatenabfrage (schluessel, signaturnummer) gibt es dort NICHT genau so – das Skript
sucht deshalb Spalten nach Namensteilen („schl“, „sign“) und gibt zur Prüfung im Protokoll aus:
  - alle Tabellen mit ihren Spalten,
  - wo die Beispiel-Wegenummern (PROBES) vorkommen, mit der ganzen Zeile.
Ohne verwertbare Zuordnung wird keine Datei geschrieben (die App meldet dann „nicht erreichbar“ statt „unbekannt“).

Aufruf: python3 tfis_index.py <ausgabe.json> <datei.gpkg> [...]
Ausgabe: {"01-0A0-00": {"s": ["123"], "n": "Eggeweg"}, ...}  (s = Signaturnummer(n), n = Name)
"""
import json
import os
import re
import sqlite3
import sys

PROBES = ("01-0A0-00", "00-0A8-00")   # Beispiele des Nutzers (Eggeweg, E1)
KEY_RE = re.compile(r"^\d\d-[0-9A-Z]{3}-\d\d$")


def cols_of(db, t):
    return [(r[1], (r[2] or "").upper()) for r in db.execute(f'PRAGMA table_info("{t}")')]


def pick(cols, *parts, exclude=()):
    for c, _ in cols:
        lc = c.lower()
        if any(p in lc for p in parts) and not any(x in lc for x in exclude):
            return c
    return None


def main(out_path, files):
    index = {}
    for path in files:
        db = sqlite3.connect(path)
        tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        print(f"{path}: {len(tables)} Tabellen")
        for t in tables:
            if t.startswith(("gpkg_", "rtree_", "sqlite_")):
                continue
            cols = cols_of(db, t)
            n = db.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
            print(f"  {t} ({n} Zeilen): {[c for c, _ in cols]}")
            # Wo stehen die Beispiel-Wegenummern?
            text_cols = [c for c, ty in cols if "BLOB" not in ty and ty not in ("GEOMETRY", "POINT", "LINESTRING", "MULTILINESTRING", "POLYGON", "MULTIPOLYGON")]
            for probe in PROBES:
                for c in text_cols:
                    try:
                        row = db.execute(f'SELECT * FROM "{t}" WHERE CAST("{c}" AS TEXT) LIKE ? LIMIT 1', (f"%{probe}%",)).fetchone()
                    except sqlite3.Error:
                        continue
                    if row:
                        names = [x for x, _ in cols]
                        shown = {names[i]: (v if not isinstance(v, bytes) else f"<{len(v)} Bytes>") for i, v in enumerate(row)}
                        print(f"    FUND {probe} in {t}.{c}: {shown}")
            key = pick(cols, "schl")
            sig = pick(cols, "sign")
            if not key or not sig:
                continue
            name = pick(cols, "name", "bezeich", exclude=("verein", "datei"))
            print(f"    → Zuordnung: Schlüssel={key}, Signatur={sig}, Name={name}")
            q = f'SELECT "{key}", "{sig}", ' + (f'"{name}"' if name else "NULL") + f' FROM "{t}"'
            rows = 0
            for k, s, nm in db.execute(q):
                if k is None or s is None:
                    continue
                k = str(k).strip().upper()
                s = str(s).strip()
                if s.endswith(".0"):
                    s = s[:-2]
                if not KEY_RE.match(k) or not s.isdigit():
                    continue
                e = index.setdefault(k, {"s": [], "n": ""})
                if s not in e["s"]:
                    e["s"].append(s)
                if nm and not e["n"]:
                    e["n"] = str(nm).strip()
                rows += 1
            print(f"    {rows} Zeilen übernommen")
        db.close()
    print(f"Wegeschlüssel: {len(index)}; Beispiele: {list(index.items())[:5]}")
    for probe in PROBES:
        print(f"  {probe}: {index.get(probe)}")
    if not index:
        if os.path.exists(out_path):
            os.remove(out_path)
        sys.exit("Keine Zuordnung Wegeschlüssel → Signaturnummer gefunden (siehe Tabellen oben).")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
