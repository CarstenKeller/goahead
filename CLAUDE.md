# GoAhead – Arbeitsregeln für dieses Repository

Web-App (PWA) für Wegemarkierer: Karten von Geobasis NRW, Wanderwege (TIM-online/TFIS, OSM),
Routen planen, unterwegs aufzeichnen. Zielgeräte: Android- und iOS-Smartphones im Gelände.
Diese Regeln gelten für jede Änderung – sie halten fest, was sich bereits bewährt hat oder
schon einmal falsch gemacht wurde.

## Sprache und Haltung

- Oberfläche, Kommentare, README, Commit-Nachrichten: **Deutsch**.
- Nichts erfinden. Externe Schnittstellen (URLs, Parameter, Layer-Namen, Antwortformate) vor der
  Verwendung belegen – Quelltext des Projekts, offizielle Doku, Capabilities – und im Code-Kommentar
  bzw. in der README vermerken, *wie* sie geprüft wurden. Ungeprüftes ausdrücklich als „ungeprüft“ kennzeichnen.
- Keine Modellnamen in Commits, Code oder Doku.

## Oberfläche – Grundregeln

1. **Untere Leisten verschieben nichts.** Alle unteren Leisten (Infofenster, Planen, Unterwegs und
   künftige) verwenden die Klasse `.sheet` und liegen *über* der Karte und ihren Bedienelementen.
   Positions-Knopf, Maßstab und Quellenangabe bleiben, wo sie sind – auch beim Ziehen der Leiste.
   Keine CSS-Regeln, die `.map-btn` oder `.leaflet-bottom` abhängig von einer Leiste verschieben.
2. **Leisten-Aufbau:** `<section class="sheet">` → Kopf `.sheet-handle` mit `.sheet-grip`
   → Inhalt `.sheet-body` (scrollt). Ziehbar machen mit `GOAHEAD.makeResizable(panel, kopf, speicherSchlüssel)`.
3. **Design:** modern, leicht transparent („Glas“). Farben, Flächen, Radien, Schatten und
   Ebenen (z-index) ausschließlich über die Variablen am Anfang von `styles.css`
   (`--c-*`, `--glass*`, `--r-*`, `--shadow*`, `--z-*`). Keine fest eingetragenen Farben in neuen Regeln.
   Neue Flächen in die Liste „Gemeinsame Glas-Fläche“ in `styles.css` aufnehmen.
4. **Knöpfe:** in `.sheet`, `.page`, `.dlg` automatisch einheitlich. Varianten über die vorhandenen
   Klassen (`.btn-primary`, `.btn-danger` bzw. die dort gelisteten). Mindestgröße für Touch ca. 44 px.
5. **Dialoge:** nie `window.prompt`/`alert` (werden teils unterdrückt). Stattdessen
   `GOAHEAD.askText(...)` und `GOAHEAD.actionSheet(...)`. `window.confirm` nur, wo bereits verwendet.
6. **Menü:** Funktionen kommen als Knopf in die Leiste per `GOAHEAD.addToToolbar(control)`.
   Modi (Planen, Unterwegs) blenden über eine Body-Klasse (`mode-…`) alles außer der Kartenwahl aus.
7. **Kartentipps** übernimmt ein Modul nur über `GOAHEAD.setMapClickHandler(fn)` (und gibt sie mit `null` zurück).
8. **Sichtbares Feedback:** Netzabfragen mit Zeitlimit; Fehler als Meldung (`GOAHEAD.showStatus`),
   nie still hängen bleiben. Leere Ergebnisse nicht mit Meldungen „belohnen“, wenn der Nutzer
   nichts erwartet (z. B. Tipp ins Leere).

## Aufbau

- `app.js`: Karte, Ebenen, Position, Menü, Infofenster, Dialoge; Schnittstelle `window.GOAHEAD` (G).
- `tracks.js`: Seite *Tracks* (Reiter GPX/Geplant/Erwandert), GPX-Import, **IndexedDB** (`G.db`).
- `planner.js`: Route planen, Liste *Geplant*, GPX-Export.
- `nav.js`: Unterwegs-Modus, Aufzeichnung, Liste *Erwandert*.
- `config.js`: Kartendienste. Reihenfolge der Skripte in `index.html` beachten (app → tracks → planner → nav).

## Bei jeder Veröffentlichung

- Versionsnummer an **drei Stellen** erhöhen: `?v=` an allen Skript-/CSS-Einbindungen in `index.html`,
  Cache-Name in `sw.js` (`goahead-shell-vN`), `APP_VERSION` in `app.js`.
- Neue Dateien in `index.html` **und** in die `SHELL`-Liste von `sw.js` aufnehmen.
- README (Funktionsliste, Dateien, Dienste) mitpflegen.

## Lokaler Speicher (IndexedDB)

- Nur `tracks.js` öffnet die Datenbank. Neue Speicher: `DB_VERSION` erhöhen und in `onupgradeneeded` anlegen.
- Andere offene Tabs mit älterer Version blockieren eine Umstellung – das ist abgefangen
  (`onblocked`, `onversionchange`, Zeitlimit). Beim Erhöhen der Version den Nutzer darauf hinweisen.
- Bearbeitete Daten erst beim ausdrücklichen „Speichern“ überschreiben; Entwürfe getrennt sichern.

## Testen

- Die Entwicklungsumgebung hat meist **keinen Zugriff** auf die externen Dienste (wms.nrw.de, BRouter,
  OSRM, Nominatim, Waymarked Trails). Getestet wird mit Playwright/Chromium (headless, Gerät „Pixel 7“)
  und **nachgebildeten Antworten** (`context.route`). Das in der Rückmeldung an den Nutzer offen sagen.
- Prüfen: keine JavaScript-Fehler (`pageerror`), Abläufe Schritt für Schritt, Screenshots ansehen.
- Lokaler Server: `python3 -m http.server 8765` im Repo-Verzeichnis.
- Externe Daten, die nur außerhalb erreichbar sind, notfalls über einen GitHub-Actions-Lauf holen
  (wie die TFIS-Wegzeichen im Deploy-Workflow).

## Veröffentlichen

- Push auf den Entwicklungs-Branch löst `.github/workflows/pages.yml` aus (GitHub Pages,
  https://carstenkeller.github.io/goahead/). Den Lauf prüfen, bevor der Nutzer testen soll.
