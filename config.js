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
  ]
};
