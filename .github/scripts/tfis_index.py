"""Erzeugt symbols/tfis/index.json: Wegeschlüssel (TFIS-Feld „schluessel“, z. B. „01-0A0-00“) →
Signaturnummer und Name. Die App (marks.js) findet damit das Wegzeichen-Bild zu einer Wegenummer.

Quelle: GeoPackage(s) aus dem TFIS-Paket von Geobasis NRW (wird im Pages-Workflow geladen).
Tabellen- und Spaltennamen des GeoPackage sind nicht dokumentiert geprüft – belegt sind nur die Feldnamen
der WMS-Sachdatenabfrage (schluessel, signaturnummer, name, siehe app.js TFIS_LABELS). Das Skript sucht daher
in allen Tabellen Spalten mit diesen Namen (ohne Groß-/Kleinschreibung) und schreibt den gefundenen Aufbau ins
Protokoll, damit er im Actions-Lauf nachgeprüft werden kann.

Aufruf: python3 tfis_index.py <ausgabe.json> <datei.gpkg> [...]
Ausgabe: {"01-0A0-00": {"s": ["123"], "n": "Eggeweg"}, ...}  (s = Signaturnummer(n), n = Name)
"""
import json
import sqlite3
import sys


def find_col(cols, *names):
    low = {c.lower(): c for c in cols}
    for n in names:
        if n in low:
            return low[n]
    return None


def main(out_path, files):
    index = {}
    for path in files:
        db = sqlite3.connect(path)
        tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        print(f"{path}: {len(tables)} Tabellen")
        for t in tables:
            cols = [r[1] for r in db.execute(f'PRAGMA table_info("{t}")')]
            key = find_col(cols, "schluessel")
            sig = find_col(cols, "signaturnummer")
            if not key or not sig:
                continue
            name = find_col(cols, "name", "wegname", "bezeichnung")
            print(f"  Tabelle {t}: Spalten {cols}")
            q = f'SELECT "{key}", "{sig}", ' + (f'"{name}"' if name else "NULL") + f' FROM "{t}"'
            rows = 0
            for k, s, n in db.execute(q):
                if k is None or s is None:
                    continue
                k = str(k).strip().upper()
                s = str(s).strip()
                if s.endswith(".0"):
                    s = s[:-2]
                if not k or not s:
                    continue
                e = index.setdefault(k, {"s": [], "n": ""})
                if s not in e["s"]:
                    e["s"].append(s)
                if n and not e["n"]:
                    e["n"] = str(n).strip()
                rows += 1
            print(f"    {rows} Zeilen übernommen")
        db.close()
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
    sample = list(index.items())[:5]
    print(f"Wegeschlüssel: {len(index)}; Beispiele: {sample}")
    for probe in ("01-0A0-00", "00-0A8-00"):
        print(f"  {probe}: {index.get(probe)}")
    if not index:
        sys.exit("Keine Tabelle mit den Spalten schluessel und signaturnummer gefunden.")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
