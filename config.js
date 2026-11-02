/*
 * Kartenkonfiguration.
 *
 * Die Kartendienste von Geobasis NRW (dieselben, die TIM-online anzeigt)
 * stehen unter der "Datenlizenz Deutschland – Zero – Version 2.0".
 * Ausnahme laut Metadaten: DTK250/DTK500 (Daten des BKG) –
 * dort gilt "Datenlizenz Deutschland – Namensnennung – Version 2.0".
 *
 * Layer-Namen geprüft am 02.11.2026 per ?diagnose gegen die GetCapabilities.
 * Die App prüft sie weiterhin bei jedem Start und weicht auf einen vorhandenen
 * Layer aus, falls ein Name einmal nicht mehr existiert (siehe app.js).
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
      layers: "nw_dtk_col",               // "DTK Farbe" (Alternative: nw_dtk_sw)
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
      layers: "nw_dop_rgb",               // "DOP Farbe"
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
   * Der Dienst hat nur eine Ebene ("nw_tfis", Titel "TFIS"). Sie enthält alle
   * Touristik-/Freizeitinhalte, nicht nur Wanderwege; filtern lässt sie sich nicht.
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
      layers: "nw_tfis",
      format: "image/png",
      transparent: true,
      maxZoom: 20,
      attribution:
        '&copy; Geobasis NRW / Wandervereine, ' +
        '<a href="https://www.govdata.de/dl-de/zero-2-0" target="_blank" rel="noopener">dl-de/zero-2-0</a>',
      visible: true,
      featureInfo: true                   // Antippen liefert Weg-Informationen (GetFeatureInfo)
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
      visible: false,
      // Antippen fragt Wanderrouten über die API von Waymarked Trails ab;
      // Basis-URL nach Fremdprojekt und Quelltext, nicht aus offizieller Doku.
      wmtApi: "https://hiking.waymarkedtrails.org/api/v1",
      // Rückfall: Overpass-API
      // (Server werden der Reihe nach probiert, falls einer nicht antwortet)
      osmInfo: [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.private.coffee/api/interpreter"
      ]
    }
  ],

  // Nur für ?diagnose: WFS-Dienste (Vektordaten), die probehalber abgefragt werden.
  // Adresse nach dem Muster der übrigen NRW-Dienste vermutet, nicht bestätigt.
  diagnoseWfs: [
    "https://www.wfs.nrw.de/geobasis/wfs_nw_tfis"
  ]
};
