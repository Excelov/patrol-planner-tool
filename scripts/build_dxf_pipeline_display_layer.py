#!/usr/bin/env python3
"""Build full-DXF display-only pipeline GeoJSON layers.

This keeps CAD line/polyline geometry as intact display features. It is not a
topology-cleaned backend calculation layer.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import ezdxf
from pyproj import CRS, Transformer


TARGET_LAYER = "新增燃气管道"


def build_transformer(central_meridian: float) -> Transformer:
    source = CRS.from_proj4(
        f"+proj=tmerc +lat_0=0 +lon_0={central_meridian} +k=1 "
        "+x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs"
    )
    target = CRS.from_epsg(4490)
    return Transformer.from_crs(source, target, always_xy=True)


def normalize_easting(value: float, zone_prefix: int | None) -> float:
    if zone_prefix is None:
        return value
    prefix_value = zone_prefix * 1_000_000
    if abs(value) > prefix_value:
        return value - prefix_value
    return value


def entity_points(entity) -> tuple[list[tuple[float, float]], bool]:
    dxftype = entity.dxftype()
    if dxftype == "LINE":
        start = entity.dxf.start
        end = entity.dxf.end
        return [(float(start.x), float(start.y)), (float(end.x), float(end.y))], False
    if dxftype == "LWPOLYLINE":
        return [(float(point[0]), float(point[1])) for point in entity.get_points("xy")], bool(entity.closed)
    if dxftype == "POLYLINE":
        return [(float(vertex.dxf.location.x), float(vertex.dxf.location.y)) for vertex in entity.vertices], entity.is_closed
    return [], False


def dist(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def normalize(v: tuple[float, float]) -> tuple[float, float]:
    length = math.hypot(v[0], v[1])
    if length == 0:
        return (0.0, 0.0)
    return (v[0] / length, v[1] / length)


def left_normal(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    direction = normalize((b[0] - a[0], b[1] - a[1]))
    return (-direction[1], direction[0])


def offset_vertex(
    points: list[tuple[float, float]],
    index: int,
    radius: float,
    side: float,
) -> tuple[float, float]:
    if len(points) == 2:
        n = left_normal(points[0], points[1])
        return (points[index][0] + n[0] * radius * side, points[index][1] + n[1] * radius * side)
    if index == 0:
        n = left_normal(points[0], points[1])
    elif index == len(points) - 1:
        n = left_normal(points[-2], points[-1])
    else:
        n1 = left_normal(points[index - 1], points[index])
        n2 = left_normal(points[index], points[index + 1])
        n = normalize((n1[0] + n2[0], n1[1] + n2[1]))
        if n == (0.0, 0.0):
            n = n2
    return (points[index][0] + n[0] * radius * side, points[index][1] + n[1] * radius * side)


def buffer_polygon(points: list[tuple[float, float]], radius: float) -> list[tuple[float, float]]:
    if len(points) < 2:
        return []
    left = [offset_vertex(points, index, radius, 1.0) for index in range(len(points))]
    right = [offset_vertex(points, index, radius, -1.0) for index in range(len(points) - 1, -1, -1)]
    polygon = left + right
    if polygon and polygon[0] != polygon[-1]:
        polygon.append(polygon[0])
    return polygon


def convert_point(
    transformer: Transformer | None,
    point: tuple[float, float],
    zone_prefix: int | None,
    source_crs: str = "cgcs2000_projected",
) -> list[float]:
    if source_crs in {"wgs84", "cgcs2000_lonlat", "gcj02"}:
        return [round(float(point[0]), 8), round(float(point[1]), 8)]
    easting = normalize_easting(point[0], zone_prefix)
    northing = point[1]
    if transformer is None:
        raise ValueError("投影坐标必须提供转换器")
    lon, lat = transformer.transform(easting, northing)
    return [round(lon, 8), round(lat, 8)]


def feature_collection(features: list[dict]) -> dict:
    return {"type": "FeatureCollection", "features": features}


def main() -> int:
    parser = argparse.ArgumentParser(description="Build full DXF pipeline display GeoJSON.")
    parser.add_argument("--dxf", type=Path, required=True)
    parser.add_argument("--layer", default=TARGET_LAYER)
    parser.add_argument("--line-output", type=Path, required=True)
    parser.add_argument("--buffer-output", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--zone-prefix", type=int, default=40)
    parser.add_argument("--central-meridian", type=float, default=120.0)
    parser.add_argument("--source-crs", choices=("cgcs2000_projected", "cgcs2000_lonlat", "wgs84", "gcj02"), default="cgcs2000_projected")
    parser.add_argument("--protection-radius-m", type=float, default=5.0)
    parser.add_argument("--min-length-m", type=float, default=1.0)
    parser.add_argument("--include-closed", action="store_true")
    args = parser.parse_args()

    transformer = None if args.source_crs != "cgcs2000_projected" else build_transformer(args.central_meridian)
    doc = ezdxf.readfile(args.dxf)
    line_features: list[dict] = []
    buffer_features: list[dict] = []
    counts: dict[str, int] = {}
    skipped = {"closed": 0, "short": 0, "unsupported": 0}

    for index, entity in enumerate(doc.modelspace(), start=1):
        if entity.dxf.layer.strip() != args.layer:
            continue
        dxftype = entity.dxftype()
        counts[dxftype] = counts.get(dxftype, 0) + 1
        if dxftype not in {"LINE", "LWPOLYLINE", "POLYLINE"}:
            skipped["unsupported"] += 1
            continue
        points, closed = entity_points(entity)
        if closed and not args.include_closed:
            skipped["closed"] += 1
            continue
        if len(points) < 2:
            skipped["short"] += 1
            continue
        unit_scale = 1.0 if args.source_crs == "cgcs2000_projected" else 111000.0
        length = sum(dist(points[i], points[i + 1]) * unit_scale for i in range(len(points) - 1))
        if length < args.min_length_m:
            skipped["short"] += 1
            continue

        handle = str(entity.dxf.handle)
        code = f"DXF-GAS-{handle}"
        line_coords = [convert_point(transformer, point, args.zone_prefix, args.source_crs) for point in points]
        line_features.append(
            {
                "type": "Feature",
                "properties": {
                    "displayCode": code,
                    "sourceHandle": handle,
                    "sourceEntity": dxftype,
                    "sourceLayer": args.layer,
                    "lengthM": round(length, 2),
                    "protectionRadiusM": args.protection_radius_m,
                    "coordinateSystem": args.source_crs.upper(),
                    "coordMode": "lonlat",
                    "usage": "display-only",
                },
                "geometry": {"type": "LineString", "coordinates": line_coords},
            }
        )

        buffer_radius = args.protection_radius_m if args.source_crs == "cgcs2000_projected" else args.protection_radius_m / 111000.0
        polygon = buffer_polygon(points, buffer_radius)
        if len(polygon) >= 4:
            buffer_features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "displayCode": code,
                        "sourceHandle": handle,
                        "sourceEntity": dxftype,
                        "protectionRadiusM": args.protection_radius_m,
                        "coordinateSystem": args.source_crs.upper(),
                        "coordMode": "lonlat",
                        "usage": "display-only-buffer",
                    },
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [[convert_point(transformer, point, args.zone_prefix, args.source_crs) for point in polygon]],
                    },
                }
            )

    args.line_output.parent.mkdir(parents=True, exist_ok=True)
    args.buffer_output.parent.mkdir(parents=True, exist_ok=True)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.line_output.write_text(json.dumps(feature_collection(line_features), ensure_ascii=False), encoding="utf-8")
    args.buffer_output.write_text(json.dumps(feature_collection(buffer_features), ensure_ascii=False), encoding="utf-8")
    args.report.write_text(
        "\n".join(
            [
                "# DXF Pipeline Display Layer Report",
                "",
                f"- Source DXF: `{args.dxf}`",
                f"- Layer: `{args.layer}`",
                f"- Line output: `{args.line_output}`",
                f"- Buffer output: `{args.buffer_output}`",
                f"- protection_radius_m: {args.protection_radius_m}",
                f"- zone_prefix: {args.zone_prefix}",
                f"- central_meridian: {args.central_meridian}",
                f"- source_crs: {args.source_crs}",
                f"- include_closed: {args.include_closed}",
                "",
                "## Counts",
                "",
                *[f"- {key}: {counts[key]}" for key in sorted(counts)],
                f"- line_features: {len(line_features)}",
                f"- buffer_features: {len(buffer_features)}",
                f"- skipped_closed: {skipped['closed']}",
                f"- skipped_short: {skipped['short']}",
                f"- skipped_unsupported: {skipped['unsupported']}",
                "",
                "## Usage",
                "",
                "- This layer is display-only.",
                "- It preserves CAD line/polyline entities as visual features.",
                "- It must not replace the backend calculation pipeline layer.",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    print(f"Line features: {len(line_features)}")
    print(f"Buffer features: {len(buffer_features)}")
    print(f"Report: {args.report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
