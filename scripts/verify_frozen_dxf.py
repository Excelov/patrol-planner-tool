"""Smoke-test DXF import through the frozen desktop executable."""
import base64, json, subprocess, tempfile, time, urllib.request
from pathlib import Path
import ezdxf

ROOT = Path(__file__).resolve().parents[1]
EXE = ROOT / 'dist' / 'patrol-planner.exe'
PORT = 8896

def main():
    if not EXE.exists():
        raise SystemExit(f'EXE not found: {EXE}')
    with tempfile.TemporaryDirectory() as td:
        dxf = Path(td) / 'smoke.dxf'
        doc = ezdxf.new('R2010')
        msp = doc.modelspace()
        msp.add_line((120.248, 36.265), (120.249, 36.266), dxfattribs={'layer': '示例管线'})
        doc.saveas(dxf)
        proc = subprocess.Popen([str(EXE), '--port', str(PORT)])
        try:
            for _ in range(40):
                try:
                    cfg = json.loads(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/api/config', timeout=1).read())
                    break
                except Exception:
                    time.sleep(.25)
            else:
                raise RuntimeError('frozen EXE did not start')
            payload = {'content': base64.b64encode(dxf.read_bytes()).decode(), 'layer': '示例管线', 'sourceCrs': 'wgs84'}
            request = urllib.request.Request(f'http://127.0.0.1:{PORT}/api/import/dxf', data=json.dumps(payload).encode(), headers={'Content-Type':'application/json','X-Planner-Token':cfg['token']})
            result = json.loads(urllib.request.urlopen(request, timeout=20).read())
            if result.get('stats', {}).get('features') != 1:
                raise RuntimeError(f'unexpected DXF feature count: {result.get("stats")}')
            if '疑似经纬度' not in result.get('stats', {}).get('coordinateHint', ''):
                raise RuntimeError('coordinate hint missing')
            print('frozen-dxf-import=passed features=1')
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)

if __name__ == '__main__':
    main()
