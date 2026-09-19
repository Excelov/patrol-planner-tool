"""Build the public, data-free source bundle for a release."""
from pathlib import Path
import csv, hashlib, json, shutil, tempfile, zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = '0.4.0-beta.1'

def write_example_data(stage):
    """Create deterministic, clearly synthetic GIS fixtures for public tests."""
    for scope, count in (('route5_scope', 177), ('route6_scope', 24)):
        folder = stage / 'data/gis' / scope
        folder.mkdir(parents=True, exist_ok=True)
        pipe_name = f'{scope}/{scope.replace("_scope", "")}_scoped_pipeline_segments.csv'
        pipe_path = stage / 'data/gis' / pipe_name
        pipe_path.parent.mkdir(parents=True, exist_ok=True)
        with pipe_path.open('w', newline='', encoding='utf-8') as stream:
            writer = csv.DictWriter(stream, fieldnames=['pipeline_code','road_name','start_x','start_y','end_x','end_y'])
            writer.writeheader()
            for i in range(count):
                x = 120.20 + (i % 40) * 0.001
                y = 36.10 + (i // 40) * 0.001
                writer.writerow({'pipeline_code':f'{scope}-P{i+1:04d}','road_name':f'示例道路{i%8+1}',
                                 'start_x':f'{x:.6f}','start_y':f'{y:.6f}',
                                 'end_x':f'{x+0.0007:.6f}','end_y':f'{y+0.0003:.6f}'})
        ref_path = stage / 'data/gis/routes' / ('route5_high_fidelity_candidate_cgcs2000_heading200.csv' if scope == 'route5_scope' else 'route6_high_fidelity_candidate_import_cgcs2000_heading200.csv')
        ref_path.parent.mkdir(parents=True, exist_ok=True)
        with ref_path.open('w', newline='', encoding='utf-8') as stream:
            writer = csv.DictWriter(stream, fieldnames=['point_x','point_y'])
            writer.writeheader()
            for i in range(24): writer.writerow({'point_x':f'{120.20+i*0.0007:.6f}','point_y':f'{36.10+i*0.0003:.6f}'})
    full = {'type':'FeatureCollection','features':[]}
    for i in range(4848):
        x = 120.15 + (i % 96) * 0.0008
        y = 36.05 + (i // 96) * 0.0008
        full['features'].append({'type':'Feature','properties':{'displayCode':f'SAMPLE-{i+1:04d}'},
            'geometry':{'type':'LineString','coordinates':[[x,y],[x+0.0004,y+0.0002]]}})
    full_path = stage / 'vendor/pig-ui/public/data/gis/dxf_pipeline_display_lines.geojson'
    full_path.parent.mkdir(parents=True, exist_ok=True)
    full_path.write_text(json.dumps(full, ensure_ascii=False), encoding='utf-8')

def main():
    stage = Path(tempfile.mkdtemp(prefix='patrol-source-'))
    try:
        for folder in ('frontend/patrol-planner', 'scripts', 'docs', 'release/installer', '.github/workflows'):
            (stage / folder).mkdir(parents=True, exist_ok=True)
        public_scripts = {
            'build_dxf_pipeline_display_layer.py', 'extract_dxf_facilities.py',
            'build_source_bundle.py', 'start-patrol-planner.ps1',
            'verify_beta.ps1', 'verify_frozen_dxf.py', 'verify_installer_script.ps1',
            'verify_portable.ps1', 'verify_public_bundle.ps1', 'verify_release.ps1',
            'verify_release_secrets.ps1'
        }
        public_docs = {p.name for p in (ROOT / 'docs').glob('patrol-planner*.md')}
        rules = [(ROOT/'frontend/patrol-planner', stage/'frontend/patrol-planner', {'.js','.mjs','.html','.css','.py','.md'}),
                 (ROOT/'scripts', stage/'scripts', {'.ps1','.mjs','.py'}),
                 (ROOT/'docs', stage/'docs', {'.md'}),
                 (ROOT/'release/installer', stage/'release/installer', {'.ps1','.iss','.md'})]
        for src, dst, exts in rules:
            for path in src.glob('*'):
                if path.suffix.lower() not in exts: continue
                if src == ROOT/'scripts' and path.name not in public_scripts: continue
                if src == ROOT/'docs' and path.name not in public_docs: continue
                shutil.copy2(path, dst/path.name)
        shutil.copy2(ROOT/'.github/workflows/patrol-planner-windows.yml', stage/'.github/workflows/patrol-planner-windows.yml')
        shutil.copy2(ROOT/'.gitignore', stage/'.gitignore')
        shutil.copy2(ROOT/'frontend/patrol-planner/README.md', stage/'README.md')
        license_file = ROOT/'release/patrol-planner-v0.4.0-beta.1/LICENSE.txt'
        if license_file.exists(): shutil.copy2(license_file, stage/'LICENSE.txt')
        write_example_data(stage)
        out = ROOT/f'release/patrol-planner-v{VERSION}-source.zip'
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as archive:
            for path in stage.rglob('*'):
                if path.is_file(): archive.write(path, path.relative_to(stage).as_posix())
        bad = [n for n in zipfile.ZipFile(out).namelist() if n.lower().endswith(('.dxf','.dwg','.env','.pem','.key'))]
        if bad: raise RuntimeError(f'sensitive files in source bundle: {bad}')
        digest = hashlib.sha256(out.read_bytes()).hexdigest()
        manifest = ROOT/f'release/RELEASE-MANIFEST-v{VERSION}.json'
        if manifest.exists():
            data = json.loads(manifest.read_text(encoding='utf-8'))
            for artifact in data.get('artifacts', []):
                path = ROOT/artifact.get('path', '')
                if path.exists(): artifact['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
            manifest.write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
            sums = ROOT/f'release/SHA256SUMS-v{VERSION}.txt'
            sums.write_text('\n'.join(f"{a['sha256']}  {a['path']}" for a in data.get('artifacts', []))+'\n', encoding='utf-8')
        print(f'created={out}')
        print(f'sha256={digest}')
    finally:
        shutil.rmtree(stage, ignore_errors=True)

if __name__ == '__main__': main()
