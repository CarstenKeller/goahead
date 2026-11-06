"""Erzeugt symbols/tfis/index.json: Verzeichnis der TFIS-Wanderwege zum Suchen nach Name/Bezeichnung.
Die App (marks.js, „Wegzeichen hinzufügen“) findet damit das Wegzeichen-Bild (symbols/tfis/<Signaturnummer>.svg).

Quelle: GeoPackage aus dem TFIS-Paket von Geobasis NRW (wird im Pages-Workflow geladen).
Geprüft in den Actions-Läufen vom 6.11.2026 (Protokoll):
  - Datei „Freizeitdaten_NRW_GeoPackage.gpkg“, Tabelle „wanderwege“ (8396 Zeilen), Spalten u. a.
    scl (Schlüssel, Form „H0001072_200013“), snr (Signaturnummer), kat (Kategorie), nam (Name), bez (Bezeichnung),
    wvi (Verein), sva (Haupt-/Stich-/Alternativstrecke).
  - Beispiel: Eggeweg = nam „Eggeweg“, bez „X“, wvi „Eggegebirgsverein e.V.“, snr 200013;
    E1 = nam „Europäischer Fernwanderweg E1“, bez „E1“, snr 100055.
  - Die Wegenummern des Nutzers (z. B. „01-0A0-00“) kommen in keiner Spalte vor – gesucht wird daher nach Name
    und Bezeichnung.

Aufruf: python3 tfis_index.py <ausgabe.json> <datei.gpkg> [...]
Ausgabe: [[Signaturnummer, Name, Bezeichnung, Verein, Kategorie], ...]  (je Kombination einmal)
"""
import json
import os
import sqlite3
import sys


def clean(v):
    return "" if v is None else str(v).strip()


def main(out_path, files):
    seen = set()
    out = []
    for path in files:
        db = sqlite3.connect(path)
        tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        if "wanderwege" not in tables:
            print(f"{path}: keine Tabelle wanderwege ({len(tables)} Tabellen)")
            continue
        cols = [r[1] for r in db.execute('PRAGMA table_info("wanderwege")')]
        print(f"{path}: wanderwege {cols}")
        need = ("snr", "nam", "bez", "wvi", "kat")
        if any(c not in cols for c in need):
            print(f"  Spalten fehlen: {[c for c in need if c not in cols]}")
            continue
        for snr, nam, bez, wvi, kat in db.execute("SELECT snr, nam, bez, wvi, kat FROM wanderwege"):
            s = clean(snr)
            if s.endswith(".0"):
                s = s[:-2]
            if not s.isdigit():
                continue
            rec = (s, clean(nam), clean(bez), clean(wvi), clean(kat))
            if rec in seen:
                continue
            seen.add(rec)
            out.append(list(rec))
        db.close()
    print(f"Einträge: {len(out)}")
    for probe in ("Eggeweg", "E1"):
        hits = [r for r in out if r[1] == probe or r[2] == probe]
        print(f"  {probe}: {len(hits)} Einträge: {hits[:12]}")
    # Prüfung: Unter welchen Vereinen steht der Europäische Fernwanderweg E1?
    e1 = sorted({r[3] for r in out if "Fernwanderweg E1" in r[1] and not "Fernwanderweg E1" + "1" in r[1]})
    print(f"  Vereine E1 (Fernwanderweg): {e1}")
    if not out:
        if os.path.exists(out_path):
            os.remove(out_path)
        sys.exit("Keine Wanderwege gefunden.")
    out.sort(key=lambda r: (r[1] or r[2]).lower())
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
