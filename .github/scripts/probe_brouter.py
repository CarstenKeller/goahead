#!/usr/bin/env python3
"""BRouter-Rundtour prüfen (engineMode=4, roundTripDistance = Radius des Wegpunktkreises, laut Quelltext
abrensch/brouter RoutingEngine.doRoundTrip). Gibt je Radius die Länge der berechneten Runde aus."""
import json
import urllib.request

ORIGIN = "https://carstenkeller.github.io"
BASE = "https://brouter.de/brouter?lonlats={lon},{lat}&profile=hiking-mountain&alternativeidx=0&format=geojson&engineMode=4&roundTripDistance={r}&roundTripStartDirection={d}"

def get(url):
    req = urllib.request.Request(url, headers={"Origin": ORIGIN, "User-Agent": "GoAhead-Pruefung"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()
    except Exception as e:  # noqa: BLE001
        return None, {}, str(e).encode()

for (lon, lat, name) in [(8.95, 51.72, "Egge"), (8.2, 51.2, "Sauerland")]:
    for r in (1000, 2000, 4000):
        for d in (0, 120):
            url = BASE.format(lon=lon, lat=lat, r=r, d=d)
            st, h, b = get(url)
            acao = h.get("Access-Control-Allow-Origin") or h.get("access-control-allow-origin")
            try:
                j = json.loads(b)
                f = j["features"][0]
                props = f["properties"]
                coords = f["geometry"]["coordinates"]
                print(f"{name} r={r} d={d}: Status {st} CORS {acao} Länge {props.get('track-length')} m "
                      f"Anstieg {props.get('filtered ascend')} Punkte {len(coords)} Start {coords[0][:2]} Ende {coords[-1][:2]} "
                      f"Faktor {int(props.get('track-length', 0)) / r:.2f}")
            except Exception as e:  # noqa: BLE001
                print(f"{name} r={r} d={d}: Status {st} CORS {acao} – {e}: {b[:300]!r}")
