# -*- coding: utf-8 -*-
"""harvesters 스트리밍 진단 테스트 2 — 패킷 크기, 필터 드라이버 확인."""

import os
import sys
import glob
import time
import subprocess


def find_cti_files():
    search_dirs = [
        r"C:\Program Files\Allied Vision\Vimba X\cti",
        r"C:\Program Files\Allied Vision\VimbaX\cti",
    ]
    for var in ("VIMBA_X_HOME", "VIMBA_HOME"):
        val = os.environ.get(var, "")
        if val:
            search_dirs.append(os.path.join(val, "cti"))
    gentl = os.environ.get("GENICAM_GENTL64_PATH", "")
    if gentl:
        search_dirs.extend(gentl.split(os.pathsep))
    cti_files = []
    for d in search_dirs:
        if os.path.isdir(d):
            cti_files.extend(glob.glob(os.path.join(d, "*.cti")))
    return list(set(cti_files))


def check_firewall():
    """Windows 방화벽 상태 확인."""
    print("\n[0] Windows 방화벽 확인")
    try:
        r = subprocess.run(
            ["netsh", "advfirewall", "show", "allprofiles", "state"],
            capture_output=True, text=True, timeout=5
        )
        for line in r.stdout.strip().split("\n"):
            line = line.strip()
            if line:
                print(f"    {line}")
    except Exception as e:
        print(f"    확인 실패: {e}")


def main():
    from harvesters.core import Harvester

    mac = "AC4FFC00A43C"
    if len(sys.argv) > 1:
        mac = sys.argv[1]

    check_firewall()

    cti_files = find_cti_files()
    print(f"\n[1] CTI: {len(cti_files)} files")

    h = Harvester()
    for cti in cti_files:
        h.add_file(cti)
    h.update()

    idx = None
    for i, info in enumerate(h.device_info_list):
        if mac in info.id_:
            idx = i
            break
    if idx is None:
        print(f"카메라 {mac} 없음")
        h.reset()
        return

    print(f"[2] 카메라: {h.device_info_list[idx].id_}")
    ia = h.create(idx)
    nm = ia.remote_device.node_map

    # 전체 노드 목록 출력 (GevSC 관련)
    print("\n[3] GigE 관련 노드:")
    for node_name in dir(nm):
        if node_name.startswith(('Gev', 'Stream', 'Payload', 'Acquisition')):
            try:
                val = getattr(nm, node_name).value
                print(f"    {node_name} = {val}")
            except Exception:
                pass

    # 테스트 1: 패킷 크기를 1500으로
    print("\n[4] 테스트: GevSCPSPacketSize = 1500")
    try:
        nm.GevSCPSPacketSize.value = 1500
        print(f"    설정 완료: {nm.GevSCPSPacketSize.value}")
    except Exception as e:
        print(f"    설정 실패: {e}")

    nm.TriggerMode.value = 'Off'
    nm.AcquisitionMode.value = 'Continuous'

    ia.start()
    got_frame = False
    for i in range(5):
        buf = ia.try_fetch(timeout=3)
        if buf:
            with buf:
                comp = buf.payload.components[0]
                print(f"    frame {i+1}: OK {comp.width}x{comp.height}")
                got_frame = True
        else:
            print(f"    frame {i+1}: None")
    ia.stop()

    if got_frame:
        print("    => 패킷 1500에서 성공!")
        ia.destroy()
        h.reset()
        return

    # 테스트 2: 패킷 크기를 8228 (점보)로
    print("\n[5] 테스트: GevSCPSPacketSize = 8228 (jumbo)")
    try:
        nm.GevSCPSPacketSize.value = 8228
        print(f"    설정 완료: {nm.GevSCPSPacketSize.value}")
    except Exception as e:
        print(f"    설정 실패: {e}")

    ia.start()
    for i in range(3):
        buf = ia.try_fetch(timeout=3)
        if buf:
            with buf:
                comp = buf.payload.components[0]
                print(f"    frame {i+1}: OK {comp.width}x{comp.height}")
                got_frame = True
        else:
            print(f"    frame {i+1}: None")
    ia.stop()

    if got_frame:
        print("    => 점보 프레임에서 성공!")
        ia.destroy()
        h.reset()
        return

    # 테스트 3: PixelFormat 변경
    print("\n[6] 테스트: PixelFormat = Mono8")
    try:
        nm.PixelFormat.value = 'Mono8'
        print(f"    설정 완료: {nm.PixelFormat.value}")
        nm.GevSCPSPacketSize.value = 1500
    except Exception as e:
        print(f"    설정 실패: {e}")

    ia.start()
    for i in range(3):
        buf = ia.try_fetch(timeout=3)
        if buf:
            with buf:
                comp = buf.payload.components[0]
                print(f"    frame {i+1}: OK {comp.width}x{comp.height}")
                got_frame = True
        else:
            print(f"    frame {i+1}: None")
    ia.stop()

    if got_frame:
        print("    => Mono8에서 성공!")
    else:
        print("\n[결과] 모든 테스트 실패 — 네트워크/방화벽 문제 가능성 높음")
        print("  확인사항:")
        print("  1. Vimba X Viewer에서 카메라 이미지가 보이는지 확인")
        print("  2. Windows 방화벽에서 Python 허용 여부")
        print("  3. 카메라와 PC가 같은 서브넷인지 (192.168.x.x)")
        print("  4. Vimba X Filter Driver 설치 여부:")
        print("     C:\\Program Files\\Allied Vision\\Vimba X\\VimbaGigETL\\SetupVimbaGigETLFilter_64bit.exe")

    ia.destroy()
    h.reset()
    print("\n정리 완료")


if __name__ == "__main__":
    main()
