# GoAhead – Projektstand, Entscheidungen und Arbeitsweise

Diese Datei ist der Einstieg für jede Weiterentwicklung (auch in einem neuen Chat). Sie fasst zusammen, **was
GoAhead ist, wie es aufgebaut ist und welche Entscheidungen schon getroffen wurden – und warum**. Die verbindlichen
Arbeitsregeln stehen in [`CLAUDE.md`](../CLAUDE.md), die Funktionsbeschreibung für Nutzer in [`README.md`](../README.md).
Bei Widersprüchen gilt: Code > CLAUDE.md > diese Datei. Beim Ändern bitte hier mitpflegen.

Stand: Version 50 (App-Version in `app.js`), November 2026.

---

## 1. Worum es geht

- **Nutzer:** ein Wegemarkierer und Wanderer in NRW (nach Screenshots und Testdaten: Raum Bad Driburg/Eggegebirge), unterwegs mit einem
  **Samsung-Android-Handy**. Zweiter Anwendungsfall: seine Frau mit **iPhone** begleitet Touren aus der Ferne
  (Modus „Begleiten“). Touren wurden früher in **komoot** geplant/aufgezeichnet und von dort übernommen.
- **Zweck:** amtliche Wanderkarten und Wanderwege (Geobasis NRW, TFIS) sehen, Wegzeichen antippen, Routen planen
  (auch Rundtouren nach Länge), unterwegs aufzeichnen mit Vibration vor Abbiegungen, Touren verwalten, teilen.
- **Form:** Web-App (PWA) unter https://carstenkeller.github.io/goahead/ **plus** eine kleine Android-App
  (WebView-Hülle), weil nur sie bei ausgeschaltetem Bildschirm zuverlässig aufzeichnet.
- **Kein Server:** alles läuft im Gerät (IndexedDB, localStorage). Teilen geht über Links mit gepackten Daten.

## 2. Wie der Nutzer arbeitet (für die Zusammenarbeit wichtig)

- Antworten und Oberfläche **auf Deutsch**; sachlich, konstruktiv-kritisch; **nichts erfinden**, Annahmen und
  Ungeprüftes kennzeichnen, Nicht-Wissen offen sagen.
- Der Nutzer testet **auf seinem Handy** nach jeder Veröffentlichung und meldet per Screenshot zurück.
  Deshalb: nach jedem Push den GitHub-Actions-Lauf prüfen und erst dann „ist online“ melden.
- Die Entwicklungsumgebung erreicht die Kartendienste meist **nicht** → Tests mit Playwright und nachgebildeten
  Antworten; das in der Rückmeldung offen sagen. Externe Daten bei Bedarf in einem Actions-Lauf holen.
- Kleine, abgeschlossene Schritte: ändern → testen → Version erhöhen → Commit (deutsch) → Push → Lauf prüfen.

## 3. Grundsätze der Oberfläche (Kurzfassung, Details in CLAUDE.md)

- **Das Display ist klein, die Karte ist das Wichtigste.** Keine Erklärtexte, nur Daten und knappe Zustände.
- **Symbolknöpfe** (`.icon-btn`, 44 px, Symbol aus `G.icon(name)`, Text in `title` + `aria-label`); Textknöpfe nur
  in Dialogen. Langer Druck zeigt den Tooltip (oben mittig wie die Statusmeldung, solange der Finger liegt).
- **Listenköpfe** (Tracks-Seite, alle drei Reiter) einheitlich: „Anzahl · km“ links, Symbolknöpfe rechts
  (GPX: Importieren; Geplant: Jahr, Einfügen, Suche; Erwandert: Jahr, Art, ggf. Liste prüfen, Suche).
- **Untere Leisten** (`.sheet`) liegen über der Karte, verschieben nichts, lassen sich bis auf die Kopfzeile
  (72 px) zusammenschieben; wichtigste Aktionen in die Kopfzeile.
- **Bedienung auf der Karte vor Knöpfen** (antippen, erneut antippen, ziehen).
- **Dialoge** nur über `G.actionSheet` / `G.askText` – nie `alert/confirm/prompt` (zeigen die Web-Adresse).
  Meldungen für Wanderer formuliert: keine HTTP-Codes, Fehlertexte oder Technikbegriffe.
- **Design:** „Glas“ (leicht transparent), untere Leisten leicht grünlich; Farben nur über CSS-Variablen.
- **Hell/Dunkel** über `:root[data-theme="dark"]`; Kontrast ≥ 4,5 : 1; Symbole ohne feste Farben.
- **Einstellungen** sind eine eigene Seite, Bereich **App (Sprache, Darstellung) immer ganz oben**.
- **Sprache:** Deutsch ist Ausgangssprache, Englisch über Wörterbuch (`i18n-en.js`).

## 4. Aufbau

| Datei | Aufgabe |
|---|---|
| `index.html` | Gerüst; im `<head>` `i18n-en.js`, `i18n.js`; danach config → regions → mosaic → app → tracks → planner → tourview → offline → photos → marks → nav → share → backup |
| `i18n.js`, `i18n-en.js` | Sprache (T(), automatische Übersetzung fester Texte per MutationObserver), Darstellung (data-theme) |
| `app.js` | Karte, Ebenen, Kartenwahl-Leiste, Position, Menü, Einstellungen, Infofenster, Dialoge, Tooltips, Brücke zur App; Schnittstelle `window.GOAHEAD` (G) |
| `tracks.js` | Seite *Tracks* (Reiter GPX/Geplant/Erwandert), GPX-Import, **einzige Stelle, die IndexedDB öffnet** (`G.db`) |
| `planner.js` | Route planen, Rundtour nach Länge, Höhenprofil, Liste *Geplant*, GPX-Export (`G.planner`) |
| `tourview.js` | Tour-Details als Leiste (`G.tourView`), Listenkopf mit Anzahl/km/Jahr/Suche (`G.listTools`) |
| `offline.js` | Kacheln im Korridor um eine Route offline speichern (`G.offline`) |
| `photos.js` | Fotos unterwegs (`G.photos`) |
| `marks.js` | Seite *Ebenen*, eigene Markierungsebenen (`G.marks`) |
| `nav.js` | Unterwegs-Modus, Aufzeichnung, Abbiegungen, Begleiten, Liste *Erwandert* (`G.nav`) |
| `share.js` | Tour/Stand teilen und einfügen (`G.share`) |
| `backup.js` | Sicherung/Wiederherstellen, Sammel-Import GPX/ZIP (`G.backup`) |
| `config.js`, `mosaic.js`, `regions.js` | Kartendienste, Mosaik nach Gebiet, Ländergrenzen |
| `sw.js` | Service Worker: App-Hülle (Netz zuerst), Kacheln aus `goahead-tiles-v1` |
| `android/` | Android-App (Kotlin): `MainActivity.kt`, `TrackingService.kt`, `TrackStore.kt` |
| `.github/workflows/` | `pages.yml` (Android-Build + Veröffentlichung), `kartendienste.yml`, `brouter-pruefen.yml` |

**Wichtige G-Funktionen:** `showStatus/hideStatus`, `actionSheet(titel, untertitel, [{label, primary, danger,
onClick}])`, `askText(titel, wert, onOk, okLabel)`, `makeResizable(panel, kopf, schlüssel)`, `addToToolbar(control)`,
`setMapClickHandler(fn|null)`, `getSettings()/onSettingsChange(fn)`, `icon(name)`, `downloadFile`, `shareGpx`,
`native.call(name, …)` (nur in der App), `i18n` (`t`, `dec`, `locale`, `setTheme`).
Nach Datenänderungen `window.dispatchEvent(new Event("goahead:data"))` → Listen laden neu.

## 5. Daten

- **IndexedDB „goahead“, Version 5**, Speicher (alle `keyPath: "id"`): `tracks` (GPX-Original), `routes` (geplant),
  `walks` (erwandert), `photos` (Blob), `marklayers` (eigene Ebenen: Wegzeichen, Positionen, Zustand). Neue Speicher: `DB_VERSION` erhöhen (Nutzer auf andere offene Fenster hinweisen).
- **localStorage** (`goahead.*`): `settings.v1` (alle Einstellungen), `view.v1` (Kartenausschnitt, Ebenen),
  `plan.v1` (Planungsentwurf), `walk.v1` (laufende Tour), `symbolScale.v1`, `loopKm.v1`, `tracksTab.v1`,
  `photoPending.v1`, Leistenhöhen (`*Height.v1`).
- **Einstellungen** (`SETTING_DEFAULTS` in `app.js`): theme `system`, lang `de`, zoomButtons aus, routing `brouter`,
  loopPrefer `longer`, loopOverlapPct 0, loopWarnPct 20, Gehgeschwindigkeit 4,5/3,0/4,0 km/h ab 5 %, offlineKm 1,
  turnWarnM 20, reversePct 1, autoEndKmh 80, walk/run/bikeMaxKmh 7/11/32, listCheck aus.
- **Sicherung** = alle Speicher + `goahead.*` als JSON; Wiederherstellen ergänzt (gleiche id überschreibt).
- Daten der Android-App liegen **getrennt von Chrome** (eigene WebView) → Umzug per Sicherung.

## 6. Kartendienste (Details und Prüfwege in README/`config.js`)

- **Wanderkarte (Mosaik):** DTK NRW → TopPlusOpen (DE) → basemap.at (AT) → OpenTopoMap (überall).
- **Luftbild (Mosaik):** DOP NRW, DOP von 12 weiteren Ländern, basemap.at Orthofoto, sonst Esri World Imagery.
- **Overlays:** Wanderwege NRW (TFIS, WMS, nur NRW), Wanderwege OSM (Waymarked Trails).
- **Routing:** BRouter (Standard, mit Höhen; Rundtour über `engineMode=4`), OSRM (FOSSGIS) als Alternative.
- **Suche:** Nominatim; Koordinaten auch UTM 32. Bedienung wie bei *Tracks*: Lupe in der Werkzeugreihe blendet das Feld ein/aus, gesucht wird mit der Eingabetaste (kein zweiter Suchknopf).
- Neue Dienste erst im Workflow „Kartendienste prüfen“ testen; Overlays mit Gebietsinhalt bekommen `region`.

## 7. Funktionen und die Entscheidungen dahinter

**Planen**
- Tippen setzt einen orangen Vorschlag, erneutes Tippen übernimmt; Strecke antippen = Zwischenpunkt; Punkte ziehbar.
  Rückgängig/Wiederholen über Schnappschüsse (`pushHistory()`).
- **Rundtour nach Länge** (Knopf ↻ ohne Route): Länge eingeben, Start antippen. Suche über viele Richtungen und
  Radien, bis eine Runde **ohne doppelte Wege** gefunden ist (Toleranz einstellbar, Standard 0 %). Ein Stiel am
  Start (Sackgasse) wird ohne Rückfrage akzeptiert. **Keine Rückfragen** an den Nutzer – suchen, bis gefunden.
  Passt die Länge nicht: nächstlängere (Standard) oder -kürzere (Einstellung); Warnung ab 20 % Abweichung (einstellbar).
- **Beenden (×):** ohne ungespeicherte Änderungen wird die Planung geleert; sonst *Speichern und beenden*,
  *Später weiterplanen* (Entwurf bleibt) oder *Verwerfen* (Entwurf weg; gespeicherte Route bleibt unverändert).
  Einen eigenen Knopf „Neue Route planen“ gibt es deshalb nicht mehr.
- Richtungspfeile auf geplanten Strecken; Höhenprofil (bei BRouter automatisch); Gehzeit aus den Geschwindigkeiten.

**Unterwegs**
- Start über „Los geht's“ (geplante Route) oder Aufnahme ohne Route (Menü). Kennzahlen, Höhenprofil mit Position,
  eine Zustandszeile (Wichtigstes zuerst, z. B. „⚠ Bildschirm anlassen“, „⚠ … m neben der Route“).
- Vibration vor Abbiegungen (in der App vibriert nur der Dienst). Offline-Karten im Korridor um die Route.
- **Richtung automatisch umdrehen**, wenn man zu Beginn entgegen der Route geht (Standard 1 % der Strecke).
- **Automatisch beenden** bei Fahrt (3 aufeinanderfolgende 20-s-Abschnitte über der Grenze, Standard 80 km/h);
  Tour bis zum letzten Lauftempo gekürzt und mit ⚠ markiert.
- Fotos über die Kopfzeile (in der App: Kamera-App, Bild im Album „GoAhead“, verkleinerte Kopie in GoAhead).

**Touren verwalten (Tracks-Seite)**
- *Erwandert:* Art der Tour aus Ø-Geschwindigkeit (Wandern/Laufen/Rad/Fahrzeug, Grenzen einstellbar) mit Filter;
  Details als Leiste; Ende abschneiden; nach *Geplant* verschieben; *Liste prüfen* (Doppelte, vermutlich geplante,
  Fahrten) nur per Einstellung – entstanden für die Bereinigung des komoot-Imports.
- *Geplant:* Ansehen, Verändern, Kopieren, Begleiten, Teilen, GPX-Export, Löschen; Einfügen geteilter Touren im Kopf.
- *GPX:* fremde GPX-Dateien anzeigen; Sammel-Import (GPX/ZIP) mit Zielwahl (automatisch nach Zeitstempeln).

**Teilen und Begleiten (ohne Server)**
- Link `…/#g=<deflate+base64url-JSON>` (Route vereinfacht auf 5 m). „Für Begleitung teilen“ (Tour) und
  „Stand teilen“ (unterwegs: Zeit, km, Spur). Empfang: Link öffnen oder Nachricht kopieren → Einfügen.
- Begleiten (`walk.companion`) zeichnet nie auf, fasst die App-Aufzeichnung nie an, speichert nichts.

**Markierungsebenen (Wegemarkierer, `marks.js`)**
- Ziel: Markierungszustand der eigenen Wabe festhalten und auf der Karte zeigen. Entscheidungen des Nutzers (11/2026):
  Wegzeichen aus **TFIS und eigene Bilder**; Erkennung als **Vorschlag mit Bestätigung**; **Zustand je Wegzeichen**
  (gut / erneuern / fehlt); Umsetzung **in zwei Schritten**.
- Schritt 1 (Version 46): Seite *Ebenen*, Leiste je Ebene (Modus `mode-marks`), Kamera in der Kopfzeile → Position an
  der GPS-Stelle → Wegzeichen antippen; ausgewählte Position = nächstes Foto ergänzt sie; Reihenfolge per Pfeilen;
  Zustand per Tipp auf das Wegzeichen; Position verschiebbar; Filter nach Wegzeichen/Zustand mit Anzahl;
  TFIS-Wegzeichen per Signaturnummer oder aus dem Infofenster (*+*).
- Version 47–49: Wegenummern des Nutzers (z. B. `01-0A0-00` Eggeweg, `00-0A8-00` E1) wurden nicht erkannt. Befund
  aus dem Protokoll der Pages-Läufe: Sie stehen **nicht** in den offenen TFIS-Daten. GeoPackage
  `Freizeitdaten_NRW_GeoPackage.gpkg`, Tabelle `wanderwege` (8396 Zeilen), Spalten u. a. `scl` (Form
  `H0001072_200013`), `snr`, `kat`, `nam`, `bez`, `wvi`. Eggeweg = `nam` „Eggeweg“, `bez` „X“, `snr` 200013;
  E1 = `nam` „Europäischer Fernwanderweg E1“, `snr` 100055. Lösung: Suche nach Name/Bezeichnung
  (`symbols/tfis/index.json` = Liste [snr, nam, bez, wvi, kat]); die eigene Wegenummer davor wird als `key` beim
  Wegzeichen gespeichert und angezeigt. Herkunft der Wegenummern unbekannt (vermutlich Vereinsnummerierung – ungeprüft).
- Version 50: Seite *Wegzeichen wählen* – alle TFIS-Wegzeichen als Bildraster (je Signaturnummer eins), Filter Verein
  (Vorgabe: Verein der schon hinterlegten TFIS-Wegzeichen) und Kategorie, Namenssuche per Lupe wie bei *Tracks*.
  Rückmeldung über Markierung der Kachel (Statusmeldungen liegen unter Vollbildseiten). Ersetzt die Textsuche mit
  Auswahlliste aus Version 49.
- Schritt 2 (offen): Foto mit den hinterlegten Wegzeichen vergleichen, beste Treffer zuerst anbieten; bestätigte Fotos
  als weitere Vergleichsbilder. Braucht echte Fotos von Markierungen zum Prüfen. Ob ein Vergleich auf dem Gerät
  verwitterte, schräg fotografierte Markierungen zuverlässig erkennt, ist **ungeprüft**.
- Grenzen: Position = GPS des Handys (im Wald einige Meter ungenau) → verschiebbar. Ebenen-Modus und Unterwegs-Modus
  schließen sich aus (beide sind untere Leisten mit eigenem Modus).

**Sprache und Darstellung**
- `T("Satz mit {0}", wert)` für Texte mit Werten; feste Texte übersetzt der Observer automatisch (nur bei Englisch).
  Nutzernamen in `data-noi18n`. Sprachwechsel lädt neu; Darstellung wirkt sofort.
- Nicht übersetzt: Quellenangaben, Diagnose-Seite, Benachrichtigung der Android-App.

## 8. Android-App

- `applicationId de.goahead.app`, minSdk 29, target/compileSdk 34. Build **nur in GitHub Actions** (`pages.yml`),
  APK unter `/goahead/app/goahead.apk`. Signatur: verschlüsselter Schlüssel `goahead-keystore.jks.enc`, Passwort nur
  im Secret `GOAHEAD_KEYSTORE_PASSWORD`. **Schlüssel und applicationId nie ändern** (sonst kein Update möglich).
- Brücke `window.GoAheadNative` (nur über `G.native.call`): `appVersion, recordingState, startRecording,
  pauseRecording, stopRecording, pointCount, getPoints, setTurns, hasCamera, takePhoto, batteryOptimized,
  requestBatteryExemption, openAppSettings, saveFile, shareText, shareFile`. **Nur ergänzen, nie umbenennen**
  (installierte Apps aktualisieren sich nicht selbst). Web-Änderungen brauchen keinen neuen App-Build.
- Aufzeichnung: Vordergrunddienst sammelt Punkte in `track.jsonl`, `nav.js` holt sie ab (`pullNative`).
- Samsung: Akku-Optimierung ausschalten (Dialog in *Einstellungen → Android-App*).

## 9. Veröffentlichen und Testen

1. Änderung + Wörterbuch (`i18n-en.js`) + README/CLAUDE.md/diese Datei pflegen.
2. Version an drei Stellen erhöhen: `?v=` in `index.html`, `goahead-shell-vN` in `sw.js`, `APP_VERSION` in `app.js`.
   Neue Dateien in `index.html` **und** `SHELL` in `sw.js`.
3. Testen: `python3 -m http.server 8765`, Playwright/Chromium „Pixel 7“, nachgebildete Antworten (`context.route`),
   App-Modus per `addInitScript` (`window.GoAheadNative`), Englisch/Dunkel per `goahead.settings.v1`
   (`{lang:"en", theme:"dark"}`), `GOAHEAD_I18N.missing` muss leer sein, keine `pageerror`, Screenshots ansehen.
   Langer Druck: CDP `Input.dispatchTouchEvent`.
4. Commit auf Deutsch, Push auf den Entwicklungs-Branch → `pages.yml` läuft → Lauf prüfen (bei 502 im
   Deploy-Schritt einen neuen Lauf per workflow_dispatch starten, nicht „Re-run failed jobs“).
   „Re-run“ legt ein zweites Paket `github-pages` an → Fehler „Multiple artifacts“.
   **Neuer Entwicklungs-Branch:** in `pages.yml` (`on.push.branches`) eintragen **und** vom Nutzer in den
   Repository-Einstellungen (Environments → `github-pages` → Deployment branches) freigeben lassen.
   Hängt eine Veröffentlichung („deployment_queued“, dann „Deployment failed, try again later“), scheitern weitere
   Läufe zum selben Commit offenbar ebenso (Vermutung, Kennung = Commit) – dann mit einem neuen Commit veröffentlichen.

## 10. Offen, ungeprüft, bekannte Grenzen

- **Nicht auf echten Geräten geprüft:** Samsung-Kamera-Ablauf, iPhone-Zwischenablage beim Einfügen, Qualität der
  BRouter-Rundtouren mit echten Daten, ob die Link-Adresse beim langen Druck auf Android wirklich weg ist.
- Samsung-Menüpfade für Akku-Einstellungen nach Fachseiten, am Gerät nicht geprüft.
- Englische Texte selbst formuliert (Begriffe wie „Accompany“, „Share progress“ ggf. anpassen).
- Kartenkacheln werden im Dunkelmodus nicht abgedunkelt (bewusst: Farben/Wegzeichen bleiben lesbar).
- Automatisch vergebene Namen („Route vom …“) bleiben in der Sprache, in der sie entstanden.
- Benachrichtigung der Android-App („GoAhead – Aufnahme läuft“) ist nur deutsch (bräuchte neuen App-Build).
- Markierungsebenen: nur mit nachgebildeten Bildern/GPS getestet; TFIS-Wegzeichen erst nach dem ersten Anzeigen offline
  verfügbar (Service Worker speichert sie beim Laden). Wiederherstellen-Meldung nennt die Zahl der Ebenen nicht.
