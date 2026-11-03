# GoAhead für Android

Kleine Android-App (Kotlin), die die Web-App https://carstenkeller.github.io/goahead/
bildschirmfüllend zeigt und **auch bei ausgeschaltetem Bildschirm aufzeichnet**.

## Wie es funktioniert

- `MainActivity.kt`: WebView mit der Web-App; Standort-Erlaubnis, Dateiauswahl (alle Dateitypen,
  mehrere Dateien), Speichern in „Downloads“, Teilen echter `.gpx`-Dateien.
  Die Web-App erkennt die App an `window.GoAheadNative`.
- `TrackingService.kt`: Vordergrunddienst vom Typ `location` mit Benachrichtigung „GoAhead – Aufnahme läuft“.
  GPS alle 2 s, Punkte ungenauer als 50 m oder näher als 5 m am letzten werden verworfen (wie in `nav.js`).
  Vibriert vor Abbiegungen (Luftlinie zur Abbiegung ≤ eingestellter Abstand – eine Näherung;
  die Web-App rechnet entlang der Route).
- `TrackStore.kt`: hängt jeden Punkt sofort an `track.jsonl` im App-Speicher an. Die Web-App holt die
  Punkte beim Einschalten des Bildschirms und alle 3 s (solange sichtbar) ab. Beim Beenden der Tour wird die Datei geleert.

Gestartet wird der Dienst nur aus der sichtbaren App („Los geht's“, „Weiter“). Dafür genügt die
Standort-Erlaubnis „Während der Nutzung der App“; „Immer erlauben“ ist nicht nötig
(Android-Regeln für Vordergrunddienste mit Standort, Stand Android 14).

## Daten

IndexedDB und Einstellungen liegen im Speicher der WebView der App, **getrennt von Chrome**.
Umzug: in Chrome *Einstellungen → Daten → Sichern*, in der App *Wiederherstellen*.
Beim Deinstallieren der App sind die Daten weg – vorher sichern.

## Samsung: Akku

Samsung beendet „optimierte“ Apps im Hintergrund. In der App: *Einstellungen → Android-App → Akku-Knopf*:
1. „Akku-Optimierung ausschalten“ (Systemdialog),
2. „App-Info öffnen“ → *Akku* → **Nicht eingeschränkt**,
3. zusätzlich unter *Einstellungen → Akku → Grenzen der Hintergrundnutzung* GoAhead nicht in
   „Schlafende Apps“/„Tief schlafende Apps“ führen.

Menübezeichnungen nach Samsung-/Fachseiten (One UI 6), **auf dem Gerät nicht geprüft** – sie können je nach Version abweichen.

## Bauen und installieren

Gebaut wird im GitHub-Actions-Lauf `.github/workflows/pages.yml` (Job `android`; lokal fehlt das Android-SDK).
Die signierte APK liegt danach unter **https://carstenkeller.github.io/goahead/app/goahead.apk**.
Installation: Link auf dem Handy öffnen, Installation aus dieser Quelle erlauben.

Signatur: `goahead-keystore.p12.enc` ist der mit AES-256 (openssl, PBKDF2) verschlüsselte Schlüssel.
Das Passwort steht nur im Repository-Secret `GOAHEAD_KEYSTORE_PASSWORD`
(*Settings → Secrets and variables → Actions → New repository secret*). Ohne Secret entsteht nur ein
Probe-Build, keine APK. Der Schlüssel muss gleich bleiben, sonst lassen sich Updates nicht über die
installierte App installieren.

Versionen: Android Gradle Plugin 8.5.2, Gradle 8.7, Kotlin 1.9.24, compileSdk/targetSdk 34, minSdk 29 (Android 10).
