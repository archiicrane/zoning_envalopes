import json
import math
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv()

app = FastAPI(title="Zoning Envelopes API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ROOT_DIR = os.path.dirname(os.path.dirname(__file__))
WEB_DIR = os.path.join(ROOT_DIR, "web")
PUBLIC_DIR = os.path.join(ROOT_DIR, "public")
SPLIT_PLUTO_DIR = os.path.join(ROOT_DIR, "split_pluto")
SPLIT_PLUTO_MANIFEST = os.path.join(ROOT_DIR, "split_pluto_manifest.json")
GEOJSON_INDEX_PATH = os.path.join(ROOT_DIR, "geojson-index.json")
SPLIT_PLUTO_BUCKET = os.getenv("SPLIT_PLUTO_BUCKET", "zoning-geojson")
SPLIT_PLUTO_BASE_URL = os.getenv("SPLIT_PLUTO_BASE_URL", f"https://{SPLIT_PLUTO_BUCKET}.s3.amazonaws.com")
if os.path.isdir(WEB_DIR):
    app.mount("/web", StaticFiles(directory=WEB_DIR), name="web")
if os.path.isdir(PUBLIC_DIR):
    app.mount("/public", StaticFiles(directory=PUBLIC_DIR), name="public")
if os.path.isdir(SPLIT_PLUTO_DIR):
    app.mount("/split_pluto", StaticFiles(directory=SPLIT_PLUTO_DIR), name="split_pluto")

MAPPLUTO_QUERY_URL = (
    "https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/MapPLUTO/FeatureServer/0/query"
)

ZONE_RULES: Dict[str, Dict[str, float]] = {
    "R1": {"far": 0.5, "max_height_ft": 35.0, "coverage": 0.35},
    "R2": {"far": 0.5, "max_height_ft": 35.0, "coverage": 0.35},
    "R3-1": {"far": 0.5, "max_height_ft": 35.0, "coverage": 0.45},
    "R3A": {"far": 0.6, "max_height_ft": 35.0, "coverage": 0.45},
    "R3X": {"far": 0.85, "max_height_ft": 35.0, "coverage": 0.5},
    "R4": {"far": 0.75, "max_height_ft": 45.0, "coverage": 0.55},
    "R4A": {"far": 0.9, "max_height_ft": 45.0, "coverage": 0.55},
    "R4-1": {"far": 1.35, "max_height_ft": 55.0, "coverage": 0.65},
    "R4B": {"far": 0.9, "max_height_ft": 45.0, "coverage": 0.6},
    "R5": {"far": 1.25, "max_height_ft": 55.0, "coverage": 0.7},
    "R5A": {"far": 1.1, "max_height_ft": 40.0, "coverage": 0.65},
    "R5B": {"far": 1.35, "max_height_ft": 33.0, "coverage": 0.55},
    "R5D": {"far": 2.0, "max_height_ft": 65.0, "coverage": 0.8},
    "R6": {"far": 2.43, "max_height_ft": 70.0, "coverage": 0.8},
    "R6A": {"far": 3.0, "max_height_ft": 70.0, "coverage": 0.8},
    "R6B": {"far": 2.0, "max_height_ft": 50.0, "coverage": 0.7},
    "R7-1": {"far": 3.44, "max_height_ft": 100.0, "coverage": 0.85},
    "R7-2": {"far": 3.44, "max_height_ft": 100.0, "coverage": 0.85},
    "R7A": {"far": 4.0, "max_height_ft": 80.0, "coverage": 0.82},
    "R7B": {"far": 3.0, "max_height_ft": 75.0, "coverage": 0.75},
    "R7D": {"far": 4.2, "max_height_ft": 100.0, "coverage": 0.85},
    "R8": {"far": 6.02, "max_height_ft": 120.0, "coverage": 0.88},
    "R8A": {"far": 6.02, "max_height_ft": 120.0, "coverage": 0.85},
    "R8B": {"far": 4.0, "max_height_ft": 75.0, "coverage": 0.75},
    "R9": {"far": 7.52, "max_height_ft": 145.0, "coverage": 0.88},
    "R9A": {"far": 7.52, "max_height_ft": 120.0, "coverage": 0.85},
    "R10": {"far": 10.0, "max_height_ft": 210.0, "coverage": 0.9},
    "R10A": {"far": 10.0, "max_height_ft": 210.0, "coverage": 0.88},
    "C3": {"far": 0.5, "max_height_ft": 35.0, "coverage": 0.4},
    "C4-1": {"far": 3.4, "max_height_ft": 80.0, "coverage": 0.85},
    "C4-2": {"far": 3.44, "max_height_ft": 80.0, "coverage": 0.85},
    "C4-4": {"far": 3.44, "max_height_ft": 120.0, "coverage": 0.88},
    "C4-4D": {"far": 4.2, "max_height_ft": 100.0, "coverage": 0.85},
    "C4-5": {"far": 4.0, "max_height_ft": 125.0, "coverage": 0.9},
    "C4-6": {"far": 10.0, "max_height_ft": 150.0, "coverage": 0.9},
    "C4-7": {"far": 10.0, "max_height_ft": 210.0, "coverage": 0.92},
    "C5-1": {"far": 5.0, "max_height_ft": 100.0, "coverage": 0.9},
    "C5-2": {"far": 6.0, "max_height_ft": 150.0, "coverage": 0.92},
    "C5-3": {"far": 9.0, "max_height_ft": 210.0, "coverage": 0.94},
    "C5-5": {"far": 12.0, "max_height_ft": 420.0, "coverage": 0.95},
    "C6-1": {"far": 6.0, "max_height_ft": 105.0, "coverage": 0.9},
    "C6-2": {"far": 6.02, "max_height_ft": 120.0, "coverage": 0.9},
    "C6-3": {"far": 7.52, "max_height_ft": 145.0, "coverage": 0.92},
    "C6-4": {"far": 10.0, "max_height_ft": 210.0, "coverage": 0.94},
    "C6-5": {"far": 12.0, "max_height_ft": 420.0, "coverage": 0.95},
    "C6-9": {"far": 15.0, "max_height_ft": 600.0, "coverage": 0.96},
    "M1-1": {"far": 1.0, "max_height_ft": 60.0, "coverage": 0.85},
    "M1-2": {"far": 2.0, "max_height_ft": 85.0, "coverage": 0.88},
    "M1-3": {"far": 5.0, "max_height_ft": 120.0, "coverage": 0.9},
    "M1-4": {"far": 10.0, "max_height_ft": 210.0, "coverage": 0.92},
    "M2-1": {"far": 2.0, "max_height_ft": 85.0, "coverage": 0.88},
    "M2-2": {"far": 2.0, "max_height_ft": 120.0, "coverage": 0.9},
    "M3-1": {"far": 2.0, "max_height_ft": 85.0, "coverage": 0.9},
}

DEFAULT_ZONE_RULE = {"far": 3.0, "max_height_ft": 85.0, "coverage": 0.8}


class EnvelopeRequest(BaseModel):
    lot_polygon: List[List[float]] = Field(..., description="[[lng, lat], ...] closed or open")
    use_type: str = Field(default="market_rate")
    far_mode: bool = Field(default=False)
    lot_coverage: float = Field(default=0.75, ge=0.2, le=1.0)
    floor_height_ft: float = Field(default=10.0, ge=8.0, le=20.0)
    zoning_far: float = Field(default=3.0, ge=0.1, le=30.0)
    max_height_ft: float = Field(default=120.0, ge=20.0, le=2000.0)
    zonedist1: Optional[str] = None
    zonedist2: Optional[str] = None
    overlay1: Optional[str] = None
    overlay2: Optional[str] = None
    bldgarea: Optional[float] = None
    numfloors: Optional[float] = None
    lot_area: Optional[float] = None
    built_far: Optional[float] = None
    resid_far: Optional[float] = None
    comm_far: Optional[float] = None
    facil_far: Optional[float] = None
    bbl: Optional[str] = None
    upzone: bool = False


def _borough_code_to_numeric(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip().upper()
    code_map = {"MN": "1", "M": "1", "BX": "2", "B": "2", "BK": "3", "K": "3", "QN": "4", "Q": "4", "SI": "5", "S": "5"}
    if text in code_map:
        return code_map[text]
    if text in {"1", "2", "3", "4", "5"}:
        return text
    return None


def _coerce_float(value: Any) -> Optional[float]:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _coerce_str(value: Any) -> Optional[str]:
    if value in (None, ""):
        return None
    text = str(value).strip()
    return text or None


def _coerce_int_str(value: Any) -> Optional[str]:
    number = _coerce_float(value)
    if number is None:
        return None
    return str(int(number))


def _close_ring(coords: List[List[float]]) -> List[List[float]]:
    if len(coords) < 3:
        raise HTTPException(status_code=400, detail="lot_polygon requires at least 3 points")
    if coords[0] != coords[-1]:
        return coords + [coords[0]]
    return coords


def _rings_to_lot_polygon(rings: Any) -> List[List[float]]:
    if not rings or not isinstance(rings, list):
        raise HTTPException(status_code=502, detail="Lot geometry missing from MapPLUTO response")
    outer = rings[0]
    if not outer or len(outer) < 4:
        raise HTTPException(status_code=502, detail="Lot geometry ring is invalid")
    polygon = [[float(p[0]), float(p[1])] for p in outer]
    return _close_ring(polygon)


def _feature_geometry_to_lot_polygon(geometry: Dict[str, Any]) -> Optional[List[List[float]]]:
    geom_type = geometry.get("type")
    coords = geometry.get("coordinates")
    if geom_type == "Polygon" and coords and coords[0]:
        return _close_ring([[float(p[0]), float(p[1])] for p in coords[0]])
    if geom_type == "MultiPolygon" and coords and coords[0] and coords[0][0]:
        return _close_ring([[float(p[0]), float(p[1])] for p in coords[0][0]])
    return None


def _project_ring_to_feet(coords: List[List[float]]) -> List[Tuple[float, float]]:
    ring = _close_ring(coords)
    lons = [pt[0] for pt in ring[:-1]]
    lats = [pt[1] for pt in ring[:-1]]
    lon0 = sum(lons) / len(lons)
    lat0 = sum(lats) / len(lats)
    feet_per_meter = 3.28083989501312
    meters_per_degree_lat = 111_320.0
    meters_per_degree_lon = 111_320.0 * math.cos(math.radians(lat0))

    projected: List[Tuple[float, float]] = []
    for lon, lat in ring:
        x = (lon - lon0) * meters_per_degree_lon * feet_per_meter
        y = (lat - lat0) * meters_per_degree_lat * feet_per_meter
        projected.append((x, y))
    return projected


def _polygon_area_square_feet(coords: List[List[float]]) -> float:
    ring = _project_ring_to_feet(coords)
    area = 0.0
    for idx in range(len(ring) - 1):
        x1, y1 = ring[idx]
        x2, y2 = ring[idx + 1]
        area += x1 * y2 - x2 * y1
    return abs(area) * 0.5


def _ring_centroid(coords: List[List[float]]) -> Tuple[float, float]:
    ring = _close_ring(coords)[:-1]
    lon = sum(point[0] for point in ring) / len(ring)
    lat = sum(point[1] for point in ring) / len(ring)
    return lon, lat


def _scale_ring(coords: List[List[float]], scale: float) -> List[List[float]]:
    ring = _close_ring(coords)
    scale = max(0.05, min(scale, 1.0))
    cx, cy = _ring_centroid(ring)
    scaled = [[cx + (lon - cx) * scale, cy + (lat - cy) * scale] for lon, lat in ring[:-1]]
    return _close_ring(scaled)


def _extract_zone_tokens(*values: Optional[str]) -> List[str]:
    tokens: List[str] = []
    for value in values:
        if not value:
            continue
        cleaned = str(value).upper().replace("/", " ").replace(",", " ")
        for token in cleaned.split():
            token = token.strip("();")
            if token and token[0] in {"R", "C", "M"} and token not in tokens:
                tokens.append(token)
    return tokens


def _zone_priority(zone: str) -> Tuple[int, int]:
    if zone.startswith("R") or zone.startswith("M"):
        return (3, len(zone))
    if zone.startswith(("C3", "C4", "C5", "C6", "C8")):
        return (3, len(zone))
    if zone.startswith(("C1", "C2", "C7")):
        return (1, len(zone))
    return (2, len(zone))


def _fallback_zone_rule(zone: str) -> Dict[str, float]:
    if zone.startswith("R") and len(zone) > 1 and zone[1].isdigit():
        digit = int(zone[1])
        far_by_digit = {1: 0.5, 2: 0.5, 3: 0.6, 4: 0.75, 5: 1.25, 6: 2.43, 7: 3.44, 8: 6.02, 9: 7.52}
        height_by_digit = {1: 35.0, 2: 35.0, 3: 35.0, 4: 45.0, 5: 55.0, 6: 70.0, 7: 100.0, 8: 120.0, 9: 145.0}
        coverage = 0.75 if digit >= 6 else 0.6
        if zone.endswith("A"):
            coverage = min(0.88, coverage + 0.05)
        elif zone.endswith("B"):
            coverage = max(0.55, coverage - 0.08)
        elif zone.endswith("D"):
            coverage = min(0.9, coverage + 0.08)
        return {
            "far": far_by_digit.get(digit, DEFAULT_ZONE_RULE["far"]),
            "max_height_ft": height_by_digit.get(digit, DEFAULT_ZONE_RULE["max_height_ft"]),
            "coverage": coverage,
        }

    if zone.startswith("C"):
        if zone.startswith(("C1", "C2")):
            return {"far": 2.0, "max_height_ft": 70.0, "coverage": 0.8}
        if zone.startswith("C4"):
            return {"far": 4.0, "max_height_ft": 120.0, "coverage": 0.88}
        if zone.startswith("C5"):
            return {"far": 8.0, "max_height_ft": 210.0, "coverage": 0.92}
        if zone.startswith("C6"):
            return {"far": 10.0, "max_height_ft": 210.0, "coverage": 0.94}
        return {"far": 4.0, "max_height_ft": 120.0, "coverage": 0.88}

    if zone.startswith("M"):
        return {"far": 2.0, "max_height_ft": 85.0, "coverage": 0.9}

    return dict(DEFAULT_ZONE_RULE)


def _resolve_zoning_analysis(
    zonedist1: Optional[str],
    zonedist2: Optional[str],
    overlay1: Optional[str] = None,
    overlay2: Optional[str] = None,
    resid_far: Optional[float] = None,
    comm_far: Optional[float] = None,
    facil_far: Optional[float] = None,
    built_far: Optional[float] = None,
    requested_far: Optional[float] = None,
    requested_height_ft: Optional[float] = None,
    lot_coverage: Optional[float] = None,
    use_type: str = "market_rate",
    upzone: bool = False,
) -> Dict[str, Any]:
    candidates = _extract_zone_tokens(zonedist1, zonedist2)
    primary_zone = max(candidates, key=_zone_priority) if candidates else None
    base_rule = dict(ZONE_RULES.get(primary_zone or "", _fallback_zone_rule(primary_zone or "")))
    overlays = _extract_zone_tokens(overlay1, overlay2)

    affordable_multiplier = 1.2 if use_type == "affordable" and primary_zone and primary_zone.startswith("R") else 1.0
    far_candidates = [base_rule["far"]]
    if resid_far and resid_far > 0:
        far_candidates.append(resid_far)
    if facil_far and facil_far > 0:
        far_candidates.append(facil_far)
    if comm_far and comm_far > 0 and ((primary_zone or "").startswith("C") or overlays):
        far_candidates.append(comm_far)
    base_far = max(far_candidates)
    scenario_far = requested_far if requested_far is not None else base_far
    if upzone:
        scenario_far = max(scenario_far, round(base_far * 1.35, 3))
    scenario_far = max(0.1, scenario_far) * affordable_multiplier

    max_height_ft = requested_height_ft if requested_height_ft is not None else base_rule["max_height_ft"]
    if upzone:
        max_height_ft = max(max_height_ft, base_rule["max_height_ft"] * 1.2)

    coverage_ratio = lot_coverage if lot_coverage is not None else base_rule["coverage"]
    coverage_ratio = max(0.2, min(1.0, coverage_ratio))

    return {
        "primary_zone": primary_zone,
        "candidate_zones": candidates,
        "commercial_overlays": overlays,
        "base_far": round(base_far, 3),
        "existing_far": round(built_far or 0.0, 3),
        "residential_far": round(resid_far or 0.0, 3),
        "commercial_far": round(comm_far or 0.0, 3),
        "facility_far": round(facil_far or 0.0, 3),
        "scenario_far": round(scenario_far, 3),
        "max_height_ft": round(max_height_ft, 2),
        "coverage_ratio": round(coverage_ratio, 3),
        "use_type": use_type,
        "upzone": upzone,
    }


def _estimate_existing_building_coverage(numfloors: Optional[float], bldgarea: Optional[float], lot_area_ft2: float) -> float:
    if lot_area_ft2 <= 0:
        return 0.55
    floors = max(1.0, numfloors or 1.0)
    if bldgarea and bldgarea > 0:
        return max(0.15, min(0.98, bldgarea / (lot_area_ft2 * floors)))
    return 0.55


def _estimate_existing_building_height_ft(numfloors: Optional[float], bldgarea: Optional[float], lot_area_ft2: float, floor_height_ft: float) -> float:
    floors = numfloors or 0.0
    if floors <= 0 and bldgarea and lot_area_ft2 > 0:
        coverage = _estimate_existing_building_coverage(numfloors, bldgarea, lot_area_ft2)
        floors = max(1.0, bldgarea / (lot_area_ft2 * max(coverage, 0.15)))
    floors = max(1.0, floors)
    return round(floors * floor_height_ft, 2)


def _build_study_geojson(payload: EnvelopeRequest, lot_area_ft2: float, zoning: Dict[str, Any]) -> Dict[str, Any]:
    outer = _close_ring(payload.lot_polygon)
    coverage_ratio = max(0.2, min(1.0, zoning["coverage_ratio"]))
    far_limited_height_ft = max(15.0, zoning["scenario_far"] * payload.floor_height_ft / coverage_ratio)
    zoning_height_ft = round(min(zoning["max_height_ft"], far_limited_height_ft), 2)

    existing_height_ft = _estimate_existing_building_height_ft(
        payload.numfloors,
        payload.bldgarea,
        lot_area_ft2,
        payload.floor_height_ft,
    )
    existing_coverage = _estimate_existing_building_coverage(payload.numfloors, payload.bldgarea, lot_area_ft2)
    envelope_ring = _scale_ring(outer, math.sqrt(coverage_ratio)) if coverage_ratio < 0.98 else outer
    existing_ring = _scale_ring(outer, math.sqrt(existing_coverage)) if existing_coverage < 0.98 else outer

    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "kind": "selected_lot",
                    "height_ft": 0,
                    "base_ft": 0,
                    "color": "#facc15",
                    "opacity": 0.12,
                },
                "geometry": {"type": "Polygon", "coordinates": [outer]},
            },
            {
                "type": "Feature",
                "properties": {
                    "kind": "existing_building",
                    "height_ft": existing_height_ft,
                    "base_ft": 0,
                    "color": "#475569",
                    "opacity": 0.82,
                    "coverage_ratio": round(existing_coverage, 3),
                },
                "geometry": {"type": "Polygon", "coordinates": [existing_ring]},
            },
            {
                "type": "Feature",
                "properties": {
                    "kind": "zoning_envelope",
                    "height_ft": zoning_height_ft,
                    "base_ft": 0,
                    "color": "#2563eb",
                    "opacity": 0.38,
                    "coverage_ratio": round(coverage_ratio, 3),
                },
                "geometry": {"type": "Polygon", "coordinates": [envelope_ring]},
            },
        ],
    }


def _point_in_ring(lng: float, lat: float, ring: List[List[float]]) -> bool:
    ring = _close_ring(ring)
    inside = False
    for idx in range(len(ring) - 1):
        x1, y1 = ring[idx]
        x2, y2 = ring[idx + 1]
        intersects = ((y1 > lat) != (y2 > lat)) and (
            lng < (x2 - x1) * (lat - y1) / ((y2 - y1) or 1e-12) + x1
        )
        if intersects:
            inside = not inside
    return inside


def _point_in_feature_geometry(lng: float, lat: float, geometry: Dict[str, Any]) -> bool:
    polygon = _feature_geometry_to_lot_polygon(geometry)
    if not polygon:
        return False
    return _point_in_ring(lng, lat, polygon)


def _feature_property(feature: Dict[str, Any], *keys: str) -> Any:
    props = feature.get("properties") or {}
    lowered = {str(key).lower(): value for key, value in props.items()}
    for key in keys:
        if key in props:
            return props[key]
        lowered_key = key.lower()
        if lowered_key in lowered:
            return lowered[lowered_key]
    return None


@lru_cache(maxsize=1)
def _split_geojson_paths() -> Tuple[Path, ...]:
    split_root = Path(SPLIT_PLUTO_DIR)
    paths = list(split_root.glob("*.geojson")) if split_root.exists() else []
    return tuple(sorted(paths))


def _split_display_name(path: Path) -> str:
    name = path.stem
    if name.lower().startswith("pluto_"):
        name = name[6:]
    return name.replace("_", " ")


def _remote_split_url(filename: str) -> str:
    return f"{SPLIT_PLUTO_BASE_URL.rstrip('/')}/{filename}"


@lru_cache(maxsize=128)
def _load_geojson_file(path_str: str) -> Dict[str, Any]:
    with open(path_str, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _iter_split_features() -> Iterable[Tuple[Path, Dict[str, Any]]]:
    for path in _split_geojson_paths():
        payload = _load_geojson_file(str(path))
        for feature in payload.get("features") or []:
            yield path, feature


def _split_feature_to_lot_record(feature: Dict[str, Any], lot_polygon: List[List[float]], source_path: str) -> Dict[str, Any]:
    borough_value = _feature_property(feature, "borough", "Borough", "boro")
    zonedist1 = _coerce_str(_feature_property(feature, "zonedist1", "ZoneDist1", "zone"))
    zonedist2 = _coerce_str(_feature_property(feature, "zonedist2", "ZoneDist2"))
    overlay1 = _coerce_str(_feature_property(feature, "overlay1", "Overlay1"))
    overlay2 = _coerce_str(_feature_property(feature, "overlay2", "Overlay2"))
    built_far = _coerce_float(_feature_property(feature, "builtfar", "BuiltFAR"))
    resid_far = _coerce_float(_feature_property(feature, "residfar", "ResidFAR"))
    comm_far = _coerce_float(_feature_property(feature, "commfar", "CommFAR"))
    facil_far = _coerce_float(_feature_property(feature, "facilfar", "FacilFAR"))
    zoning = _resolve_zoning_analysis(
        zonedist1,
        zonedist2,
        overlay1=overlay1,
        overlay2=overlay2,
        resid_far=resid_far,
        comm_far=comm_far,
        facil_far=facil_far,
        built_far=built_far,
    )
    return {
        "bbl": _coerce_str(_feature_property(feature, "bbl", "BBL")),
        "borough": _borough_code_to_numeric(_coerce_str(borough_value)),
        "borough_raw": _coerce_str(borough_value),
        "block": _coerce_int_str(_feature_property(feature, "block", "Block")),
        "lot": _coerce_int_str(_feature_property(feature, "lot", "Lot")),
        "address": _coerce_str(_feature_property(feature, "address", "Address")),
        "zone": zoning["primary_zone"] or zonedist1 or zonedist2,
        "zonedist1": zonedist1,
        "zonedist2": zonedist2,
        "overlay1": overlay1,
        "overlay2": overlay2,
        "landuse": _feature_property(feature, "landuse", "LandUse"),
        "lot_area": _coerce_float(_feature_property(feature, "lotarea", "LotArea")),
        "bldgarea": _coerce_float(_feature_property(feature, "bldgarea", "BldgArea")),
        "numfloors": _coerce_float(_feature_property(feature, "numfloors", "NumFloors")),
        "built_far": built_far,
        "resid_far": resid_far,
        "comm_far": comm_far,
        "facil_far": facil_far,
        "lot_polygon": lot_polygon,
        "source": f"split:{source_path}",
        "zoning_analysis": zoning,
    }


def _find_split_feature_by_bbl(borough: str, block: str, lot: str) -> Optional[Dict[str, Any]]:
    borough_numeric = _borough_code_to_numeric(borough)
    block_num = str(int(block))
    lot_num = str(int(lot))
    for path, feature in _iter_split_features():
        lot_polygon = _feature_geometry_to_lot_polygon(feature.get("geometry") or {})
        if not lot_polygon:
            continue
        feature_borough = _borough_code_to_numeric(_coerce_str(_feature_property(feature, "borough", "Borough", "boro")))
        feature_block = _coerce_int_str(_feature_property(feature, "block", "Block"))
        feature_lot = _coerce_int_str(_feature_property(feature, "lot", "Lot"))
        if feature_borough == borough_numeric and feature_block == block_num and feature_lot == lot_num:
            return _split_feature_to_lot_record(feature, lot_polygon, path.relative_to(SPLIT_PLUTO_DIR).as_posix())
    return None


def _find_split_feature_by_point(lng: float, lat: float) -> Optional[Dict[str, Any]]:
    for path, feature in _iter_split_features():
        geometry = feature.get("geometry") or {}
        if not _point_in_feature_geometry(lng, lat, geometry):
            continue
        lot_polygon = _feature_geometry_to_lot_polygon(geometry)
        if not lot_polygon:
            continue
        return _split_feature_to_lot_record(feature, lot_polygon, path.relative_to(SPLIT_PLUTO_DIR).as_posix())
    return None


def _query_mappluto_lot(conditions: str) -> Optional[Dict[str, Any]]:
    params = {
        "f": "json",
        "where": conditions,
        "outFields": "Borough,Block,Lot,BBL,Address,ZoneDist1,ZoneDist2,Overlay1,Overlay2,LotArea,BldgArea,NumFloors,LandUse,BuiltFAR,ResidFAR,CommFAR,FacilFAR",
        "returnGeometry": "true",
        "outSR": "4326",
        "resultRecordCount": "1",
    }
    try:
        resp = requests.get(MAPPLUTO_QUERY_URL, params=params, timeout=15)
    except requests.RequestException:
        return None

    if not resp.ok:
        return None

    payload = resp.json()
    features = payload.get("features") or []
    if not features:
        return None
    return features[0]


def _compose_lot_response(row: Dict[str, Any], lot_polygon: Optional[List[List[float]]], source: str) -> Dict[str, Any]:
    z1 = _coerce_str(row.get("zonedist1") or row.get("ZoneDist1") or row.get("zone"))
    z2 = _coerce_str(row.get("zonedist2") or row.get("ZoneDist2"))
    overlay1 = _coerce_str(row.get("overlay1") or row.get("Overlay1"))
    overlay2 = _coerce_str(row.get("overlay2") or row.get("Overlay2"))
    built_far = _coerce_float(row.get("built_far") or row.get("BuiltFAR"))
    resid_far = _coerce_float(row.get("resid_far") or row.get("ResidFAR"))
    comm_far = _coerce_float(row.get("comm_far") or row.get("CommFAR"))
    facil_far = _coerce_float(row.get("facil_far") or row.get("FacilFAR"))
    zoning = _resolve_zoning_analysis(
        z1,
        z2,
        overlay1=overlay1,
        overlay2=overlay2,
        resid_far=resid_far,
        comm_far=comm_far,
        facil_far=facil_far,
        built_far=built_far,
    )
    return {
        "bbl": _coerce_str(row.get("bbl") or row.get("BBL")),
        "borough": _coerce_str(row.get("borough") or row.get("Borough")),
        "borough_raw": _coerce_str(row.get("Borough")),
        "block": _coerce_int_str(row.get("block") or row.get("Block")),
        "lot": _coerce_int_str(row.get("lot") or row.get("Lot")),
        "address": _coerce_str(row.get("address") or row.get("Address")),
        "zone": zoning["primary_zone"] or z1 or z2,
        "zonedist1": z1,
        "zonedist2": z2,
        "overlay1": overlay1,
        "overlay2": overlay2,
        "landuse": row.get("landuse") or row.get("LandUse"),
        "lot_area": _coerce_float(row.get("lot_area") or row.get("LotArea")),
        "bldgarea": _coerce_float(row.get("bldgarea") or row.get("BldgArea")),
        "numfloors": _coerce_float(row.get("numfloors") or row.get("NumFloors")),
        "built_far": built_far,
        "resid_far": resid_far,
        "comm_far": comm_far,
        "facil_far": facil_far,
        "lot_polygon": lot_polygon,
        "source": source,
        "zoning_analysis": zoning,
    }


@app.get("/")
def root() -> FileResponse:
    return FileResponse(os.path.join(WEB_DIR, "index.html"))


@app.get("/favicon.ico")
def favicon() -> Response:
    icon_path = os.path.join(WEB_DIR, "favicon.svg")
    if os.path.isfile(icon_path):
        return FileResponse(icon_path, media_type="image/svg+xml")
    return Response(status_code=204)


@app.get("/api/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/api/config")
def frontend_config() -> Dict[str, str]:
    token = (
        os.getenv("MAPBOX_TOKEN")
        or os.getenv("MAPBOX_PUBLIC_TOKEN")
        or os.getenv("MAPBOX_ACCESS_TOKEN")
        or ""
    )
    return {"mapboxToken": token}


@app.get("/api/data/splits")
def list_split_files() -> Dict[str, Any]:
    try:
        local_paths = _split_geojson_paths()
        if local_paths:
            files = []
            for path in local_paths:
                rel = path.relative_to(SPLIT_PLUTO_DIR).as_posix()
                files.append(
                    {
                        "id": path.stem,
                        "name": _split_display_name(path),
                        "path": rel,
                        "url": f"/split_pluto/{rel}",
                        "size_bytes": path.stat().st_size,
                    }
                )
            return {"files": files, "count": len(files)}

        # Primary remote source: user-maintained S3 index file.
        if os.path.isfile(GEOJSON_INDEX_PATH):
            with open(GEOJSON_INDEX_PATH, "r", encoding="utf-8-sig") as fh:
                index_payload = json.load(fh)
            if isinstance(index_payload, dict):
                index_entries = index_payload.get("files") or []
            elif isinstance(index_payload, list):
                index_entries = index_payload
            else:
                index_entries = []
            files = []
            for entry in index_entries or []:
                if not isinstance(entry, dict):
                    continue
                filename = _coerce_str(entry.get("name")) or Path(_coerce_str(entry.get("key") or "")).name
                if not filename:
                    continue
                entry_stem = Path(filename).stem
                files.append(
                    {
                        "id": entry_stem,
                        "name": _split_display_name(Path(filename)),
                        "path": _coerce_str(entry.get("key")) or filename,
                        "url": _coerce_str(entry.get("url")) or _remote_split_url(filename),
                        "size_bytes": 0,
                    }
                )
            return {"files": files, "count": len(files)}

        # Fallback: read the pre-built manifest (used on Vercel where split_pluto/ is excluded)
        if os.path.isfile(SPLIT_PLUTO_MANIFEST):
            with open(SPLIT_PLUTO_MANIFEST, "r", encoding="utf-8") as fh:
                manifest = json.load(fh)
            files = [
                {
                    "id": entry["id"],
                    "name": entry["name"],
                    "path": entry["filename"],
                    "url": _remote_split_url(entry["filename"]),
                    "size_bytes": 0,
                }
                for entry in (manifest.get("files") or [])
            ]
            return {"files": files, "count": len(files)}
    except Exception:
        return {"files": [], "count": 0}

    return {"files": [], "count": 0}


@app.get("/api/lot/{borough}/{block}/{lot}")
def get_lot_by_bbl_parts(borough: str, block: str, lot: str) -> Dict[str, Any]:
    boro_map = {"M": "1", "B": "2", "K": "3", "Q": "4", "S": "5"}
    b = borough.strip().upper()
    b = boro_map.get(b, b)

    block_num = str(int(block))
    lot_num = str(int(lot))

    query = (
        "https://data.cityofnewyork.us/resource/64uk-42ks.json"
        f"?$select=bbl,borough,block,lot,address,zonedist1,zonedist2,overlay1,overlay2,landuse,lotarea,bldgarea,numfloors,builtfar,residfar,commfar,facilfar"
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
    split_match = _find_split_feature_by_bbl(b, block_num, lot_num)
    if split_match:
        merged = dict(row)
        if not merged.get("zonedist1"):
            merged["zonedist1"] = split_match.get("zonedist1")
        if not merged.get("zonedist2"):
            merged["zonedist2"] = split_match.get("zonedist2")
        if not merged.get("bldgarea"):
            merged["bldgarea"] = split_match.get("bldgarea")
        if not merged.get("numfloors"):
            merged["numfloors"] = split_match.get("numfloors")
        response = _compose_lot_response(merged, split_match["lot_polygon"], split_match["source"])
        response["borough"] = row.get("borough")
        return response

    lot_polygon = None
    borough_mappluto = {"1": "MN", "2": "BX", "3": "BK", "4": "QN", "5": "SI"}
    where = f"Borough='{borough_mappluto.get(b, b)}' AND Block={int(block_num)} AND Lot={int(lot_num)}"
    feature = _query_mappluto_lot(where)
    if feature:
        geom = feature.get("geometry") or {}
        rings = geom.get("rings")
        if rings:
            lot_polygon = _rings_to_lot_polygon(rings)

    response = _compose_lot_response(row, lot_polygon, "mappluto")
    response["borough"] = row.get("borough")
    return response


@app.get("/api/lot_at_point")
def get_lot_at_point(lng: float, lat: float) -> Dict[str, Any]:
    split_match = _find_split_feature_by_point(lng, lat)
    if split_match:
        return split_match

    params = {
        "f": "json",
        "where": "1=1",
        "outFields": "Borough,Block,Lot,BBL,Address,ZoneDist1,ZoneDist2,Overlay1,Overlay2,LotArea,BldgArea,NumFloors,LandUse,BuiltFAR,ResidFAR,CommFAR,FacilFAR",
        "geometry": f"{lng},{lat}",
        "geometryType": "esriGeometryPoint",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "returnGeometry": "true",
        "outSR": "4326",
        "resultRecordCount": "1",
    }

    try:
        resp = requests.get(MAPPLUTO_QUERY_URL, params=params, timeout=15)
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"MapPLUTO query failed: {exc}")

    if not resp.ok:
        raise HTTPException(status_code=502, detail="Failed to query MapPLUTO")

    payload = resp.json()
    features = payload.get("features") or []
    if not features:
        raise HTTPException(status_code=404, detail="No lot found at clicked location")

    feat = features[0]
    attrs = feat.get("attributes") or {}
    geom = feat.get("geometry") or {}
    lot_polygon = _rings_to_lot_polygon(geom.get("rings"))

    response = _compose_lot_response(attrs, lot_polygon, "mappluto")
    response["borough"] = _borough_code_to_numeric(_coerce_str(attrs.get("Borough")))
    response["borough_raw"] = _coerce_str(attrs.get("Borough"))
    return response


@app.post("/api/envelope")
def build_envelope(payload: EnvelopeRequest) -> Dict[str, Any]:
    outer = _close_ring(payload.lot_polygon)
    lot_area_ft2 = _polygon_area_square_feet(outer)
    use_type = payload.use_type.lower().strip()

    zoning = _resolve_zoning_analysis(
        payload.zonedist1,
        payload.zonedist2,
        overlay1=payload.overlay1,
        overlay2=payload.overlay2,
        resid_far=payload.resid_far,
        comm_far=payload.comm_far,
        facil_far=payload.facil_far,
        built_far=payload.built_far,
        requested_far=payload.zoning_far,
        requested_height_ft=payload.max_height_ft,
        lot_coverage=payload.lot_coverage if payload.far_mode else None,
        use_type=use_type,
        upzone=payload.upzone,
    )
    geojson = _build_study_geojson(payload, lot_area_ft2, zoning)

    existing_feature = next(feature for feature in geojson["features"] if feature["properties"]["kind"] == "existing_building")
    zoning_feature = next(feature for feature in geojson["features"] if feature["properties"]["kind"] == "zoning_envelope")

    return {
        "inputs": payload.model_dump(),
        "results": {
            "use_type": use_type,
            "zoning_analysis": zoning,
            "lot_area_ft2": round(lot_area_ft2, 2),
            "existing_building_height_ft": existing_feature["properties"]["height_ft"],
            "existing_building_coverage_ratio": existing_feature["properties"]["coverage_ratio"],
            "full_envelope_height_ft": zoning_feature["properties"]["height_ft"],
            "full_envelope_coverage_ratio": zoning_feature["properties"]["coverage_ratio"],
        },
        "geojson": geojson,
    }
