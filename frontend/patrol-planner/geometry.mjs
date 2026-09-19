const R = 6371008.8;
const rad = Math.PI / 180;
export function distance(a, b) {
  const x = (b[0] - a[0]) * rad * Math.cos((a[1] + b[1]) * rad / 2);
  return Math.hypot(x, (b[1] - a[1]) * rad) * R;
}
export function toGcj([lng, lat]) {
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return [lng, lat];
  const x = lng - 105, y = lat - 35, pi = Math.PI;
  const wave = (20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2 / 3;
  let dy = -100 + 2 * x + 3 * y + .2 * y * y + .1 * x * y + .2 * Math.sqrt(Math.abs(x)) + wave;
  dy += (20 * Math.sin(y * pi) + 40 * Math.sin(y / 3 * pi)) * 2 / 3;
  dy += (160 * Math.sin(y / 12 * pi) + 320 * Math.sin(y * pi / 30)) * 2 / 3;
  let dx = 300 + x + 2 * y + .1 * x * x + .1 * x * y + .1 * Math.sqrt(Math.abs(x)) + wave;
  dx += (20 * Math.sin(x * pi) + 40 * Math.sin(x / 3 * pi)) * 2 / 3;
  dx += (150 * Math.sin(x / 12 * pi) + 300 * Math.sin(x / 30 * pi)) * 2 / 3;
  const sin = Math.sin(lat * rad), magic = 1 - .00669342162296594323 * sin * sin;
  dy = dy * 180 / ((6378245 * (1 - .00669342162296594323)) / (magic * Math.sqrt(magic)) * pi);
  dx = dx * 180 / (6378245 / Math.sqrt(magic) * Math.cos(lat * rad) * pi);
  return [lng + dx, lat + dy];
}
export function fromGcj(point) {
  let guess = [...point];
  for (let i = 0; i < 5; i++) {
    const converted = toGcj(guess);
    guess = guess.map((v, j) => v + point[j] - converted[j]);
  }
  return guess;
}
export function pointSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
// Classify a path turn in screen/map coordinates. This is a geometric
// candidate signal only; legality still comes from the road provider.
export function classifyTurn(a, b, c, thresholds = {}) {
  const minLeg = Number(thresholds.minLegM) || 3;
  const ab = distance(a, b), bc = distance(b, c);
  if (ab < minLeg || bc < minLeg) return {kind: 'straight', angle: 0, cross: 0};
  // Normalize in coordinate units; using metre lengths with degree deltas
  // would distort the turn angle by the longitude/latitude scale.
  const abCoord = Math.hypot(b[0]-a[0], b[1]-a[1]), bcCoord = Math.hypot(c[0]-b[0], c[1]-b[1]);
  const ux = (b[0]-a[0]) / abCoord, uy = (b[1]-a[1]) / abCoord;
  const vx = (c[0]-b[0]) / bcCoord, vy = (c[1]-b[1]) / bcCoord;
  const cross = ux * vy - uy * vx;
  const dot = Math.max(-1, Math.min(1, ux * vx + uy * vy));
  const angle = Math.acos(dot) * 180 / Math.PI;
  const uTurnAngle = Number(thresholds.uTurnAngle) || 150;
  if (angle >= uTurnAngle) return {kind: 'uturn-candidate', angle, cross};
  if (angle < 20) return {kind: 'straight', angle, cross};
  return {kind: cross > 0 ? 'left' : 'right', angle, cross};
}
export function analyzePathTurns(path, thresholds = {}) {
  const result = {left: 0, right: 0, uturnCandidates: 0, sharp: 0, turns: []};
  if (!Array.isArray(path)) return result;
  for (let i = 1; i < path.length - 1; i++) {
    const turn = classifyTurn(path[i - 1], path[i], path[i + 1], thresholds);
    if (turn.kind === 'left') result.left++;
    else if (turn.kind === 'right') result.right++;
    else if (turn.kind === 'uturn-candidate') result.uturnCandidates++;
    if (turn.angle >= (Number(thresholds.sharpAngle) || 70)) result.sharp++;
    if (turn.kind !== 'straight') result.turns.push({...turn, index: i});
  }
  return result;
}
export function turnReviewPoints(path, thresholds = {}) {
  const analysis = analyzePathTurns(path, thresholds);
  return analysis.turns.filter(t => t.kind === 'uturn-candidate' || t.angle >= (Number(thresholds.reviewAngle) || 100)).map(t => ({
    index: t.index, coordinate: path[t.index], angle: Math.round(t.angle * 10) / 10,
    kind: t.kind, reason: t.kind === 'uturn-candidate' ? '疑似掉头，需确认合法掉头节点' : '急转弯，需确认道路连接'
  }));
}
export function lineLength(points) {
  return points.slice(1).reduce((sum, p, i) => sum + distance(points[i], p), 0);
}
export function sampleLine(points, spacing = 300) {
  const length = lineLength(points), count = Math.max(1, Math.ceil(length / spacing));
  const samples = [points[0]];
  let traversed = 0, target = length / count;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], d = distance(a, b);
    while (d > 0 && target < traversed + d && samples.length <= count) {
      const t = (target - traversed) / d;
      samples.push(a.map((v, j) => v + (b[j] - v) * t));
      target += length / count;
    }
    traversed += d;
  }
  if (distance(samples.at(-1), points.at(-1)) > 1) samples.push(points.at(-1));
  return samples;
}
// Length-weighted midpoint sampling, not feature-count or vertex-count coverage.
// A local route-segment grid keeps full CAD evaluation practical.
export function coverage(features, route, radius = 40, spacing = 20) {
  if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(spacing) || spacing <= 0) throw new Error('覆盖距离无效');
  const center = route[0] || features[0]?.geometry.coordinates[0] || [120, 36];
  const project = p => [(p[0] - center[0]) * rad * R * Math.cos(center[1] * rad), (p[1] - center[1]) * rad * R];
  const cell = Math.max(100, radius), grid = new Map(), projected = route.map(project);
  for (let i = 1; i < projected.length; i++) {
    const a = projected[i - 1], b = projected[i];
    for (let x = Math.floor((Math.min(a[0], b[0]) - radius) / cell); x <= Math.floor((Math.max(a[0], b[0]) + radius) / cell); x++) {
      for (let y = Math.floor((Math.min(a[1], b[1]) - radius) / cell); y <= Math.floor((Math.max(a[1], b[1]) + radius) / cell); y++) {
        const key = `${x},${y}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push([a, b]);
      }
    }
  }
  let total = 0, covered = 0;
  const perFeature = {};
  for (const feature of features) {
    let length = 0, hit = 0;
    const points = feature.geometry.coordinates.map(project);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(d / spacing));
      for (let j = 0; j < n; j++) {
        const t = (j + .5) / n, p = a.map((v, k) => v + (b[k] - v) * t);
        // A route segment can cross a grid boundary while a nearby pipe sample
        // lands in the neighboring cell. Check the radius-sized neighborhood;
        // using only the sample's own cell caused false uncovered gaps beside
        // the same road, especially for the two sides of a road corridor.
        const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell);
        const reach = Math.ceil(radius / cell) + 1;
        let coveredSample = false;
        for (let gx = cx - reach; gx <= cx + reach && !coveredSample; gx++) {
          for (let gy = cy - reach; gy <= cy + reach && !coveredSample; gy++) {
            const segments = grid.get(`${gx},${gy}`) || [];
            if (segments.some(([c, e]) => pointSegment(p, c, e) <= radius)) coveredSample = true;
          }
        }
        if (coveredSample) hit += d / n;
      }
      length += d;
    }
    total += length; covered += hit;
    perFeature[feature.id] = {total: length, covered: hit, ratio: length ? hit / length : 0};
  }
  return {total, covered, uncovered: Math.max(0, total - covered), ratio: total ? covered / total : 0, perFeature, spacing, radius};
}
export function rankRoutes(routes, maximumKm, priority = 'coverage') {
  return [...routes].sort((a, b) => {
    const invalidA = a.distance > maximumKm * 1000, invalidB = b.distance > maximumKm * 1000;
    if (invalidA !== invalidB) return Number(invalidA) - Number(invalidB);
    const fit = (b.roadFitRatio ?? 0) - (a.roadFitRatio ?? 0);
    const score = (b.score ?? -Infinity) - (a.score ?? -Infinity);
    return priority === 'distance' ? a.distance - b.distance || b.coverage.ratio - a.coverage.ratio || score || fit
      : b.coverage.ratio - a.coverage.ratio || score || fit || a.distance - b.distance;
  });
}
export function scoreRouteMetrics(metrics = {}) {
  const clamp = v => Math.max(0, Math.min(1, Number(v) || 0));
  const coverageRatio = clamp(metrics.coverageRatio), taskRatio = clamp(metrics.taskRatio), orderRatio = clamp(metrics.orderRatio);
  const legalTurnRatio = clamp(metrics.legalTurnRatio ?? 1), detourRatio = clamp(metrics.detourRatio), duplicateRatio = clamp(metrics.duplicateRatio);
  return coverageRatio * 50 + taskRatio * 20 + orderRatio * 15 + legalTurnRatio * 10 - (detourRatio + duplicateRatio) * 15;
}
export function normalizeGeoJSON(data, coordinateSystem = 'WGS84') {
  if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('请导入 GeoJSON FeatureCollection');
  const allLines = data.features.length > 0 && data.features.every(f => f?.geometry?.type === 'LineString');
  const hasNormalizedMetadata = data.features.some(f => f?.geometry?.type === 'LineString' && typeof f.id === 'string' && f.id && Object.hasOwn(f?.properties || {}, 'sourceId'));
  const normalized = allLines && hasNormalizedMetadata;
  if (normalized) {
    const ids = new Set();
    for (const f of data.features) {
      if (f?.type !== 'Feature' || f.geometry?.type !== 'LineString' || typeof f.id !== 'string' || !f.id || !f.properties || !Object.hasOwn(f.properties, 'sourceId') || f.properties.sourceId === undefined || ids.has(f.id)) {
        throw new Error('已规范化管线图层必须保留唯一字符串 id 与 properties.sourceId');
      }
      ids.add(f.id);
    }
  }
  const isGcj02 = String(coordinateSystem).toUpperCase().replace(/[^A-Z0-9]/g, '') === 'GCJ02';
  const features = [];
  let vertices = 0;
  for (const [index, f] of data.features.entries()) {
    const g = f.geometry;
    if (g?.type === 'Point') continue;
    if (!g || !['LineString', 'MultiLineString'].includes(g.type)) throw new Error('管线图层仅接受 LineString / MultiLineString，请先剔除文字、面和点图层');
    const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
    for (const [part, line] of lines.entries()) {
      if (!Array.isArray(line) || line.length < 2) throw new Error('每条管线至少需要两个坐标');
      for (const p of line) {
        if (!Array.isArray(p) || p.length < 2 || !p.slice(0, 2).every(n => typeof n === 'number' && Number.isFinite(n)) || p[0] < 72 || p[0] > 138 || p[1] <= 0 || p[1] > 56) {
          throw new Error('坐标超出中国经纬度范围：CAD 平面坐标须先投影转换');
        }
      }
      vertices += line.length;
      if (vertices > 150000 || features.length >= 10000) throw new Error('图层过大，请裁剪到巡线范围（最多 1 万条线、15 万坐标）');
      features.push({type: 'Feature', id: normalized ? f.id : `${index}:${part}`, properties: normalized ? {...f.properties} : {...f.properties, sourceId: f.id ?? index},
        geometry: {type: 'LineString', coordinates: line.map(p => isGcj02 ? p.slice(0, 2) : toGcj(p))}});
    }
  }
  if (!features.length) throw new Error('管线图层为空');
  return features;
}

export function extractTaskPoints(data, coordinateSystem = 'WGS84') {
  if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) return [];
  const isGcj02 = String(coordinateSystem).toUpperCase().replace(/[^A-Z0-9]/g, '') === 'GCJ02';
  const keys = /(阀|门井|检查井|井室|调压|标志桩|阴保|桩|valve|manhole|regulat|marker|cp)/i;
  return data.features.flatMap((f, index) => {
    if (f?.geometry?.type !== 'Point' || !Array.isArray(f.geometry.coordinates)) return [];
    const props = f.properties || {};
    const text = [f.id, ...Object.values(props)].filter(v => v !== undefined && v !== null).join(' ');
    if (!keys.test(text)) return [];
    const p = f.geometry.coordinates;
    if (p.length < 2 || !p.slice(0, 2).every(n => typeof n === 'number' && Number.isFinite(n))) return [];
    return [{id: String(f.id ?? `task-${index}`), coordinate: isGcj02 ? p.slice(0, 2) : toGcj(p), name: String(props.name || props.type || f.id || '设施任务点').slice(0, 80), kind: 'task'}];
  });
}

export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    const intersect = ((yi > point[1]) !== (yj > point[1])) && point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || 1e-15) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
export function lineIntersectsPolygon(line, polygon) {
  const edgeHit = (a, b, c, d) => {
    const cross = (u, v, w) => (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
    const c1 = cross(a, b, c), c2 = cross(a, b, d), c3 = cross(c, d, a), c4 = cross(c, d, b);
    return ((c1 === 0 && c2 === 0) || c1 * c2 <= 0) && ((c3 === 0 && c4 === 0) || c3 * c4 <= 0);
  };
  if (line.some(point => pointInPolygon(point, polygon))) return true;
  for (let li = 1; li < line.length; li++) {
    if (polygon.some((a, i) => edgeHit(a, polygon[(i + 1) % polygon.length], line[li - 1], line[li]))) return true;
  }
  return false;
}
export function linesInPolygon(features, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) throw new Error('区域至少需要 3 个点');
  return features.filter(feature => feature.geometry?.type === 'LineString' && lineIntersectsPolygon(feature.geometry.coordinates, polygon));
}
