/*
 * Kartenkonfiguration.
 *
 * Die Kartendienste von Geobasis NRW (dieselben, die TIM-online anzeigt)
 * stehen unter der "Datenlizenz Deutschland – Zero – Version 2.0".
 * Ausnahme laut Metadaten: DTK250/DTK500 (Daten des BKG) –
 * dort gilt "Datenlizenz Deutschland – Namensnennung – Version 2.0".
 *
 * HINWEIS: Die Layer-Namen unten konnten bei der Entwicklung nicht gegen
 * die GetCapabilities der Dienste geprüft werden. Deshalb fragt die App
 * beim Start die Capabilities ab und wählt automatisch einen vorhandenen
 * Layer, falls der eingetragene Name nicht existiert (siehe app.js).
 */
window.GOAHEAD_CONFIG = {
  // Startansicht, solange noch keine GPS-Position vorliegt (Sauerland)
  initialView: { lat: 51.2, lng: 8.2, zoom: 10 },

  // Zoom, auf den beim ersten GPS-Fix gesprungen wird
  locateZoom: 16,

  baseLayers: [
    {
      id: "nrw-dtk",
      name: "Topografische Karte NRW (DTK)",
      type: "wms",
      url: "https://www.wms.nrw.de/geobasis/wms_nw_dtk",
      layers: "nw_dtk_col",               // ungeprüft, siehe Hinweis oben
      preferLayerMatch: /dtk.*col|col.*dtk|farb/i,
      format: "image/png",
      transparent: false,
      maxZoom: 20,
      attribution:
        '&copy; Geobasis NRW, ' +
        '<a href="https://www.govdata.de/dl-de/zero-2-0" target="_blank" rel="noopener">dl-de/zero-2-0</a>',
      default: true
    },
    {
      id: "nrw-dop",
      name: "Luftbild NRW (DOP)",
      type: "wms",
      url: "https://www.wms.nrw.de/geobasis/wms_nw_dop",
      layers: "nw_dop_rgb",               // ungeprüft, siehe Hinweis oben
      preferLayerMatch: /rgb/i,
      format: "image/jpeg",
      transparent: false,
      maxZoom: 20,
      attribution:
        '&copy; Geobasis NRW, ' +
        '<a href="https://www.govdata.de/dl-de/zero-2-0" target="_blank" rel="noopener">dl-de/zero-2-0</a>'
    },
    {
      id: "osm",
      name: "OpenStreetMap",
      type: "xyz",
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende'
    }
  ],

  /*
   * Ein-/ausblendbare Ebenen über der Hintergrundkarte.
   *
   * "Wanderwege NRW (amtlich)": Touristik- und Freizeitinformationssystem (TFIS NRW)
   * von Geobasis NRW. Laut Geobasis NRW liefern die Wandervereine (Kooperation mit dem
   * Landeswanderverband NRW) ihre markierten Wege mindestens jährlich zu.
   * Die Layer-Namen des Dienstes sind nicht hinterlegt: Die App ermittelt beim Start
   * alle Ebenen, deren Name oder Titel "wander" enthält (layerMatch). Ergebnis
   * prüfen: App mit ?diagnose aufrufen.
   *
   * "Wanderwege OSM": Waymarked Trails, Daten aus OpenStreetMap (von Freiwilligen
   * erfasst, nicht amtlich) – nützlich zum Vergleich.
   */
  overlays: [
    {
      id: "nrw-tfis-wander",
      name: "Wanderwege NRW (amtlich, TFIS)",
      type: "wms",
      url: "https://www.wms.nrw.de/geobasis/wms_nw_tfis",
      layers: null,                        // wird zur Laufzeit ermittelt
      layerMatch: /wander/i,
      format: "image/png",
      transparent: true,
      maxZoom: 20,
      attribution:
        '&copy; Geobasis NRW / Wandervereine, ' +
        '<a href="https://www.govdata.de/dl-de/zero-2-0" target="_blank" rel="noopener">dl-de/zero-2-0</a>',
      visible: true
    },
    {
      id: "osm-hiking",
      name: "Wanderwege OSM (Waymarked Trails)",
      type: "xyz",
      url: "https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png",
      maxZoom: 20,
      maxNativeZoom: 18,
      attribution:
        'Wanderwege: <a href="https://hiking.waymarkedtrails.org" target="_blank" rel="noopener">Waymarked Trails</a> ' +
        '(<a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener">CC BY-SA</a>)',
      visible: false
    }
  ]
};
