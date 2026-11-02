# GoAhead – Wanderkarte für Wegemarkierer

Web-App (PWA) für Android und iOS. Sie zeigt die eigene Position auf den Karten von
**Geobasis NRW**, also auf denselben Diensten, die auch TIM-online nutzt.

## Stand (Schritt 1)

- Beim Start wird die GPS-Position gesucht und die Karte auf sie zentriert (Zoomstufe 16).
- Gesten: mit einem Finger verschieben, mit zwei Fingern zoomen, doppelt tippen zum Vergrößern. Zusätzlich gibt es +/−-Knöpfe.
- Positions-Knopf (unten rechts): Die Karte folgt der Position (Knopf blau). Wer die Karte von Hand verschiebt, beendet das Folgen. Ein Tipp auf den Knopf zentriert wieder.
- Kartenwahl (oben rechts): Topografische Karte NRW (DTK), Luftbild NRW (DOP) oder OpenStreetMap.
- Die zuletzt gewählte Karte und der Ausschnitt werden auf dem Gerät gespeichert.
- Maßstabsleiste unten links.
- Die App lässt sich zum Startbildschirm hinzufügen. Die App-Hülle funktioniert dann auch offline, die Kartenkacheln **noch nicht**.

## Kartendienste und Lizenz

| Karte | Dienst | Lizenz |
|---|---|---|
| DTK NRW | `https://www.wms.nrw.de/geobasis/wms_nw_dtk` (WMS) | Datenlizenz Deutschland – Zero 2.0 |
| DOP NRW | `https://www.wms.nrw.de/geobasis/wms_nw_dop` (WMS) | Datenlizenz Deutschland – Zero 2.0 |
| OSM | `tile.openstreetmap.org` | ODbL, Namensnennung erforderlich |

Laut Metadaten gilt für die BKG-Maßstäbe DTK250/DTK500 stattdessen
„Datenlizenz Deutschland – Namensnennung 2.0“.

**Offen bzw. ungeprüft:** Die Layer-Namen `nw_dtk_col` und `nw_dop_rgb` sowie die Unterstützung
von EPSG:3857 konnten während der Entwicklung nicht gegen die GetCapabilities geprüft werden.
Die Entwicklungsumgebung hatte keinen Netzzugang zu `*.nrw.de`. Deshalb fragt die App beim
Start die Capabilities ab. Fehlt der eingetragene Layer, weicht sie auf einen passenden Layer aus.
Das klappt aber nur, wenn der Dienst CORS erlaubt. Die Ergebnisse stehen in der Browser-Konsole.
Bleibt die DTK grau, die Layer-Namen in `config.js` prüfen.

## Starten / Hosten

Die Standortabfrage funktioniert im Browser nur über **HTTPS** (Ausnahme: `localhost`).

Lokal am Rechner:

```sh
python3 -m http.server 8000
# dann http://localhost:8000 öffnen
```

Zum Testen auf dem Handy die Dateien über einen HTTPS-Host ausliefern, z. B. GitHub Pages.
Es gibt keinen Build-Schritt: Die Dateien werden so ausgeliefert, wie sie im Repository liegen.

## Dateien

- `index.html`, `styles.css`, `app.js`: die App
- `config.js`: Kartendienste, Startansicht, Zoomstufe
- `sw.js`, `manifest.webmanifest`, `icons/`: PWA (installierbar, App-Hülle offline)
- `vendor/leaflet/`: Leaflet 1.9.4 (BSD-2-Clause), lokal eingebunden
