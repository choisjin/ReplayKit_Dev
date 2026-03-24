import os, glob, json

print("=== 1. CTI 파일 탐색 ===")
search = [
    r"C:\Program Files\Allied Vision",
    r"C:\Program Files (x86)\Allied Vision",
]
for var in ("VIMBA_X_HOME", "VIMBA_HOME", "GENICAM_GENTL64_PATH"):
    val = os.environ.get(var, "")
    if val:
        print(f"  ENV {var}={val}")

cti_files = []
for d in search:
    if os.path.isdir(d):
        for root, dirs, files in os.walk(d):
            for f in files:
                if f.endswith(".cti"):
                    path = os.path.join(root, f)
                    cti_files.append(path)
                    print(f"  CTI: {path}")
if not cti_files:
    print("  CTI 파일 없음")

print("\n=== 2. Harvester 카메라 열거 ===")
try:
    from harvesters.core import Harvester
    h = Harvester()
    for c in cti_files:
        h.add_file(c)
    h.update()
    print(f"  발견 카메라: {len(h.device_info_list)}개")
    for info in h.device_info_list:
        print(f"  ---")
        print(f"  id: {info.id_}")
        for attr in ["model", "serial_number", "vendor", "tl_type", "access_status", "display_name"]:
            print(f"    {attr}: {getattr(info, attr, 'N/A')}")
    h.reset()
except ImportError:
    print("  harvesters 미설치")
except Exception as e:
    print(f"  에러: {e}")

print("\n=== 3. 현재 연결된 VisionCamera 디바이스 ===")
try:
    script_dir = os.path.dirname(os.path.abspath(__file__))
    aux_file = os.path.join(script_dir, "backend", "auxiliary_devices.json")
    if os.path.exists(aux_file):
        data = json.loads(open(aux_file, encoding="utf-8").read())
        for d in data:
            if d.get("type") == "vision_camera":
                print(f"  {json.dumps(d, ensure_ascii=False, indent=4)}")
        if not any(d.get("type") == "vision_camera" for d in data):
            print("  vision_camera 타입 디바이스 없음")
    else:
        print(f"  파일 없음: {aux_file}")
except Exception as e:
    print(f"  에러: {e}")

input("\n아무 키나 눌러 종료...")
