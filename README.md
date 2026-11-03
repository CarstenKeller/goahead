# GoAhead – Wanderkarte für Wegemarkierer

Web-App (PWA) für Android und iOS. Sie zeigt die eigene Position auf den Karten von
**Geobasis NRW**, also auf denselben Diensten, die auch TIM-online nutzt.

## Stand (Schritt 1)

- Beim Start wird die GPS-Position gesucht und die Karte auf sie zentriert (Zoomstufe 16).
- Gesten: mit einem Finger verschieben, mit zwei Fingern zoomen, doppelt tippen zum Vergrößern. Die +/−-Knöpfe
  lassen sich in den Einstellungen einblenden (Standard: aus).
- **Menü** (☰ oben rechts): Eine Leiste mit den Funktionsknöpfen fährt von rechts ein: Kartenwahl,
  Größe der Wegemarkierungen, Tracks, Route planen, Einstellungen. Ein Tipp auf die Karte schließt das Menü.
- **Route planen** (Knopf mit Routen-Symbol im Menü), Modul `planner.js`:
  - Im Planungsmodus bleibt im Menü nur die Kartenwahl. Unten erscheint das Planungsfeld.
  - Suche: Adresse (Nominatim/OpenStreetMap) oder Koordinaten: Dezimalgrad (`51.758, 9.030`, auch mit
    Dezimalkomma oder vertauscht) oder UTM Zone 32 wie in TIM-online (`32U 494000 5735000` oder `494000 5735000`).
    Koordinaten setzen direkt einen Vorschlagspunkt.
  - Tipp auf die Karte setzt einen Vorschlagspunkt (orange, verschiebbar). Die Strecke vom letzten bestätigten Punkt
    erscheint orange gestrichelt. Nochmal auf den Vorschlagspunkt tippen (oder „Punkt übernehmen“) rastet ihn ein,
    er wird zum Ausgangspunkt für den nächsten.
  - „📍 Hier“ nimmt die eigene GPS-Position als Vorschlagspunkt.
  - Tipp auf einen Routenpunkt markiert ihn (blau). Dann:
    - Tipp auf die Karte schlägt einen Ersatzpunkt vor; die neuen Anschlussstrecken zu den Nachbarpunkten erscheinen
      orange gestrichelt, die bisherigen blass. Nochmal auf den Ersatzpunkt tippen (oder „Ersatzpunkt übernehmen“)
      ersetzt den alten Punkt.
    - „Punkt löschen“ entfernt ihn; Vorgänger und Nachfolger werden neu verbunden.
    - „Abbrechen“ oder erneutes Antippen hebt die Markierung auf.
  - „Rundtour“ verbindet den letzten Punkt mit dem Startpunkt (wieder ausschaltbar).
  - Routing-Profil: *Wandern* (BRouter, Profil `hiking-mountain`, Rückfall OSRM), *Fußweg* (OSRM der FOSSGIS,
    Rückfall BRouter) oder *Luftlinie*. Findet kein Dienst einen Weg, wird die Luftlinie genommen und gestrichelt gezeigt.
  - Anzeige: Punkte, Länge, Anstieg (nur bei BRouter), Zahl der Luftlinien-Abschnitte.
  - „💾 Speichern“ legt die Route unter *Tracks → Geplant* ab (neue Route: Name im Dialog; bearbeitete Route: wird
    überschrieben). Änderungen an einer gespeicherten Route wirken erst nach „Speichern“ – bis dahin bleibt der
    gespeicherte Stand unverändert. Die Kopfzeile zeigt „ungespeichert“, Beenden und „Neu“ fragen nach.
  - Der Arbeitsstand (Entwurf) wird zusätzlich lokal gesichert und ist nach einem Neustart wieder da.
- **Tracks** (Knopf mit Linien-Symbol im Menü): eigene Seite mit den Reitern *GPX*, *Geplant*, *Erwandert*.
  - *Geplant*: gespeicherte Routen mit Länge, Anstieg, Punktzahl, Datum. Antippen öffnet ein Menü:
    *▶ Los geht's* (Unterwegs-Modus), *✎ Verändern* (Planungsmodus), *⬇ GPX exportieren*, *🗑 Löschen*.
    GPX-Export: Track mit der berechneten Linie (inkl. Rundtour-Rückweg) und Wegpunkte für die geplanten Punkte.
  - *Erwandert*: beendete Aufzeichnungen mit Länge, Zeit in Bewegung, Anstieg (aus GPS-Höhen, daher „ca.“), Datum.
    Antippen: auf der Karte zeigen/entfernen, GPX exportieren (Track mit Höhe und Zeit), löschen.
  - Gespeichert wird lokal (IndexedDB `goahead`, Version 3, Speicher `tracks`, `routes`, `walks`).
- **Unterwegs** (*Los geht's*), Modul `nav.js`:
  - Zeigt die geplante Route, die eigene Position (Folgemodus) und die gewanderte Strecke (blau). Im Menü bleibt nur
    die Kartenwahl. Das Feld unten zeigt gewanderte Strecke, Zeit in Bewegung und Länge der Planung.
  - *⏸ Pause* / *▶ Weiter*: Während der Pause wird nichts aufgezeichnet; danach beginnt ein neues Teilstück.
    *◎ Position* zentriert wieder. *■ Beenden*: speichern unter *Erwandert*, weiterwandern oder verwerfen.
  - Aufgezeichnet werden Positionen mit höchstens 50 m Ungenauigkeit und mindestens 5 m Abstand.
  - Der Zwischenstand wird laufend lokal gesichert. Wird die Seite neu geladen, geht die Tour pausiert weiter.
  - **Grenze:** Eine Web-App zeichnet nur auf, solange sie sichtbar ist. Die App hält deshalb den Bildschirm an
    (Screen Wake Lock), sofern der Browser das kann; sonst erscheint ein Hinweis.
- **Untere Leisten ziehen:** Planungsfeld und Unterwegs-Feld lassen sich am Griff oben größer oder kleiner ziehen
  (Höhe wird gespeichert). Alle unteren Leisten legen sich über Positions-Knopf, Maßstab und Quellenangabe,
  ohne sie zu verschieben.
- **Oberfläche:** leicht transparente „Glas“-Flächen mit Unschärfe, einheitlich über Design-Variablen in `styles.css`.
  Browser ohne Unschärfe-Unterstützung bekommen automatisch weniger durchsichtige Flächen.
- **Einstellungen:** Zoom-Knöpfe ein/aus (wird gespeichert), App-Version, Link zur Diagnose.
- Positions-Knopf (unten rechts): Die Karte folgt der Position (Knopf blau). Im Folgemodus wird um die eigene
  Position gezoomt. Verschieben der Karte oder Zoomen auf einen GPX-Track beendet das Folgen, ein Tipp auf den
  Knopf zentriert wieder.
- Kartenwahl (im Menü): Topografische Karte NRW (DTK), Luftbild NRW (DOP) oder OpenStreetMap.
- Die zuletzt gewählte Karte und der Ausschnitt werden auf dem Gerät gespeichert.
- Maßstabsleiste unten links.
- **Wanderwege ein-/ausblenden** (Kartenwahl oben rechts, Abschnitt mit Häkchen):
  - *Wanderwege NRW (amtlich, TFIS)*: Touristik- und Freizeitinformationssystem von Geobasis NRW
    (`https://www.wms.nrw.de/geobasis/wms_nw_tfis`). Die Wegedaten liefern laut Geobasis NRW die
    Wandervereine über den Landeswanderverband NRW zu, mindestens jährlich.
  - *Wanderwege OSM (Waymarked Trails)*: Daten aus OpenStreetMap, nicht amtlich. Zum Vergleich.
  - Der Ein/Aus-Zustand wird gespeichert.
- **Wege antippen** (bei eingeschalteter Ebene „Wanderwege NRW (amtlich, TFIS)“): Ein Infofenster zeigt die
  Sachdaten, die der TFIS-Dienst für die Stelle liefert (WMS GetFeatureInfo, GML 3.2.1). Zuerst wird mit
  großzügiger Fangtoleranz abgefragt, bei leerem Ergebnis noch einmal genau. Über „Original-Antwort des
  Servers öffnen“ lässt sich die unverarbeitete Antwort ansehen.
- **OSM-Wege antippen** (bei eingeschalteter Ebene „Wanderwege OSM“): Die App fragt die API von
  Waymarked Trails ab (`https://hiking.waymarkedtrails.org/api/v1`, Endpunkte laut Quelltext von
  github.com/waymarkedtrails/waymarkedtrails-api):
  - `list/by_area` liefert die Routen im Umkreis von etwa 24 Bildschirmpixeln (bbox in EPSG:3857).
  - `details/relation/{id}` liefert je Route Betreuer, Länge und alle OSM-Angaben.
  - `symbols/id/{id}.svg` liefert das Wegzeichen als Bild.

  Schlägt die Abfrage fehl, fragt die App die Overpass-API (zwei Server). Sind beide Wege-Ebenen an,
  zeigt das Infofenster beide Quellen getrennt.
- **Infofenster:** Es erscheint nur, wenn an der Tippstelle Wege gefunden wurden. Während der Suche pulsiert ein
  oranger Kreis an der Tippstelle. Das Fenster sitzt fest im unteren Drittel über die volle Breite und ist scrollbar. Es liegt
  über Positions-Knopf und Quellenangabe.
  Tippen ins Leere schließt es. Durch Ziehen am Kopf wird es größer oder kleiner; ganz nach unten gezogen
  schließt es. Die Höhe wird gespeichert. Jede Abfrage hat ein Zeitlimit (10–12 s).
- **Größe der Wegemarkierungen** (Knopf unter der Kartenwahl): Regler von 100 bis 300 %, wird gespeichert.
  - TFIS (WMS): stufenlos. Für dieselbe Fläche wird ein kleineres Bild angefordert und vergrößert angezeigt.
    Dadurch wird es etwas unschärfer. Möglicherweise blendet der Server dann Inhalte aus, die er nur bei
    feineren Maßstäben zeigt.
  - OSM (Waymarked Trails): nur 100/200/400 %. Es werden Kacheln einer gröberen Zoomstufe vergrößert angezeigt.
- **GPX-Tracks** (Reiter *GPX* auf der Seite *Tracks*):
  - Eine oder mehrere GPX-Dateien importieren. Gelesen werden Tracks, Routen und Wegpunkte.
  - Gespeichert wird die Original-Datei lokal im Browser (IndexedDB), sie ist auch nach einem Neustart
    wieder da. Je Track: ein-/ausblenden (Zustand wird gespeichert), hinzoomen, GPX herunterladen, löschen.
  - Angezeigt werden Länge, Anstieg (aus den Höhenwerten der Datei, daher nur „ca.“) und die Zahl der Wegpunkte.
  - Antippen eines Wegpunkts zeigt Name und Beschreibung. Die Tracklinien reagieren nicht auf Antippen, damit
    das Antippen von Wanderwegen weiter funktioniert.
  - Die Daten liegen nur auf diesem Gerät und in diesem Browser. Bei Speichermangel kann der Browser sie
    löschen. Die App bittet deshalb um dauerhaften Speicher (`navigator.storage.persist`).
- **TFIS-Infos:** Der Wegname ist die Überschrift, die Felder haben deutsche Bezeichnungen (Kategorie, Verein,
  Verlauf, Länge, Streckenvariante, Signaturnummer, Schlüssel).
  Wegzeichen: Das offizielle TFIS-Paket von Geobasis NRW (OpenGeodata.NRW, dl-de/zero-2.0) enthält die
  Wegzeichen als SVG, benannt nach Signaturnummer. Der Deploy-Workflow lädt sie bei jedem Veröffentlichen und
  einmal im Monat nach `symbols/tfis/<Signaturnummer>.svg`. Die App zeigt das passende Zeichen im Infofenster.
- Die App lässt sich zum Startbildschirm hinzufügen. Die App-Hülle funktioniert dann auch offline, die Kartenkacheln **noch nicht**.

## Hinweis zum lokalen Speicher

Ändert sich die Datenbank-Version (zuletzt auf 3), müssen andere offene Tabs mit einer älteren App-Version
geschlossen werden – sonst blockiert der Browser die Umstellung. Die App meldet das jetzt, statt still zu hängen,
und gibt die Datenbank ab dieser Version selbst frei, wenn eine neuere Version sie anfordert.

## Kartendienste und Lizenz

Routing und Suche (ohne API-Schlüssel; die Dienste sind kostenlos, aber nur für maßvolle Nutzung gedacht):

| Zweck | Dienst | Geprüft |
|---|---|---|
| Routing Wandern | BRouter `https://brouter.de/brouter` (`lonlats`, `profile=hiking-mountain`, `format=geojson`) | Parameter, Antwortformat und CORS im Quelltext github.com/abrensch/brouter |
| Routing Fußweg | OSRM der FOSSGIS `https://routing.openstreetmap.de/routed-foot/route/v1/driving/…` | so von openstreetmap.org verwendet (Quelltext openstreetmap-website) |
| Adresssuche | Nominatim `https://nominatim.openstreetmap.org/search` | Standard-API; nur auf Knopfdruck, max. 1 Anfrage/s |

| Karte | Dienst | Lizenz |
|---|---|---|
| DTK NRW | `https://www.wms.nrw.de/geobasis/wms_nw_dtk` (WMS) | Datenlizenz Deutschland – Zero 2.0 |
| DOP NRW | `https://www.wms.nrw.de/geobasis/wms_nw_dop` (WMS) | Datenlizenz Deutschland – Zero 2.0 |
| OSM | `tile.openstreetmap.org` | ODbL, Namensnennung erforderlich |

Laut Metadaten gilt für die BKG-Maßstäbe DTK250/DTK500 stattdessen
„Datenlizenz Deutschland – Namensnennung 2.0“.

**Geprüft (02.11.2026, per `?diagnose`):** Die Layer-Namen `nw_dtk_col`, `nw_dop_rgb` und `nw_tfis` sind korrekt.
Alle drei Dienste unterstützen EPSG:3857 und erlauben Abfragen aus dem Browser (CORS). Der TFIS-Dienst
hat nur die eine Ebene `nw_tfis` und ist abfragbar (GetFeatureInfo). Die App prüft die Namen bei jedem Start
weiter und weicht auf einen vorhandenen Layer aus, falls einer verschwindet.

**Diagnose:** Die App mit `?diagnose` aufrufen (https://carstenkeller.github.io/goahead/?diagnose).
Sie zeigt dann je Dienst, ob die Capabilities lesbar waren, welche Layer es gibt und welche verwendet werden.

## Starten / Hosten

Die Standortabfrage funktioniert im Browser nur über **HTTPS** (Ausnahme: `localhost`).

Lokal am Rechner:

```sh
python3 -m http.server 8000
# dann http://localhost:8000 öffnen
```

Auf dem Handy: **https://carstenkeller.github.io/goahead/**

Die Seite wird per GitHub Actions (`.github/workflows/pages.yml`) bei jedem Push auf `main`
oder den Entwicklungs-Branch veröffentlicht. Es gibt keinen Build-Schritt: Die Dateien werden
so ausgeliefert, wie sie im Repository liegen.

Einmalig nötig: unter *Settings → Pages → Build and deployment → Source* die Option **GitHub Actions** wählen.

## Dateien

- `CLAUDE.md`: Arbeitsregeln für Änderungen (UI-Grundregeln, Versionen, Speicher, Tests)
- `index.html`, `styles.css`, `app.js`: die App
- `tracks.js`: Seite *Tracks*, GPX-Import, lokale Speicherung, Track-Liste
- `planner.js`: Route planen (Routing, Suche, Planungsfeld), Liste *Geplant*, GPX-Export
- `nav.js`: Unterwegs-Modus, Aufzeichnung, Liste *Erwandert*
- `config.js`: Kartendienste, Startansicht, Zoomstufe
- `sw.js`, `manifest.webmanifest`, `icons/`: PWA (installierbar, App-Hülle offline)
- `vendor/leaflet/`: Leaflet 1.9.4 (BSD-2-Clause), lokal eingebunden
