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

**Leitlinie: Das Display ist klein, die Karte ist das Wichtigste.** Bedienfelder brauchen so wenig
Platz wie möglich:

- **Keine Erklärtexte zur Bedienung** in der Oberfläche. Angezeigt werden nur Daten (Name, Kennzahlen)
  und knappe Zustände/Warnungen, wenn sonst Daten verloren gehen könnten (z. B. „⚠ Bildschirm anlassen“).
- **Knöpfe als Symbole mit Tooltip** statt Beschriftung: `class="icon-btn"`, Symbol aus `GOAHEAD.icon(name)`,
  Beschriftung in `title` **und** `aria-label`. Langer Druck zeigt den Tooltip auf Touch-Geräten (global in app.js).
  Textknöpfe nur in Dialogen/Auswahlmenüs.
- **Wichtigste Aktionen in die Kopfzeile** der Leiste (z. B. Speichern, Beenden), Titel und Kennzahlen links daneben.
  Kopfknöpfe sind schlank und ohne Fläche (Titel braucht mindestens ein Drittel der Breite); die Leiste lässt
  sich auch ziehen, wenn der Finger auf einem Kopfknopf beginnt.
- Bedienelemente, die bei hochgezogener Leiste gebraucht werden (z. B. Kamera unterwegs), gehören in die
  Kopfzeile – nicht als Kartenknopf, den die Leiste verdeckt.
- **Bedienung direkt auf der Karte vor Knöpfen:** Antippen, erneut antippen, Doppeltipp, Ziehen
  (z. B. Vorschlagspunkt erneut antippen = übernehmen; Strecke antippen = Zwischenpunkt; Doppeltipp = Modus wechseln).
  Keinen Knopf für etwas, das auf der Karte direkt geht.
- Selten gebrauchte Eingaben (z. B. Suche) erst auf Knopfdruck einblenden.
- **Einstellungen** sind eine eigene Seite (`.page`, wie *Tracks*), nach Bereichen gruppiert (`.settings-group`:
  Karte, Planen, Unterwegs, Touren, Daten, App). Neue Einstellungen in den passenden Bereich. Kurze Auswahlen
  (z. B. Kartenwahl) sind eine ziehbare `.sheet` – keine Klappfelder in der Menüleiste.
- Globale Ereignis-Abfangungen (z. B. Klick nach Tooltip verschlucken) dürfen nie einen späteren,
  unabhängigen Tipp blockieren: Zustand bei jeder neuen Berührung zurücksetzen.
- **Sprache:** Deutsch ist die Ausgangssprache, Englisch kommt aus `i18n-en.js` (Schlüssel = deutscher Text).
  Feste Oberflächentexte (Knöpfe, Überschriften, `title`/`aria-label`/`placeholder`) werden automatisch übersetzt –
  dafür nur den deutschen Text als eigenen Textknoten bzw. Attribut schreiben und ins Wörterbuch eintragen.
  Texte mit Werten immer als ganzer Satz mit Platzhaltern: `T("Route „{0}“ gespeichert.", name)` – nie aus
  Bruchstücken zusammensetzen. Zahlen mit Nachkommastellen über `G.i18n.dec`, Datum mit `G.i18n.locale`.
  Nutzerdaten (Namen) in Elementen mit `data-noi18n`. Neue Texte: Test mit `lang: "en"` und `GOAHEAD_I18N.missing`.
- **Darstellung:** Hell/Dunkel nur über die Variablen in `styles.css` (Block `:root[data-theme="dark"]`); neue Farben
  immer für beide Varianten anlegen.
- Das `hidden`-Attribut blendet immer aus (globale Regel `[hidden] { display: none !important }`) –
  nicht mit eigenen `display`-Regeln dagegen arbeiten.

1. **Untere Leisten verschieben nichts.** Alle unteren Leisten (Infofenster, Planen, Unterwegs,
   Einstellungen und künftige) verwenden die Klasse `.sheet` und liegen *über* der Karte und ihren
   Bedienelementen. Positions-Knopf, Maßstab und Quellenangabe bleiben, wo sie sind – auch beim Ziehen
   der Leiste. Keine CSS-Regeln, die `.map-btn` oder `.leaflet-bottom` abhängig von einer Leiste verschieben.
   **Mindesthöhe und Positions-Knopf:** Jede Leiste lässt sich bis auf ihre Kopfzeile zusammenschieben,
   nie niedriger: `--sheet-min` (72 px) = Höhe der Kopfzeile (`.sheet-handle` ist genau so hoch).
   Der Positions-Knopf sitzt fest *oberhalb* dieser Mindesthöhe (`bottom: --sheet-min + 12 px`) und ist
   bei zusammengeschobener Leiste immer ganz sichtbar. Kopfzeilen-Inhalte dürfen nicht höher als
   `--sheet-min` werden: Titel und **eine** Zustandszeile (einzeilig, Wichtigstes zuerst), höchstens
   5 Symbolknöpfe.
2. **Leisten-Aufbau:** `<section class="sheet">` → Kopf `.sheet-handle` mit `.sheet-grip`,
   `.sheet-titles` (Titel + Kennzahlen) und `.sheet-head-btns` → Inhalt `.sheet-body` (scrollt).
   Ziehbar machen mit `GOAHEAD.makeResizable(panel, kopf, speicherSchlüssel)`.
3. **Design:** modern, leicht transparent („Glas“). Farben, Flächen, Radien, Schatten und
   Ebenen (z-index) ausschließlich über die Variablen am Anfang von `styles.css`
   (`--c-*`, `--glass*`, `--r-*`, `--shadow*`, `--z-*`). Keine fest eingetragenen Farben in neuen Regeln.
   Neue Flächen in die Liste „Gemeinsame Glas-Fläche“ in `styles.css` aufnehmen.
4. **Knöpfe:** in `.sheet`, `.page`, `.dlg` automatisch einheitlich; Symbolknöpfe `.icon-btn` (44 × 44 px),
   Reihen davon in `.icon-row`. Varianten über die vorhandenen Klassen (`.btn-primary`, `.btn-danger`
   bzw. die dort gelisteten). Mindestgröße für Touch 44 px.
5. **Dialoge:** nie `window.prompt`/`alert`/`confirm` (zeigen die Web-Adresse, werden teils unterdrückt). Stattdessen
   `GOAHEAD.askText(...)` und `GOAHEAD.actionSheet(...)` („Abbrechen“ kommt automatisch dazu).
   Meldungen für Wanderer formulieren: was passiert ist und was man tun kann – keine HTTP-Codes, Fehlertexte
   (`err.message`), URLs, Dienst- oder Technikbegriffe. Technisches nach `console.warn` bzw. in den Diagnose-Modus.
6. **Menü:** Funktionen kommen als Knopf in die Leiste per `GOAHEAD.addToToolbar(control)`.
   Modi (Planen, Unterwegs) blenden über eine Body-Klasse (`mode-…`) alles außer der Kartenwahl (`.maps-control`) aus.
   Auswahlen und Einstellungen öffnen eine `.sheet` (z. B. Kartenwahl), keine Klappfelder im Menü. Die Leaflet-Ebenensteuerung
   ist unsichtbar und bleibt nur die Logik dahinter (Ereignisse `baselayerchange`/`overlayadd`).
   Symbole: einfache eigene SVG-Pfade oder Tabler Icons (MIT) in `ICONS` – Herkunft im Kommentar nennen.
7. **Kartentipps** übernimmt ein Modul nur über `GOAHEAD.setMapClickHandler(fn)` (und gibt sie mit `null` zurück).
8. **Sichtbares Feedback:** Netzabfragen mit Zeitlimit; Fehler als Meldung (`GOAHEAD.showStatus`),
   nie still hängen bleiben. Leere Ergebnisse nicht mit Meldungen „belohnen“, wenn der Nutzer
   nichts erwartet (z. B. Tipp ins Leere).

## Aufbau

- `app.js`: Karte, Ebenen, Position, Menü, Infofenster, Dialoge; Schnittstelle `window.GOAHEAD` (G).
- `tracks.js`: Seite *Tracks* (Reiter GPX/Geplant/Erwandert), GPX-Import, **IndexedDB** (`G.db`).
- `planner.js`: Route planen, Liste *Geplant*, GPX-Export.
- `offline.js`: Kartenkacheln entlang einer Route offline speichern (Cache `goahead-tiles-v1`).
- `nav.js`: Unterwegs-Modus, Aufzeichnung, Abbiegungen/Vibration, Liste *Erwandert*.
- `tourview.js`: `G.tourView.open({...})` (Tour-Details als Leiste), `G.listTools` (Listenkopf mit Anzahl, km,
  Jahr, Suche). `photos.js`: `G.photos` (Speicher „photos“, Blob), Kamera über `takePhoto` der App, sonst `<input capture>`.
- `backup.js`: Sicherung/Wiederherstellen (alle Speicher + `goahead.*` in localStorage), Sammel-Import GPX/ZIP.
  Nach Änderungen an gespeicherten Daten `goahead:data` auf `window` auslösen – die Listen laden dann neu.
- `android/`: Android-App (Kotlin, WebView). Brücke `window.GoAheadNative`, in der Web-App nur über `G.native`
  (`G.native.call(name, …)`, sonst `null`). Downloads/Teilen laufen dort über die App (`G.downloadFile`, `G.shareGpx`
  benutzen, nie eigene `<a download>`). Aufzeichnung: Dienst sammelt, `nav.js` holt ab (`pullNative`); in der App
  vibriert nur der Dienst. Die App-Methoden ändern sich selten – neue nur zusätzlich, alte nicht umbenennen
  (installierte Apps werden nicht automatisch aktualisiert). Build nur in GitHub Actions; testen am Gerät des Nutzers.
- `sw.js`: App-Hülle (Netz zuerst) und Kacheln aus dem Offline-Speicher. Der Kachel-Cache darf beim
  Aktualisieren des Service Workers **nicht** gelöscht werden (sonst gehen Offline-Karten mitten in einer Tour verloren).
- `config.js`: Kartendienste. `mosaic.js` + `regions.js`: Hintergrundkarten als Mosaik nach Gebiet
  (Quellen in `config.js`, unten = überall → oben = genaueste, `region` = Länderkürzel). Neue Kartendienste erst
  im Workflow „Kartendienste prüfen“ (`.github/scripts/probe_maps.py`) testen. Overlays mit Inhalt nur in einem Gebiet
  bekommen `region` (keine Anfragen außerhalb, auch nicht offline). Reihenfolge der Skripte in `index.html` beachten
  (im `<head>`: i18n-en → i18n; dann config → regions → mosaic → app → tracks → planner → tourview → offline → photos → nav → share → backup).
- `share.js`: Teilen ohne Server (Link `#g=` mit gepacktem JSON). Begleiten ist ein Modus in `nav.js`
  (`walk.companion`): nie aufzeichnen, nie die App-Aufzeichnung (`G.native`) anfassen, nichts speichern.

## Bei jeder Veröffentlichung

- Versionsnummer an **drei Stellen** erhöhen: `?v=` an allen Skript-/CSS-Einbindungen in `index.html`,
  Cache-Name in `sw.js` (`goahead-shell-vN`), `APP_VERSION` in `app.js`.
- Neue Dateien in `index.html` **und** in die `SHELL`-Liste von `sw.js` aufnehmen.
- In `app.js` Tabellen/Variablen, die beim Aufbau gebraucht werden (z. B. `ICONS`), vor ihrer ersten
  Verwendung definieren – Funktionsdeklarationen werden „hochgezogen“, `var`-Werte nicht.
- README (Funktionsliste, Dateien, Dienste) mitpflegen.

## Lokaler Speicher (IndexedDB)

- Nur `tracks.js` öffnet die Datenbank. Neue Speicher: `DB_VERSION` erhöhen und in `onupgradeneeded` anlegen.
- Andere offene Tabs mit älterer Version blockieren eine Umstellung – das ist abgefangen
  (`onblocked`, `onversionchange`, Zeitlimit). Beim Erhöhen der Version den Nutzer darauf hinweisen.
- Bearbeitete Daten erst beim ausdrücklichen „Speichern“ überschreiben; Entwürfe getrennt sichern.
- Bearbeitungsschritte rückgängig machbar halten (Planen: Schnappschuss mit `pushHistory()` vor jeder Änderung).

## Testen

- Die Entwicklungsumgebung hat meist **keinen Zugriff** auf die externen Dienste (wms.nrw.de, BRouter,
  OSRM, Nominatim, Waymarked Trails). Getestet wird mit Playwright/Chromium (headless, Gerät „Pixel 7“)
  und **nachgebildeten Antworten** (`context.route`). Das in der Rückmeldung an den Nutzer offen sagen.
- App-Modus testen: `window.GoAheadNative` per `addInitScript` nachbilden.
- Prüfen: keine JavaScript-Fehler (`pageerror`), Abläufe Schritt für Schritt, Screenshots ansehen.
- Grenzen der Testumgebung kennen: Playwright beantwortet nachgebildete Anfragen auch „offline“ und ergänzt
  CORS-Freigaben selbst. Fehlendes Netz bzw. CORS-Ablehnung daher mit `route.abort()` nachstellen.
- Lokaler Server: `python3 -m http.server 8765` im Repo-Verzeichnis.
- Externe Daten, die nur außerhalb erreichbar sind, notfalls über einen GitHub-Actions-Lauf holen
  (wie die TFIS-Wegzeichen im Deploy-Workflow).

## Veröffentlichen

- Push auf den Entwicklungs-Branch löst `.github/workflows/pages.yml` aus (GitHub Pages,
  https://carstenkeller.github.io/goahead/). Den Lauf prüfen, bevor der Nutzer testen soll.
