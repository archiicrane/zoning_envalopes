import json
import math
import os
import re
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
ZONING_RULES_PATH = os.path.join(WEB_DIR, "zoning-rules.jsonld")
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

DEFAULT_ZONE_RULE = {"far": 3.0, "max_height_ft": 85.0, "coverage": 0.8}


class EnvelopeRequest(BaseModel):
    lot_polygon: List[List[float]] = Field(..., description="[[lng, lat], ...] closed or open")
    use_type: str = Field(default="market_rate")
    building_use_type: Optional[str] = Field(default="residential")
    housing_type: Optional[str] = Field(default="marketRate")
    footnote_variant: Optional[str] = Field(default=None)
    far_mode: bool = Field(default=False)
    lot_coverage: float = Field(default=0.75, ge=0.2, le=1.0)
    floor_height_ft: float = Field(default=10.0, ge=8.0, le=20.0)
    zoning_far: float = Field(default=3.0, ge=0.1, le=30.0)
    max_height_ft: Optional[float] = Field(default=None, ge=20.0, le=2000.0)
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


def _ring_inset_scale(coords: List[List[float]], inset_ft: float) -> float:
    if inset_ft <= 0:
        return 1.0

    ring = _project_ring_to_feet(coords)
    xs = [point[0] for point in ring[:-1]]
    ys = [point[1] for point in ring[:-1]]
    width = max(xs) - min(xs)
    depth = max(ys) - min(ys)
    if width <= 0 or depth <= 0:
        return 1.0

    scale_x = max(0.05, (width - (2 * inset_ft)) / width)
    scale_y = max(0.05, (depth - (2 * inset_ft)) / depth)
    return max(0.05, min(1.0, min(scale_x, scale_y)))


def _extract_zone_tokens(*values: Optional[str]) -> List[str]:
    tokens: List[str] = []
    for value in values:
        if not value:
            continue
        cleaned = str(value).upper()
        # Treat mixed designations like "M1-R6A" as two zoning tokens while preserving
        # standard district suffixes like "M1-1".
        cleaned = re.sub(r"(?<=\d)-(?=[RCM])", " ", cleaned)
        cleaned = (
            cleaned.replace("/", " ")
            .replace(",", " ")
            .replace(";", " ")
            .replace("(", " ")
            .replace(")", " ")
        )
        for token in cleaned.split():
            token = token.strip("();")
            if token and token[0] in {"R", "C", "M"} and token not in tokens:
                tokens.append(token)
    return tokens


def _normalize_zone_token(value: Optional[str]) -> str:
    return str(value or "").strip().upper().replace(" ", "")


def _normalize_building_use_type(value: Optional[str]) -> str:
    text = str(value or "residential").strip()
    if text in {"communityFacility", "facility"}:
        return "communityFacility"
    if text in {"nonResidential", "commercial", "non_residential"}:
        return "nonResidential"
    if text in {"mixedUse", "mixed"}:
        return "mixedUse"
    return "residential"


def _normalize_housing_type(value: Optional[str], use_type: Optional[str]) -> str:
    text = str(value or "").strip()
    if text in {"qualifyingAffordable", "affordable", "qualifyingSenior", "senior", "qualifyingAffordableOrSenior", "affordableOrSenior", "affordable_or_senior"}:
        return "qualifyingAffordableOrSenior"
    if str(use_type or "").strip().lower() in {"affordable", "senior", "affordable_or_senior"}:
        return "qualifyingAffordableOrSenior"
    return "marketRate"


def _normalize_rule_variants(rule: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    standard_far = _coerce_float(rule.get("standardFar")) or _coerce_float(rule.get("maxFar")) or _coerce_float(rule.get("qualifyingFar"))
    qualifying_far = _coerce_float(rule.get("qualifyingFar")) or standard_far
    base_variant = {
        "minimumBaseHeightFt": rule.get("minimumBaseHeightFt"),
        "maximumBaseHeightFt": rule.get("maximumBaseHeightFt"),
        "maximumBuildingHeightFt": rule.get("maximumBuildingHeightFt"),
        "maximumFrontWallHeightFt": rule.get("maximumFrontWallHeightFt"),
        "perimeterWallHeightFt": rule.get("perimeterWallHeightFt"),
        "ridgeHeightFt": rule.get("ridgeHeightFt"),
        "streetSetbackWideFt": rule.get("streetSetbackWideFt"),
        "streetSetbackNarrowFt": rule.get("streetSetbackNarrowFt"),
        "openSpaceRatio": rule.get("openSpaceRatio"),
        "usesOpenSpaceRatio": rule.get("usesOpenSpaceRatio"),
        "frontYardFt": rule.get("frontYardFt"),
        "sideYardEachFt": rule.get("sideYardEachFt"),
        "rearYardFt": rule.get("rearYardFt"),
        "bulkRegime": rule.get("bulkRegime"),
        "sourceSections": list(rule.get("sourceSections") or []),
        "notes": rule.get("notes"),
    }

    def _merge_variant_sources(*sources: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        merged: Dict[str, Any] = {}
        for source in sources:
            if isinstance(source, dict):
                merged.update(source)
        return merged

    def _merge_source_sections(*sources: Any) -> List[str]:
        merged: List[str] = []
        for source in sources:
            if isinstance(source, list):
                for value in source:
                    if value not in merged:
                        merged.append(value)
        return merged

    def _build_variant(label: str, far_value: Optional[float], variant: Dict[str, Any], fallback: Dict[str, Any]) -> Dict[str, Any]:
        merged = _merge_variant_sources(fallback, variant)
        return {
            "label": label,
            "far": _coerce_float(variant.get("far")) if variant.get("far") is not None else far_value,
            "minimumBaseHeightFt": _coerce_float(variant.get("minimumBaseHeightFt")) or _coerce_float(fallback.get("minimumBaseHeightFt")),
            "maximumBaseHeightFt": _coerce_float(variant.get("maximumBaseHeightFt")) or _coerce_float(fallback.get("maximumBaseHeightFt")),
            "maximumBuildingHeightFt": _coerce_float(variant.get("maximumBuildingHeightFt")) or _coerce_float(fallback.get("maximumBuildingHeightFt")),
            "maximumFrontWallHeightFt": _coerce_float(variant.get("maximumFrontWallHeightFt")) or _coerce_float(fallback.get("maximumFrontWallHeightFt")),
            "perimeterWallHeightFt": _coerce_float(variant.get("perimeterWallHeightFt")) or _coerce_float(fallback.get("perimeterWallHeightFt")),
            "ridgeHeightFt": _coerce_float(variant.get("ridgeHeightFt")) or _coerce_float(fallback.get("ridgeHeightFt")),
            "streetSetbackWideFt": _coerce_float(variant.get("streetSetbackWideFt")) or _coerce_float(fallback.get("streetSetbackWideFt")),
            "streetSetbackNarrowFt": _coerce_float(variant.get("streetSetbackNarrowFt")) or _coerce_float(fallback.get("streetSetbackNarrowFt")),
            "openSpaceRatio": _coerce_float(variant.get("openSpaceRatio")) or _coerce_float(fallback.get("openSpaceRatio")),
            "usesOpenSpaceRatio": merged.get("usesOpenSpaceRatio"),
            "frontYardFt": _coerce_float(variant.get("frontYardFt")) or _coerce_float(fallback.get("frontYardFt")),
            "sideYardEachFt": _coerce_float(variant.get("sideYardEachFt")) or _coerce_float(fallback.get("sideYardEachFt")),
            "rearYardFt": _coerce_float(variant.get("rearYardFt")) or _coerce_float(fallback.get("rearYardFt")),
            "bulkRegime": variant.get("bulkRegime") or fallback.get("bulkRegime"),
            "sourceSections": _merge_source_sections(fallback.get("sourceSections"), variant.get("sourceSections")),
            "notes": variant.get("notes") or fallback.get("notes"),
        }

    variants = rule.get("variants") if isinstance(rule.get("variants"), dict) else {}
    standard_source = dict(variants.get("standardResidential") or {})
    qualifying_source = _merge_variant_sources(
        variants.get("qualifyingAffordableOrSenior"),
        variants.get("qualifyingAffordableHousing"),
        variants.get("qualifyingSeniorHousing"),
    )
    structures_source = _merge_variant_sources(
        variants.get("buildingsOrOtherStructures"),
        variants.get("nonResidential"),
    )

    standard_variant = _build_variant("Market Rate / Standard Residential", standard_far, standard_source, base_variant)
    qualifying_variant = _build_variant("Qualifying Affordable or Senior Housing", qualifying_far, qualifying_source, standard_variant)
    structures_variant = _build_variant("Buildings or Other Structures", _coerce_float(structures_source.get("far")), structures_source, standard_variant)

    return {
        "standardResidential": standard_variant,
        "qualifyingAffordableOrSenior": qualifying_variant,
        "buildingsOrOtherStructures": structures_variant,
    }


def _select_variant_key(building_use_type: str, housing_type: str) -> str:
    if building_use_type in {"nonResidential", "communityFacility"}:
        return "buildingsOrOtherStructures"
    if housing_type == "qualifyingAffordableOrSenior":
        return "qualifyingAffordableOrSenior"
    return "standardResidential"


def _resolve_zr_variant(zone: str, building_use_type: str, housing_type: str, footnote_variant: Optional[str]) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    warnings: List[str] = []
    rules = _load_zr_rules_index()

    zone_token = _normalize_zone_token(zone)
    footnote_token = _normalize_zone_token(footnote_variant)
    candidates: List[str] = []
    if footnote_token:
                candidates.append(footnote_token)
                if "-2" in footnote_token:
                        candidates.append(footnote_token.replace("-2", "^2"))
                        if zone_token:
                                candidates.append(f"{zone_token}^2")
    if zone_token:
                candidates.append(zone_token)

    unique_candidates: List[str] = []
    for candidate in candidates:
        if candidate and candidate not in unique_candidates:
            unique_candidates.append(candidate)

    direct = None
    matched_zone = None
    for candidate in unique_candidates:
        if candidate in rules:
            matched_zone = candidate
            direct = rules[candidate]
            break

    if not direct:
        return None, [f"Missing zoning controls for {zone_token or '(unknown zone)'}."]

    equivalent = _normalize_zone_token(direct.get("residentialEquivalent"))
    base = rules.get(equivalent) if equivalent else None
    merged = dict(base or {})
    merged.update(direct)
    merged["zoneCode"] = matched_zone or zone_token

    variants = _normalize_rule_variants(merged)
    requested_variant = _select_variant_key(building_use_type, housing_type)
    selected_variant = requested_variant if requested_variant in variants else "standardResidential"
    if selected_variant not in variants:
        selected_variant = next(iter(variants.keys()), "standardResidential")
    if requested_variant not in variants:
        warnings.append(f"Requested variant '{requested_variant}' not found for {matched_zone}; using '{selected_variant}'.")

    variant = variants.get(selected_variant) or {}
    source_sections = list(dict.fromkeys([*(merged.get("sourceSections") or []), *(variant.get("sourceSections") or [])]))

    resolved = dict(merged)
    resolved.update({k: v for k, v in variant.items() if v is not None})
    resolved["sourceSections"] = source_sections
    resolved["selectedVariant"] = selected_variant
    resolved["variantLabel"] = variant.get("label") or selected_variant
    resolved["variants"] = variants
    return resolved, warnings


@lru_cache(maxsize=1)
def _load_zr_rules_index() -> Dict[str, Dict[str, Any]]:
    path = Path(ZONING_RULES_PATH)
    if not path.exists():
        return {}

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}

    rules = payload.get("rules") or []
    index: Dict[str, Dict[str, Any]] = {}
    for rule in rules:
        zone_code = _normalize_zone_token(rule.get("zoneCode"))
        if zone_code:
            index[zone_code] = rule
    return index


def _resolve_zr_rule(zone: str) -> Optional[Dict[str, Any]]:
    zone_token = _normalize_zone_token(zone)
    if not zone_token:
        return None

    rules = _load_zr_rules_index()
    direct = rules.get(zone_token)
    if not direct:
        return None

    equivalent = _normalize_zone_token(direct.get("residentialEquivalent"))
    if not equivalent:
        return dict(direct)

    base = rules.get(equivalent)
    if not base:
        return dict(direct)

    merged = dict(base)
    merged.update(direct)
    merged["zoneCode"] = direct.get("zoneCode", zone_token)
    return merged


def _rule_far(rule: Dict[str, Any], use_type: str) -> Optional[float]:
    direct_far = _coerce_float(rule.get("far"))
    if direct_far and direct_far > 0:
        return direct_far
    qualifying_far = _coerce_float(rule.get("qualifyingFar"))
    standard_far = _coerce_float(rule.get("standardFar"))
    if use_type == "affordable" and qualifying_far and qualifying_far > 0:
        return qualifying_far
    return standard_far if standard_far and standard_far > 0 else qualifying_far


def _rule_max_height_ft(rule: Dict[str, Any]) -> Optional[float]:
    for key in ("maximumBuildingHeightFt", "ridgeHeightFt", "maximumFrontWallHeightFt"):
        value = _coerce_float(rule.get(key))
        if value and value > 0:
            return value
    return None


def _rule_base_height_ft(rule: Dict[str, Any]) -> Optional[float]:
    for key in ("maximumBaseHeightFt", "perimeterWallHeightFt", "maximumFrontWallHeightFt"):
        value = _coerce_float(rule.get(key))
        if value and value > 0:
            return value
    return None


def _rule_street_setback_ft(rule: Dict[str, Any]) -> Optional[float]:
    for key in ("streetSetbackWideFt", "streetSetbackNarrowFt", "frontYardFt", "simplifiedPlanInsetFt"):
        value = _coerce_float(rule.get(key))
        if value and value > 0:
            return value
    return None


def _rule_rear_yard_ft(rule: Dict[str, Any]) -> Optional[float]:
    value = _coerce_float(rule.get("rearYardFt"))
    if value and value > 0:
        return value
    return None


def _zone_r_digit(zone: str) -> Optional[int]:
    token = _normalize_zone_token(zone)
    if not token.startswith("R") or len(token) < 2 or not token[1].isdigit():
        return None

    # Handles R6, R6A, R7-2, R10A
    idx = 1
    digits = []
    while idx < len(token) and token[idx].isdigit():
        digits.append(token[idx])
        idx += 1
    if not digits:
        return None
    return int("".join(digits))


def _rear_yard_requirement_ft(primary_zone: str, zr_rule: Optional[Dict[str, Any]]) -> Optional[float]:
    if zr_rule:
        rule_val = _rule_rear_yard_ft(zr_rule)
        if rule_val and rule_val > 0:
            return rule_val

    r_digit = _zone_r_digit(primary_zone)
    if r_digit is not None:
        return 30.0 if r_digit >= 6 else 20.0

    return None


def _open_space_ratio_required(primary_zone: str, bulk_regime: Optional[str], zr_rule: Optional[Dict[str, Any]]) -> Optional[float]:
    if zr_rule:
        for key in ("openSpaceRatio", "openSpaceRatioRequired"):
            value = _coerce_float(zr_rule.get(key))
            if value and value > 0:
                return value
    return None


def _district_type(zone: str) -> str:
    token = _normalize_zone_token(zone)
    if token.startswith("MX"):
        return "mixed"
    if token.startswith("R"):
        return "R"
    if token.startswith("C"):
        return "C"
    if token.startswith("M"):
        return "M"
    return "mixed"


def _is_contextual_regime(bulk_regime: Optional[str]) -> bool:
    regime = str(bulk_regime or "").lower()
    return regime.startswith("contextual")


def _build_parsed_district(zone: str) -> Dict[str, Any]:
    zone_token = _normalize_zone_token(zone)
    rule = _resolve_zr_rule(zone_token)
    fallback = _fallback_zone_rule(zone_token)
    max_far = _coerce_float((rule or {}).get("qualifyingFar")) or _coerce_float((rule or {}).get("standardFar")) or fallback["far"]
    standard_far = _coerce_float((rule or {}).get("standardFar")) or fallback["far"]
    qualifying_far = _coerce_float((rule or {}).get("qualifyingFar"))
    bulk_regime = (rule or {}).get("bulkRegime")
    height_limit_ft = _rule_max_height_ft(rule) if rule else _coerce_float(fallback.get("max_height_ft"))
    front_yard_ft = _coerce_float((rule or {}).get("frontYardFt")) or 0.0
    side_yard_ft = _coerce_float((rule or {}).get("sideYardEachFt")) or 0.0
    rear_yard_ft = _rear_yard_requirement_ft(zone_token, rule) or 0.0
    open_space_ratio = _open_space_ratio_required(zone_token, bulk_regime, rule)
    uses_open_space_ratio = bool(open_space_ratio and open_space_ratio > 0 and not _is_contextual_regime(bulk_regime))

    return {
        "zone": zone_token,
        "district_type": _district_type(zone_token),
        "residential_equivalent": _normalize_zone_token((rule or {}).get("residentialEquivalent")) or None,
        "standard_far": round(standard_far, 3) if standard_far else 0.0,
        "qualifying_far": round(qualifying_far, 3) if qualifying_far else None,
        "max_far": round(max_far, 3) if max_far else 0.0,
        "height_limit_ft": round(height_limit_ft, 2) if height_limit_ft else None,
        "front_yard_ft": round(front_yard_ft, 2),
        "side_yard_ft": round(side_yard_ft, 2),
        "rear_yard_ft": round(rear_yard_ft, 2),
        "uses_open_space_ratio": uses_open_space_ratio,
        "open_space_ratio": round(open_space_ratio, 3) if uses_open_space_ratio and open_space_ratio else None,
        "bulk_regime": bulk_regime,
        "has_contextual_rules": _is_contextual_regime(bulk_regime),
    }


def _zone_priority(zone: str) -> Tuple[int, int]:
    if zone.startswith("R"):
        return (4, len(zone))
    if zone.startswith(("C3", "C4", "C5", "C6", "C8")):
        return (3, len(zone))
    if zone.startswith("M"):
        return (2, len(zone))
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


def _coverage_fallback(zone: str) -> float:
    return _fallback_zone_rule(zone).get("coverage", DEFAULT_ZONE_RULE["coverage"])


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
    lot_area_ft2: Optional[float] = None,
    use_type: str = "market_rate",
    building_use_type: str = "residential",
    housing_type: str = "marketRate",
    footnote_variant: Optional[str] = None,
    upzone: bool = False,
) -> Dict[str, Any]:
    candidates = _extract_zone_tokens(zonedist1, zonedist2)
    primary_zone = max(candidates, key=_zone_priority) if candidates else None
    parsed_districts = [_build_parsed_district(zone) for zone in candidates]
    warnings: List[str] = []
    if len(candidates) > 1:
        warnings.append("Multiple zoning districts detected. Envelope is approximate.")
    if any(zone.startswith("MX") for zone in candidates):
        warnings.append("MX district detected. Envelope is approximate.")

    fallback_rule = _fallback_zone_rule(primary_zone or "")
    normalized_building_use = _normalize_building_use_type(building_use_type)
    normalized_housing = _normalize_housing_type(housing_type, use_type)
    zr_rule, variant_warnings = _resolve_zr_variant(
        primary_zone or "",
        normalized_building_use,
        normalized_housing,
        footnote_variant,
    )
    warnings.extend(variant_warnings)
    base_rule: Dict[str, Any] = {
        "far": fallback_rule.get("far"),
        "max_height_ft": None,
        "coverage": fallback_rule.get("coverage"),
    }
    if zr_rule:
        rule_far = _coerce_float(zr_rule.get("far")) or _rule_far(zr_rule, use_type)
        if rule_far and rule_far > 0:
            base_rule["far"] = rule_far
        rule_height = _rule_max_height_ft(zr_rule)
        if rule_height and rule_height > 0:
            base_rule["max_height_ft"] = rule_height
        base_rule["bulk_regime"] = zr_rule.get("bulkRegime")
        base_rule["base_height_ft"] = _rule_base_height_ft(zr_rule)
        base_rule["street_setback_ft"] = _rule_street_setback_ft(zr_rule)
        base_rule["rear_yard_ft"] = _rule_rear_yard_ft(zr_rule)
        simplified_inset_ft = _coerce_float(zr_rule.get("simplifiedPlanInsetFt"))
        if simplified_inset_ft and simplified_inset_ft > 0:
            base_rule["simplified_plan_inset_ft"] = simplified_inset_ft
        base_rule["source_sections"] = zr_rule.get("sourceSections") or []
    else:
        warnings.append("Missing full rule data for this condition.")
    overlays = _extract_zone_tokens(overlay1, overlay2)

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
    scenario_far = max(0.1, scenario_far)

    max_height_ft = requested_height_ft if requested_height_ft is not None else base_rule.get("max_height_ft")
    if upzone:
        if max_height_ft is not None and base_rule.get("max_height_ft") is not None:
            max_height_ft = max(max_height_ft, base_rule["max_height_ft"] * 1.2)

    if max_height_ft is None:
        warnings.append("Missing full rule data for this condition.")

    requested_coverage_ratio = lot_coverage if lot_coverage is not None else _coverage_fallback(primary_zone or "")
    requested_coverage_ratio = max(0.2, min(1.0, requested_coverage_ratio))

    front_yard_ft_required = _coerce_float((zr_rule or {}).get("frontYardFt")) or 0.0
    side_yard_ft_required = _coerce_float((zr_rule or {}).get("sideYardEachFt")) or 0.0
    rear_yard_ft_required = _rear_yard_requirement_ft(primary_zone or "", zr_rule) or 0.0
    open_space_ratio_required = _open_space_ratio_required(primary_zone or "", base_rule.get("bulk_regime"), zr_rule) or 0.0
    uses_open_space_ratio = bool(open_space_ratio_required > 0 and not _is_contextual_regime(base_rule.get("bulk_regime")))
    if not uses_open_space_ratio:
        open_space_ratio_required = 0.0

    open_space_required_ft2 = 0.0
    allowable_floor_area_ft2 = 0.0
    osr_coverage_cap: Optional[float] = None
    if open_space_ratio_required and open_space_ratio_required > 0 and lot_area_ft2 and lot_area_ft2 > 0:
        allowable_floor_area_ft2 = lot_area_ft2 * scenario_far
        osr_fraction = open_space_ratio_required / 100.0
        open_space_required_ft2 = allowable_floor_area_ft2 * osr_fraction
        osr_coverage_cap = 1.0 - (scenario_far * osr_fraction)

    coverage_ratio = requested_coverage_ratio
    if osr_coverage_cap is not None:
        coverage_ratio = min(coverage_ratio, osr_coverage_cap)
    coverage_ratio = max(0.05, min(1.0, coverage_ratio))

    return {
        "primary_zone": primary_zone,
        "candidate_zones": candidates,
        "parsed_districts": parsed_districts,
        "warnings": warnings,
        "commercial_overlays": overlays,
        "base_far": round(base_far, 3),
        "existing_far": round(built_far or 0.0, 3),
        "residential_far": round(resid_far or 0.0, 3),
        "commercial_far": round(comm_far or 0.0, 3),
        "facility_far": round(facil_far or 0.0, 3),
        "scenario_far": round(scenario_far, 3),
        "max_height_ft": round(max_height_ft, 2) if max_height_ft is not None else None,
        "requested_coverage_ratio": round(requested_coverage_ratio, 3),
        "coverage_ratio": round(coverage_ratio, 3),
        "coverage_ratio_limited_by_open_space": bool(osr_coverage_cap is not None and coverage_ratio < requested_coverage_ratio),
        "allowable_floor_area_ft2": round(allowable_floor_area_ft2 or ((lot_area_ft2 or 0.0) * scenario_far), 2),
        "front_yard_ft_required": round(front_yard_ft_required, 2),
        "side_yard_ft_required": round(side_yard_ft_required, 2),
        "open_space_ratio_required": round(open_space_ratio_required or 0.0, 3),
        "open_space_required_ft2": round(open_space_required_ft2, 2),
        "rear_yard_ft_required": round(rear_yard_ft_required or 0.0, 2),
        "has_contextual_rules": _is_contextual_regime(base_rule.get("bulk_regime")),
        "uses_open_space_ratio": uses_open_space_ratio,
        "bulk_regime": base_rule.get("bulk_regime"),
        "base_height_ft": round(_coerce_float(base_rule.get("base_height_ft")) or 0.0, 2),
        "street_setback_ft": round(_coerce_float(base_rule.get("street_setback_ft")) or 0.0, 2),
        "simplified_plan_inset_ft": round(_coerce_float(base_rule.get("simplified_plan_inset_ft")) or 0.0, 2),
        "source_sections": base_rule.get("source_sections") or [],
        "selected_variant": zr_rule.get("selectedVariant") if zr_rule else None,
        "variant_label": zr_rule.get("variantLabel") if zr_rule else None,
        "building_use_type": normalized_building_use,
        "housing_type": normalized_housing,
        "footnote_variant": _coerce_str(footnote_variant),
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


def _build_study_geojson(payload: EnvelopeRequest, lot_area_ft2: float, zoning: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    outer = _close_ring(payload.lot_polygon)
    lot_area = max(1.0, lot_area_ft2)
    floor_to_floor_height_ft = payload.floor_height_ft or 10.0

    existing_height_ft = _estimate_existing_building_height_ft(
        payload.numfloors,
        payload.bldgarea,
        lot_area,
        floor_to_floor_height_ft,
    )
    existing_coverage = _estimate_existing_building_coverage(payload.numfloors, payload.bldgarea, lot_area)
    existing_ring = _scale_ring(outer, math.sqrt(existing_coverage)) if existing_coverage < 0.98 else outer

    rear_yard_ft = max(0.0, _coerce_float(zoning.get("rear_yard_ft_required")) or 0.0)
    side_yard_ft = max(0.0, _coerce_float(zoning.get("side_yard_ft_required")) or 0.0)
    front_yard_ft = max(0.0, _coerce_float(zoning.get("front_yard_ft_required")) or 0.0)

    rear_scale = _ring_inset_scale(outer, rear_yard_ft)
    area_after_rear = lot_area * (rear_scale ** 2)
    rear_yard_area_ft2 = max(0.0, lot_area - area_after_rear)

    side_scale = _ring_inset_scale(outer, side_yard_ft)
    area_after_side = area_after_rear * (side_scale ** 2)
    side_yard_area_ft2 = max(0.0, area_after_rear - area_after_side)

    front_scale = _ring_inset_scale(outer, front_yard_ft)
    area_after_front = area_after_side * (front_scale ** 2)
    front_yard_area_ft2 = max(0.0, area_after_side - area_after_front)

    area_after_yards_ft2 = max(100.0, area_after_front)
    allowable_floor_area_ft2 = max(0.0, lot_area * (_coerce_float(zoning.get("scenario_far")) or 0.0))
    required_open_space_ft2 = max(0.0, _coerce_float(zoning.get("open_space_required_ft2")) or 0.0)

    buildable_footprint_ft2 = max(100.0, area_after_yards_ft2 - required_open_space_ft2)
    buildable_ratio = max(0.02, min(1.0, buildable_footprint_ft2 / lot_area))
    buildable_ring = _scale_ring(outer, math.sqrt(buildable_ratio)) if buildable_ratio < 0.995 else outer

    floors_needed = max(1.0, allowable_floor_area_ft2 / max(1.0, buildable_footprint_ft2))
    required_height_ft = floors_needed * floor_to_floor_height_ft

    height_limit_ft = _coerce_float(zoning.get("max_height_ft"))
    if height_limit_ft and height_limit_ft > 0:
        envelope_height_ft = min(required_height_ft, height_limit_ft)
        full_far_fits = required_height_ft <= height_limit_ft + 1e-6
    else:
        envelope_height_ft = 0.0
        full_far_fits = False

    base_height_ft = max(0.0, min(envelope_height_ft, _coerce_float(zoning.get("base_height_ft")) or 0.0))

    bulk_regime = zoning.get("bulk_regime") or ""
    upper_inset_ft = zoning.get("street_setback_ft") or zoning.get("simplified_plan_inset_ft") or 0.0
    upper_scale = _ring_inset_scale(buildable_ring, upper_inset_ft)
    upper_ring = _scale_ring(buildable_ring, upper_scale) if upper_scale < 0.99 else buildable_ring

    stepped_regimes = {
        "base-and-setback",
        "contextual",
        "contextual-variant",
        "sky-exposure-plane",
        "sky-exposure-plane-or-tower",
        "manufacturing-sky-exposure",
    }

    zoning_features: List[Dict[str, Any]] = []
    if envelope_height_ft <= 0:
        zoning_features = []
    elif base_height_ft > 0 and base_height_ft < envelope_height_ft and bulk_regime in stepped_regimes:
        zoning_features.extend(
            [
                {
                    "type": "Feature",
                    "properties": {
                        "kind": "zoning_envelope",
                        "height_ft": round(base_height_ft, 2),
                        "base_ft": 0,
                        "color": "#2563eb",
                        "coverage_ratio": round(buildable_ratio, 3),
                        "segment": "base",
                    },
                    "geometry": {"type": "Polygon", "coordinates": [buildable_ring]},
                },
                {
                    "type": "Feature",
                    "properties": {
                        "kind": "zoning_envelope",
                        "height_ft": round(envelope_height_ft, 2),
                        "base_ft": round(base_height_ft, 2),
                        "color": "#2563eb",
                        "coverage_ratio": round(max(0.05, buildable_ratio * upper_scale * upper_scale), 3),
                        "segment": "upper",
                    },
                    "geometry": {"type": "Polygon", "coordinates": [upper_ring]},
                },
            ]
        )
    else:
        zoning_features.append(
            {
                "type": "Feature",
                "properties": {
                    "kind": "zoning_envelope",
                    "height_ft": round(envelope_height_ft, 2),
                    "base_ft": 0,
                    "color": "#2563eb",
                    "coverage_ratio": round(buildable_ratio, 3),
                    "segment": "single",
                },
                "geometry": {"type": "Polygon", "coordinates": [buildable_ring]},
            }
        )

    overlays: List[Dict[str, Any]] = []
    rear_clear_ring = _scale_ring(outer, rear_scale) if rear_scale < 0.995 else outer
    yards_clear_ratio = max(0.02, min(1.0, area_after_yards_ft2 / lot_area))
    yards_clear_ring = _scale_ring(outer, math.sqrt(yards_clear_ratio)) if yards_clear_ratio < 0.995 else outer

    if rear_yard_area_ft2 > 1.0 and rear_scale < 0.999:
        overlays.append(
            {
                "type": "Feature",
                "properties": {
                    "kind": "rear_yard_zone",
                    "area_ft2": round(rear_yard_area_ft2, 2),
                    "color": "#f59e0b",
                },
                "geometry": {"type": "Polygon", "coordinates": [outer, rear_clear_ring]},
            }
        )

    open_space_zone_area_ft2 = max(0.0, area_after_yards_ft2 - buildable_footprint_ft2)
    if open_space_zone_area_ft2 > 1.0 and yards_clear_ratio > buildable_ratio:
        overlays.append(
            {
                "type": "Feature",
                "properties": {
                    "kind": "open_space_zone",
                    "area_ft2": round(open_space_zone_area_ft2, 2),
                    "color": "#10b981",
                },
                "geometry": {"type": "Polygon", "coordinates": [yards_clear_ring, buildable_ring]},
            }
        )

    overlays.append(
        {
            "type": "Feature",
            "properties": {
                "kind": "buildable_footprint",
                "area_ft2": round(buildable_footprint_ft2, 2),
                "color": "#0ea5e9",
            },
            "geometry": {"type": "Polygon", "coordinates": [buildable_ring]},
        }
    )

    study = {
        "lot_area_ft2": round(lot_area, 2),
        "far": round(_coerce_float(zoning.get("scenario_far")) or 0.0, 3),
        "allowable_floor_area_ft2": round(allowable_floor_area_ft2, 2),
        "required_open_space_ft2": round(required_open_space_ft2, 2),
        "rear_yard_area_ft2": round(rear_yard_area_ft2, 2),
        "rear_yard_requirement_ft": round(rear_yard_ft, 2),
        "front_yard_requirement_ft": round(front_yard_ft, 2),
        "side_yard_requirement_ft": round(side_yard_ft, 2),
        "buildable_footprint_ft2": round(buildable_footprint_ft2, 2),
        "estimated_floors": round(floors_needed, 2),
        "required_height_ft": round(required_height_ft, 2),
        "envelope_height_ft": round(envelope_height_ft, 2),
        "height_limit_ft": round(height_limit_ft, 2) if height_limit_ft else None,
        "full_far_fits": bool(full_far_fits),
        "full_far_fit_warning": None if full_far_fits else (
            "Missing full rule data for this condition."
            if not height_limit_ft else "Full FAR may not fit inside this envelope under current assumptions."
        ),
    }

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
            *overlays,
            *zoning_features,
        ],
    }, study


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


@app.get("/api/data/split/{split_id}")
def get_split_geojson(split_id: str) -> Response:
    catalog = list_split_files().get("files") or []
    target = next((item for item in catalog if _coerce_str(item.get("id")) == split_id), None)
    if not target:
        raise HTTPException(status_code=404, detail="Split file not found")

    path = _coerce_str(target.get("path"))
    url = _coerce_str(target.get("url"))

    # Local files can be served directly when present.
    if path and os.path.isdir(SPLIT_PLUTO_DIR):
        local_path = os.path.join(SPLIT_PLUTO_DIR, os.path.basename(path))
        if os.path.isfile(local_path):
            return FileResponse(local_path, media_type="application/json")

    if not url:
        raise HTTPException(status_code=404, detail="Split file URL not available")

    try:
        upstream = requests.get(url, timeout=60)
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch split file: {exc}") from exc

    if not upstream.ok:
        raise HTTPException(status_code=502, detail=f"Upstream split file request failed ({upstream.status_code})")

    return Response(content=upstream.content, media_type="application/json")


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
        lot_area_ft2=payload.lot_area or lot_area_ft2,
        use_type=use_type,
        building_use_type=payload.building_use_type or "residential",
        housing_type=payload.housing_type or "marketRate",
        footnote_variant=payload.footnote_variant,
        upzone=payload.upzone,
    )
    geojson, buildability_study = _build_study_geojson(payload, lot_area_ft2, zoning)

    existing_feature = next(feature for feature in geojson["features"] if feature["properties"]["kind"] == "existing_building")
    zoning_features = [feature for feature in geojson["features"] if feature["properties"]["kind"] == "zoning_envelope"]
    full_envelope_height_ft = max((feature["properties"].get("height_ft") or 0.0) for feature in zoning_features) if zoning_features else 0.0
    full_envelope_coverage_ratio = max((feature["properties"].get("coverage_ratio") or 0.0) for feature in zoning_features) if zoning_features else 0.0

    return {
        "inputs": payload.model_dump(),
        "results": {
            "use_type": use_type,
            "zoning_analysis": zoning,
            "lot_area_ft2": round(lot_area_ft2, 2),
            "existing_building_height_ft": existing_feature["properties"]["height_ft"],
            "existing_building_coverage_ratio": existing_feature["properties"]["coverage_ratio"],
            "full_envelope_height_ft": round(full_envelope_height_ft, 2),
            "full_envelope_coverage_ratio": round(full_envelope_coverage_ratio, 3),
            "zoning_buildability_study": buildability_study,
        },
        "geojson": geojson,
    }
