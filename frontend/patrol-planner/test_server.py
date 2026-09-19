import unittest
import io
import json
import base64
import tempfile
from pathlib import Path
from unittest.mock import patch
import server
import ezdxf


class PlannerTests(unittest.TestCase):
    def test_order_precision_and_max_waypoints(self):
        points = [[120+i*.001,36] for i in range(30)]
        result = server.validate_request({'points':points,'strategy':16})
        self.assertEqual(result, points)

    def test_split_route_points_overlapping_chunks(self):
        points = [[120+i*.001, 36] for i in range(40)]
        chunks = server.split_route_points(points)
        self.assertEqual([len(c) for c in chunks], [18, 18, 6])
        self.assertEqual(chunks[0][-1], chunks[1][0])
        self.assertEqual(chunks[1][-1], chunks[2][0])
        self.assertEqual(chunks[0][0], points[0])
        self.assertEqual(chunks[-1][-1], points[-1])

    def test_loop_and_invalid_inputs(self):
        result = server.validate_request({'points':[[120,36],[120.1,36],[120,36]],'strategy':13})
        self.assertEqual(result[0],result[-1])
        for points in (None, [], [[120,36],[120,36]], [[True,36],[121,36]], [[float('nan'),36],[121,36]], [[40500000,3600000],[121,36]]):
            with self.assertRaises(ValueError):
                server.validate_request({'points':points,'strategy':16})
        with self.assertRaises(ValueError):
            server.validate_request({'points':[[120,36],[121,36]],'strategy':16,'vehicle':'truck'})

    def test_local_datasets(self):
        self.assertEqual(len(server.dataset('route5')['pipelines']['features']),177)
        self.assertGreater(len(server.dataset('route6')['pipelines']['features']),0)
        self.assertEqual(len(server.dataset('full')['pipelines']['features']),4848)

    def test_import_dxf_wgs84_keeps_geographic_units(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / 'lonlat.dxf'
            doc = ezdxf.new('R2010')
            doc.modelspace().add_line((120.248, 36.265), (120.249, 36.266), dxfattribs={'layer': '新增燃气管道'})
            doc.saveas(path)
            body = {'content': base64.b64encode(path.read_bytes()).decode(), 'layer': '新增燃气管道', 'sourceCrs': 'wgs84'}
            result = server.import_dxf(body)
            self.assertEqual(result['stats']['features'], 1)
            self.assertEqual(result['pipelines']['features'][0]['geometry']['coordinates'][0], [120.248, 36.265])
            self.assertIn('疑似经纬度', result['stats']['coordinateHint'])
        with self.assertRaises(ValueError):
            server.dataset('../../config')

    def test_network_error_never_exposes_key(self):
        with patch.object(server,'settings',return_value={'AMAP_WEBSERVICE_KEY':'SECRET_TEST'}), patch.object(server,'urlopen',side_effect=Exception('https://example/?key=SECRET_TEST')):
            with self.assertRaisesRegex(ValueError,'连接失败') as ctx:
                server.driving({'points':[[120,36],[121,36]],'strategy':16})
            self.assertNotIn('SECRET_TEST',str(ctx.exception))

    def test_route_turn_and_bridge_diagnostics_are_preserved(self):
        payload = {'status':'1','route':{'paths':[{'distance':'120','duration':'60','restriction':'0','steps':[
            {'road':'测试路','instruction':'沿测试路行驶','action':'直行','distance':'60','polyline':'120,36;120.001,36'},
            {'road':'跨河桥','instruction':'右转进入跨河桥','action':'右转','distance':'60','polyline':'120.001,36;120.001,36.001'}
        ]}]}}
        class Response(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *args): return False
        def fake_urlopen(*args, **kwargs): return Response(json.dumps(payload).encode())
        with patch.object(server,'settings',return_value={'AMAP_WEBSERVICE_KEY':'TEST'}), patch.object(server,'urlopen',side_effect=fake_urlopen):
            route = server.driving({'points':[[120,36],[120.001,36.001]],'strategy':16})['routes'][0]
        self.assertEqual(route['turnStats']['right'], 1)
        self.assertEqual(route['turnStats']['bridge'], 1)


if __name__ == '__main__':
    unittest.main()
