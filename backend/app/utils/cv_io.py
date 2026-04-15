"""cv2.imread / cv2.imwrite 한글 경로 대응 래퍼.

Windows에서 cv2.imread/imwrite는 비-ASCII 경로(한글 등)를 처리하지 못함.
바이트 기반 imdecode/imencode로 우회.
"""

import cv2
import numpy as np
from pathlib import Path


def safe_imread(path: str | Path, flags: int = cv2.IMREAD_COLOR):
    """cv2.imread 대체. 한글 경로에서도 동작.

    np.fromfile은 파일을 곧바로 uint8 배열로 읽어 중간 bytes 객체 체류를 제거한다
    (기존 p.read_bytes() + np.frombuffer 방식 대비 피크 메모리 절반).
    """
    p = Path(path)
    try:
        buf = np.fromfile(str(p), dtype=np.uint8)
    except (FileNotFoundError, OSError):
        return None
    if buf.size == 0:
        return None
    return cv2.imdecode(buf, flags)


def safe_imwrite(path: str | Path, img, params=None) -> bool:
    """cv2.imwrite 대체. 한글 경로에서도 동작."""
    p = Path(path)
    ext = p.suffix or ".png"
    encode_params = params or []
    ok, buf = cv2.imencode(ext, img, encode_params)
    if not ok:
        return False
    # tofile은 ndarray를 곧바로 파일로 쓴다 (tobytes() 중간 사본 제거).
    buf.tofile(str(p))
    return True
