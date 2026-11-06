# GoAhead – Wanderkarte für Wegemarkierer

Web-App (PWA) für Android und iOS. Sie zeigt die eigene Position auf den Karten von
**Geobasis NRW**, also auf denselben Diensten, die auch TIM-online nutzt.

## Stand (Schritt 1)

- Beim Start wird die GPS-Position gesucht und die Karte auf sie zentriert (Zoomstufe 16).
- Gesten: mit einem Finger verschieben, mit zwei Fingern zoomen, doppelt tippen zum Vergrößern. Die +/−-Knöpfe
  lassen sich in den Einstellungen einblenden (Standard: aus).
- **Menü** (☰ oben rechts): Eine Leiste mit den Funktionsknöpfen fährt von rechts ein: Karten,
  Tracks, Route planen, Aufnahme, Einstellungen. Ein Tipp auf die Karte schließt das Menü.
- **Route planen** (Knopf mit Routen-Symbol im Menü), Modul `planner.js`:
  - Im Planungsmodus bleibt im Menü nur die Kartenwahl. Unten erscheint ein kompaktes Feld: Kopfzeile mit Name,
    Kennzahlen (Punkte, Länge, Anstieg; Vorschlag in Orange) und *Beenden*; darunter Symbolknöpfe
    *Speichern*, *Rückgängig*, *Wiederholen*, *S* (zum Startpunkt), *Rundtour* und *Suche*. Das Routing wird in den
    Einstellungen gewählt; bei BRouter erscheint das Höhenprofil automatisch. Langer Druck auf einen Knopf zeigt seine Beschreibung – oben mittig wie die
    Statusmeldung, solange der Finger liegt; beim Loslassen wird der Knopf nicht ausgelöst.
  - **Auf der Karte:**
    - Tipp auf die Karte: Vorschlagspunkt mit vorgeschlagener Strecke (orange, gestrichelt).
      Nochmal auf den Vorschlagspunkt tippen: einrasten.
    - Routenpunkt: 1. Tipp markiert ihn (blau). Dann Tipp auf die Karte oder Punkt ziehen → Ersatzvorschlag mit
      neuen Anschlussstrecken; Tipp darauf übernimmt ihn. 2. Tipp: Löschmodus (rot, „−“). 3. Tipp: löschen
      (Vorgänger und Nachfolger werden neu verbunden). Tipp daneben bricht den Löschmodus ab.
    - Strecke zwischen zwei Punkten: Tipp fügt dort einen **vorläufigen** Zwischenpunkt ein (orange „+“).
      Tipp auf ihn übernimmt ihn, Ziehen verschiebt ihn (mit Vorschlag der neuen Strecken). Ein Tipp woanders
      (Karte, Strecke, anderer Punkt) gilt als Versehen und nimmt ihn wieder weg – ohne Spur im Rückgängig-Verlauf.
      Doppeltipp wechselt zwischen *Weg* (Routing) und *direkt* (gerade Linie, gestrichelt, mit ihrer Länge
      in der Gesamtstrecke). Gilt auch für den Rückweg einer Rundtour.
  - **Rundtour nach Länge:** *Rundtour* bei leerer Planung (oder nur einem Punkt) fragt nach der Länge in km;
    danach Startpunkt auf der Karte antippen (ein vorhandener Punkt dient als Start). BRouter berechnet eine Runde
    (`engineMode=4`, geprüft im Quelltext abrensch/brouter und per Workflow „BRouter-Rundtour prüfen“ gegen
    brouter.de). `roundTripDistance` ist dort der Radius des Kreises, auf dem BRouter Wegpunkte setzt; die Länge
    war im Test das 5,4- bis 8,9-Fache.
    - BRouter vermeidet doppelte Wege nicht sicher. GoAhead schneidet daher Stichwege heraus (auf demselben Weg hin
      und zurück: Hin- und Rückweg spiegelbildlich höchstens 20 m auseinander) und misst je Runde den Anteil doppelt
      gegangener Strecke (alle 10 m abgetastet; doppelt = ein anderer Teil der Runde näher als 15 m).
    - Ein „Stiel“ am Start (Anfang und Ende auf demselben Weg, z. B. Start in einer Sackgasse) wird akzeptiert,
      wenn keine Richtung ohne ihn auskommt.
    - Suche ohne Rückfrage: 6 Richtungen; ohne passende Runde 6 weitere, danach größere Radien (×1,6, ×2,5), bis
      eine Runde innerhalb der Toleranz *Planen → Rundtour: doppelte Wege erlaubt bis … %* (Standard 0 %) gefunden
      ist; dann bis zu 3 Nachbesserungen der Länge.
    - Auswahl: Länge ±6 % → am nächsten; sonst die nächstlängere (Standard) bzw. nächstkürzere (Einstellung
      *Rundtour, wenn die Länge nicht passt*). Weicht die Länge um mehr als *Rundtour: Warnung ab
      Längenabweichung* (Standard 20 %) ab, zeigt die Meldung „⚠ +… % Länge“.
    - Ergebnis: normale Planung mit Wegpunkten alle 1–3 km (verschieben, löschen, einfügen wie gewohnt), Rückweg als
      Rundtour-Abschnitt. Erneut *Rundtour*: *Andere Variante* (andere Richtungen), *Länge ändern*, *Als eigene
      Planung weiter*. Immer BRouter, auch wenn OSRM eingestellt ist (OSRM kennt keine Rundtour). Mit Punkten ≥ 2
      schließt/öffnet *Rundtour* wie bisher den Rückweg.
  - *Rückgängig/Wiederholen*: bis zu 20 Schritte (während der Sitzung).
  - Für alle vorläufigen (orangen) Punkte gilt: antippen = übernehmen, ziehen = verschieben, Tipp woanders = wegnehmen.
  - **Höhen und Dauer:** Kopfzeile zeigt Punkte, Länge, ↑/↓ Höhenmeter und ≈ Gehzeit. Bei BRouter-Routing erscheint
    automatisch ein Säulendiagramm (Farbe: Steigung/Ebene/Gefälle); Antippen/Ziehen darin zeigt Entfernung und Höhe und
    markiert die Stelle auf der Karte.
    - Höhen stammen aus BRouter (dritter Koordinatenwert, geprüft im Quelltext `FormatJson`). Abschnitte ohne Höhen
      (OSRM, direkte Linien) werden zwischen bekannten Höhen linear aufgefüllt. Höhenmeter zählen ab 3 m Änderung.
    - Gehzeit: Route im 25-m-Raster; je Schritt Steigung (> Schwelle), Gefälle (< −Schwelle) oder Ebene mit der
      jeweiligen Geschwindigkeit aus den **Einstellungen** (Startwerte als Annahme: 4,5 / 3,0 / 4,0 km/h, Schwelle 5 %).
  - Suche (Lupe blendet das Feld ein/aus, Eingabetaste sucht): Adresse (Nominatim/OpenStreetMap) oder Koordinaten: Dezimalgrad (`51.758, 9.030`, auch mit
    Dezimalkomma oder vertauscht) oder UTM Zone 32 wie in TIM-online (`32U 494000 5735000` oder `494000 5735000`).
    Koordinaten setzen direkt einen Vorschlagspunkt.
  - Findet kein Routing-Dienst einen Weg, wird die gerade Linie genommen und mit ⚠ markiert.
  - *Speichern* legt die Route unter *Tracks → Geplant* ab (neue Route: Name im Dialog; bearbeitete Route: wird
    überschrieben). Änderungen an einer gespeicherten Route wirken erst nach *Speichern*; ein roter Punkt hinter
    dem Namen zeigt ungespeicherte Änderungen. Der Arbeitsstand wird zusätzlich lokal gesichert.
  - Neue Route: Knopf *Route planen* im Menü; eine offene Planung beendet man mit × (*Speichern und beenden*,
    *Später weiterplanen* oder *Verwerfen*).
- **Tracks** (Knopf mit Linien-Symbol im Menü): eigene Seite mit den Reitern *GPX*, *Geplant*, *Erwandert*.
  - *Geplant*: gespeicherte Routen mit Länge, Anstieg, Punktzahl, Datum. Antippen öffnet ein Menü:
    *▶ Los geht's* (Unterwegs-Modus), *👁 Ansehen* (nur auf der Karte zeigen; Antippen der Linie öffnet das Menü),
    *✎ Verändern* (Planungsmodus), *⧉ Kopieren und neu planen* (Kopie als neue, ungespeicherte Planung – Vorlage für
    ähnliche Touren), *↗ Teilen*, *⬇ GPX exportieren*, *🗑 Löschen*. Ansehen, Verändern und Kopieren zoomen auf die Route.
    GPX-Export: Track mit der berechneten Linie (inkl. Rundtour-Rückweg) und Wegpunkte für die geplanten Punkte.
  - *Erwandert*: beendete Aufzeichnungen mit Länge, Zeit in Bewegung, Anstieg (aus GPS-Höhen, daher „ca.“), Datum.
    Antippen: auf der Karte zeigen/entfernen, GPX exportieren (Track mit Höhe und Zeit), löschen.
  - Gespeichert wird lokal (IndexedDB `goahead`, Version 3, Speicher `tracks`, `routes`, `walks`).
  - **Teilen** (geplante und erwanderte Touren, z. B. an WhatsApp über das Teilen-Menü des Systems): GPX-Datei mit
    Beschreibung (Länge, Höhenmeter, Gehzeit, Punkte) und Höhen, dazu derselbe Text als Nachricht.
    **Grenze:** Chrome erlaubt beim Teilen nur bestimmte Dateitypen, `.gpx` gehört nicht dazu (geprüft im
    Chromium-Quelltext `chrome/browser/webshare/share_service_impl.cc`). Dann bietet die App an, die Datei als
    `Name.gpx.txt` zu teilen (Empfänger entfernt „.txt“; GoAhead liest sie auch so) oder die GPX herunterzuladen
    und nur den Text zu teilen.
- **Aufnahme ohne Route** (roter Aufnahme-Knopf im Menü): spontane Tour aufzeichnen wie unterwegs, nur ohne
  Routenbezug (keine Restzeit/Abbiegungen). Beim Beenden fragt die App nach dem Namen.
- **Begleiten** (Modul `share.js`, ohne Server): Wer mitwandert, aber nicht aufzeichnet (z. B. iPhone mit der Web-App),
  sieht Karte, Route, eigene Position, km gewandert/verbleibend, Restzeit, Ankunft und Höhenprofil.
  - *Geplant → „Für Begleitung teilen“* schickt einen Text mit GoAhead-Link (Route vereinfacht auf 5 m, gepackt).
  - Empfang: Link antippen, oder – in der Web-App auf dem Home-Bildschirm des iPhones, die einen eigenen Speicher
    hat (Kenntnisstand, ungeprüft) – Nachricht kopieren und unter *Tracks → Geplant* (Knopf „Einfügen“ im Listenkopf) bzw. beim Begleiten „Einfügen“ tippen. Die Tour
    landet unter *Geplant*, dann „Begleiten“ (auch über das Menü einer geplanten Tour).
  - *Unterwegs → „Stand teilen“* (Knopf neben „S“) schickt den aktuellen Stand: Route (auch umgedreht), Start, km,
    Zeit in Bewegung und die gelaufene Spur. Beim Begleiten „Einfügen“ übernimmt ihn; danach zählt GoAhead die Strecke
    entlang der Route seit der Stelle des Stands dazu. Ohne Stand ist „km gewandert“ die Strecke entlang der Route.
  - Begleiten zeichnet nicht auf, hält den Bildschirm nicht an und speichert beim Beenden nichts.
  - Daten: JSON, deflate (`CompressionStream`, Safari ab 16.4), base64url im Link-Teil `#g=`; Linien als
    Polyline-Zeichenkette (Google-Verfahren, Höhe als dritter Wert).
- **Ebenen** (Knopf mit Wegzeichen-Schild im Menü), Modul `marks.js`: eigene Markierungsebenen, z. B. für die
  eigene Wabe. Seite *Ebenen*: neue Ebene anlegen, Ebenen ein-/ausblenden, umbenennen, löschen. Eine Ebene öffnen
  zeigt sie mit einer Leiste über der Karte:
  - **Wegzeichen hinterlegen:** amtliche TFIS-Wegzeichen über die Suche (Lupe): Name oder Bezeichnung des Weges
    („Eggeweg“, „E1“, „X“), davor optional die eigene Wegenummer des Vereins („01-0A0-00 Eggeweg“ – sie steht nicht
    in TFIS und wird beim Wegzeichen angezeigt), oder die Signaturnummer. Auch direkt aus dem Infofenster (Weg antippen,
    *+* neben dem Wegzeichen). Dazu eigene Bilder (Knopf mit Bild-Symbol). Das Wegeverzeichnis
    (`symbols/tfis/index.json`) erzeugt der Pages-Workflow aus dem TFIS-GeoPackage (`.github/scripts/tfis_index.py`,
    Tabelle `wanderwege`, Aufbau im Skript mit Prüfweg beschrieben).
  - **Erfassen:** Kamera in der Kopfzeile fotografiert die Markierung an der GPS-Position und legt eine Position an;
    danach das passende Wegzeichen antippen. Ist eine Position ausgewählt, ergänzt das nächste Foto dieselbe Stelle
    (mehrere Wegzeichen nacheinander). *+* erfasst ein Wegzeichen ohne Foto (z. B. wenn es fehlt).
  - **Position antippen:** Fotos, Wegzeichen in ihrer Reihenfolge (Pfeile ändern sie), Zustand je Wegzeichen
    (*gut*, *erneuern*, *fehlt*); die ausgewählte Position lässt sich auf der Karte verschieben (GPS ist im Wald oft
    einige Meter ungenau).
  - **Karte:** an jeder Position die Wegzeichen untereinander, Rahmen nach Zustand (grün, orange, rot gestrichelt);
    unter Zoomstufe 14 nur farbige Punkte. Die Ebenen stehen auch in der Kartenwahl.
  - **Filter** nach Wegzeichen und Zustand mit Anzahl der Positionen und Wegzeichen; je hinterlegtem Wegzeichen die
    Anzahl nach Zustand.
  - Gespeichert in IndexedDB (Speicher `marklayers`, Fotos im Speicher `photos`), in der Sicherung enthalten.
  - Noch offen (Schritt 2): automatische Erkennung des Wegzeichens im Foto als Vorschlag.
- **Fotos unterwegs** (Kamera-Knopf in der Kopfzeile von *Unterwegs*), Modul `photos.js`: Das Foto wird an der
  aktuellen Position der Tour zugeordnet und als Kamera-Marker auf der Karte gezeigt; Antippen zeigt das Bild
  (dort auch löschen). In der **Android-App** speichert die Kamera das Bild in voller Größe in der Galerie,
  Album „GoAhead“ (Ordner Pictures/GoAhead); GoAhead behält eine verkleinerte Kopie (max. 1600 px). Im **Browser**
  kann eine Web-App nicht in die Galerie speichern – dort liegt das Foto nur in GoAhead. Fotos sind Teil der Sicherung.
- **Unterwegs** (*Los geht's*), Module `nav.js` und `offline.js`:
  - Kopfzeile: Name mit Offline-Symbol, eine Zustandszeile (Abbiegung, neben der Route, GPS ungenau,
    Bildschirm anlassen, Aufnahme/Pause) und die Knöpfe *Pause/Weiter*, *S* (zum Startpunkt),
    *Position und Start zeigen*, *Position*, *Beenden*.
  - Kennzahlen: km gewandert, km verbleibend (entlang der Route), Ø km/h, Zeit unterwegs, Restzeit und Ankunft
    (nach den Gehgeschwindigkeiten aus den Einstellungen), aktuelle Geschwindigkeit, Höhe, geplante Länge/Gehzeit.
    Darunter das Höhenprofil mit der eigenen Position (bei Routen mit Höhen).
  - Position auf der Route: Projektion auf das 25-m-Raster, zuerst in der Nähe der letzten Stelle gesucht
    (Schleifen/Kreuzungen springen nicht). Mehr als 50 m daneben: Hinweis, keine Abbiegungs-Vibration.
  - **Vibration vor Abbiegungen** (Abstand in den Einstellungen, Standard 20 m): Abbiegungen werden beim Start aus
    der Routenform berechnet (Richtungswechsel > 35° über ±15 m). Links: zwei kurze, rechts: ein langer Impuls.
    Safari auf dem iPhone unterstützt keine Vibration (`navigator.vibrate`) – dort bleibt es still.
  - **Offline-Karten:** Beim Start werden die Kacheln aller sichtbaren Kartenebenen in den Zoomstufen 12–17 in
    einem Korridor um die Route gespeichert (Abstand in den Einstellungen, Standard 1 km). Ohne Empfang wird alle
    30 s und beim Wiederkehren des Netzes erneut versucht. Fertig: grünes Wolken-Symbol neben dem Namen
    (Tooltip: Anzahl Kacheln). Ebenen ohne CORS-Freigabe werden übersprungen und im Tooltip genannt. Der
    Service Worker liefert gespeicherte Kacheln auch ohne Netz. Nach dem Ende der Tour wird der Speicher freigegeben.
  - Zeigt die geplante Route, die eigene Position (Folgemodus) und die gewanderte Strecke (blau). Im Menü bleibt nur
    die Kartenwahl. Das Feld unten zeigt gewanderte Strecke, Zeit in Bewegung und Länge der Planung.
  - *⏸ Pause* / *▶ Weiter*: Während der Pause wird nichts aufgezeichnet; danach beginnt ein neues Teilstück.
    *◎ Position* zentriert wieder. *■ Beenden*: speichern unter *Erwandert*, weiterwandern oder verwerfen.
  - Aufgezeichnet werden Positionen mit höchstens 50 m Ungenauigkeit und mindestens 5 m Abstand.
  - Der Zwischenstand wird laufend lokal gesichert. Wird die Seite neu geladen, geht die Tour pausiert weiter.
  - **Grenze:** Eine Web-App zeichnet nur auf, solange sie sichtbar ist. Die App hält deshalb den Bildschirm an
    (Screen Wake Lock), sofern der Browser das kann; sonst erscheint ein Hinweis.
  - **Android-App** (`android/`, siehe [android/README.md](android/README.md)): zeigt GoAhead bildschirmfüllend und
    zeichnet über einen Vordergrunddienst **auch bei ausgeschaltetem Bildschirm** auf; vibriert dann auch vor
    Abbiegungen. Beim Einschalten holt die Web-App die Punkte ab. Ist die Akku-Optimierung noch an, erscheint
    „⚠ Akku-Optimierung an“ und beim Start ein Dialog zu den Akku-Einstellungen (Samsung).
    In der App werden GPX-Dateien als echte `.gpx` geteilt und Exporte unter „Downloads“ gespeichert.
    Download der APK: https://carstenkeller.github.io/goahead/app/goahead.apk
- **Erwandert → Ansehen:** Strecke auf der Karte und eine ziehbare Leiste mit Kennzahlen (km, Zeit in Bewegung,
  Ø km/h, ↑/↓ m, Höhenbereich, Start/Ende, Datum), Höhenprofil und Fotos. *Geplant → Ansehen* ebenso mit
  km, ↑/↓, Gehzeit und Profil. „⋯“ öffnet das Menü der Tour, „✕“ schließt und entfernt die Linie.
- **Listen *Geplant* und *Erwandert*:** oben Anzahl und Gesamt-km der angezeigten Touren, Filter nach Jahr
  und Namenssuche (Lupe).
- **Erwandert → Liste prüfen** (Knopf mit Haken; erst nach Einschalten unter *Einstellungen → Daten → Listenprüfung*): findet vermutlich *doppelte* Touren (gleicher Tag, Start auf
  ~100 m, Länge auf 200 m) und vermutlich *geplante* Touren, die beim Import unter „Erwandert“ gelandet sind
  (keine Zeitstempel, oder Zeiten ohne Pausen und ohne festen Aufnahmetakt – typisch für berechnete Zeiten einer
  Planung). Die Treffer werden erst angezeigt (mit Begründung), dann auf Wunsch gelöscht bzw. nach „Geplant“
  verschoben. Die Erkennung „geplant“ ist eine Heuristik, an echten komoot-Daten nicht geprüft. Einzelne Touren
  lassen sich auch über ihr Menü nach „Geplant“ verschieben. Eigene GoAhead-Aufnahmen gelten nie als geplant.
  Weitere Gruppen: *mit Fahrt am Ende* (siehe unten; „Alle kürzen“) und *Fahrzeug* (Ø schneller als „Rad bis“).
- **Art der Tour** (Symbole: Tabler Icons, MIT-Lizenz, github.com/tabler/tabler-icons) aus der Ø-Geschwindigkeit in Bewegung: Wandern bis 7, Laufen bis 11, Rad bis 32 km/h, darüber
  Fahrzeug (Grenzen nach Erfahrung des Nutzers, in den Einstellungen änderbar). Kleines Symbol vor dem Namen,
  „Ø … km/h“ in der Zeile, Filter „Alle Arten / Wandern / Laufen / Rad / Fahrzeug“.
- **Richtung automatisch umdrehen** (Einstellung „Richtung umdrehen nach … % der Strecke“, Standard 1 %, 0 = aus):
  Geht man zu Beginn einer Tour entlang der Route rückwärts – netto mehr als der eingestellte Anteil der Länge,
  mindestens 50 m –, dreht GoAhead die Tour um: Reihenfolge der Punkte, Abschnitte, Start, Abbiegungen, Profil und
  Kennzahlen; kurze Vibration und Meldung. Bei Rundtouren wird P0 → P1 … Pm → P0 zu P0 → Pm … P1 → P0. Ist man
  genauso weit vorwärts gegangen, gilt die Richtung als bestätigt und es wird nicht mehr geprüft. Gedreht wird nur
  die laufende Tour; die gespeicherte Planung bleibt unverändert.
- **Fahrt erkannt → automatisch beenden** (Einstellung „Automatisch beenden ab“, Standard 80 km/h): Liegt die
  Geschwindigkeit über mindestens drei 20-Sekunden-Fenster (Luftlinie, damit einzelne GPS-Ausreißer nicht zählen)
  über der Grenze, wird die Tour bis zu der Stelle gekürzt, an der man zuletzt höchstens Lauftempo hatte, und
  mit ⚠ gespeichert. In der Android-App prüft das die Web-App beim Abholen der Punkte, also spätestens, wenn der
  Bildschirm wieder an ist – gekürzt wird trotzdem an der richtigen Stelle.
- **Ende abschneiden** (Menü einer erwanderten Tour, „✂“): Schieberegler für den neuen Endpunkt oder die Linie auf der
  Karte antippen; vorgeschlagen ist der erkannte Einstieg ins Fahrzeug. Der abgeschnittene Teil wird grau gestrichelt
  gezeigt; „Kürzen“ speichert (Strecke, Zeit in Bewegung, Anstieg, Ende werden neu berechnet).
- **Planung beenden** (× im Planungsfeld): ohne ungespeicherte Änderungen wird das Feld geleert. Sonst Auswahl
  *Speichern und beenden*, *Später weiterplanen* (Entwurf bleibt, „Route planen“ setzt ihn fort) oder *Verwerfen*
  (Entwurf gelöscht; eine schon gespeicherte Route bleibt unverändert).
- **Untere Leisten ziehen:** Planungsfeld und Unterwegs-Feld lassen sich am Griff oben größer oder kleiner ziehen
  (Höhe wird gespeichert). Alle unteren Leisten legen sich über Positions-Knopf, Maßstab und Quellenangabe,
  ohne sie zu verschieben.
- **Oberfläche:** leicht transparente „Glas“-Flächen mit Unschärfe, einheitlich über Design-Variablen in `styles.css`.
  Browser ohne Unschärfe-Unterstützung bekommen automatisch weniger durchsichtige Flächen.
- **Richtungspfeile** auf geplanten Strecken (Planen, Ansehen, Unterwegs): kleine weiße Pfeile im Abstand von
  etwa 110 Bildpunkten, beim Zoomen neu verteilt.
- **Einstellungen** (Zahnrad im Menü): eigene Seite, nach Bereichen geordnet (App mit Sprache und
  Darstellung ganz oben, dann Karte, Planen, Unterwegs, Touren, Daten, Android-App) – Zoom-Knöpfe ein/aus,
  Routing beim Planen (BRouter, Standard, mit Höhen / OSRM), Gehgeschwindigkeit (Ebene, Steigung, Gefälle in km/h,
  Schwelle in %), Unterwegs: Offline-Abstand (km) und Vibrationsabstand (m), App-Version, Link zur Diagnose.
  Alles wird gespeichert.
- **Darstellung** (*Einstellungen → App*, ganz oben): *System-Modus* (Standard, folgt dem hellen/dunklen Modus des Telefons),
  *Hell* oder *Dunkel*. Dunkel färbt Leisten, Seiten, Dialoge und Kartenknöpfe um; die Karte selbst bleibt unverändert.
- **Sprache** (*Einstellungen → App*, ganz oben): Deutsch (Standard) oder English. Der Wechsel lädt die Seite neu (eine laufende
  Tour bleibt erhalten). Nicht übersetzt: Quellenangaben der Karten, die Diagnose-Seite und – in der Android-App – die
  Benachrichtigung des Aufnahme-Dienstes („GoAhead – Aufnahme läuft“). Namen von Touren/Routen, die beim Anlegen
  automatisch entstehen (z. B. „Route vom …“), bleiben in der Sprache, in der sie angelegt wurden.
- **Meldungen und Rückfragen** erscheinen im Stil der App (keine Browser-Dialoge) und ohne technische Angaben;
  technische Einzelheiten zu Kartenabfragen nur im Diagnose-Modus (Adresse mit `?diagnose`).
- **Sicherung** (Einstellungen → Daten): *Sichern* schreibt alle Tracks, geplanten Routen, erwanderten Touren und
  Einstellungen in eine JSON-Datei (`goahead-sicherung-JJJJ-MM-TT.json`; speichern oder teilen, z. B. an Google Drive).
  *Wiederherstellen* ergänzt: Einträge mit gleicher Kennung werden überschrieben, andere bleiben. Laufende Tour und
  Planungsentwurf des Geräts werden nicht überschrieben. So zieht man auch von Chrome in die Android-App um.
  In der Android-App zusätzlich: Akku-Zustand und Knopf zu den Akku-Einstellungen.
- **Untere Leisten** lassen sich bis auf ihre Kopfzeile zusammenschieben; der Positions-Knopf sitzt immer darüber.
- Positions-Knopf (unten rechts): Die Karte folgt der Position (Knopf blau). Im Folgemodus wird um die eigene
  Position gezoomt. Verschieben der Karte oder Zoomen auf einen GPX-Track beendet das Folgen, ein Tipp auf den
  Knopf zentriert wieder.
- Kartenwahl (Knopf „Karten“ im Menü, ziehbare Leiste): **Wanderkarte**, **Luftbild** (beide automatisch nach
  Gebiet) oder OpenStreetMap; darunter die Ebenen (Wanderwege NRW/OSM) zum Ein- und Ausblenden.
  - Die beiden automatischen Karten sind Mosaike (`mosaic.js`): An jeder Stelle erscheint die genaueste Karte,
    die dort gilt, an Landes- und Staatsgrenzen zugeschnitten (Grenzen in `regions.js`, Natural Earth, gemeinfrei,
    vereinfacht auf etwa 150 m – an Grenzen kann daher auf einigen 100 m die nächstallgemeinere Karte zu sehen sein).
    Plant man in Baden-Württemberg, wird keine NRW-Karte geladen; im Grenzgebiet beide.
  - **Wanderkarte:** NRW → DTK NRW; übriges Deutschland → TopPlusOpen (BKG); Österreich → basemap.at;
    sonst → OpenTopoMap.
  - **Luftbild:** NRW → DOP NRW; die Luftbilder (DOP20) der Länder BY, BW, NI, HE, RP, SL, SN, TH, ST, BB/BE, MV, SH
    ab Zoomstufe 11; Österreich → basemap.at Orthofoto; sonst (Überblick, Hamburg, Bremen, Ausland) → Esri World Imagery.
  - Die Quellenangabe unten zeigt jeweils die Dienste im aktuellen Ausschnitt.
  - Offline-Karten unterwegs speichern genau die Dienste, die entlang der Route gelten.
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
- **Größe der Wegemarkierungen** (*Einstellungen → Karte*): Regler von 100 bis 300 %, wird gespeichert.
  - TFIS (WMS): stufenlos. Für dieselbe Fläche wird ein kleineres Bild angefordert und vergrößert angezeigt.
    Dadurch wird es etwas unschärfer. Möglicherweise blendet der Server dann Inhalte aus, die er nur bei
    feineren Maßstäben zeigt.
  - OSM (Waymarked Trails): nur 100/200/400 %. Es werden Kacheln einer gröberen Zoomstufe vergrößert angezeigt.
- **GPX-Tracks** (Reiter *GPX* auf der Seite *Tracks*):
  - Eine oder mehrere GPX-Dateien importieren (Symbolknopf rechts im Listenkopf). Gelesen werden Tracks, Routen und Wegpunkte.
  - **Sammel-Import** (z. B. aus komoot): viele GPX-Dateien oder ZIP-Archive (auch Ordner darin) auf einmal.
    Danach wählen: *Automatisch* (Dateien mit Zeitstempeln an fast allen Punkten → *Erwandert*, sonst → *Geplant*),
    alle nach *Geplant*, alle nach *Erwandert* oder alle nach *GPX*. Geplante werden zu Routen mit Wegpunkten etwa
    alle 1 km; die Linie bleibt wie in der Datei und lässt sich wie eine eigene Planung verändern und abgehen.
    Erwanderte behalten Zeitstempel; die Zeit in Bewegung ist geschätzt (Lücken über 2 min und Stillstand zählen nicht).
    Schon importierte Dateien (gleicher Name, Länge, Start) werden übersprungen.
    **komoot:** bietet offiziell nur den GPX-Download je Tour (App: ⋯ → „GPX-Datei herunterladen“, Web: „Export“;
    die Region muss freigeschaltet sein). Ob komoot geplanten Touren Zeitstempel mitgibt, ist ungeprüft – im Zweifel
    geplante und gemachte Touren getrennt importieren und das Ziel ausdrücklich wählen.
    ZIP: Verfahren „stored“/„deflate“ (Entpacken über `DecompressionStream`, Chrome ab 80, Safari ab 16.4), kein ZIP64.
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

Ändert sich die Datenbank-Version (zuletzt auf 4: Speicher „photos“), müssen andere offene Tabs mit einer älteren App-Version
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
| TopPlusOpen (Deutschland) | `sgx.geodatenzentrum.de/wmts_topplus_open` (WMTS, WEBMERCATOR) | dl-de/by-2-0 |
| basemap.at (Österreich) | `mapsneu.wien.gv.at/basemap/geolandbasemap` und `…/bmaporthofoto30cm` | CC BY 4.0 |
| OpenTopoMap (Rückfall) | `{a,b,c}.tile.opentopomap.org` | CC-BY-SA |
| DOP Bayern | `geoservices.bayern.de/od/wms/dop/v1/dop20`, Ebene `by_dop20c` | CC BY 4.0 |
| DOP Baden-Württemberg | `owsproxy.lgl-bw.de/owsproxy/ows/WMS_LGL-BW_ATKIS_DOP_20_C`, `IMAGES_DOP_20_RGB` | dl-de/by-2-0 |
| DOP Niedersachsen | `opendata.lgln.niedersachsen.de/doorman/noauth/dop_wms`, `ni_dop20` | CC BY 4.0 |
| DOP Hessen | `www.gds-srv.hessen.de/cgi-bin/lika-services/ogc-free-images.ows`, `he_dop_rgb` | frei nach § 18 HVGG |
| DOP Rheinland-Pfalz | `geo4.service24.rlp.de/wms/rp_dop20.fcgi`, `rp_dop20` | dl-de/by-2-0 |
| DOP Saarland | `geoportal.saarland.de/freewms/dop2023`, `sl_dop20_rgb` | Capabilities: „noLimitations“ (laut OSM-Wiki dl-de/by-2-0) |
| DOP Sachsen | `geodienste.sachsen.de/wms_geosn_dop-rgb/guest`, `sn_dop_020` | Nutzungsbedingungen GeoSN (laut OSM-Wiki dl-de/by-2-0) |
| DOP Thüringen | `www.geoproxy.geoportal-th.de/geoproxy/services/DOP20`, `th_dop` | CC BY 4.0 |
| DOP Sachsen-Anhalt | `www.geodatenportal.sachsen-anhalt.de/wss/service/ST_LVermGeo_DOP_WMS_OpenData/guest` | „OpenData“ – Lizenztext **ungeprüft** |
| DOP Brandenburg/Berlin | `isk.geobasis-bb.de/mapproxy/dop20c/service/wms`, `bebb_dop20c` | dl-de/by-2-0 |
| DOP Mecklenburg-Vorpommern | `www.geodaten-mv.de/dienste/adv_dop`, `mv_dop` | Quellenvermerk „© GeoBasis-DE/M-V“ |
| DOP Schleswig-Holstein | `dienste.gdi-sh.de/WMS_SH_DOP20col_OpenGBD`, `sh_dop20_rgb` | CC BY 4.0 |
| Esri World Imagery (Rückfall) | `server.arcgisonline.com/…/World_Imagery` | Nutzungsbedingungen **ungeprüft** |
| OSM | `tile.openstreetmap.org` | ODbL, Namensnennung erforderlich |

**Geprüft (03.11.2026, GitHub-Actions-Workflow „Kartendienste prüfen“, `.github/scripts/probe_maps.py`):**
Capabilities bzw. Probe-Kachel, EPSG:3857, JPEG-Ausgabe, CORS und Lizenz (Fees/AccessConstraints) aller Dienste
oben. Nicht aufgenommen: Hamburg (frei nur gemeinsam mit Maxar-Bildern unter geschlossener Lizenz), Bremen
(kein Dienst gefunden), BKG-DOP bundesweit (Zugriff verweigert). Die in den basemap.at-Capabilities genannten
Hosts `maps1–3.wien.gv.at` waren nicht auflösbar; `mapsneu.wien.gv.at` liefert dieselben Kacheln.

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
- `docs/PROJEKT.md`: Projektstand, Entscheidungen und Arbeitsweise (Einstieg für Weiterentwicklung)
- `index.html`, `styles.css`, `app.js`: die App
- `i18n.js`, `i18n-en.js`: Sprache (Deutsch/Englisch, Wörterbuch) und Darstellung (hell/dunkel), werden zuerst geladen
- `tracks.js`: Seite *Tracks*, GPX-Import, lokale Speicherung, Track-Liste
- `planner.js`: Route planen (Routing, Suche, Planungsfeld), Liste *Geplant* (Ansehen, Kopieren, Verändern …), GPX-Export
- `mosaic.js`, `regions.js`: Kartenmosaik nach Gebiet und die Grenzen dazu
- `offline.js`: Offline-Karten entlang der Route
- `nav.js`: Unterwegs-Modus, Aufzeichnung, Abbiegungen, Liste *Erwandert*
- `tourview.js`: Leiste mit Tour-Details, Listenkopf (Anzahl, km, Jahr, Suche)
- `photos.js`: Fotos unterwegs (Kamera, Speicher, Marker, Anzeige)
- `marks.js`: Seite *Ebenen*, eigene Markierungsebenen (Wegzeichen, Positionen, Zustand, Filter)
- `share.js`: Tour und Stand für die Begleitung teilen und einfügen
- `backup.js`: Sicherung/Wiederherstellen, Sammel-Import (GPX, ZIP) nach *Geplant*/*Erwandert*
- `android/`: Android-App (WebView + Aufzeichnung im Hintergrund), Build im Pages-Workflow
- `config.js`: Kartendienste, Startansicht, Zoomstufe
- `sw.js`, `manifest.webmanifest`, `icons/`: PWA (installierbar, App-Hülle offline)
- `vendor/leaflet/`: Leaflet 1.9.4 (BSD-2-Clause), lokal eingebunden
