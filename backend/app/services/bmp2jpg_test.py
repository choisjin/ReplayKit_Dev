import struct
import subprocess
import os
import time

d = open('/tmp/hkmc_test.bmp', 'rb').read()
off = struct.unpack_from('<I', d, 10)[0]
w = struct.unpack_from('<i', d, 18)[0]
h = abs(struct.unpack_from('<i', d, 22)[0])
bpp = struct.unpack_from('<H', d, 28)[0]
bytespp = bpp // 8
rs = (w * bytespp + 3) & ~3
print('BMP: %dx%d, %dbpp' % (w, h, bpp))

# BMP -> PPM 변환 (순수 Python, BGR->RGB 스왑)
rows = []
for y in range(h - 1, -1, -1):
    s = off + y * rs
    row = d[s:s + w * bytespp]
    # BGR -> RGB 스왑
    rgb = bytearray(w * 3)
    for x in range(w):
        rgb[x*3] = row[x*bytespp + 2]
        rgb[x*3+1] = row[x*bytespp + 1]
        rgb[x*3+2] = row[x*bytespp]
    rows.append(bytes(rgb))

ppm_header = ('P6\n%d %d\n255\n' % (w, h)).encode()
ppm_data = ppm_header + b''.join(rows)
with open('/tmp/hkmc_test.ppm', 'wb') as f:
    f.write(ppm_data)
print('PPM: %d bytes' % len(ppm_data))

# PPM -> JPEG (GStreamer)
if os.path.exists('/tmp/hkmc_test.jpg'):
    os.unlink('/tmp/hkmc_test.jpg')

t0 = time.time()
p = subprocess.run(
    ['gst-launch-1.0', '-e', '-q',
     'filesrc', 'location=/tmp/hkmc_test.ppm', '!',
     'decodebin', '!',
     'videoconvert', '!',
     'jpegenc', 'quality=70', '!',
     'filesink', 'location=/tmp/hkmc_test.jpg'],
    capture_output=True,
)
elapsed = time.time() - t0

jpg_size = os.path.getsize('/tmp/hkmc_test.jpg') if os.path.exists('/tmp/hkmc_test.jpg') else 0
print('JPEG: %d bytes (%.1f KB), 변환시간: %.3fs' % (jpg_size, jpg_size / 1024, elapsed))
if p.stderr:
    err = p.stderr.decode(errors='replace').strip()
    if err:
        print('ERR:', err[:300])
print('SUCCESS' if jpg_size > 0 else 'FAILED')

# 정리
for f in ['/tmp/hkmc_test.ppm', '/tmp/hkmc_raw.bgr']:
    if os.path.exists(f):
        os.unlink(f)
