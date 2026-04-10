import os
from typing import Any, Dict, List, Optional

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv()

app = FastAPI(title="Zoning Envelopes Starter API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "web")
app.mount("/web", StaticFiles(directory=WEB_DIR), name="web")


class EnvelopeRequest(BaseModel):
    lot_polygon: List[List[float]] = Field(..., description="[[lng, lat], ...] closed or open")
    use_type: str = Field(default="market_rate")
    far_mode: bool = Field(default=False)
    lot_coverage: float = Field(default=0.75, ge=0.2, le=1.0)
    floor_height_ft: float = Field(default=10.0, ge=8.0, le=20.0)
    zoning_far: float = Field(default=3.0, ge=0.1, le=30.0)
    max_height_ft: float = Field(default=120.0, ge=20.0, le=2000.0)


def _close_ring(coords: List[List[float]]) -> List[List[float]]:
    if len(coords) < 3:
        raise HTTPException(status_code=400, detail="lot_polygon requires at least 3 points")
    if coords[0] != coords[-1]:
        return coords + [coords[0]]
    return coords


def _bbox(coords: List[List[float]]) -> Dict[str, float]:
    xs = [p[0] for p in coords]
    ys = [p[1] for p in coords]
    return {"min_x": min(xs), "max_x": max(xs), "min_y": min(ys), "max_y": max(ys)}


def _make_inner_ring_from_bbox(outer: List[List[float]], scale: float) -> List[List[float]]:
    box = _bbox(outer)
    cx = (box["min_x"] + box["max_x"]) * 0.5
    cy = (box["min_y"] + box["max_y"]) * 0.5

    def s(point: List[float]) -> List[float]:
        return [cx + (point[0] - cx) * scale, cy + (point[1] - cy) * scale]

    ring = [s(p) for p in outer[:-1]]
    ring.append(ring[0])
    return ring


@app.get("/")
def root() -> FileResponse:
    return FileResponse(os.path.join(WEB_DIR, "index.html"))


@app.get("/api/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/api/lot/{borough}/{block}/{lot}")
def get_lot_by_bbl_parts(borough: str, block: str, lot: str) -> Dict[str, Any]:
    # Borough can be numeric (1..5) or letter (M,B,K,Q,S)
    boro_map = {"M": "1", "B": "2", "K": "3", "Q": "4", "S": "5"}
    b = borough.strip().upper()
    b = boro_map.get(b, b)

    block_num = str(int(block))
    lot_num = str(int(lot))

    query = (
        "https://data.cityofnewyork.us/resource/64uk-42ks.json"
        f"?$select=bbl,borough,block,lot,zonedist1,zonedist2,landuse,bldgarea,numfloors"
        f"&$where=borough='{b}' AND block='{block_num}' AND lot='{lot_num}'"
        "&$limit=1"
    )

    resp = requests.get(query, timeout=15)
    if not resp.ok:
        raise HTTPException(status_code=502, detail="Failed to query NYC PLUTO")

    rows = resp.json()
    if not rows:
        raise HTTPException(status_code=404, detail="No lot found for supplied BBL parts")

    row = rows[0]
    z1 = (row.get("zonedist1") or "").strip()
    z2 = (row.get("zonedist2") or "").strip()

    return {
        "bbl": row.get("bbl"),
        "borough": row.get("borough"),
        "block": row.get("block"),
        "lot": row.get("lot"),
        "zone": z1 or z2 or None,
        "zonedist1": z1 or None,
        "zonedist2": z2 or None,
        "landuse": row.get("landuse"),
        "bldgarea": row.get("bldgarea"),
        "numfloors": row.get("numfloors"),
    }


@app.post("/api/envelope")
def build_envelope(payload: EnvelopeRequest) -> Dict[str, Any]:
    # Starter only: mock geometry represented as GeoJSON polygon footprints + height metadata.
    outer = _close_ring(payload.lot_polygon)

    use_type = payload.use_type.lower().strip()
    far_adj = 1.15 if use_type == "affordable" else 1.0

    target_far = payload.zoning_far * far_adj
    full_height_ft = min(payload.max_height_ft, max(40.0, 20.0 + target_far * 25.0))

    # FAR-mode envelope (rough): use lot coverage to derive floor count and resulting height.
    far_height_ft: Optional[float] = None
    if payload.far_mode:
        # Synthetic study metric in starter mode.
        effective_floorplate_ratio = max(0.2, min(1.0, payload.lot_coverage))
        est_floors = max(1, int(round((target_far / effective_floorplate_ratio))))
        far_height_ft = min(payload.max_height_ft, est_floors * payload.floor_height_ft)

    # Synthetic "setback" footprint for visual contrast in map.
    inner = _make_inner_ring_from_bbox(outer, scale=0.78)

    return {
        "inputs": payload.model_dump(),
        "results": {
            "use_type": use_type,
            "target_far": round(target_far, 3),
            "full_envelope_height_ft": round(full_height_ft, 2),
            "far_envelope_height_ft": round(far_height_ft, 2) if far_height_ft is not None else None,
        },
        "geojson": {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {
                        "kind": "full_envelope",
                        "height_ft": full_height_ft,
                        "color": "#2563eb",
                        "opacity": 0.35,
                    },
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [inner],
                    },
                },
                {
                    "type": "Feature",
                    "properties": {
                        "kind": "lot",
                        "height_ft": 8,
                        "color": "#475569",
                        "opacity": 0.25,
                    },
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [outer],
                    },
                },
            ]
            + (
                [
                    {
                        "type": "Feature",
                        "properties": {
                            "kind": "far_envelope",
                            "height_ft": far_height_ft,
                            "color": "#f97316",
                            "opacity": 0.5,
                        },
                        "geometry": {
                            "type": "Polygon",
                            "coordinates": [_make_inner_ring_from_bbox(outer, scale=0.62)],
                        },
                    }
                ]
                if far_height_ft is not None
                else []
            ),
        },
    }
