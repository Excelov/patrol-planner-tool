import {toGcj, fromGcj, distance, lineLength, sampleLine, coverage, rankRoutes, scoreRouteMetrics, normalizeGeoJSON, extractTaskPoints, linesInPolygon, analyzePathTurns, turnReviewPoints} from './geometry.mjs';

const $ = id => document.getElementById(id);
const state = {features: [], selected: new Set(), points: [], importedTasks: [], calibration: {eastM:0,northM:0,confirmed:false,at:null}, insertAfter: null, lastChangedIndex: null, previousRoute: null, reference: [], routes: [], active: null, area: null, revision: 0, operation: 0, datasetLoading: 0, planning: 0, scope: 'route5', add: false, drawArea: false};
let map, config, pipeOverlays = [], markers = [], routeOverlays = [], turnReviewOverlays = [], referenceOverlay, areaOverlay;
const km = meters => (meters / 1000).toFixed(2);
const percent = n => (n * 100).toFixed(1) + '%';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function message(text, error = false) { $('status').textContent = text; $('status').className = error ? 'error' : ''; }
function updatePlanButton() { $('plan').disabled = state.datasetLoading > 0 || state.planning > 0; }
function removeImportedScopeOption() { $('scope').querySelector('[value="imported"]')?.remove(); }
function guarded(fn) { return async (...args) => { try { await fn(...args); } catch (e) { message(e.message || '操作失败', true); } }; }
function action(id, fn) { $(id).addEventListener('click', guarded(fn)); }
async function api(url, options) {
  let request = options;
  let response = await fetch(url, request);
  let data = await response.json();
  // A server restart rotates the loopback token. Refresh it once so an open
  // browser tab does not fail every POST until the user hard-refreshes.
  if (response.status === 403 && data.error === '请求来源校验失败，请刷新本地页面' && options?.headers) {
    const refreshed = await fetch('/api/config', {cache: 'no-store'});
    if (refreshed.ok) {
      const latest = await refreshed.json();
      config = latest;
      request = {...options, headers: {...options.headers, 'X-Planner-Token': latest.token}};
      response = await fetch(url, request);
      data = await response.json();
    }
  }
  if (!response.ok) throw new Error(data.error || '本地服务请求失败');
  return data;
}
function targetFeatures() { return state.features.filter(f => state.selected.has(f.id)); }
function boundsFit(overlays) { if (map && overlays.length) map.setFitView(overlays, false, [90, 70, 60, 55], 17); }
function applyImportShift(eastM, northM) {
  const all = [...state.features.flatMap(f => f.geometry.coordinates), ...state.importedTasks.map(t => t.coordinate)];
  const lat = all[0]?.[1] || 36; const dLat = northM / 111320; const dLon = eastM / (111320 * Math.cos(lat * Math.PI / 180));
  state.features.forEach(f => { f.geometry.coordinates = f.geometry.coordinates.map(([x,y]) => [x+dLon,y+dLat]); });
  state.importedTasks.forEach(t => { t.coordinate = [t.coordinate[0]+dLon,t.coordinate[1]+dLat]; });
}
function invalidate(text = '点位或道路策略已更改，请重新生成方案。') {
  state.revision++; state.previousRoute = state.active || state.previousRoute; state.routes = []; state.active = null;
  if (map) map.remove(routeOverlays);
  routeOverlays = [];
  if (map) map.remove(turnReviewOverlays);
  turnReviewOverlays = [];
  $('metrics').innerHTML = ''; $('candidates').innerHTML = ''; $('route-details').hidden = true;
  const local = $('replan-local'); if (local) local.disabled = !(state.previousRoute && state.lastChangedIndex != null && state.points.length >= 2);
  stylePipes(); message(text);
}
function pipeColor(feature) {
  if (!state.selected.has(feature.id)) return '#aeb9b3';
  const stat = state.active?.coverage.perFeature[feature.id];
  return stat && stat.ratio < .95 ? '#df802f' : '#208664';
}
function stylePipes() {
  pipeOverlays.forEach((overlay, i) => overlay.setOptions({strokeColor: pipeColor(state.features[i]), strokeWeight: state.selected.has(state.features[i].id) ? 4 : 2}));
}
function drawPipes() {
  if (!map) return;
  map.remove(pipeOverlays);
  pipeOverlays = state.features.map(feature => {
    const overlay = new AMap.Polyline({path: feature.geometry.coordinates, strokeColor: pipeColor(feature), strokeWeight: 4, strokeOpacity: .88, bubble: false, zIndex: 40});
    overlay.on('click', event => {
      if (state.add) { addPoint([event.lnglat.lng, event.lnglat.lat]); return; }
      if (state.selected.has(feature.id)) state.selected.delete(feature.id); else state.selected.add(feature.id);
      selectionChanged();
    });
    return overlay;
  });
  if ($('show-pipes').checked) map.add(pipeOverlays);
  if (referenceOverlay) map.remove(referenceOverlay);
  referenceOverlay = state.reference.length ? new AMap.Polyline({path: state.reference, strokeColor: '#819c98', strokeStyle: 'dashed', strokeWeight: 3, zIndex: 30}) : null;
  if (referenceOverlay && $('show-reference').checked) map.add(referenceOverlay);
}
function drawArea() { if (!map) return; if (areaOverlay) map.remove(areaOverlay); areaOverlay = state.area?.length >= 3 ? new AMap.Polygon({path: state.area, strokeColor:'#b66b2c', fillColor:'#edb47d', fillOpacity:.15, strokeWeight:3, zIndex:35}) : null; if (areaOverlay) map.add(areaOverlay); }
function renderRoads() {
  const groups = new Map();
  state.features.forEach(f => {
    const road = String(f.properties?.road || f.properties?.sourceLayer || '未标注道路');
    if (!groups.has(road)) groups.set(road, []);
    groups.get(road).push(f);
  });
  $('roads').replaceChildren();
  const search = $('road-filter').value.trim().toLowerCase();
  [...groups].sort((a,b) => a[0].localeCompare(b[0], 'zh')).filter(([name]) => name.toLowerCase().includes(search)).forEach(([road, features]) => {
    const label = document.createElement('label'); label.className = 'road';
    const box = document.createElement('input'); box.type = 'checkbox';
    const selected = features.filter(f => state.selected.has(f.id)).length;
    box.checked = selected === features.length; box.indeterminate = selected > 0 && selected < features.length;
    const name = document.createElement('span'); name.textContent = road;
    const count = document.createElement('small'); count.textContent = `${selected}/${features.length}`;
    box.onchange = () => { features.forEach(f => box.checked ? state.selected.add(f.id) : state.selected.delete(f.id)); selectionChanged(); };
    label.append(box, name, count); $('roads').append(label);
  });
  const selected = targetFeatures();
  $('dataset-note').textContent = `共 ${state.features.length} 段 · 已选 ${selected.length} 段 / ${km(selected.reduce((n,f) => n + lineLength(f.geometry.coordinates), 0))} km`;
}
function selectionChanged() {
  state.revision++; renderRoads(); stylePipes();
  if (state.routes.length) guarded(evaluateRoutes)();
}
function finishArea() {
  if (state.area?.length < 3) throw new Error('区域至少需要 3 个点');
  state.drawArea = false; $('area-mode').classList.remove('active');
  const selected = linesInPolygon(state.features, state.area); state.selected = new Set(selected.map(f => f.id));
  invalidate(`已选中区域内 ${selected.length} 段管线，区域内管线将全部作为必巡目标。`); drawArea(); renderRoads(); boundsFit([areaOverlay]);
}
async function loadScope(scope, {token = ++state.operation, manageLoading = true, announce = true} = {}) {
  const operation = token;
  if (manageLoading) state.datasetLoading++;
  if (announce) invalidate('正在读取本地管线资料…');
  updatePlanButton();
  try {
    const data = await api(`/api/dataset?scope=${scope}`);
    if (operation !== state.operation) return false;
    state.features = normalizeGeoJSON(data.pipelines, 'WGS84');
    state.scope = scope; state.reference = data.reference.map(toGcj);
    state.importedTasks = (data.tasks?.features || []).filter(f => f.geometry?.type === 'Point').map((f,i) => ({id:String(f.id || `task-${i}`), coordinate:toGcj(f.geometry.coordinates), name:String(f.properties?.label || f.properties?.name || f.properties?.facilityType || '设施任务点'), kind:'task', facilityType:String(f.properties?.facilityType || 'unmapped'), sourceHandle:String(f.properties?.sourceHandle || '')})); renderTasksPicker();
    state.selected = new Set(state.features.map(f => f.id)); state.points = []; state.area = null;
    renderRoads(); drawPipes(); drawArea(); renderPoints(); boundsFit(pipeOverlays);
    $('reference').disabled = !state.reference.length;
    message(`已加载${data.name}。请选择目标管段，并在附近可行驶道路上添加途经点。`);
    return true;
  } catch (error) {
    if (operation !== state.operation) return false;
    throw error;
  } finally { if (manageLoading) state.datasetLoading--; updatePlanButton(); }
}
function renderPoints() {
  $('point-count').textContent = `${state.points.length} 点`;
  $('points').replaceChildren();
  if (!state.points.length) $('points').innerHTML = '<div class="empty">还没有点位。可在地图上布点。</div>';
  state.points.forEach((point, i) => {
    const row = document.createElement('div'); row.className = 'point';
    if (state.insertAfter === i) row.classList.add('insert-anchor');
    row.title = '点击此点，后续地图加点将插入到它后面';
    row.onclick = event => { if (event.target.tagName !== 'INPUT' && event.target.tagName !== 'BUTTON') { state.insertAfter = i; renderPoints(); message(`已选中第 ${i + 1} 点，地图加点将插入其后`); } };
    const order = document.createElement('span'); order.textContent = i + 1;
    const input = document.createElement('input'); input.value = point.name; input.maxLength = 80; input.setAttribute('aria-label', `点位 ${i + 1} 名称`);
    input.onchange = () => { point.name = input.value; };
    const modeLabel = {road:'道路', task:'任务', free:'自由'}[point.mode || 'road'];
    const sideLabel = point.side === 'left' ? '管线左侧候选' : point.side === 'right' ? '管线右侧候选' : point.side === 'center' ? '管线中心候选' : '';
    const location = document.createElement('small'); location.textContent = `${i === 0 ? '起点' : i === state.points.length - 1 && !$('loop').checked ? '终点' : '途经'} · ${modeLabel}${sideLabel ? ` · ${sideLabel}` : ''}${point.roadMatch?.road ? ` · ${point.roadMatch.road}` : point.roadMatch?.status === 'review' ? ' · 待道路复核' : ''}${point.roadFit ? ` · ${point.roadFit === 'matched' ? '路线贴合' : '路线偏离'}${point.snapDistance != null ? ` ${point.snapDistance}m` : ''}` : ''}${point.roadSide ? ` · 道路${point.roadSide === 'left' ? '左侧' : point.roadSide === 'right' ? '右侧' : '中心'}${point.roadSideConfidence === 'review' ? '待复核' : ''}` : ''}`;
    row.append(order, input, location);
    [['↑', -1], ['↓', 1], ['×', 0]].forEach(([label, delta]) => {
      const button = document.createElement('button'); button.textContent = label;
      button.setAttribute('aria-label', `${label === '×' ? '删除' : label === '↑' ? '上移' : '下移'}点位 ${i + 1}`);
      button.disabled = delta !== 0 && (i + delta < 0 || i + delta >= state.points.length);
      button.onclick = () => { state.lastChangedIndex=i; if (delta === 0) state.points.splice(i, 1); else [state.points[i], state.points[i + delta]] = [state.points[i + delta], state.points[i]]; invalidate(); renderPoints(); };
      row.append(button);
    });
    $('points').append(row);
  });
  if (!map) return;
  map.remove(markers);
  markers = state.points.map((point, i) => {
    const marker = new AMap.Marker({position: point.coordinate, draggable: true, offset: new AMap.Pixel(-14, -14), zIndex: 150,
      content: `<div class="marker ${i === state.points.length-1 ? 'last' : ''}">${i+1}</div>`, title: point.name});
    marker.on('dragend', event => { state.lastChangedIndex=i; point.coordinate = [event.lnglat.lng, event.lnglat.lat]; invalidate(); });
    marker.on('click', () => { state.insertAfter = i; renderPoints(); message(`已选中第 ${i + 1} 点，地图加点将插入其后`); });
    return marker;
  });
  map.add(markers);
}
  function setPoints(points, source) {
    state.points = points.map((coordinate, i) => ({coordinate, mode: 'road', name: i === 0 ? '出发点' : `${source} ${i}`}));
  state.insertAfter = state.points.length ? state.points.length - 1 : null;
  invalidate(); renderPoints(); boundsFit(markers);
}
  function addPoint(coordinate, metadata = {}) {
    const maxPoints = config?.license?.maxPoints || Infinity;
    if (state.points.length >= maxPoints) {
      const contact = config?.license?.contactUrl || '';
      throw new Error(`试用版最多支持 ${maxPoints} 个地图点。${contact ? `请联系开发者：${contact}` : '请联系开发者升级授权'}`);
    }
    const mode = $('point-mode')?.value || 'road';
    const first = state.points.length === 0;
    const labels = {road: '道路点', task: '任务点', free: '自由点'};
    const point = {coordinate, mode: metadata.mode || mode, name: metadata.name || (first ? '出发点' : `${labels[mode]} ${state.points.length + 1}`), facilityType: metadata.facilityType, sourceHandle: metadata.sourceHandle};
    const index = first ? 0 : Math.min((state.insertAfter ?? state.points.length - 1) + 1, state.points.length);
    state.points.splice(index, 0, point);
    state.insertAfter = index;
  invalidate(); renderPoints();
}
function numericSettings() {
  const radius = Number($('radius').value), max = Number($('max-km').value);
  if (!Number.isFinite(radius) || radius < 5 || radius > 300) throw new Error('管线邻近距离需在 5–300m 之间');
  if (!Number.isFinite(max) || max < .1 || max > 1000) throw new Error('路线长度上限需在 0.1–1000km 之间');
  return {radius, max};
}
function nearestGeometrySegment(point, geometry) {
  let best = {distance: Infinity, index: 0};
  for (let i = 1; i < (geometry?.length || 0); i++) {
    const a = geometry[i - 1], b = geometry[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    const q = [a[0] + t * dx, a[1] + t * dy], d = distance(point, q);
    if (d < best.distance) best = {distance: d, index: i - 1, a, b};
  }
  return best;
}
function nearestReferenceSegment(point) {
  const route = state.active?.geometry || state.routes?.[0]?.geometry;
  if (route?.length > 1) return nearestGeometrySegment(point, route);
  let best = {distance: Infinity, index: 0};
  for (const feature of state.features || []) {
    const coords = feature.geometry?.coordinates;
    if (feature.geometry?.type === 'LineString') {
      const hit = nearestGeometrySegment(point, coords);
      if (hit.distance < best.distance) best = hit;
    }
  }
  return best;
}
function evaluateRoutes() {
  const {radius, max} = numericSettings();
  const features = targetFeatures();
  state.routes.forEach(route => { route.coverage = coverage(features, route.geometry, radius); const fits=state.points.map(p=>Math.min(...route.geometry.map(x=>distance(p.coordinate,x)))<=80); route.roadFitRatio=fits.length ? fits.filter(Boolean).length/fits.length : 0; const direct=state.points.slice(1).reduce((s,p,i)=>s+distance(state.points[i].coordinate,p.coordinate),0); const detour=direct>0?route.distance/direct-1:0; route.diagnosticReasons=[]; if(route.roadFitRatio<1) route.diagnosticReasons.push('控制点偏离道路'); if(route.coverage.ratio<.95) route.diagnosticReasons.push('管线覆盖不足'); if(detour>.6) route.diagnosticReasons.push('道路可能绕行'); if(route.restriction==='1') route.diagnosticReasons.push('高德返回限行'); const turns=route.turnStats||{}; route.geometryTurns=analyzePathTurns(route.geometry); route.turnReviewPoints=turnReviewPoints(route.geometry); if((turns.uturn||0)>0 || route.geometryTurns.uturnCandidates>0) route.diagnosticReasons.push('包含疑似掉头动作，请核查合法掉头节点'); if((turns.bridge||0)>0) route.diagnosticReasons.push('经过桥梁连接，请核查通行和管线侧别'); route.score=scoreRouteMetrics({coverageRatio:route.coverage.ratio,taskRatio:1,orderRatio:1,legalTurnRatio:(turns.uturn||route.geometryTurns.uturnCandidates)?0:1,detourRatio:Math.min(1,Math.max(0,detour-.6)),duplicateRatio:0}); route.diagnostic=route.diagnosticReasons.length?route.diagnosticReasons.join('、'):'道路连接正常'; });
  state.routes = rankRoutes(state.routes, max, $('priority').value);
  chooseRoute(state.routes[0]);
}
function annotateRoadFit(route) {
  if (!route?.geometry?.length) return;
  state.points.forEach(point => { const hit=nearestGeometrySegment(point.coordinate, route.geometry); const nearest=hit.distance; point.snapDistance = Number.isFinite(nearest) ? Math.round(nearest) : null; point.roadFit = nearest <= 80 ? 'matched' : 'review'; if (hit.a && nearest <= 120) { const cross=(hit.b[0]-hit.a[0])*(point.coordinate[1]-hit.a[1])-(hit.b[1]-hit.a[1])*(point.coordinate[0]-hit.a[0]); point.roadSide = Math.abs(cross)<1e-7 ? 'center' : cross>0 ? 'left' : 'right'; point.roadSideConfidence = nearest<=40 ? 'high' : 'review'; } else { point.roadSide=null; point.roadSideConfidence='review'; } });
}
function chooseRoute(route) {
  if (!route) return;
  state.active = route;
  annotateRoadFit(route);
  renderPoints();
  const {max, radius} = numericSettings();
  if (map) {
    map.remove(routeOverlays);
    routeOverlays = state.routes.map(r => new AMap.Polyline({path: r.geometry, strokeColor: r === route ? '#3279d7' : '#afc4d8', strokeWeight: r === route ? 6 : 3, strokeOpacity: r === route ? .95 : .5, zIndex: r === route ? 100 : 60, showDir: r === route}));
    routeOverlays.forEach((overlay, i) => overlay.on('click', () => chooseRoute(state.routes[i])));
    map.add(routeOverlays);
    turnReviewOverlays = (route.turnReviewPoints || []).map((p, i) => new AMap.Marker({position:p.coordinate, title:p.reason, content:`<div style="background:#d97726;color:#fff;border:2px solid #fff;border-radius:50%;width:22px;height:22px;line-height:18px;text-align:center;font-weight:700">↪</div>`, zIndex:130, offset:new AMap.Pixel(-11,-11)}));
    if (turnReviewOverlays.length) map.add(turnReviewOverlays);
    if (routeOverlays.length) map.setFitView(routeOverlays, false, [40, 40, 40, 40]);
  }
  stylePipes();
  const c = route.coverage;
  const direct = state.points.slice(1).reduce((s,p,i)=>s+distance(state.points[i].coordinate,p.coordinate),0); const detour = direct > 0 ? Math.max(0, route.distance / direct - 1) : 0; const tasks = state.points.filter(p=>p.mode==='task').length;
  const reviewTurns = route.turnReviewPoints?.length || 0;
  $('metrics').innerHTML = [[km(route.distance)+' km','道路路线长度'],[percent(c.ratio),'道路走廊管线覆盖'],[km(c.uncovered)+' km','未覆盖管线长度'],[Math.round(route.duration/60)+' min','高德通行估时（不含巡检停留）'],[percent(Math.max(0, Math.min(1, 1-detour))),'顺序连接效率'],[`${tasks} 个`,'任务点已纳入'],[`${reviewTurns} 个`,'疑似掉头/急转复核'],[Math.round(route.score ?? 0),'综合评分']].map(([value,label]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join('');
  $('candidates').replaceChildren();
  state.routes.forEach((r, i) => {
    const button = document.createElement('button'); button.className = 'candidate' + (r === route ? ' active' : '');
    button.innerHTML = `<strong>方案 ${i+1} · ${r.distance > max*1000 ? '超出里程上限' : '里程符合'}</strong>${km(r.distance)} km · 覆盖 ${percent(r.coverage.ratio)} · 评分 ${Math.round(r.score ?? 0)}<small>控制点贴合 ${percent(r.roadFitRatio ?? 0)} · ${r.diagnostic || '待诊断'}</small>`;
    button.onclick = () => chooseRoute(r); $('candidates').append(button);
  });
  $('steps').innerHTML = '<h3>行驶指引</h3>' + route.steps.map((s,i) => `<p>${i+1}. ${escape(s.instruction || s.road)}</p>`).join('') + (route.turnReviewPoints?.length ? `<details class="turn-review"><summary>疑似掉头/急转复核（${route.turnReviewPoints.length}）</summary>${route.turnReviewPoints.map((p,i)=>`<div class="turn-review-row"><span>${i+1}. ${p.reason} · ${p.angle}°</span><button type="button" data-turn-index="${p.index}">加入控制点</button></div>`).join('')}</details>` : '');
  $('steps').querySelectorAll('[data-turn-index]').forEach(button => button.onclick = () => { const index=Number(button.dataset.turnIndex); const review=route.turnReviewPoints?.find(p=>p.index===index); if(!review) return; const insert=Math.min(state.points.length, Math.max(1, Math.round(index / Math.max(1, route.geometry.length - 1) * state.points.length))); state.points.splice(insert,0,{coordinate:[...review.coordinate],mode:'road',name:`折返点复核 ${insert+1}`,source:'road-turn-review',controlType:review.kind}); state.insertAfter=insert; invalidate('已加入折返点复核控制点，请重新生成路线确认道路合法性'); renderPoints(); });
  const gaps = targetFeatures().filter(f => c.perFeature[f.id]?.ratio < .95).sort((a,b) => c.perFeature[a.id].ratio-c.perFeature[b.id].ratio);
  $('gaps').innerHTML = `<h3>覆盖不足 95% 的管段 · ${gaps.length} 段</h3>`;
  gaps.slice(0,100).forEach(feature => {
    const button = document.createElement('button'); button.className = 'gap';
    button.textContent = `${feature.properties.road || feature.properties.sourceId || feature.id} · 覆盖 ${percent(c.perFeature[feature.id].ratio)} · 点击定位补点`;
    button.onclick = () => { const index = state.features.indexOf(feature); boundsFit([pipeOverlays[index]].filter(Boolean)); };
    $('gaps').append(button);
  });
  if (gaps.length > 100) $('gaps').insertAdjacentHTML('beforeend', '<p>列表仅展示前 100 段；导出路线包含全部目标管段的覆盖统计。</p>');
  $('route-details').hidden = false; $('export-gpx').disabled = false;
  const over = route.distance > max*1000, allOver = state.routes.every(r => r.distance > max*1000);
  message(`${allOver ? '所有候选方案均超出里程上限，请调整点位或拆分任务。' : over ? `当前方案超限 ${km(route.distance-max*1000)} km，请调整点位或拆分任务。` : '当前方案符合里程上限。'} 已按 ${radius}m 邻近距离评估 ${targetFeatures().length} 个目标管段。${route.diagnosticReasons?.length ? `诊断：${route.diagnosticReasons.join('、')}。` : ''}${c.ratio < .95 ? '可定位橙色管段，在旁边道路补点后重新规划。' : ''}`, over || allOver || Boolean(route.diagnosticReasons?.length));
}
async function plan() {
  if (state.datasetLoading) throw new Error('管线资料正在加载，请加载完成后再生成方案');
  if (state.planning) throw new Error('正在生成道路方案，请稍候');
  numericSettings();
  if (!targetFeatures().length) throw new Error('请至少选中一段巡检管线');
  let points = state.points.map(p => p.coordinate);
  if (points.length < 2) throw new Error('请至少设置两个道路点位');
  if ($('loop').checked && distance(points[0], points.at(-1)) >= 2) points = [...points, points[0]];
  const operation = ++state.operation;
  invalidate('正在请求高德机动车路线并计算目标管线覆盖…');
  const revision = state.revision;
  state.planning++; updatePlanButton();
  try {
      const result = await api('/api/plan', {method:'POST', headers:{'Content-Type':'application/json','X-Planner-Token':config.token}, body:JSON.stringify({points, strategy:Number($('strategy').value), vehicle:$('vehicle').value})});
    if (operation !== state.operation || revision !== state.revision) { message('算路期间设置发生变化，本次结果已舍弃，请重新规划。'); return; }
    state.routes = result.routes.map(r => ({...r, requestSegments: result.segments, controlPointOrder: result.controlPointOrder, orderLocked: result.orderLocked, changedPointIndex: state.lastChangedIndex}));
    state.previousRoute = null; state.lastChangedIndex = null;
    evaluateRoutes(); boundsFit(routeOverlays);
  } finally { state.planning--; updatePlanButton(); }
}
function draft() {
  return {format:'patrol-planner-draft', version:1, coordinateSystem:'GCJ-02', scope:state.scope, calibration:state.calibration,
    selected:[...state.selected], points:state.points, area:state.area, lastChangedIndex:state.lastChangedIndex, settings:Object.fromEntries(['strategy','max-km','radius','priority'].map(id => [id,$(id).value])), loop:$('loop').checked,
    imported:state.scope === 'imported' ? {type:'FeatureCollection',features:state.features} : null};
}
function download(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)], {type:'application/json;charset=utf-8'}));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadText(name, text, type='text/plain;charset=utf-8') { const url=URL.createObjectURL(new Blob([text],{type})); const a=document.createElement('a'); a.href=url; a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); }
async function restore(data) {
  if (data?.format !== 'patrol-planner-draft' || data.version !== 1 || data.coordinateSystem !== 'GCJ-02' || !['dxf','route5','route6','full','imported'].includes(data.scope)) throw new Error('不支持的草稿格式或坐标系');
    if (!Array.isArray(data.points) || data.points.length < 2 || !Array.isArray(data.selected)) throw new Error('草稿点位或管线选择无效');
  const points = data.points.map(p => {
    const c = p.coordinate;
    if (!Array.isArray(c) || c.length !== 2 || !c.every(n => typeof n === 'number' && Number.isFinite(n)) || c[0] < 72 || c[0] > 138 || c[1] <= 0 || c[1] > 56) throw new Error('草稿包含无效坐标');
    return {coordinate:c, mode:['road','task','free'].includes(p.mode) ? p.mode : 'road', name:String(p.name || '沿线点').slice(0,80)};
  });
  const settings = data.settings || {};
  if (![10,13,15,16,18].includes(Number(settings.strategy)) || !['coverage','distance'].includes(settings.priority) || !(Number(settings['max-km']) >= .1 && Number(settings['max-km']) <= 1000) || !(Number(settings.radius) >= 5 && Number(settings.radius) <= 300)) throw new Error('草稿规划参数无效');
  let imported;
  if (data.scope === 'imported') imported = normalizeGeoJSON(data.imported, 'GCJ-02');
  const operation = ++state.operation;
  state.datasetLoading++; invalidate('正在恢复草稿…'); updatePlanButton();
  const revision = state.revision;
  try {
    if (imported) {
      state.scope = 'imported'; state.features = imported; state.reference = []; state.selected = new Set();
      if (!$('scope').querySelector('[value="imported"]')) $('scope').add(new Option('导入的管线图层','imported'));
      $('reference').disabled = true;
    } else {
      removeImportedScopeOption();
      if (!await loadScope(data.scope, {token:operation, manageLoading:false, announce:false}) || operation !== state.operation || revision !== state.revision) return;
    }
    if (operation !== state.operation || revision !== state.revision) return;
    $('scope').value = data.scope;
  state.selected = new Set(data.selected.filter(id => state.features.some(f => f.id === id))); state.area = Array.isArray(data.area) && data.area.length >= 3 ? data.area : null;
    const maxPoints = config?.license?.maxPoints || Infinity;
    if (points.length > maxPoints) throw new Error(`当前授权最多恢复 ${maxPoints} 个地图点，请联系开发者升级授权`);
    state.points = points; $('loop').checked = Boolean(data.loop);
    Object.entries(settings).forEach(([id,value]) => { if (['strategy','max-km','radius','priority'].includes(id)) $(id).value = value; });
    invalidate('已恢复草稿。点位和管线选择已载入，请重新联网算路获取道路方案。');
  renderPoints(); renderRoads(); drawPipes(); drawArea(); boundsFit(markers.length ? markers : areaOverlay ? [areaOverlay] : pipeOverlays);
  } finally { state.datasetLoading--; updatePlanButton(); }
}
action('plan', plan);
action('replan-local', async () => {
  const old = state.previousRoute; const idx = state.lastChangedIndex; if (!old || idx == null) throw new Error('请先修改一个点位');
  const from = Math.max(0, idx - 1), to = Math.min(state.points.length - 1, idx + 1); if (to - from < 1) throw new Error('相邻点不足，无法局部重算');
  const result = await api('/api/plan/segment', {method:'POST', headers:{'Content-Type':'application/json','X-Planner-Token':config.token}, body:JSON.stringify({points:state.points.slice(from,to+1).map(p=>p.coordinate), strategy:Number($('strategy').value), vehicle:$('vehicle').value})});
  const segment = result.routes?.[0]; if (!segment?.geometry?.length) throw new Error('高德未返回局部道路段');
  const nearestIndex = point => old.geometry.reduce((best,p,i)=>distance(p,point)<distance(old.geometry[best],point)?i:best,0);
  const a=nearestIndex(state.points[from].coordinate), b=nearestIndex(state.points[to].coordinate); const lo=Math.min(a,b), hi=Math.max(a,b);
  const merged = [...old.geometry.slice(0,lo), ...segment.geometry, ...old.geometry.slice(hi+1)];
  state.routes=[{...old,geometry:merged,distance:old.distance,steps:segment.steps,localReplan:true,localRange:[from+1,to+1]}]; state.previousRoute=null; state.lastChangedIndex=null; evaluateRoutes(); boundsFit(routeOverlays); message(`已局部重算第 ${from+1}–${to+1} 点之间的道路段；总里程仍为原路线估算，请点击“生成道路巡线方案”进行全量校正。`);
});
action('fit', () => boundsFit(pipeOverlays.filter((_,i) => state.selected.has(state.features[i].id))));
action('fit-route', () => boundsFit(routeOverlays.length ? routeOverlays : markers));
action('select-all', () => { state.selected = new Set(state.features.map(f => f.id)); selectionChanged(); });
action('select-none', () => { state.selected.clear(); selectionChanged(); });
action('add-mode', () => { state.add = !state.add; $('add-mode').classList.toggle('active', state.add); $('map-help').textContent = state.add ? '加点模式：按顺序点击道路。再次点击「地图加点」退出。' : '浏览模式：点击管线可选中 / 取消；点位标记可拖动。'; if(map) map.setDefaultCursor(state.add ? 'crosshair' : 'default'); });
action('area-mode', () => { if (state.drawArea && state.area?.length >= 3) { finishArea(); return; } state.drawArea = !state.drawArea; state.add = false; $('add-mode').classList.remove('active'); $('area-mode').classList.toggle('active', state.drawArea); $('map-help').textContent = state.drawArea ? '区域模式：依次点击地图边界点，完成后再次点击“画区域选管线”按钮。' : '浏览模式：点击管线可选中 / 取消；点位标记可拖动。'; if(map) map.setDefaultCursor(state.drawArea ? 'crosshair' : 'default'); });
action('area-clear', () => { state.area = null; state.drawArea = false; $('area-mode').classList.remove('active'); if(areaOverlay) map?.remove(areaOverlay); areaOverlay = null; invalidate('已清除区域，当前恢复为手动管段选择。'); });
action('undo', () => { state.points.pop(); invalidate(); renderPoints(); });
action('clear', () => { state.points = []; invalidate(); renderPoints(); });
action('continue-segment', () => {
  if (state.points.length < 2) throw new Error('当前至少需要两个点位后才能开始下一段');
  const last = state.points.at(-1);
  state.points = [{coordinate: [...last.coordinate], name: `${last.name || '上一段终点'} · 下一段起点`}];
  state.points[0].mode = last.mode || 'road'; state.insertAfter = 0;
  $('loop').checked = false;
  invalidate('已保留上一段终点作为下一段起点。请继续在地图上添加点位，完成后单独生成下一段路线。');
  renderPoints();
});
action('add-coordinate', () => {
  const point = $('coordinate').value.trim().split(/[,，]/).map(Number);
  if (point.length !== 2 || !point.every(Number.isFinite) || point[0]<72 || point[0]>138 || point[1]<=0 || point[1]>56) throw new Error('请输入有效 GCJ-02 经纬度，用逗号分隔');
  addPoint(point);
});
action('reference', () => {
  if (!state.reference.length) throw new Error('当前范围没有历史参考路线');
  const points = sampleLine(state.reference, lineLength(state.reference)/9);
  setPoints(points.slice(0,11), '历史参考');
  message('已沿历史轨迹抽取参考点，重新算路会受当前道路规则影响，不保证复现历史轨迹。');
});
action('match-roads', async () => {
  if (!state.points.length) throw new Error('请先添加任务点或道路点');
  // Geocoder is loaded lazily in some AMap builds even when requested via the
  // script query string. Ensure the plugin is ready before checking points.
  if (!window.AMap?.Geocoder && window.AMap?.plugin) {
    try { await new Promise((resolve, reject) => AMap.plugin(['AMap.Geocoder'], () => window.AMap.Geocoder ? resolve() : reject(new Error('plugin-not-ready')))); } catch { /* local geometry fallback below */ }
  }
  if (!window.AMap?.Geocoder) {
    let matched = 0;
    for (const point of state.points) {
      const hit = nearestReferenceSegment(point.coordinate);
      const d = Number.isFinite(hit.distance) ? hit.distance : Infinity;
      point.snapDistance = Number.isFinite(d) ? Math.round(d) : null;
      point.roadMatch = {
        road: point.roadCandidate || '',
        address: '',
        status: d <= 80 ? 'local-geometry' : 'review'
      };
      point.roadFit = d <= 80 ? 'matched' : 'review';
      if (d <= 80) matched++;
    }
    renderPoints();
    message(`高德地理编码未加载，已完成本地几何匹配：${matched}/${state.points.length} 个点通过邻近道路检查；道路名称需联网后复核。`, matched < state.points.length);
    return;
  }
  const geocoder = new AMap.Geocoder({radius:1000, extensions:'all'});
  let matched=0;
  for (const point of state.points) {
    await new Promise(resolve => geocoder.getAddress(point.coordinate, (status, result) => {
      const comp = result?.regeocode?.addressComponent;
      point.roadMatch = status === 'complete' && comp ? {road:String(comp.street || comp.township || ''), address:String(result.regeocode.formattedAddress || ''), status:'matched'} : {road:'', address:'', status:'review'};
      if (point.roadMatch.road) { point.roadCandidate = point.roadMatch.road; point.snapDistance = null; point.confidence = 'geocoder'; }
      if (point.roadMatch.road) matched++; resolve();
    }));
  }
  renderPoints(); message(`道路匹配检查完成：${matched}/${state.points.length} 个点识别到道路名称。无道路名称的点位请拖到可行驶道路附近复核。`, matched < state.points.length);
});
action('search-place', async () => {
  const keyword = $('place-search').value.trim(); if (!keyword) throw new Error('请输入要搜索的地名或道路');
  if (!window.AMap?.Geocoder) {
    let matched = 0;
    for (const point of state.points) {
      const hit = nearestReferenceSegment(point.coordinate), d = Number.isFinite(hit.distance) ? hit.distance : Infinity;
      point.snapDistance = Number.isFinite(d) ? Math.round(d) : null;
      point.roadMatch = {road: point.roadCandidate || '', address: '', status: d <= 80 ? 'local-geometry' : 'review'};
      point.roadFit = d <= 80 ? 'matched' : 'review';
      if (d <= 80) matched++;
    }
    renderPoints(); message(`高德地理编码未加载，已完成本地几何匹配：${matched}/${state.points.length} 个点在管线邻近范围内；道路名称需联网后复核。`, matched < state.points.length);
    return;
  }
  const geocoder = new AMap.Geocoder({city:'全国',radius:1000});
  const refs = state.features.flatMap(f => f.geometry?.coordinates || []).filter(p => Array.isArray(p) && p.length === 2);
  const center = refs.length ? [refs.reduce((s,p)=>s+p[0],0)/refs.length, refs.reduce((s,p)=>s+p[1],0)/refs.length] : map?.getCenter?.() ? [map.getCenter().lng,map.getCenter().lat] : [120.28,36.29];
  const location = await new Promise((resolve,reject) => geocoder.getLocation(keyword, (status,result) => { const gs=(result?.geocodes||[]).filter(g=>g?.location); if(status!=='complete' || !gs.length) return reject(new Error('未找到该地点，请换更具体的名称')); gs.sort((a,b)=>distance([a.location.lng,a.location.lat],center)-distance([b.location.lng,b.location.lat],center)); const best=[gs[0].location.lng,gs[0].location.lat]; const limit=refs.length ? Math.max(15000, Math.min(50000, distance(center,[Math.max(...refs.map(p=>p[0])),Math.max(...refs.map(p=>p[1]))])*2)) : 50000; if(distance(best,center)>limit) return reject(new Error('搜索结果在当前管线范围外，请加上城市或道路名称')); resolve(best); }));
  map?.setZoomAndCenter(16, location); addPoint(location); message(`已搜索到“${keyword}”，并按当前点类型加入点位列表。`);
});
action('save', () => { const route = state.active; if (!route) throw new Error('请先生成道路方案'); const name = (prompt('请输入线路名称', `线路${(savedPlans().length + 1)}`) || '').trim(); if (!name) return; const plans = savedPlans(); plans.push({id:crypto.randomUUID(), name, createdAt:new Date().toISOString(), route, draft:draft()}); localStorage.setItem('patrol-planner-plans-v1', JSON.stringify(plans)); localStorage.setItem('patrol-planner-draft-v1',JSON.stringify(draft())); renderPlansLibrary(); message(`已保存“${name}”，共 ${plans.length} 条线路方案。`); });
action('load', async () => { const value = localStorage.getItem('patrol-planner-draft-v1'); if (!value) throw new Error('本机浏览器尚无草稿'); await restore(JSON.parse(value)); });
action('export-draft', () => download('巡线规划草稿.json', draft()));
action('export-gpx', () => { const route = state.active; if (!route) throw new Error('请先生成道路方案'); const name = prompt('GPX 文件名称', '巡线线路') || '巡线线路'; const trk = route.geometry.map(p => { const [lon,lat]=fromGcj(p); return `<trkpt lat="${lat}" lon="${lon}"></trkpt>`; }).join(''); const xml = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="巡线规划小工具" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${escape(name)}</name><trkseg>${trk}</trkseg></trk></gpx>`; const url=URL.createObjectURL(new Blob([xml],{type:'application/gpx+xml'})); const a=document.createElement('a'); a.href=url; a.download=`${name}.gpx`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); });
action('coverage-total', () => { const plans = JSON.parse(localStorage.getItem('patrol-planner-plans-v1') || '[]'); if (!plans.length) throw new Error('请先保存至少一条线路方案'); const geometry = plans.flatMap(p => p.route?.geometry || []); if (geometry.length < 2) throw new Error('已保存方案没有可用轨迹'); const c = coverage(targetFeatures(), geometry, Number($('radius').value)); if(state.active) state.active.coverage=c; stylePipes(); message(`已叠加 ${plans.length} 条线路，累计管线覆盖率 ${percent(c.ratio)}（覆盖 ${km(c.covered)} / ${km(c.total)}）。`, c.ratio < .95); $('metrics').insertAdjacentHTML('afterbegin', `<div class="metric"><strong>${percent(c.ratio)}</strong><span>已保存线路累计覆盖</span></div>`); });
function savedPlans() { try { return JSON.parse(localStorage.getItem('patrol-planner-plans-v1') || '[]'); } catch { return []; } }
function renderTasksPicker() { const box=$('tasks-picker'); if(!box) return; const tasks=state.importedTasks||[]; box.hidden=!tasks.length; if(!tasks.length){box.innerHTML='';return;} const groups={}, labels={valve:'阀门',valve_well:'阀井',regulator:'调压设施',marker:'标志桩',cathodic:'阴保桩',unmapped:'未识别',valve_simulated:'模拟阀门',valve_well_simulated:'模拟阀井'}; tasks.forEach((t,i)=>{const k=t.facilityType||'unmapped';(groups[k] ||= []).push({...t,_i:i});}); box.innerHTML=`<div class="row"><strong>设施批量选择（${tasks.length}）</strong><button type="button" id="tasks-all">全选</button><button type="button" id="tasks-none">全不选</button></div>`+Object.entries(groups).map(([k,items])=>`<fieldset><legend>${escape(labels[k]||k)}（${items.length}）</legend>${items.slice(0,500).map(t=>`<label class="task-check"><input type="checkbox" data-task-index="${t._i}" checked><span>${escape(t.name)}</span></label>`).join('')}</fieldset>`).join(''); $('tasks-all').onclick=()=>box.querySelectorAll('input[type=checkbox]').forEach(x=>x.checked=true); $('tasks-none').onclick=()=>box.querySelectorAll('input[type=checkbox]').forEach(x=>x.checked=false); }
function renderPlansLibrary() {
  const box = $('plans-library'), list = $('plans-list'); if (!box || !list) return;
  const plans = savedPlans(); box.hidden = !plans.length; list.innerHTML = plans.map((p,i) => { const ps=p.draft?.points || []; const names=ps.slice(0,4).map((x,j)=>`${j+1}.${escape(x.name||'途经点')}`).join('、'); return `<div class="plan-row"><button data-plan-load="${i}">${escape(p.name)}</button><small>${ps.length} 个途经点 · ${names}${ps.length>4?'…':''} · ${p.route ? km(p.route.distance) : '-'} km</small><button data-plan-rename="${i}">改名</button><button data-plan-delete="${i}">删除</button></div>`; }).join('');
  list.querySelectorAll('[data-plan-load]').forEach(b => b.onclick = async () => { const p=plans[Number(b.dataset.planLoad)]; if(p.draft) await restore(p.draft); if(p.route){ state.routes=[p.route]; chooseRoute(p.route); } message(`已打开方案“${p.name}”，途经点已恢复，可继续调整后重新生成`); });
  list.querySelectorAll('[data-plan-rename]').forEach(b => b.onclick = () => { const i=Number(b.dataset.planRename), n=prompt('新名称',plans[i].name); if(n?.trim()){plans[i].name=n.trim();localStorage.setItem('patrol-planner-plans-v1',JSON.stringify(plans));renderPlansLibrary();} });
  list.querySelectorAll('[data-plan-delete]').forEach(b => b.onclick = () => { const i=Number(b.dataset.planDelete); if(confirm(`删除“${plans[i].name}”？`)){plans.splice(i,1);localStorage.setItem('patrol-planner-plans-v1',JSON.stringify(plans));renderPlansLibrary();} });
}
action('plans-manage', () => { const box=$('plans-library'); if (box) { box.hidden=!box.hidden; renderPlansLibrary(); } });
action('share-route', () => { const route=state.active; if(!route) throw new Error('请先生成或加载路线'); const name=prompt('分享标题','巡线线路')||'巡线线路'; const pts=route.geometry, xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]), minx=Math.min(...xs),maxx=Math.max(...xs),miny=Math.min(...ys),maxy=Math.max(...ys); const xy=p=>`${10+(p[0]-minx)/(maxx-minx||1)*580},${20+(maxy-p[1])/(maxy-miny||1)*300}`; const path=pts.map(xy).join(' '); const waypointSvg=state.points.map((p,i)=>{const q=xy(p.coordinate);return `<circle cx="${q.split(',')[0]}" cy="${q.split(',')[1]}" r="9" fill="#fff" stroke="#155d8a" stroke-width="2"/><text x="${q.split(',')[0]}" y="${Number(q.split(',')[1])+4}" text-anchor="middle" font-size="10" font-weight="700">${i+1}</text>`;}).join(''); const steps=route.steps.map((s,i)=>{const t=String(s.instruction||'').replace(/向?左转/g,'左拐').replace(/向?右转/g,'右拐').replace(/行驶/g,'沿'); return `${i+1}. ${escape(t||`沿${s.road||'当前道路'}行驶`)}`;}).join('<br>'); const w=window.open('','_blank'); if(w) w.document.write(`<title>${escape(name)}</title><style>body{font:14px sans-serif;margin:24px;color:#17332e}svg{max-width:100%;background:#eef4ef;border:1px solid #ccd} .legend{color:#155d8a}</style><h1>${escape(name)}</h1><p class="legend">蓝线为行驶路线，圆点数字为途经点顺序，箭头表示行驶方向</p><svg width="600" height="340" viewBox="0 0 600 340"><defs><marker id="a" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#1672c4"/></marker></defs><polyline points="${path}" fill="none" stroke="#1672c4" stroke-width="4" marker-end="url(#a)"/>${waypointSvg}</svg><h3>路线指引</h3><p>${steps}</p><p>距离：${km(route.distance)} km　预计：${Math.round(route.duration/60)} 分钟</p><script>window.print()<\/script>`); });
action('export-kml', () => { const r=state.active;if(!r) throw new Error('请先生成路线'); const c=r.geometry.map(p=>{const q=fromGcj(p);return `${q[0]},${q[1]},0`;}).join(' '); downloadText('巡线线路.kml',`<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>巡线线路</name><LineString><tessellate>1</tessellate><coordinates>${c}</coordinates></LineString></Placemark></Document></kml>`,'application/vnd.google-earth.kml+xml'); });
action('export-csv', () => { const r=state.active;if(!r) throw new Error('请先生成路线'); const rows=['序号,经度,纬度,名称,点位类型,管线侧别,匹配道路,吸附距离米']; state.points.forEach((p,i)=>{const q=fromGcj(p.coordinate); const mode={road:'道路点',task:'任务点',free:'自由点'}[p.mode||'road']||p.mode||''; const side={left:'左侧',right:'右侧',center:'中心'}[p.side]||''; const esc=v=>`"${String(v??'').replaceAll('"','""')}"`; rows.push(`${i+1},${q[0]},${q[1]},${esc(p.name)},${esc(mode)},${esc(side)},${esc(p.roadMatch?.road||p.roadCandidate||'')},${p.snapDistance??''}`);}); downloadText('巡线点位.csv','\ufeff'+rows.join('\n'),'text/csv;charset=utf-8'); });
$('road-filter').oninput = renderRoads;
$('place-search').onkeydown = e => { if (e.key === 'Enter') $('search-place').click(); };
$('scope').onchange = guarded(async () => { if ($('scope').value !== 'imported') { removeImportedScopeOption(); await loadScope($('scope').value); } });
$('strategy').onchange = () => invalidate();
$('loop').onchange = () => { invalidate(); renderPoints(); };
for (const id of ['max-km','radius','priority']) $(id).onchange = guarded(() => { state.revision++; if (state.routes.length) { try { evaluateRoutes(); } catch (e) { invalidate(); throw e; } } });
$('show-pipes').onchange = () => { if (map) map[$('show-pipes').checked ? 'add' : 'remove'](pipeOverlays); };
$('show-reference').onchange = () => { if (map && referenceOverlay) map[$('show-reference').checked ? 'add' : 'remove'](referenceOverlay); };
async function readFile(input) { const file = input.files[0]; if (!file) return null; if (file.size > 20*1024*1024) throw new Error('文件超过 20MB，请裁剪范围'); if (/\\.dxf$/i.test(file.name)) { const bytes=new Uint8Array(await file.arrayBuffer()); let binary=''; for(let i=0;i<bytes.length;i+=0x8000) binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000)); return {__dxf:true,name:file.name,content:btoa(binary)}; } return JSON.parse(await file.text()); }
$('layer-file').onchange = guarded(async () => {
  const operation = ++state.operation;
  state.datasetLoading++; invalidate('正在读取导入的管线图层…'); updatePlanButton();
  try {
    const data = await readFile($('layer-file')); if (!data || operation !== state.operation) return;
    const crs = $('import-crs').value;
    if (!data.__dxf && crs === 'cgcs2000_projected') throw new Error('GeoJSON/GIS 文件需要选择 WGS84、CGCS2000 经纬度或 GCJ-02；投影坐标请先转换为经纬度后导入');
    let source = data;
    if (data.__dxf) {
      const zonePrefix = Number($('import-zone')?.value || 40), centralMeridian = Number($('import-meridian')?.value || 120);
      if (!Number.isInteger(zonePrefix) || zonePrefix < 1 || zonePrefix > 60) throw new Error('投影带号必须是 1–60 的整数');
      if (!Number.isFinite(centralMeridian) || centralMeridian < 70 || centralMeridian > 140) throw new Error('中央子午线必须在 70–140° 之间');
      message('正在本机解析 DXF，请稍候…'); source = await api('/api/import/dxf', {method:'POST', headers:{'Content-Type':'application/json','X-Planner-Token':config.token}, body:JSON.stringify({content:data.content, layer:'新增燃气管道', sourceCrs:crs, zonePrefix, centralMeridian})});
    }
    const features = normalizeGeoJSON(source.pipelines || source, crs);
    state.importedTasks = extractTaskPoints(source, crs).map(p => ({...p, facilityType:String(p.properties?.facilityType || p.kind || 'unmapped'), sourceHandle:String(p.properties?.sourceHandle || '')})); renderTasksPicker();
    if (operation !== state.operation) return;
    state.features = features; state.scope = 'imported'; state.reference = []; state.points = []; state.selected = new Set(features.map(f => f.id));
    const hint = source.stats?.coordinateHint;
    message(`已导入 ${features.length} 条管线${state.importedTasks.length ? `，识别 ${state.importedTasks.length} 个设施任务点` : ''}${hint ? `。坐标预判：${hint}` : '。'}`);
    if (!$('scope').querySelector('[value="imported"]')) $('scope').add(new Option('导入的管线图层','imported'));
    $('scope').value = 'imported'; $('reference').disabled = true;
    invalidate('DXF 图层已导入，当前为预览状态。请观察管线与高德道路是否基本重合。'); renderRoads(); drawPipes(); renderPoints(); boundsFit(pipeOverlays);
    if (data.__dxf && $('import-preview')) {
      const ok = confirm('DXF 预览已加载。请检查管线与高德道路是否基本重合，点击“确定”表示匹配；点击“取消”可输入整体偏移量进行校准。');
      if (!ok) {
        const east = Number(prompt('请输入整体东移量（米，向东为正）', '0') || 0);
        const north = Number(prompt('请输入整体北移量（米，向北为正）', '0') || 0);
        if (!Number.isFinite(east) || !Number.isFinite(north) || Math.abs(east)>10000 || Math.abs(north)>10000) throw new Error('偏移量必须在 ±10000 米以内');
        applyImportShift(east, north); state.calibration={eastM:east,northM:north,confirmed:true,at:new Date().toISOString()}; renderRoads(); drawPipes(); boundsFit(pipeOverlays); message(`已按东移 ${east}m、北移 ${north}m 完成预览校准，请再次检查图层重合情况。`);
      } else { state.calibration={eastM:0,northM:0,confirmed:true,at:new Date().toISOString()}; message('已确认 DXF 预览与底图基本匹配，可以继续选择管线和手工布点。'); }
    }
  } finally { state.datasetLoading--; updatePlanButton(); }
});
$('draft-file').onchange = guarded(async () => { const data = await readFile($('draft-file')); if (data) await restore(data); });
action('merge-imported', async () => {
  if (state.scope !== 'imported') throw new Error('请先在「选择巡检管线」中导入 GeoJSON 图层');
  if (!state.features.length) throw new Error('当前无导入图层');
  const tolerance = Number($('merge-tolerance').value);
  if (!Number.isFinite(tolerance) || tolerance < 0.1 || tolerance > 20) throw new Error('合并阈值需在 0.1–20m 之间');
  const operation = ++state.operation;
  state.datasetLoading++; updatePlanButton();
  invalidate(`正在合并碎片管线（阈值 ${tolerance}m）…`);
  try {
    const result = await api('/api/pipelines/merge', {
      method: 'POST', headers: {'Content-Type': 'application/json', 'X-Planner-Token': config.token},
      body: JSON.stringify({features: state.features, tolerance_m: tolerance}),
    });
    if (operation !== state.operation) return;
    const merged = [...result.merged, ...result.orphans];
    state.features = normalizeGeoJSON({type: 'FeatureCollection', features: merged}, 'GCJ-02');
    state.selected = new Set(state.features.map(f => f.id));
    invalidate(`合并完成：${result.stats.segment_count} 段 → ${result.stats.merged_count} 条连续管线 + ${result.stats.orphan_count} 孤段。最长链 ${result.stats.max_chain_segments} 段。`);
    renderRoads(); drawPipes(); renderPoints(); boundsFit(pipeOverlays);
  } finally { state.datasetLoading--; updatePlanButton(); }
});
action('add-imported-tasks', () => {
  if (!state.importedTasks.length) throw new Error('当前图层未识别到设施点');
  const existing = new Set(state.points.map(p => `${p.coordinate[0].toFixed(6)},${p.coordinate[1].toFixed(6)}`));
  const checked = new Set([...($('tasks-picker')?.querySelectorAll('input[data-task-index]:checked') || [])].map(x=>Number(x.dataset.taskIndex)));
  const tasks = state.importedTasks.filter((p,i) => checked.has(i) && !existing.has(`${p.coordinate[0].toFixed(6)},${p.coordinate[1].toFixed(6)}`));
  tasks.forEach(p => addPoint(p.coordinate, {mode:'task', name:p.name, facilityType:p.facilityType, sourceHandle:p.sourceHandle}));
  message(`已加入 ${tasks.length} 个设施任务点，请检查道路匹配并调整顺序`);
});
action('simulate-facilities', () => {
  const lines = state.features.filter(f => f.geometry?.type === 'LineString');
  if (!lines.length) throw new Error('请先导入 DXF 管线图层');
  const nodes = [];
  const near = (a,b) => distance(a,b) <= 12;
  lines.forEach(f => { const c=f.geometry.coordinates; if (c.length >= 2) { nodes.push(c[0]); nodes.push(c.at(-1)); } });
  const clusters = [];
  nodes.forEach(p => { let g=clusters.find(x => near(x.coordinate,p)); if (!g) clusters.push({coordinate:p,count:1}); else { g.count++; } });
  const candidates = clusters.filter(x => x.count === 1 || x.count >= 3).slice(0, 300);
  state.importedTasks = candidates.map((x,i) => ({id:`sim-${i+1}`, coordinate:x.coordinate, name:x.count >= 3 ? `模拟阀井 ${i+1}` : `模拟阀门 ${i+1}`, kind:'task', facilityType:x.count >= 3 ? 'valve_well_simulated' : 'valve_simulated', sourceHandle:'inferred-breakpoint'})); renderTasksPicker();
  message(`已根据 ${lines.length} 条线段的断点生成 ${state.importedTasks.length} 个模拟设施点。它们仅用于测试，请点击“加入识别到的设施任务点”后参与路线规划。`);
});
async function init() {
  config = await api('/api/config');
  const license = config.license || {};
  $('connection').textContent = config.routingConfigured ? `● 本地服务就绪 · ${license.active ? `试用剩余 ${license.remainingDays ?? '-'} 天` : '试用已结束'}` : '缺少高德算路 Key';
  if (license.contactUrl) message(`当前为${license.mode === 'trial' ? '试用版' : '授权版'}，地图最多 ${license.maxPoints || 16} 个点。授权或商业合作请联系：${license.contactUrl}`, !license.active);
  await loadScope('dxf');
  if (!config.jsKey) throw new Error('未找到高德 JS API Key。可使用列表编辑点位，请检查项目 .env 配置。');
  if (config.securityJsCode) window._AMapSecurityConfig = {securityJsCode:config.securityJsCode};
  await new Promise((resolve,reject) => {
    const script = document.createElement('script');
    const timeout = setTimeout(() => reject(new Error('高德地图加载超时，请检查联网状态和 JS Key 域名白名单后刷新。')),20000);
    script.onload = () => { clearTimeout(timeout); window.AMap ? resolve() : reject(new Error('高德地图初始化失败，请检查 JS Key 和安全密钥。')); };
    script.onerror = () => { clearTimeout(timeout); reject(new Error('无法加载高德地图，请检查网络。')); };
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(config.jsKey)}&plugin=AMap.Scale,AMap.ToolBar,AMap.Geocoder`;
    document.head.append(script);
  });
  map = new AMap.Map('map',{center:[120.28,36.29],zoom:13,viewMode:'2D',resizeEnable:true});
  map.addControl(new AMap.Scale()); map.addControl(new AMap.ToolBar({position:'RB'}));
  map.on('click', event => { const point = [event.lnglat.lng,event.lnglat.lat]; if (state.drawArea) { state.area = [...(state.area || []), point]; drawArea(); return; } if (state.add) addPoint(point); });
  map.on('dblclick', event => { if (state.drawArea) { event.originEvent?.preventDefault?.(); finishArea(); } });
  drawPipes(); renderPoints(); renderPlansLibrary(); boundsFit(pipeOverlays);
}
guarded(init)();





