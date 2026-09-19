import test from 'node:test';
import assert from 'node:assert/strict';
import {coverage, distance, toGcj, fromGcj, rankRoutes, scoreRouteMetrics, normalizeGeoJSON, sampleLine, pointInPolygon, linesInPolygon, classifyTurn, analyzePathTurns, turnReviewPoints} from './geometry.mjs';
const pipe = (id, coordinates) => ({id, type:'Feature', properties:{}, geometry:{type:'LineString', coordinates}});
test('known project coordinate converts to GCJ without double shifting; inverse roundtrip', () => {
  const wgs = [120.24317206,36.26561587], gcj = toGcj(wgs);
  assert.ok(distance(gcj,[120.248201,36.265762]) < 3);
  assert.ok(distance(fromGcj(gcj),wgs) < .01);
  const result = normalizeGeoJSON({type:'FeatureCollection',features:[pipe('a',[gcj,[120.25,36.26]])]},'GCJ-02');
  assert.deepEqual(result[0].geometry.coordinates[0],gcj);
});
test('lowercase GCJ-02 import mode avoids a second coordinate shift', () => {
  const p = [120.248201, 36.265762];
  const result = normalizeGeoJSON({type:'FeatureCollection',features:[pipe('gcj',[p,[120.249,36.266]])]},'gcj02');
  assert.deepEqual(result[0].geometry.coordinates[0], p);
});
test('normalized imported layers preserve ids and source ids across draft restore', () => {
  const source = {type:'FeatureCollection',features:[
    {type:'Feature',id:'source-a',properties:{sourceId:'source-a'},geometry:{type:'MultiLineString',coordinates:[[[120,36],[120.001,36]],[[120.002,36],[120.003,36]]]}},
    {type:'Feature',id:'source-b',properties:{sourceId:'source-b'},geometry:{type:'LineString',coordinates:[[120.01,36],[120.011,36]]}}
  ]};
  const normalized = normalizeGeoJSON(source, 'GCJ-02');
  const restored = normalizeGeoJSON({type:'FeatureCollection',features:normalized}, 'GCJ-02');
  assert.deepEqual(restored.map(f => f.id), normalized.map(f => f.id));
  assert.deepEqual(restored.map(f => f.properties.sourceId), normalized.map(f => f.properties.sourceId));
  assert.throws(() => normalizeGeoJSON({type:'FeatureCollection',features:[normalized[0], {...normalized[1], id:normalized[0].id}]}, 'GCJ-02'), /唯一字符串/);
});
test('coverage measures line interiors, not just endpoints', () => {
  const c = coverage([pipe('a',[[120,36],[120.01,36]])],[[120,36],[120.01,36]],10);
  assert.ok(c.total > 890 && c.total < 910);
  assert.ok(c.ratio > .999);
});
test('parallel separated pipeline remains uncovered; duplicate route does not inflate coverage', () => {
  const line = [[120,36],[120.01,36]];
  const features = [pipe('a',line),pipe('b',[[120,36.002],[120.01,36.002]])];
  const c = coverage(features,[...line,...line.toReversed()],40);
  assert.ok(Math.abs(c.ratio-.5)<.001);
  assert.equal(c.perFeature.b.covered,0);
});
test('one road corridor covers pipelines on both sides within the configured radius', () => {
  const road = [[120,36],[120.01,36]];
  const features = [
    pipe('left', [[120,35.99975],[120.01,35.99975]]),
    pipe('right', [[120,36.00025],[120.01,36.00025]])
  ];
  const c = coverage(features, road, 35);
  assert.ok(c.ratio > .99);
  assert.ok(c.perFeature.left.ratio > .99);
  assert.ok(c.perFeature.right.ratio > .99);
});
test('weighted by length, not number of pipe features', () => {
  const c = coverage([pipe('long',[[120,36],[120.01,36]]),pipe('short',[[120,36.01],[120.001,36.01]])],[[120,36],[120.01,36]],20);
  assert.ok(c.ratio > .90 && c.ratio < .92);
});
test('partial coverage and empty route are reported honestly', () => {
  const f = [pipe('a',[[120,36],[120.01,36]])];
  const c = coverage(f,[[120,36],[120.005,36]],5,5);
  assert.ok(c.ratio > .49 && c.ratio < .53);
  assert.equal(coverage(f,[],40).ratio,0);
  assert.equal(coverage([],[],40).total,0);
});
test('distance cap ranks feasible route above higher coverage over-cap route', () => {
  const a = {distance:11000,coverage:{ratio:1}}, b = {distance:9000,coverage:{ratio:.8}};
  assert.equal(rankRoutes([a,b],10)[0],b);
  assert.equal(rankRoutes([b,a],20)[0],a);
});
test('sampling stays on given reference', () => {
  const points = [[120,36],[120.009,36],[120.001,36],[120.02,36]];
  const samples = sampleLine([points[0],points[3]],200);
  assert.deepEqual(samples[0],points[0]); assert.deepEqual(samples.at(-1),points[3]);
  assert.ok(samples.every(p=>p[1] === 36));
});
test('reject planar CAD, non-line geometry, malformed points and invalid radius', () => {
  for (const coords of [[[40500000,4000000],[40500001,4000000]], [[null,36],[120,36]], [[120,36]]]) {
    assert.throws(()=>normalizeGeoJSON({type:'FeatureCollection',features:[pipe('a',coords)]}));
  }
  assert.throws(()=>normalizeGeoJSON({type:'FeatureCollection',features:[{geometry:{type:'Point',coordinates:[120,36]}}]}));
  assert.throws(()=>coverage([],[],NaN));
});
test('area selection includes crossing and interior lines, excludes outside lines', () => {
  const poly = [[120,36],[120.01,36],[120.01,36.01],[120,36.01]];
  assert.equal(pointInPolygon([120.005,36.005], poly), true);
  assert.equal(pointInPolygon([120.02,36.005], poly), false);
  const result = linesInPolygon([pipe('inside',[[120.002,36.002],[120.003,36.003]]),pipe('cross',[[119.99,36.005],[120.005,36.005]]),pipe('outside',[[120.02,36.02],[120.03,36.03]])], poly);
  assert.deepEqual(result.map(f=>f.id), ['inside','cross']);
});
test('route ranking uses road fit as a tie breaker after coverage', () => {
  const routes = [
    {distance:1000, coverage:{ratio:.9}, roadFitRatio:.6},
    {distance:1200, coverage:{ratio:.9}, roadFitRatio:.95},
  ];
  assert.equal(rankRoutes(routes, 10, 'coverage')[0].roadFitRatio, .95);
});
test('route ranking uses score before road fit when coverage ties', () => {
  const routes = [
    {distance:1000, coverage:{ratio:.9}, roadFitRatio:.99, score:70},
    {distance:1200, coverage:{ratio:.9}, roadFitRatio:.8, score:85},
  ];
  assert.equal(rankRoutes(routes, 10, 'coverage')[0].score, 85);
});
test('path turn analysis flags u-turn candidates for road legality review', () => {
  const path = [[120,36],[120.002,36],[120,36],[119.998,36]];
  const turns = analyzePathTurns(path, {uTurnAngle:150});
  assert.equal(classifyTurn(path[0],path[1],path[2],{uTurnAngle:150}).kind, 'uturn-candidate');
  assert.ok(turns.uturnCandidates >= 1);
  assert.equal(turnReviewPoints(path)[0].kind, 'uturn-candidate');
});
test('route score follows coverage-first weighting and penalizes illegal turns', () => {
  const good = scoreRouteMetrics({coverageRatio: .95, taskRatio: 1, orderRatio: 1, legalTurnRatio: 1});
  const bad = scoreRouteMetrics({coverageRatio: .95, taskRatio: 1, orderRatio: 1, legalTurnRatio: 0, detourRatio: .2});
  assert.ok(good > bad);
  assert.ok(scoreRouteMetrics({coverageRatio: 1, taskRatio: 1, orderRatio: 1, legalTurnRatio: 1}) > scoreRouteMetrics({coverageRatio: .8, taskRatio: 1, orderRatio: 1, legalTurnRatio: 1}));
});
