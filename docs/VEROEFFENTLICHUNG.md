# GoAhead – Grundlagen für Veröffentlichung und Vermarktung

Einstieg für die Planung von Veröffentlichung und Kommerzialisierung (eigener Chat, getrennt von der
Weiterentwicklung). Funktionaler Stand und Entscheidungen: [`PROJEKT.md`](PROJEKT.md), Funktionsliste und
Kartendienste: [`../README.md`](../README.md). Stand: 7.11.2026, App-Version 60.

**Kennzeichnung:** *belegt* = im Repository nachvollziehbar (Code, Prüf-Workflow, Capabilities). *ungeprüft* = aus
allgemeinem Wissen, vor jeder Entscheidung an der Originalquelle (Nutzungsbedingungen, Gesetz, Anbieter) prüfen.
Rechtliche Fragen (Lizenzen, Marke, Datenschutz, Haftung) sind keine Rechtsberatung – ggf. Fachleute fragen.

---

## 1. Was GoAhead ist (Kurzprofil)

- **Zielgruppe heute:** ein ehrenamtlicher **Wegemarkierer** (Eggegebirgsverein e.V., NRW, „Wabe 902“), dazu
  Wandern allgemein. Zweitnutzerin: Partnerin mit iPhone (Begleiten aus der Ferne).
- **Kern-Nutzen:**
  1. Amtliche Wanderkarten und Wanderwege NRW (Geobasis NRW, TFIS) auf dem Handy, Wege antippen → Wegzeichen.
  2. **Markierungsebenen** (Alleinstellungsmerkmal): Wegzeichen der eigenen Wabe hinterlegen (amtliche
     TFIS-Wegzeichen oder eigene Fotos), unterwegs Markierungen fotografieren und mit Zustand (gut / erneuern /
     fehlt) an der GPS-Position erfassen, filtern, zählen, **PDF-Bericht (A4)** erzeugen.
  3. Touren planen (BRouter/OSRM, Rundtour nach Länge), unterwegs aufzeichnen mit Vibration vor Abbiegungen,
     Offline-Karten entlang der Route, Touren verwalten (Import u. a. aus komoot-GPX), teilen/begleiten ohne Server.
- **Form:** Web-App (PWA) + kleine Android-App (WebView-Hülle mit Hintergrund-Aufzeichnung). Kein Server, kein Konto,
  alle Daten bleiben auf dem Gerät. Sprachen Deutsch/Englisch, hell/dunkel.
- **Geplant (Schritt 2):** automatische Erkennung des Wegzeichens im Foto (Vorschlag mit Bestätigung) – noch nicht
  gebaut, Machbarkeit auf dem Gerät **ungeprüft**.

## 2. Technik und Betrieb (belegt)

| Thema | Stand |
|---|---|
| Hosting | GitHub Pages, https://carstenkeller.github.io/goahead/ , Veröffentlichung per GitHub Actions (`.github/workflows/pages.yml`) bei jedem Push auf `main` oder den Entwicklungs-Branch |
| Repository | `github.com/CarstenKeller/goahead`, **öffentlich**, **keine Lizenzdatei** (siehe 4.) |
| Server/Backend | keines. Daten in IndexedDB/localStorage des Geräts; Sicherung als JSON-Datei (Einstellungen → Daten) |
| Web-Technik | HTML/CSS/JavaScript ohne Build-Schritt, Leaflet 1.9.4 (BSD-2-Clause) lokal in `vendor/` |
| Android-App | `applicationId de.goahead.app`, minSdk 29, targetSdk 34, Kotlin, Build nur in GitHub Actions; APK unter `…/goahead/app/goahead.apk` (nicht im Play Store). Signaturschlüssel verschlüsselt im Repo (`android/goahead-keystore.jks.enc`), Passwort nur im GitHub-Secret `GOAHEAD_KEYSTORE_PASSWORD` – **Schlüssel und applicationId nie ändern** (sonst keine Updates) |
| Android-Berechtigungen | Internet, Netzwerkstatus, genauer/ungefährer Standort, Vordergrunddienst (Standort), Benachrichtigungen, Wake-Lock, Vibration, Ausnahme von der Akku-Optimierung |
| iOS | keine App; die Web-App läuft in Safari (Hintergrund-Aufzeichnung dort nicht möglich) |
| Kosten heute | keine (GitHub kostenlos, alle Dienste ohne Schlüssel) |

## 3. Abhängigkeiten von Diensten Dritter

GoAhead ruft alle Dienste **direkt vom Gerät** auf, ohne Schlüssel und ohne eigenen Server. Für eine Veröffentlichung
mit vielen Nutzern oder eine kommerzielle Nutzung ist das der wichtigste Prüfpunkt.

### 3.1 Karten und Daten (Lizenzen belegt per Capabilities/Prüf-Workflow 2.–3.11.2026, siehe README)

| Dienst | Zweck | Lizenz (Repo) | Für Vermarktung zu prüfen |
|---|---|---|---|
| Geobasis NRW: DTK, DOP, **TFIS** (WMS `wms.nrw.de`, GeoPackage auf `opendata.nrw.de`) | Wanderkarte, Luftbild, Wanderwege, Wegzeichen-SVGs, Wegeverzeichnis | dl-de/zero-2.0 | Zero-Lizenz erlaubt nach Wortlaut auch kommerzielle Nutzung (*ungeprüft im Detail*); Last-/Fair-Use-Regeln der Server *ungeprüft* |
| BKG TopPlusOpen | Wanderkarte DE außerhalb NRW | dl-de/by-2.0 | Namensnennung Pflicht (vorhanden) |
| basemap.at | Österreich | CC BY 4.0 | Namensnennung (vorhanden) |
| DOP anderer Länder (12) | Luftbild | je Land: CC BY 4.0, dl-de/by-2.0, § 18 HVGG …; **Sachsen-Anhalt ungeprüft**, Saarland/Sachsen nur laut OSM-Wiki | einzeln bestätigen |
| OpenTopoMap | Rückfall weltweit | CC-BY-SA | kleiner, ehrenamtlicher Server – Massennutzung durch eine App *ungeprüft/kritisch* |
| OpenStreetMap-Kacheln `tile.openstreetmap.org` | Kartenwahl „OpenStreetMap“ | ODbL (Daten), Namensnennung | OSM Tile Usage Policy (*ungeprüft*): keine starke Nutzung durch Apps, kann blockieren → für Vermarktung eigenen/kommerziellen Kachelanbieter einplanen |
| Esri World Imagery | Luftbild-Rückfall | **Nutzungsbedingungen ungeprüft** | vermutlich Konto/Lizenz für kommerzielle Nutzung nötig (*ungeprüft*) – ggf. entfernen |
| Waymarked Trails (Kacheln + API) | Wanderwege OSM | CC BY-SA (Kacheln) | Nutzungsbedingungen/Last *ungeprüft* |
| Overpass API (`overpass-api.de`, `overpass.private.coffee`) | OSM-Wege antippen | – | Fair-Use (*ungeprüft*) |
| Natural Earth | Ländergrenzen für das Kartenmosaik | gemeinfrei | – |

### 3.2 Routing und Suche (belegt: Endpunkte/Parameter; Nutzungsbedingungen ungeprüft)

| Dienst | Zweck | Hinweis |
|---|---|---|
| BRouter `brouter.de` | Routing Wandern, Rundtour | öffentlicher Server eines Einzelnen; für viele Nutzer eigenen BRouter betreiben (Open Source) |
| OSRM der FOSSGIS `routing.openstreetmap.de` | Routing Fußweg | FOSSGIS-Bedingungen *ungeprüft* |
| Nominatim `nominatim.openstreetmap.org` | Adresssuche | Usage Policy (*ungeprüft*): max. 1 Anfrage/s, aussagekräftige Kennung; für Apps mit vielen Nutzern eigener/kommerzieller Geocoder |

### 3.3 Software-Bestandteile (belegt)

- Leaflet 1.9.4 – BSD-2-Clause (Lizenz in `vendor/leaflet/LICENSE`)
- Tabler Icons (einige Symbole) – MIT
- Lizenz-/Quellenhinweise erscheinen in der App als Kartenquellenangabe; ein Impressum/„Lizenzen“-Bildschirm fehlt.

## 4. Rechtliche und organisatorische Punkte (offen)

1. **Lizenz des eigenen Codes:** Das Repo ist öffentlich, hat aber **keine LICENSE-Datei** (= „alle Rechte
   vorbehalten“, der Code ist aber für jeden sichtbar). Entscheiden: Open Source (welche Lizenz?) oder
   proprietär (Repo privat stellen – ob GitHub Pages dann im gewählten Tarif weiter geht, *ungeprüft*).
2. **Hosting-Bedingungen:** GitHub Pages ist laut GitHub-Richtlinien (*ungeprüft*) nicht für kommerzielle
   Online-Geschäfte/SaaS gedacht → bei Vermarktung eigenes Hosting/Domain planen.
3. **Name/Marke „GoAhead“:** nicht geprüft. Es gibt bekannte Software gleichen Namens (u. a. einen Embedded-Webserver,
   *aus allgemeinem Wissen, ungeprüft*) → DPMA/EUIPO-Recherche, ggf. Namensänderung **vor** Store-Einträgen
   (die applicationId `de.goahead.app` ist unabhängig vom Anzeigenamen, aber nicht änderbar).
4. **Datenschutz (DSGVO):** GoAhead selbst speichert nichts auf Servern. Aber: Jede Kachel-, Routing- und Suchanfrage
   geht direkt an Dritte (IP-Adresse, Kartenausschnitt ≈ Aufenthaltsort). Fotos/Touren/Ebenen bleiben lokal.
   Geteilte Links (`#g=…`) tragen die Daten im Fragment (wird nicht an den Server übertragen – technischer Fakt
   des Browsers). → Datenschutzerklärung nötig (Pflicht u. a. für Store-Einträge, *ungeprüft im Detail*).
5. **Impressum:** für ein öffentliches Angebot in Deutschland vermutlich Pflicht (*ungeprüft*); fehlt bisher.
6. **Haftung/Gewähr:** Routing, Offline-Karten, Wegzustände – Hinweis „ohne Gewähr“ fehlt bisher.
7. **App-Stores:**
   - Google Play (*ungeprüft*): Entwicklerkonto, Datenschutzerklärung, Erklärung zur Standortnutzung im Hintergrund
     und zum Vordergrunddienst, Ziel-API-Level-Vorgaben (targetSdk ist 34 – aktuelle Vorgabe prüfen).
   - Apple App Store: eine reine WebView-Hülle wird laut Apple-Richtlinien oft abgelehnt (*ungeprüft*); für iOS wäre
     eine eigene App mit echtem Mehrwert (Hintergrund-GPS) nötig.
8. **Abhängigkeit von NRW-Daten:** Kernnutzen (TFIS-Wanderwege, Wegzeichen) gibt es so nur in NRW. Andere
   Bundesländer haben eigene Systeme (*ungeprüft*, wie offen) – wichtig für die Marktgröße.

## 5. Mögliche Zielgruppen (Annahmen, nicht geprüft)

- Wegemarkierer und Wegewarte der Wander- und Gebirgsvereine (in NRW u. a. Eggegebirgsverein, Sauerländischer
  Gebirgsverein, Teutoburger-Wald-Verband – Namen aus den TFIS-Daten belegt; Anzahl der Markierer **unbekannt**).
- Vereine/Verbände als Organisation (Zustandsberichte je Wabe, PDF), ggf. Kommunen/Touristik.
- Wanderer allgemein (Konkurrenz: komoot, Outdooractive u. a. – Vergleich nicht erstellt).
- Für Organisationen fehlt heute: Teilen von Ebenen zwischen mehreren Markierern, zentrale Übersicht (bräuchte
  einen Server – Gegensatz zum heutigen „ohne Server“-Prinzip).

## 6. Was für eine Vermarktung technisch fehlt (Überblick)

- Eigene Domain + Hosting, eigene bzw. bezahlte Kachel-/Routing-/Suchdienste oder Absprachen mit den Betreibern.
- Impressum, Datenschutzerklärung, Lizenz-/Quellen-Seite in der App, Haftungshinweis.
- Store-fähige Android-App (Play-Konto, Store-Texte, Screenshots, Datenschutz-Formular), ggf. iOS-App.
- Ggf. Server für Konten/Teilen (Vereine), Bezahlung (Abo/Einmalkauf/Vereinslizenz) – Modell offen.
- Automatische Wegzeichen-Erkennung (Schritt 2) als möglicher Mehrwert – Machbarkeit offen.
- Tests auf mehr Geräten (bisher: ein Samsung-Android, Chromium-Tests mit nachgebildeten Diensten).

## 7. Offene Fragen an den Nutzer (für den Vermarktungs-Chat)

- Ziel: Verein unterstützen (kostenlos, gemeinnützig) oder Einkommen? Wer wäre Anbieter (Privatperson, Verein, Firma)?
- Nur NRW oder bundesweit? Nur Markierer oder auch Wanderer allgemein?
- Open Source oder geschlossen? Bleibt „ohne Server“ ein Grundsatz?
- Bereitschaft für laufende Kosten (Kacheln, Hosting, Store-Gebühren)?
