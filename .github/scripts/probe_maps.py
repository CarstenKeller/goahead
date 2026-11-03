#!/usr/bin/env python3
"""Kartendienste prüfen (läuft in GitHub Actions, weil die Entwicklungsumgebung sie nicht erreicht).

Für jeden Kandidaten: HTTP-Status, Inhaltstyp, CORS-Freigabe (Access-Control-Allow-Origin bei
Anfrage mit Origin der App), bei Capabilities die Ebenen, Bezugssysteme bzw. TileMatrixSets und
Kachel-Vorlagen. Zusätzlich je eine Probe-Kachel bzw. GetMap im Gebiet des Dienstes.
Die Ergebnisse stehen im Protokoll des Laufs; nur geprüfte Dienste werden in config.js übernommen.
"""
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET

ORIGIN = "https://carstenkeller.github.io"
UA = "GoAhead-Kartenpruefung (github.com/CarstenKeller/goahead)"


def get(url, n=4_000_000):
    req = urllib.request.Request(url, headers={"Origin": ORIGIN, "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, dict(r.headers), r.read(n)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read(2000)
    except Exception as e:  # noqa: BLE001
        return None, {}, str(e).encode()


def head(name, url, status, h, body):
    acao = h.get("Access-Control-Allow-Origin") or h.get("access-control-allow-origin")
    print(f"\n### {name}\nURL: {url}\nStatus: {status}  Typ: {h.get('Content-Type')}  Länge: {len(body)}  CORS: {acao}")


def local(tag):
    return tag.split("}")[-1]


def wms(name, base, sample_bbox3857):
    sep = "&" if "?" in base else "?"
    url = base + sep + "SERVICE=WMS&REQUEST=GetCapabilities"
    st, h, b = get(url)
    head(name + " (WMS-Capabilities)", url, st, h, b)
    if st != 200:
        print(b[:300])
        return
    try:
        root = ET.fromstring(b)
    except ET.ParseError as e:
        print("XML-Fehler:", e, b[:300])
        return
    ver = root.attrib.get("version")
    crs = set()
    layers = []
    for el in root.iter():
        t = local(el.tag)
        if t in ("CRS", "SRS") and el.text:
            crs.update(el.text.split())
        if t == "Layer":
            nm = None
            title = None
            for c in el:
                if local(c.tag) == "Name":
                    nm = c.text
                if local(c.tag) == "Title":
                    title = c.text
            if nm:
                layers.append((nm, title))
    for el in root.iter():
        if local(el.tag) in ("AccessConstraints", "Fees"):
            print(local(el.tag) + ":", (el.text or "").strip()[:900])
    print("Version:", ver, "| EPSG:3857:", "EPSG:3857" in crs, "| Ebenen:", "; ".join(f"{n} ({t})" for n, t in layers[:25]))
    if layers:
        ln = layers[0][0] if len(layers) == 1 else next((n for n, _ in layers if re.search(r"dop|rgb|ortho", n, re.I)), layers[-1][0])
        crsp = "CRS" if ver == "1.3.0" else "SRS"
        gm = (base + sep + f"SERVICE=WMS&VERSION={ver}&REQUEST=GetMap&LAYERS={ln}&STYLES=&{crsp}=EPSG:3857"
              f"&BBOX={sample_bbox3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=TRUE")
        st2, h2, b2 = get(gm)
        head(name + f" (GetMap {ln})", gm, st2, h2, b2)
        if not (h2.get("Content-Type") or "").startswith("image"):
            print(b2[:300])


def wmts(name, url):
    st, h, b = get(url)
    head(name + " (WMTS-Capabilities)", url, st, h, b)
    if st != 200:
        print(b[:300])
        return
    try:
        root = ET.fromstring(b)
    except ET.ParseError as e:
        print("XML-Fehler:", e, b[:300])
        return
    for el in root.iter():
        if local(el.tag) in ("AccessConstraints", "Fees"):
            print(local(el.tag) + ":", (el.text or "").strip()[:300])
    for lay in root.iter():
        if local(lay.tag) != "Layer":
            continue
        ident = None
        sets = []
        tmpl = []
        styles = []
        for c in lay.iter():
            t = local(c.tag)
            if t == "Identifier" and ident is None and c in list(lay):
                ident = c.text
            if t == "TileMatrixSet" and c.text:
                sets.append(c.text)
            if t == "ResourceURL" and c.attrib.get("resourceType") == "tile":
                tmpl.append(c.attrib.get("template"))
            if t == "Style":
                for s in c:
                    if local(s.tag) == "Identifier":
                        styles.append(s.text)
        print(f"- Ebene {ident}: Stile {styles} Sets {sorted(set(sets))}\n    Vorlagen {tmpl[:3]}")


def tile(name, url):
    st, h, b = get(url)
    head(name + " (Kachel)", url, st, h, b)
    if not (h.get("Content-Type") or "").startswith("image"):
        print(b[:300])


def page(name, url, pattern):
    st, h, b = get(url, 3_000_000)
    head(name + " (Seite)", url, st, h, b)
    text = re.sub(r"<[^>]+>", " ", b.decode("utf-8", "replace"))
    text = re.sub(r"[ \t]+", " ", text)
    for line in text.splitlines():
        line = line.strip()
        if line and re.search(pattern, line, re.I):
            print("  |", line[:400])


# Probepunkte (EPSG:3857-Kachel z14 bzw. 256-px-BBOX) je Gebiet
def bbox(lon, lat, z=15):
    import math
    r = 6378137.0
    x = math.radians(lon) * r
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * r
    s = 2 * math.pi * r / 2 ** z
    return f"{x - s / 2:.1f},{y - s / 2:.1f},{x + s / 2:.1f},{y + s / 2:.1f}"


def xyz(lon, lat, z=14):
    import math
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n)
    return z, x, y


def tilematrix_ids(url, setname):
    st, h, b = get(url)
    root = ET.fromstring(b)
    for tms in root.iter():
        if local(tms.tag) != "TileMatrixSet":
            continue
        kids = list(tms)
        ident = next((c.text for c in kids if local(c.tag) == "Identifier"), None)
        if ident != setname:
            continue
        ids = [next((m.text for m in tm if local(m.tag) == "Identifier"), None) for tm in kids if local(tm.tag) == "TileMatrix"]
        print(f"TileMatrixSet {setname}: {len(ids)} Stufen, Kennungen {ids[:3]} … {ids[-2:]}")


def second():
    print("# Kartendienste – Prüfung 2")
    z, x, y = xyz(9.2, 48.8)
    tilematrix_ids("https://sgx.geodatenzentrum.de/wmts_topplus_open/1.0.0/WMTSCapabilities.xml", "WEBMERCATOR")
    tile("TopPlusOpen web", f"https://sgx.geodatenzentrum.de/wmts_topplus_open/tile/1.0.0/web/default/WEBMERCATOR/{z}/{y}/{x}.png")
    tilematrix_ids("https://sgx.geodatenzentrum.de/wmts_basemapde/1.0.0/WMTSCapabilities.xml", "GLOBAL_WEBMERCATOR")
    tile("basemap.de farbe", f"https://sgx.geodatenzentrum.de/wmts_basemapde/tile/1.0.0/de_basemapde_web_raster_farbe/default/GLOBAL_WEBMERCATOR/{z}/{y}/{x}.png")
    z, x, y = xyz(13.0, 47.3)
    tile("basemap.at standard", f"https://maps1.wien.gv.at/basemap/geolandbasemap/normal/google3857/{z}/{y}/{x}.png")
    tile("basemap.at orthofoto", f"https://maps2.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg")
    page("basemap.at Lizenz", "https://basemap.at/", r"lizenz|licen|cc.by|nutzung")
    for name, base, (lon, lat) in [
        ("HE (lika-services)", "https://www.gds-srv.hessen.de/cgi-bin/lika-services/ogc-free-images.ows", (8.7, 50.1)),
        ("HE (freeimages)", "https://www.gds-srv.hessen.de/cgi-bin/lika-services/ogc-freeimages.ows", (8.7, 50.1)),
        ("HE (Geoportal 54936)", "https://www.geoportal.hessen.de/mapbender/php/wms.php?inspire=1&layer_id=54936&withChilds=1", (8.7, 50.1)),
        ("HH (Zeitreihe)", "https://geodienste.hamburg.de/wms_dop_zeitreihe_unbelaubt", (10.0, 53.55)),
        ("HH (HH_WMS_DOP_hochaufloesend)", "https://geodienste.hamburg.de/HH_WMS_DOP_hochaufloesend", (10.0, 53.55)),
        ("ST", "https://www.geodatenportal.sachsen-anhalt.de/wss/service/ST_LVermGeo_DOP_WMS_OpenData/guest", (11.97, 51.48)),
        ("MV", "https://www.geodaten-mv.de/dienste/adv_dop", (11.41, 53.63)),
        ("SN", "https://geodienste.sachsen.de/wms_geosn_dop-rgb/guest", (13.7, 51.05)),
        ("SL", "https://geoportal.saarland.de/freewms/dop2023", (7.0, 49.23)),
    ]:
        wms("DOP " + name, base, bbox(lon, lat))
    page("Sachsen Nutzungsbedingungen", "https://geoportal.sachsen.de/nutzungsbedingungen.html", r"lizenz|dl-de|cc by|namensnennung")


DOPS = [
    ("NW", "https://www.wms.nrw.de/geobasis/wms_nw_dop", "nw_dop_rgb", "1.3.0", (8.2, 51.2)),
    ("BY", "https://geoservices.bayern.de/od/wms/dop/v1/dop20", "by_dop20c", "1.1.1", (11.5, 48.1)),
    ("NI", "https://opendata.lgln.niedersachsen.de/doorman/noauth/dop_wms", "ni_dop20", "1.3.0", (9.7, 52.4)),
    ("HE", "https://www.gds-srv.hessen.de/cgi-bin/lika-services/ogc-free-images.ows", "he_dop_rgb", "1.3.0", (8.7, 50.1)),
    ("BW", "https://owsproxy.lgl-bw.de/owsproxy/ows/WMS_LGL-BW_ATKIS_DOP_20_C", "IMAGES_DOP_20_RGB", "1.3.0", (9.2, 48.8)),
    ("RP", "https://geo4.service24.rlp.de/wms/rp_dop20.fcgi", "rp_dop20", "1.3.0", (7.6, 50.0)),
    ("SN", "https://geodienste.sachsen.de/wms_geosn_dop-rgb/guest", "sn_dop_020", "1.3.0", (13.7, 51.05)),
    ("TH", "https://www.geoproxy.geoportal-th.de/geoproxy/services/DOP20", "th_dop", "1.3.0", (11.0, 50.98)),
    ("BB", "https://isk.geobasis-bb.de/mapproxy/dop20c/service/wms", "bebb_dop20c", "1.3.0", (13.06, 52.4)),
    ("SH", "https://dienste.gdi-sh.de/WMS_SH_DOP20col_OpenGBD", "sh_dop20_rgb", "1.3.0", (10.13, 54.32)),
    ("ST", "https://www.geodatenportal.sachsen-anhalt.de/wss/service/ST_LVermGeo_DOP_WMS_OpenData/guest", "lsa_lvermgeo_dop20_2", "1.3.0", (11.97, 51.48)),
    ("MV", "https://www.geodaten-mv.de/dienste/adv_dop", "mv_dop", "1.3.0", (11.41, 53.63)),
    ("BE", "https://gdi.berlin.de/services/wms/truedop_2024", "truedop_2024", "1.3.0", (13.4, 52.52)),
    ("SL", "https://geoportal.saarland.de/freewms/dop2023", "sl_dop20_rgb", "1.3.0", (7.0, 49.23)),
]


def third():
    print("# Kartendienste – Prüfung 3")
    z, x, y = xyz(13.0, 47.3)
    for host in ("mapsneu.wien.gv.at", "maps.wien.gv.at", "maps1.wien.gv.at", "www.basemap.at"):
        tile("basemap.at standard " + host, f"https://{host}/basemap/geolandbasemap/normal/google3857/{z}/{y}/{x}.png")
    tile("basemap.at orthofoto mapsneu", f"https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg")
    tile("TopPlusOpen z05", "https://sgx.geodatenzentrum.de/wmts_topplus_open/tile/1.0.0/web/default/WEBMERCATOR/05/10/16.png")
    tile("TopPlusOpen z5", "https://sgx.geodatenzentrum.de/wmts_topplus_open/tile/1.0.0/web/default/WEBMERCATOR/5/10/16.png")
    for code, base, layer, ver, (lon, lat) in DOPS:
        crsp = "CRS" if ver == "1.3.0" else "SRS"
        u = (base + f"?SERVICE=WMS&VERSION={ver}&REQUEST=GetMap&LAYERS={layer}&STYLES=&{crsp}=EPSG:3857"
             f"&BBOX={bbox(lon, lat)}&WIDTH=256&HEIGHT=256&FORMAT=image/jpeg")
        tile("DOP " + code + " jpeg", u)
    page("Sachsen-Anhalt Open Data Lizenz", "https://www.lvermgeo.sachsen-anhalt.de/de/gdp-open-data.html", r"lizenz|dl-de|cc by|namensnennung")


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "3":
    third()
    sys.exit(0)

if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "2":
    second()
    sys.exit(0)

if __name__ == "__main__":
    print("# Kartendienste – Prüfung")
    # Deutschland: Topografie
    wmts("TopPlusOpen (BKG)", "https://sgx.geodatenzentrum.de/wmts_topplus_open/1.0.0/WMTSCapabilities.xml")
    wmts("basemap.de (BKG/AdV)", "https://sgx.geodatenzentrum.de/wmts_basemapde/1.0.0/WMTSCapabilities.xml")
    # Österreich
    wmts("basemap.at", "https://www.basemap.at/wmts/1.0.0/WMTSCapabilities.xml")
    wmts("basemap.at (mapsneu)", "https://mapsneu.wien.gv.at/basemap/1.0.0/WMTSCapabilities.xml")
    # weltweit
    z, x, y = xyz(8.9, 48.5)
    tile("OpenTopoMap", f"https://a.tile.opentopomap.org/{z}/{x}/{y}.png")
    tile("Esri World Imagery", f"https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}")
    page("OpenTopoMap – Über", "https://opentopomap.org/about", r"nutz|usage|tile|kachel|lizenz|licen")
    # Luftbilder der Länder (Kandidaten aus Sekundärquellen – hier geprüft)
    cands = [
        ("BY", "https://geoservices.bayern.de/od/wms/dop/v1/dop20", (11.5, 48.1)),
        ("NI", "https://opendata.lgln.niedersachsen.de/doorman/noauth/dop_wms", (9.7, 52.4)),
        ("HE", "https://www.gds-srv.hessen.de/cgi-bin/likaservices/ogc-free-images.ows", (8.7, 50.1)),
        ("BW", "https://owsproxy.lgl-bw.de/owsproxy/ows/WMS_LGL-BW_ATKIS_DOP_20_C", (9.2, 48.8)),
        ("RP", "https://geo4.service24.rlp.de/wms/rp_dop20.fcgi", (7.6, 50.0)),
        ("SN", "https://geodienste.sachsen.de/wms_geosn_dop-rgb/guest", (13.7, 51.05)),
        ("TH", "https://www.geoproxy.geoportal-th.de/geoproxy/services/DOP20", (11.0, 50.98)),
        ("BB", "https://isk.geobasis-bb.de/mapproxy/dop20c/service/wms", (13.06, 52.4)),
        ("SH", "https://dienste.gdi-sh.de/WMS_SH_DOP20col_OpenGBD", (10.13, 54.32)),
        ("ST", "https://www.geodatenportal.sachsen-anhalt.de/wss/service/ST_LVermGeo_DOP_WMS_OpenData/guest", (11.97, 51.48)),
        ("MV", "https://www.geodaten-mv.de/dienste/adv_dop", (11.41, 53.63)),
        ("HH", "https://geodienste.hamburg.de/HH_WMS_DOP", (10.0, 53.55)),
        ("BE", "https://gdi.berlin.de/services/wms/truedop_2024", (13.4, 52.52)),
        ("SL", "https://geoportal.saarland.de/freewms/dop2023", (7.0, 49.23)),
        ("BKG DOP (bundesweit)", "https://sg.geodatenzentrum.de/wms_dop", (9.0, 50.0)),
    ]
    for name, base, (lon, lat) in cands:
        wms("DOP " + name, base, bbox(lon, lat))
    # Übersichten mit Adressen (zum Nachschlagen fehlender Länder)
    page("Übersicht DOP der Länder (WHZ)", "https://gauss.whz.de/veribus/dop.html", r"https?://|lizenz|cc by|dl-de")
    page("OSM-Wiki DE:Luftbilder", "https://wiki.openstreetmap.org/wiki/DE:Luftbilder", r"wms|lizenz|dl-de|cc by|zero")
    sys.exit(0)
