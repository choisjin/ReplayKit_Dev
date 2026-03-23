# -*- coding: utf-8 -*-
"""harvesters 스트리밍 테스트 — 카메라 연결 후 프레임 수신 확인."""

import os
import sys
import glob
import time


def find_cti_files():
    search_dirs = [
        r"C:\Program Files\Allied Vision\Vimba X\cti",
        r"C:\Program Files\Allied Vision\VimbaX\cti",
        r"C:\Program Files (x86)\Allied Vision\Vimba X\cti",
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


def main():
    from harvesters.core import Harvester

    mac = "AC4FFC00A43C"
    if len(sys.argv) > 1:
        mac = sys.argv[1]

    cti_files = find_cti_files()
    print(f"[1] CTI files: {len(cti_files)}")
    for f in cti_files:
        print(f"    {f}")

    h = Harvester()
    for cti in cti_files:
        h.add_file(cti)
    h.update()

    print(f"\n[2] 카메라 목록: {len(h.device_info_list)}")
    for i, info in enumerate(h.device_info_list):
        print(f"    [{i}] {info.id_}")

    # MAC으로 카메라 찾기
    idx = None
    for i, info in enumerate(h.device_info_list):
        if mac in info.id_:
            idx = i
            break

    if idx is None:
        print(f"\n카메라 {mac} 를 찾을 수 없습니다")
        h.reset()
        return

    print(f"\n[3] 카메라 연결: [{idx}] {h.device_info_list[idx].id_}")
    ia = h.create(idx)

    # 노드맵 확인
    nm = ia.remote_device.node_map
    print("\n[4] 노드맵 설정:")
    for attr in ('TriggerMode', 'AcquisitionMode', 'PixelFormat',
                 'Width', 'Height', 'GevSCPSPacketSize', 'GevSCPD'):
        if hasattr(nm, attr):
            try:
                print(f"    {attr} = {getattr(nm, attr).value}")
            except Exception as e:
                print(f"    {attr} = ERROR: {e}")

    # 트리거 끄기
    if hasattr(nm, 'TriggerMode'):
        nm.TriggerMode.value = 'Off'
        print("    -> TriggerMode set to Off")
    if hasattr(nm, 'AcquisitionMode'):
        nm.AcquisitionMode.value = 'Continuous'
        print("    -> AcquisitionMode set to Continuous")
    if hasattr(nm, 'GevSCPSPacketSize'):
        current = nm.GevSCPSPacketSize.value
        if current > 1500:
            nm.GevSCPSPacketSize.value = 1500
            print(f"    -> GevSCPSPacketSize: {current} -> 1500")

    # 방법 1: ia.start() + fetch
    print("\n[5] 테스트 A: ia.start() + ia.fetch(timeout=5)")
    ia.start()
    print("    acquisition started")

    for i in range(5):
        try:
            buffer = ia.try_fetch(timeout=5)
            if buffer is None:
                print(f"    fetch {i+1}: None (timeout)")
            else:
                with buffer:
                    comp = buffer.payload.components[0]
                    print(f"    fetch {i+1}: OK — {comp.width}x{comp.height}, "
                          f"dtype={comp.data.dtype}, shape={comp.data.shape}")
        except Exception as e:
            print(f"    fetch {i+1}: ERROR — {e}")

    ia.stop()
    print("    acquisition stopped")

    # 방법 2: fetch with blocking
    print("\n[6] 테스트 B: ia.start() + ia.fetch(timeout=10) blocking")
    ia.start()
    try:
        with ia.fetch(timeout=10) as buffer:
            comp = buffer.payload.components[0]
            print(f"    fetch OK — {comp.width}x{comp.height}, "
                  f"dtype={comp.data.dtype}, shape={comp.data.shape}")
    except Exception as e:
        print(f"    fetch ERROR — {e}")
    ia.stop()

    # 방법 3: num_buffers 명시
    print("\n[7] 테스트 C: ia.start(num_buffers=16) + fetch")
    try:
        ia.num_buffers = 16
        ia.start()
        print(f"    num_buffers={ia.num_buffers}, acquisition started")
        for i in range(3):
            buffer = ia.try_fetch(timeout=5)
            if buffer is None:
                print(f"    fetch {i+1}: None")
            else:
                with buffer:
                    comp = buffer.payload.components[0]
                    print(f"    fetch {i+1}: OK — {comp.width}x{comp.height}")
        ia.stop()
    except Exception as e:
        print(f"    ERROR: {e}")
        try:
            ia.stop()
        except Exception:
            pass

    # 정리
    print("\n[8] 정리")
    ia.destroy()
    h.reset()
    print("    완료")


if __name__ == "__main__":
    main()
