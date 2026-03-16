import struct
import subprocess

d = open('/tmp/hkmc_test.bmp', 'rb').read()
off = struct.unpack_from('<I', d, 10)[0]
w = struct.unpack_from('<i', d, 18)[0]
h = abs(struct.unpack_from('<i', d, 22)[0])
rs = (w * 3 + 3) & ~3
rows = []
for y in range(h - 1, -1, -1):
    s = off + y * rs
    rows.append(d[s:s + w * 3])
raw = b''.join(rows)
print('BMP: %dx%d, raw size: %d bytes' % (w, h, len(raw)))

caps = 'video/x-raw,format=BGR,width=%d,height=%d,framerate=0/1' % (w, h)
p = subprocess.run(
    ['gst-launch-1.0', '-e', '-q',
     'fdsrc', 'blocksize=%d' % len(raw), '!',
     caps, '!',
     'videoconvert', '!',
     'jpegenc', 'quality=70', '!',
     'filesink', 'location=/tmp/hkmc_test.jpg'],
    input=raw,
    capture_output=True,
)

import os
jpg_size = os.path.getsize('/tmp/hkmc_test.jpg') if os.path.exists('/tmp/hkmc_test.jpg') else 0
print('JPEG: %d bytes (%.1f KB)' % (jpg_size, jpg_size / 1024))
if p.stderr:
    print('ERR:', p.stderr.decode(errors='replace')[:500])
if jpg_size > 0:
    print('SUCCESS')
else:
    print('FAILED')
