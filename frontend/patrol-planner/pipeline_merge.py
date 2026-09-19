"""pipeline_merge.py - 通用管线碎片合并（拓扑连接）

业务目的：把 DXF/GIS/Shapefile 导出的碎片 LineString，端点距离阈值内的自动拼接成连续 Polyline。

设计原则（应用级）：
- 数据源无关：输入输出都是 GeoJSON FeatureCollection
- 属性透传：合并时保留第一条的属性 + 记录 source_segment_count
- 阈值可调：端点距离阈值默认 0.5m（适合 CGCS2000 经纬度）
- 闭环检测：起点==终点的链自动标记为 closed=True
- ponytail: O(n²) 端点匹配，n<2000 够用；>5000 升级到 R-tree 索引
"""
from __future__ import annotations

import math
from collections import defaultdict


EARTH_R = 6371008.8


def haversine_m(a: list[float], b: list[float]) -> float:
    """GCJ-02/WGS84 经纬度两点球面距离(米)"""
    lon1, lat1 = math.radians(a[0]), math.radians(a[1])
    lon2, lat2 = math.radians(b[0]), math.radians(b[1])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(h))


def merge_pipelines(features: list[dict], tolerance_m: float = 0.5) -> dict:
    """
    把碎片 LineString 合并成连续 Polyline。

    Args:
        features: GeoJSON features (geometry.type=='LineString')
        tolerance_m: 端点距离<=此值视为同一节点

    Returns:
        {
            'merged': [Feature...],   # 合并后的连续 polyline
            'orphans': [Feature...],  # 单段孤立
            'stats': {input_count, segment_count, merged_count, orphan_count,
                      avg_segment_length_m, max_chain_segments}
        }
    """
    segments = _extract_segments(features)
    if not segments:
        return {'merged': [], 'orphans': [],
                'stats': {'input_count': len(features), 'segment_count': 0,
                          'merged_count': 0, 'orphan_count': 0,
                          'avg_segment_length_m': 0.0, 'max_chain_segments': 0}}

    # 1) 端点聚类（union-find）
    endpoints = []
    for s_idx, s in enumerate(segments):
        endpoints.append((s_idx, 'start', s['pts'][0]))
        endpoints.append((s_idx, 'end', s['pts'][-1]))

    parent = list(range(len(endpoints)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i, j):
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj

    for i in range(len(endpoints)):
        for j in range(i + 1, len(endpoints)):
            if haversine_m(endpoints[i][2], endpoints[j][2]) <= tolerance_m:
                union(i, j)

    endpoint_node = {(s_idx, et): find(i)
                     for i, (s_idx, et, _) in enumerate(endpoints)}

    # 2) 拼链：每个未使用的段做种子，向两端扩展
    used = [False] * len(segments)
    chains = []
    for s_idx in range(len(segments)):
        if used[s_idx]:
            continue
        used[s_idx] = True
        chain_pts = list(segments[s_idx]['pts'])
        chain_segs = [s_idx]
        start_node = endpoint_node[(s_idx, 'start')]
        end_node = endpoint_node[(s_idx, 'end')]
        chain_pts, chain_segs, used = _extend(
            chain_pts, chain_segs, used, segments, endpoint_node, start_node, 'backward')
        chain_pts, chain_segs, used = _extend(
            chain_pts, chain_segs, used, segments, endpoint_node, end_node, 'forward')
        chain_pts = _dedupe_consecutive(chain_pts)
        if len(chain_pts) >= 2:
            closed = haversine_m(chain_pts[0], chain_pts[-1]) < 1.0
            chains.append({'pts': chain_pts, 'seg_indices': chain_segs, 'closed': closed})

    return _build_result(chains, segments, features)


def _extract_segments(features: list[dict]) -> list[dict]:
    segs = []
    for f_idx, f in enumerate(features):
        geom = f.get('geometry') or {}
        if geom.get('type') != 'LineString':
            continue
        coords = geom.get('coordinates') or []
        if len(coords) < 2:
            continue
        segs.append({
            'pts': [[float(c[0]), float(c[1])] for c in coords],
            'feature_idx': f_idx,
            'attrs': dict(f.get('properties') or {}),
        })
    return segs


def _extend(chain_pts, chain_segs, used, segments, endpoint_node, cur_node, direction):
    """从 cur_node 朝 direction 方向扩展链，返回 (pts, segs, used)。"""
    while True:
        candidates = []
        for s_idx, seg in enumerate(segments):
            if used[s_idx]:
                continue
            for end_type in ('start', 'end'):
                if endpoint_node.get((s_idx, end_type)) == cur_node:
                    candidates.append((s_idx, end_type))
                    break  # 每段最多匹配一个端点
        if not candidates:
            break
        s_idx, end_type = candidates[0]
        used[s_idx] = True
        chain_segs.append(s_idx)
        seg_pts = segments[s_idx]['pts']
        if direction == 'forward':
            if end_type == 'start':
                new_pts = seg_pts[1:]
                cur_node = endpoint_node[(s_idx, 'end')]
            else:
                new_pts = list(reversed(seg_pts))[1:]
                cur_node = endpoint_node[(s_idx, 'start')]
            chain_pts.extend(new_pts)
        else:
            if end_type == 'end':
                new_pts = seg_pts[:-1]
                cur_node = endpoint_node[(s_idx, 'start')]
            else:
                new_pts = list(reversed(seg_pts))[:-1]
                cur_node = endpoint_node[(s_idx, 'end')]
            chain_pts = new_pts + chain_pts
    return chain_pts, chain_segs, used


def _dedupe_consecutive(pts: list[list[float]]) -> list[list[float]]:
    out = []
    for p in pts:
        if not out or haversine_m(out[-1], p) > 1e-7:
            out.append(p)
    return out


def _build_result(chains, segments, features):
    merged, orphans = [], []
    total_len = 0.0
    max_segs = 0
    for ch in chains:
        total_len += _polyline_length(ch['pts'])
        max_segs = max(max_segs, len(ch['seg_indices']))
        props_base = dict(segments[ch['seg_indices'][0]]['attrs']) if ch['seg_indices'] else {}
        feat = {
            'type': 'Feature',
            'geometry': {'type': 'LineString', 'coordinates': ch['pts']},
            'properties': {**props_base,
                           'source_segment_count': len(ch['seg_indices']),
                           'closed': ch['closed']},
        }
        if len(ch['seg_indices']) == 1:
            feat['properties']['merge_state'] = 'orphan'
            orphans.append(feat)
        else:
            feat['properties']['merge_state'] = 'merged'
            merged.append(feat)
    n = len(merged) + len(orphans)
    avg_len = total_len / n if n else 0.0
    return {
        'merged': merged, 'orphans': orphans,
        'stats': {
            'input_count': len(features),
            'segment_count': len(segments),
            'merged_count': len(merged),
            'orphan_count': len(orphans),
            'avg_segment_length_m': round(avg_len, 2),
            'max_chain_segments': max_segs,
        },
    }


def _polyline_length(pts):
    return sum(haversine_m(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


if __name__ == '__main__':
    # 自检1：3段拼成"┐"开放链 → 应合并为1条
    sample = [
        {'type': 'Feature', 'geometry': {'type': 'LineString',
         'coordinates': [[0, 0], [1, 0]]}, 'properties': {'id': 'a'}},
        {'type': 'Feature', 'geometry': {'type': 'LineString',
         'coordinates': [[1, 0], [1, 1]]}, 'properties': {'id': 'b'}},
        {'type': 'Feature', 'geometry': {'type': 'LineString',
         'coordinates': [[0, 0], [0, 1]]}, 'properties': {'id': 'c'}},
    ]
    r = merge_pipelines(sample, tolerance_m=0.5)
    assert r['stats']['merged_count'] == 1, f"应合并1条，得到{r['stats']}"
    assert r['stats']['orphan_count'] == 0
    assert r['merged'][0]['properties']['source_segment_count'] == 3
    print(f"✓ 自检1：3段开放链合并 {r['stats']}")

    # 自检2：4段成闭环
    sample2 = [
        {'type': 'Feature', 'geometry': {'type': 'LineString',
         'coordinates': [[0, 0], [1, 0]]}, 'properties': {}},
        {'type': 'Feature', 'geometry': {'type': 'LineString',
         'coordinates': [[1, 0], [1, 1]]}, 'properties': {}},
        {'type': 'Feature', 'geometry': {'type': 'LineString',
         'coordinates': [[1, 1], [0, 1]]}, 'properties': {}},
        {'type': 'Feature', 'geometry': {'type': 'LineString',
         'coordinates': [[0, 1], [0, 0]]}, 'properties': {}},
    ]
    r = merge_pipelines(sample2, tolerance_m=0.5)
    print(f"✓ 自检2：4段闭环 {r['stats']} closed={r['merged'][0]['properties']['closed']}")
    assert r['merged'][0]['properties']['closed'] is True

    # 自检3：孤段
    sample3 = [
        {'type': 'Feature', 'geometry': {'type': 'LineString',
         'coordinates': [[100, 100], [101, 100]]}, 'properties': {}},
        {'type': 'Feature', 'geometry': {'type': 'LineString',
         'coordinates': [[200, 200], [201, 200]]}, 'properties': {}},
    ]
    r = merge_pipelines(sample3, tolerance_m=0.5)
    assert r['stats']['orphan_count'] == 2
    print(f"✓ 自检3：2孤段 orphan={r['stats']['orphan_count']}")