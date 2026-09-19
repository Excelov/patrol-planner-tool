#!/usr/bin/env python3
"""Extract CAD facility symbols/labels into a task-point GeoJSON layer.

The mapping CSV is intentionally editable by business users.  Matching uses
the DXF layer, INSERT block name and TEXT/MTEXT content, in that order.
"""
from __future__ import annotations

import argparse, csv, json, re
from pathlib import Path
import ezdxf
from pyproj import CRS, Transformer


def transformer(central_meridian: float) -> Transformer:
    src = CRS.from_proj4(f"+proj=tmerc +lat_0=0 +lon_0={central_meridian} +k=1 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs")
    return Transformer.from_crs(src, CRS.from_epsg(4490), always_xy=True)


def coord(t: Transformer | None, xy, zone_prefix: int | None, source_crs: str = "cgcs2000_projected") -> list[float]:
    x, y = float(xy[0]), float(xy[1])
    if source_crs in {"wgs84", "cgcs2000_lonlat", "gcj02"}:
        return [round(x, 8), round(y, 8)]
    if t is None:
        raise ValueError("投影坐标必须提供转换器")
    if zone_prefix is not None and abs(x) > zone_prefix * 1_000_000:
        x -= zone_prefix * 1_000_000
    lon, lat = t.transform(x, y)
    return [round(lon, 8), round(lat, 8)]


def text_value(entity) -> str:
    if entity.dxftype() == "INSERT":
        return str(getattr(entity.dxf, "name", ""))
    if entity.dxftype() == "TEXT":
        return str(getattr(entity.dxf, "text", ""))
    if entity.dxftype() == "MTEXT":
        try:
            return str(entity.plain_text())
        except Exception:
            return str(getattr(entity, "text", ""))
    return ""


def load_mapping(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def classify(layer: str, value: str, rows: list[dict[str, str]]) -> tuple[str, str]:
    haystack = f"{layer} {value}".lower()
    for row in rows:
        patterns = [row.get("layer_pattern", ""), row.get("block_pattern", ""), row.get("text_pattern", "")]
        for pattern in patterns:
            if pattern and re.search(pattern, haystack, re.I):
                return row.get("facility_type", "other") or "other", row.get("label", value) or value
    return "unmapped", value


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dxf", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--report", type=Path, required=True)
    p.add_argument("--mapping", type=Path, required=True)
    p.add_argument("--zone-prefix", type=int, default=40)
    p.add_argument("--central-meridian", type=float, default=120.0)
    p.add_argument("--source-crs", choices=("cgcs2000_projected", "cgcs2000_lonlat", "wgs84", "gcj02"), default="cgcs2000_projected")
    p.add_argument("--all-layers", action="store_true", help="scan every layer; default still scans every layer for facilities")
    args = p.parse_args()
    doc, tr, rows = ezdxf.readfile(args.dxf), (None if args.source_crs != "cgcs2000_projected" else transformer(args.central_meridian)), load_mapping(args.mapping)
    features, counts, entity_counts, unmapped = [], {}, {}, []
    supported = {"POINT", "INSERT", "TEXT", "MTEXT"}
    for idx, entity in enumerate(doc.modelspace(), 1):
        kind = entity.dxftype(); layer = str(getattr(entity.dxf, "layer", "")).strip()
        entity_counts[kind] = entity_counts.get(kind, 0) + 1
        if kind not in supported:
            continue
        point = getattr(entity.dxf, "insert", None) if kind == "INSERT" else getattr(entity.dxf, "insert", None) or getattr(entity.dxf, "location", None)
        if point is None:
            continue
        raw = text_value(entity).replace("\\P", " ").strip()
        ftype, label = classify(layer, raw, rows)
        counts[ftype] = counts.get(ftype, 0) + 1
        handle = str(getattr(entity.dxf, "handle", idx))
        if ftype == "unmapped":
            unmapped.append({"handle": handle, "layer": layer, "entity": kind, "value": raw})
        features.append({"type": "Feature", "properties": {"taskId": f"DXF-FAC-{handle}", "facilityType": ftype, "label": label or ftype, "sourceHandle": handle, "sourceEntity": kind, "sourceLayer": layer, "rawValue": raw, "coordinateSystem": args.source_crs.upper(), "coordMode": "lonlat", "matchStatus": "unmapped" if ftype == "unmapped" else "mapped", "usage": "facility-task-point"}, "geometry": {"type": "Point", "coordinates": coord(tr, (point.x, point.y), args.zone_prefix, args.source_crs)}})
    args.output.parent.mkdir(parents=True, exist_ok=True); args.report.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False), encoding="utf-8")
    report = ["# DXF Facility Extraction Report", "", f"- Source DXF: `{args.dxf}`", f"- Mapping: `{args.mapping}`", f"- Facilities: {len(features)}", "", "## Facility types", ""]
    report += [f"- {k}: {v}" for k, v in sorted(counts.items())]
    report += ["", "## Source entity counts", ""] + [f"- {k}: {v}" for k, v in sorted(entity_counts.items())]
    report += ["", f"- Unmapped facilities: {len(unmapped)}", "", "Unmapped objects are retained in GeoJSON and must be reviewed before route planning.", ""]
    args.report.write_text("\n".join(report), encoding="utf-8")
    print(f"Facility features: {len(features)}; unmapped: {len(unmapped)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
