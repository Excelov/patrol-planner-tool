"""Loopback-only patrol planner. Python standard library; no database required."""
from __future__ import annotations

import argparse
import base64
import csv
import json
import math
import os
import re
import secrets
import sys
import threading
import time
import subprocess
import runpy
import tempfile
import hashlib
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode, urlsplit, parse_qs
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pipeline_merge import merge_pipelines

APP = Path(__file__).resolve().parent
# In a PyInstaller one-file build resources are unpacked under _MEIPASS.
# Keep source-tree behavior unchanged while resolving bundled scripts/data.
RESOURCE_ROOT = Path(getattr(sys, '_MEIPASS', APP.parent.parent))
ROOT = RESOURCE_ROOT if getattr(sys, '_MEIPASS', None) else APP.parent.parent
TOKEN = secrets.token_urlsafe(24)
LOCK = threading.Lock()
IMPORT_LOCK = threading.Lock()
CACHE = {}
SCOPES = {
    'dxf': ('DXF 转换管线图层', None, None),
    'route5': ('线路五', 'route5_scope/route5_scoped_pipeline_segments.csv', 'routes/route5_high_fidelity_candidate_cgcs2000_heading200.csv'),
    'route6': ('线路六', 'route6_scope/route6_scoped_pipeline_segments.csv', 'routes/route6_high_fidelity_candidate_import_cgcs2000_heading200.csv'),
}

TRIAL_DAYS = 15
FREE_MAX_POINTS = 16


def _user_data_dir():
    base = os.environ.get('LOCALAPPDATA') or os.environ.get('APPDATA') or str(Path.home())
    path = Path(base) / 'PatrolPlanner'
    path.mkdir(parents=True, exist_ok=True)
    return path


def _device_hash():
    raw = '|'.join([str(uuid.getnode()), os.environ.get('COMPUTERNAME', ''), os.environ.get('USERDOMAIN', '')])
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()[:24]


def license_status():
    """Return the local beta trial gate; signed commercial licenses are a later module."""
    now = datetime.now(timezone.utc)
    trial_file = _user_data_dir() / 'trial.json'
    try:
        data = json.loads(trial_file.read_text('utf-8'))
        started = datetime.fromisoformat(data['startedAt'])
    except Exception:
        started = now
        trial_file.write_text(json.dumps({'startedAt': started.isoformat(), 'deviceHash': _device_hash()}, ensure_ascii=False), encoding='utf-8')
    elapsed = max(0, (now - started).total_seconds())
    remaining = max(0, TRIAL_DAYS - math.ceil(elapsed / 86400))
    active = remaining > 0
    return {'mode': 'trial', 'active': active, 'remainingDays': remaining, 'maxPoints': FREE_MAX_POINTS,
            'deviceHash': _device_hash(), 'contactUrl': os.environ.get('PATROL_CONTACT_URL', 'https://github.com/Excelov/patrol-planner-tool/issues')}


def settings():
    values = {}
    for name in ('.env', '.env.development', '.env.local'):
        file = ROOT / 'vendor/pig-ui' / name
        if file.exists():
            for line in file.read_text('utf-8-sig').splitlines():
                match = re.match(r'^\s*([A-Z_]+)\s*=\s*(.*?)\s*$', line)
                if match:
                    values[match[1]] = match[2].strip('\"\'')
    config_files = [ROOT / 'config/local/amap.local.ps1']
    # Packaged Windows builds keep customer settings outside the executable.
    for base in (os.environ.get('LOCALAPPDATA'), os.environ.get('APPDATA')):
        if base:
            config_files.append(Path(base) / 'PatrolPlanner' / 'amap.local.ps1')
    for file in config_files:
        if file.exists():
            # Read literal assignments only. Do not execute a configuration script.
            for key, _, value in re.findall(r'\$env:(\w+)\s*=\s*([\"\'])(.*?)\2', file.read_text('utf-8-sig')):
                values[key] = value
    for key in ('VITE_AMAP_WEB_JS_KEY', 'VITE_AMAP_SECURITY_JS_CODE', 'AMAP_WEBSERVICE_KEY'):
        if os.environ.get(key):
            values[key] = os.environ[key]
    return values


def csv_rows(file):
    with file.open(encoding='utf-8-sig', newline='') as stream:
        return list(csv.DictReader(stream))


def dataset(scope):
    if scope == 'dxf':
        file = ROOT / 'data/gis/processed/medium_pressure_gas_pipeline_lines.geojson'
        if not file.exists(): raise ValueError('尚未生成 DXF 管线图层')
        result = json.loads(file.read_text('utf-8-sig'))
        return {'name': 'DXF 转换管线图层', 'pipelines': result, 'reference': []}
    if scope == 'full':
        result = json.loads((ROOT / 'vendor/pig-ui/public/data/gis/dxf_pipeline_display_lines.geojson').read_text('utf-8-sig'))
        for feature in result['features']:
            feature['id'] = feature['properties']['displayCode']
        return {'name': 'CAD 全部管线（展示资料）', 'pipelines': result, 'reference': []}
    if scope not in SCOPES:
        raise ValueError('未知管线范围')
    name, pipes, reference = SCOPES[scope]
    features = []
    for row in csv_rows(ROOT / 'data/gis' / pipes):
        features.append({'type': 'Feature', 'id': row['pipeline_code'],
                         'properties': {'name': row['pipeline_code'], 'road': row['road_name'], 'coordinateSystem': 'CGCS2000'},
                         'geometry': {'type': 'LineString', 'coordinates': [
                             [float(row['start_x']), float(row['start_y'])],
                             [float(row['end_x']), float(row['end_y'])]]}})
    route = [[float(row['point_x']), float(row['point_y'])] for row in csv_rows(ROOT / 'data/gis' / reference)]
    return {'name': name, 'pipelines': {'type': 'FeatureCollection', 'features': features}, 'reference': route}


def validate_request(body):
    if not isinstance(body, dict):
        raise ValueError('请求必须为对象')
    points = body.get('points')
    if not isinstance(points, list) or len(points) < 2:
        raise ValueError('请至少设置 2 个点')
    for point in points:
        if (not isinstance(point, list) or len(point) != 2 or
            any(type(n) not in (int, float) or not math.isfinite(n) for n in point) or
            not (72 <= point[0] <= 138 and 0 < point[1] <= 56)):
            raise ValueError('坐标必须是中国境内的 GCJ-02 经纬度')
    if any(a == b for a, b in zip(points, points[1:])):
        raise ValueError('相邻路线点不能重合')
    if body.get('strategy') not in (10, 13, 15, 16, 18):
        raise ValueError('不支持的驾车策略')
    if body.get('vehicle', 'car') not in ('car', 'ebike', 'motorcycle'):
        raise ValueError('不支持的规划载具')
    return points


def coord(point):
    return ','.join(f'{n:.6f}' for n in point)


def merge_request(body):
    """合并碎片管线。body = {'features': [...], 'tolerance_m': 0.5}"""
    features = body.get('features')
    if not isinstance(features, list):
        raise ValueError('请求必须包含 features 数组')
    tolerance = float(body.get('tolerance_m', 0.5))
    if not (0.01 <= tolerance <= 50):
        raise ValueError('端点合并阈值需在 0.01–50m 之间')
    result = merge_pipelines(features, tolerance_m=tolerance)
    return {
        'merged': result['merged'],
        'orphans': result['orphans'],
        'stats': result['stats'],
    }

def import_dxf(body):
    raw = body.get('content') if isinstance(body, dict) else None
    if not isinstance(raw, str) or len(raw) > 30_000_000: raise ValueError('DXF 文件内容无效或超过 20MB')
    try: data = base64.b64decode(raw, validate=True)
    except Exception: raise ValueError('DXF 文件编码无效') from None
    layer = str(body.get('layer', '新增燃气管道'))[:120]
    with tempfile.TemporaryDirectory(prefix='patrol-dxf-') as temp:
        src = Path(temp) / 'input.dxf'; out = Path(temp) / 'lines.geojson'; buf = Path(temp) / 'buffer.geojson'; report = Path(temp) / 'report.md'; mapping = ROOT / 'data/gis/templates/dxf_facility_mapping_template.csv'; facilities = Path(temp) / 'facilities.geojson'; facilities_report = Path(temp) / 'facilities.md'
        src.write_bytes(data)
        coordinate_hint = '未判定（请以图纸坐标说明为准）'
        try:
            import ezdxf
            doc_hint = ezdxf.readfile(src)
            values = []
            for entity in list(doc_hint.modelspace())[:5000]:
                for attr in ('start', 'end', 'insert', 'location'):
                    point = getattr(getattr(entity, 'dxf', None), attr, None)
                    if point is not None and hasattr(point, 'x'):
                        values.extend((float(point.x), float(point.y)))
                if len(values) >= 2000:
                    break
            if values:
                xs, ys = values[0::2], values[1::2]
                if max(abs(x) for x in xs) <= 180 and max(abs(y) for y in ys) <= 90:
                    coordinate_hint = '疑似经纬度坐标：请确认选择 WGS84、CGCS2000 经纬度或 GCJ-02'
                elif max(abs(x) for x in xs) >= 200000 or max(abs(y) for y in ys) >= 100000:
                    coordinate_hint = '疑似三度带/高斯投影坐标：请确认带号和中央子午线'
        except Exception:
            pass
        source_crs = str(body.get('sourceCrs', 'cgcs2000_projected')).lower()
        if source_crs not in {'cgcs2000_projected', 'cgcs2000_lonlat', 'wgs84', 'gcj02'}:
            raise ValueError('不支持的 DXF 源坐标系')
        cmd = [sys.executable, str(RESOURCE_ROOT / 'scripts/build_dxf_pipeline_display_layer.py'), '--dxf', str(src), '--layer', layer, '--line-output', str(out), '--buffer-output', str(buf), '--report', str(report), '--source-crs', source_crs, '--zone-prefix', str(body.get('zonePrefix', 40)), '--central-meridian', str(body.get('centralMeridian', 120)), '--protection-radius-m', str(body.get('protectionRadiusM', 5))]
        try:
            if getattr(sys, 'frozen', False):
                # A one-file PyInstaller executable cannot launch itself as a
                # Python interpreter. Run the bundled converter in-process.
                with IMPORT_LOCK:
                    old_argv = sys.argv
                    try:
                        sys.argv = cmd[1:]
                        try:
                            runpy.run_path(cmd[1], run_name='__main__')
                        except SystemExit as ex:
                            if ex.code not in (None, 0):
                                raise RuntimeError(f'转换脚本退出码 {ex.code}')
                    finally:
                        sys.argv = old_argv
            else:
                subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=60)
        except Exception as e: raise ValueError(f'DXF 转换失败：{str(e)[:180]}') from None
        facility_cmd = [sys.executable, str(RESOURCE_ROOT / 'scripts/extract_dxf_facilities.py'), '--dxf', str(src), '--output', str(facilities), '--report', str(facilities_report), '--mapping', str(mapping), '--source-crs', source_crs, '--zone-prefix', str(body.get('zonePrefix', 40)), '--central-meridian', str(body.get('centralMeridian', 120))]
        try:
            if getattr(sys, 'frozen', False):
                with IMPORT_LOCK:
                    old_argv = sys.argv
                    try:
                        sys.argv = facility_cmd[1:]
                        try:
                            runpy.run_path(facility_cmd[1], run_name='__main__')
                        except SystemExit as ex:
                            if ex.code not in (None, 0):
                                raise RuntimeError(f'设施脚本退出码 {ex.code}')
                    finally:
                        sys.argv = old_argv
            else:
                subprocess.run(facility_cmd, check=True, capture_output=True, text=True, timeout=60)
        except Exception: pass
        result = json.loads(out.read_text('utf-8')); task_points = json.loads(facilities.read_text('utf-8')) if facilities.exists() else {'type':'FeatureCollection','features':[]}
        return {'name':'DXF 转换管线图层', 'pipelines':result, 'tasks':task_points, 'reference':[], 'stats':{'features':len(result.get('features',[])), 'tasks':len(task_points.get('features',[])), 'sourceCrs':source_crs, 'coordinateHint':coordinate_hint, 'zonePrefix':body.get('zonePrefix',40), 'centralMeridian':body.get('centralMeridian',120), 'layer':layer}}


def split_route_points(points, max_total=18):
    """Split an ordered route into overlapping chunks for AMap requests."""
    if max_total < 2:
        raise ValueError('分段点数上限无效')
    chunks = []
    start = 0
    while start < len(points) - 1:
        end = min(start + max_total - 1, len(points) - 1)
        chunks.append(points[start:end + 1])
        start = end
    return chunks


def driving(body):
    points = validate_request(body)
    strategy = str(body['strategy'])
    vehicle = body.get('vehicle', 'car')
    key = settings().get('AMAP_WEBSERVICE_KEY', '')
    if not key:
        raise ValueError('未找到 AMAP_WEBSERVICE_KEY，请检查项目本地配置')
    cache_key = json.dumps({'points': points, 'strategy': strategy, 'vehicle': vehicle}, separators=(',', ':'), ensure_ascii=False)
    with LOCK:
        cached = CACHE.get(cache_key)
        if cached and time.monotonic() - cached[0] < 300:
            return {**cached[1], 'cached': True}
        # AMap accepts at most 16 waypoints per request. Split long plans into
        # overlapping chunks and stitch the returned geometries in order.
        chunks = split_route_points(points)
        stitched = {}
        for chunk in chunks:
            params = {'origin': coord(chunk[0]), 'destination': coord(chunk[-1]),
                      'waypoints': ';'.join(map(coord, chunk[1:-1])), 'strategy': strategy,
                      'extensions': 'all', 'output': 'json', 'key': key}
            try:
                with urlopen('https://restapi.amap.com/v3/direction/driving?' + urlencode(params), timeout=30) as response:
                    result = json.load(response)
            except Exception:
                raise ValueError('高德驾车服务连接失败或超时，请检查网络后重试') from None
            if result.get('status') != '1':
                info = str(result.get('info', '未知错误'))[:150]
                code = str(result.get('infocode', ''))[:30]
                raise ValueError(f'高德算路失败：{info}（{code}）。请检查 Key 权限、配额和途经点。')
            for index, route in enumerate(result.get('route', {}).get('paths', [])):
                item = stitched.setdefault(index, {'distance': 0.0, 'duration': 0.0, 'tolls': 0.0, 'restriction': str(route.get('restriction', '')), 'geometry': [], 'steps': [], 'turnStats': {'left': 0, 'right': 0, 'uturn': 0, 'bridge': 0}})
                geometry = []
                for step in route.get('steps', []):
                    for pair in step.get('polyline', '').split(';'):
                        if pair:
                            point = [float(n) for n in pair.split(',')]
                            if not geometry or geometry[-1] != point:
                                geometry.append(point)
                    action = str(step.get('action', ''))
                    instruction = str(step.get('instruction', ''))
                    road = str(step.get('road', '未命名道路'))
                    item['steps'].append({'road': road, 'instruction': instruction,
                                          'distance': float(step.get('distance', 0)), 'action': action})
                    turn_text = f'{action}{instruction}'
                    if '左' in turn_text: item['turnStats']['left'] += 1
                    if '右' in turn_text: item['turnStats']['right'] += 1
                    if '掉头' in turn_text or '调头' in turn_text or 'U-turn' in turn_text: item['turnStats']['uturn'] += 1
                    if '桥' in f'{road}{instruction}': item['turnStats']['bridge'] += 1
                if item['geometry'] and geometry and item['geometry'][-1] == geometry[0]:
                    geometry = geometry[1:]
                item['geometry'].extend(geometry)
                item['distance'] += float(route.get('distance', 0))
                item['duration'] += float(route.get('duration', 0))
                item['tolls'] += float(route.get('tolls', 0))
        routes = []
        for index, route in stitched.items():
            if len(route['geometry']) >= 2:
                route['id'] = index
                routes.append(route)
        if not routes:
            raise ValueError('高德没有返回可用的道路路线，请把途经点调整到可行驶道路')
        payload = {'routes': routes, 'cached': False, 'segments': len(chunks), 'pointCount': len(points), 'controlPointOrder': list(range(1, len(points) + 1)), 'orderLocked': True, 'vehicle': vehicle, 'provider': 'AMap Driving v3', 'coordinateSystem': 'GCJ-02'}
        if len(CACHE) >= 100:
            CACHE.clear()
        CACHE[cache_key] = (time.monotonic(), payload)
        return payload


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, value, status=200, mime='application/json; charset=utf-8'):
        raw = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(raw)

    def local_request(self):
        host = self.headers.get('Host', '')
        if host not in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'):
            self.send({'error': '仅允许本机访问'}, 403)
            return False
        return True

    def do_GET(self):
        if not self.local_request():
            return
        url = urlsplit(self.path)
        try:
            if url.path == '/api/config':
                env = settings()
                self.send({'jsKey': env.get('VITE_AMAP_WEB_JS_KEY', ''),
                           'securityJsCode': env.get('VITE_AMAP_SECURITY_JS_CODE', ''),
                           'routingConfigured': bool(env.get('AMAP_WEBSERVICE_KEY')), 'license': license_status(), 'token': TOKEN})
            elif url.path == '/api/dataset':
                self.send(dataset(parse_qs(url.query).get('scope', ['route5'])[0]))
            elif url.path in ('/', '/index.html', '/app.js', '/geometry.mjs', '/style.css'):
                name = 'index.html' if url.path == '/' else url.path[1:]
                mime = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css'}[Path(name).suffix]
                self.send((APP / name).read_bytes(), mime=mime + '; charset=utf-8')
            else:
                self.send({'error': 'Not found'}, 404)
        except (ValueError, OSError):
            self.send({'error': '无法读取数据，请检查管线范围和本地资料文件'}, 400)

    def do_POST(self):
        if not self.local_request():
            return
        origin = self.headers.get('Origin')
        allowed = (f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}')
        if (origin and origin not in allowed) or self.headers.get('X-Planner-Token') != TOKEN:
            self.send({'error': '请求来源校验失败，请刷新本地页面'}, 403)
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 35000000:
                raise ValueError('请求大小无效')
            body = json.loads(self.rfile.read(length))
            if self.path == '/api/plan':
                license_info = license_status()
                if not license_info['active']:
                    raise ValueError('试用期已结束，请联系开发者获取授权')
                if len(body.get('points', [])) > license_info['maxPoints']:
                    raise ValueError(f"试用版最多支持 {license_info['maxPoints']} 个地图点，请联系开发者升级授权")
                self.send(driving(body))
            elif self.path == '/api/plan/segment':
                license_info = license_status()
                if not license_info['active']:
                    raise ValueError('试用期已结束，请联系开发者获取授权')
                if len(body.get('points', [])) > license_info['maxPoints']:
                    raise ValueError(f"试用版最多支持 {license_info['maxPoints']} 个地图点，请联系开发者升级授权")
                self.send(driving(body))
            elif self.path == '/api/import/dxf':
                self.send(import_dxf(body))
            elif self.path == '/api/pipelines/merge':
                self.send(merge_request(body))
            else:
                self.send({'error': 'Not found'}, 404)
        except (ValueError, TypeError, KeyError) as error:
            self.send({'error': str(error)}, 400)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8787)
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'Patrol planner: http://127.0.0.1:{args.port}', flush=True)
    server.serve_forever()
