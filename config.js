/*
 * Kartenkonfiguration.
 *
 * Die Kartendienste von Geobasis NRW (dieselben, die TIM-online anzeigt)
 * stehen unter der "Datenlizenz Deutschland – Zero – Version 2.0".
 * Weitere Dienste (Deutschland, Österreich, Luftbilder der Länder): siehe baseLayers.
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

  /*
   * Hintergrundkarten. „Wanderkarte“ und „Luftbild“ sind Mosaike (mosaic.js): An jeder Stelle wird
   * die genaueste Karte gezeigt, die dort gilt – an Landes-/Staatsgrenzen zugeschnitten (regions.js).
   * Reihenfolge der Quellen: unten (überall) → oben (genaueste).
   *
   * Alle Dienste geprüft am 03.11.2026 per GitHub-Actions-Lauf (.github/scripts/probe_maps.py,
   * Workflow „Kartendienste prüfen“): Capabilities bzw. Probe-Kachel, EPSG:3857, CORS, Lizenz aus
   * Fees/AccessConstraints der Capabilities (Ausnahmen bei der Quelle vermerkt).
   */
  baseLayers: [
    {
      id: "topo",
      name: "Wanderkarte (amtlich, automatisch)",
      type: "mosaic",
      default: true,
      maxZoom: 20,
      sources: [
        {
          // weltweit (außerhalb DE/AT). Lizenz CC-BY-SA laut opentopomap.org/about; kleiner Server –
          // daher nur als Rückfall
          id: "otm", name: "OpenTopoMap", kind: "xyz", url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
          maxNativeZoom: 17,
          attribution: 'Karte: &copy; <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA), Daten: &copy; OpenStreetMap-Mitwirkende'
        },
        {
          // Deutschland: TopPlusOpen (BKG), WMTS WEBMERCATOR 0–18, dl-de/by-2-0 (Capabilities)
          id: "topplus", name: "TopPlusOpen (BKG)", kind: "xyz", region: ["DEU"],
          url: "https://sgx.geodatenzentrum.de/wmts_topplus_open/tile/1.0.0/web/default/WEBMERCATOR/{z}/{y}/{x}.png",
          maxNativeZoom: 18,
          attribution: '&copy; <a href="https://sg.geodatenzentrum.de/web_public/gdz/dokumentation/deu/TopPlusOpen.pdf" target="_blank" rel="noopener">BKG</a> (2026), dl-de/by-2-0'
        },
        {
          // Österreich: basemap.at (Ebene geolandbasemap, google3857), CC BY 4.0 (basemap.at).
          // Kachel-Host laut Capabilities maps1–3.wien.gv.at – im Test nicht auflösbar; mapsneu.wien.gv.at liefert.
          // Höchste Zoomstufe nicht geprüft (vorsichtig 18, darüber vergrößert)
          id: "basemapat", name: "basemap.at", kind: "xyz", region: ["AUT"],
          url: "https://mapsneu.wien.gv.at/basemap/geolandbasemap/normal/google3857/{z}/{y}/{x}.png",
          maxNativeZoom: 18,
          attribution: 'Grundkarte: <a href="https://basemap.at" target="_blank" rel="noopener">basemap.at</a> (CC BY 4.0)'
        },
        {
          // NRW: DTK von Geobasis NRW (wie bisher), dl-de/zero-2-0
          id: "nrw-dtk", name: "DTK NRW", kind: "wms", region: ["NW"], minZoom: 8,
          url: "https://www.wms.nrw.de/geobasis/wms_nw_dtk", layers: "nw_dtk_col", format: "image/png",
          attribution: '&copy; Geobasis NRW, <a href="https://www.govdata.de/dl-de/zero-2-0" target="_blank" rel="noopener">dl-de/zero-2-0</a>'
        }
      ]
    },
    {
      id: "aerial",
      name: "Luftbild (amtlich, automatisch)",
      type: "mosaic",
      maxZoom: 20,
      sources: [
        {
          // Rückfall weltweit, bei kleinen Zoomstufen und in Hamburg/Bremen. Kachel und CORS geprüft;
          // die Nutzungsbedingungen von Esri sind NICHT geprüft (Quellenangabe wie in leaflet-providers)
          id: "esri", name: "Esri World Imagery", kind: "xyz",
          url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          maxNativeZoom: 19,
          attribution: 'Luftbild: &copy; Esri, Maxar, Earthstar Geographics u. a.'
        },
        {
          id: "at-dop", name: "basemap.at Orthofoto", kind: "xyz", region: ["AUT"],
          url: "https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg",
          maxNativeZoom: 18,
          attribution: 'Orthofoto: <a href="https://basemap.at" target="_blank" rel="noopener">basemap.at</a> (CC BY 4.0)'
        },
        // Luftbilder der Länder (DOP20). Unter Zoom 11 nicht (zu viele Dienste je Kachel) – dort Esri.
        { id: "by-dop", name: "DOP Bayern", kind: "wms", region: ["BY"], minZoom: 11, version: "1.1.1",
          url: "https://geoservices.bayern.de/od/wms/dop/v1/dop20", layers: "by_dop20c",
          attribution: "DOP &copy; Bayerische Vermessungsverwaltung, CC BY 4.0" },
        { id: "bw-dop", name: "DOP Baden-Württemberg", kind: "wms", region: ["BW"], minZoom: 11,
          url: "https://owsproxy.lgl-bw.de/owsproxy/ows/WMS_LGL-BW_ATKIS_DOP_20_C", layers: "IMAGES_DOP_20_RGB",
          attribution: "DOP &copy; LGL-BW (2026), dl-de/by-2-0" },
        { id: "ni-dop", name: "DOP Niedersachsen", kind: "wms", region: ["NI"], minZoom: 11,
          url: "https://opendata.lgln.niedersachsen.de/doorman/noauth/dop_wms", layers: "ni_dop20",
          attribution: "DOP &copy; LGLN (2026), CC BY 4.0" },
        { id: "he-dop", name: "DOP Hessen", kind: "wms", region: ["HE"], minZoom: 11,
          url: "https://www.gds-srv.hessen.de/cgi-bin/lika-services/ogc-free-images.ows", layers: "he_dop_rgb",
          attribution: "DOP &copy; HVBG (freie Nutzung nach § 18 HVGG)" },
        { id: "rp-dop", name: "DOP Rheinland-Pfalz", kind: "wms", region: ["RP"], minZoom: 11,
          url: "https://geo4.service24.rlp.de/wms/rp_dop20.fcgi", layers: "rp_dop20",
          attribution: "DOP &copy;GeoBasis-DE / LVermGeoRP (2026), dl-de/by-2-0" },
        { id: "sl-dop", name: "DOP Saarland", kind: "wms", region: ["SL"], minZoom: 11,
          // Lizenz: Capabilities „noLimitations“; laut OSM-Wiki dl-de/by-2-0
          url: "https://geoportal.saarland.de/freewms/dop2023", layers: "sl_dop20_rgb",
          attribution: "DOP &copy; LVGL Saarland" },
        { id: "sn-dop", name: "DOP Sachsen", kind: "wms", region: ["SN"], minZoom: 11,
          // Lizenz: Capabilities verweisen auf geoportal.sachsen.de/nutzungsbedingungen.html; dl-de/by-2-0 laut OSM-Wiki
          url: "https://geodienste.sachsen.de/wms_geosn_dop-rgb/guest", layers: "sn_dop_020",
          attribution: "DOP &copy; GeoSN, dl-de/by-2-0" },
        { id: "th-dop", name: "DOP Thüringen", kind: "wms", region: ["TH"], minZoom: 11,
          url: "https://www.geoproxy.geoportal-th.de/geoproxy/services/DOP20", layers: "th_dop",
          attribution: "DOP &copy; GDI-Th, CC BY 4.0" },
        { id: "st-dop", name: "DOP Sachsen-Anhalt", kind: "wms", region: ["ST"], minZoom: 11,
          // Dienst heißt „OpenData“; einen Lizenztext nennen die Capabilities nicht – Lizenz UNGEPRÜFT
          url: "https://www.geodatenportal.sachsen-anhalt.de/wss/service/ST_LVermGeo_DOP_WMS_OpenData/guest", layers: "lsa_lvermgeo_dop20_2",
          attribution: "DOP &copy; GeoBasis-DE / LVermGeo ST" },
        { id: "bb-dop", name: "DOP Brandenburg/Berlin", kind: "wms", region: ["BB", "BE"], minZoom: 11,
          url: "https://isk.geobasis-bb.de/mapproxy/dop20c/service/wms", layers: "bebb_dop20c",
          attribution: "DOP &copy; GeoBasis-DE/LGB, dl-de/by-2-0" },
        { id: "mv-dop", name: "DOP Mecklenburg-Vorpommern", kind: "wms", region: ["MV"], minZoom: 11,
          url: "https://www.geodaten-mv.de/dienste/adv_dop", layers: "mv_dop",
          attribution: "DOP &copy; GeoBasis-DE/M-V 2026" },
        { id: "sh-dop", name: "DOP Schleswig-Holstein", kind: "wms", region: ["SH"], minZoom: 11,
          url: "https://dienste.gdi-sh.de/WMS_SH_DOP20col_OpenGBD", layers: "sh_dop20_rgb",
          attribution: "DOP &copy; GeoBasis-DE/LVermGeo SH/CC BY 4.0" },
        {
          id: "nrw-dop", name: "DOP NRW", kind: "wms", region: ["NW"], minZoom: 8,
          url: "https://www.wms.nrw.de/geobasis/wms_nw_dop", layers: "nw_dop_rgb",
          attribution: '&copy; Geobasis NRW, <a href="https://www.govdata.de/dl-de/zero-2-0" target="_blank" rel="noopener">dl-de/zero-2-0</a>'
        }
      ]
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
      region: ["NW"],                     // Inhalt nur in NRW: außerhalb keine Anfragen (auch nicht offline)
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
