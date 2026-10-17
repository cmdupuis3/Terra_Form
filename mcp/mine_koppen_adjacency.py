#!/usr/bin/env python3
"""Mine which Koppen classes actually sit next to each other on land (Karth & Smith 2017 framing: learn the
adjacency constraint from the exemplar, report a violation as a contradiction with coordinates).

Reads data/koppen_2048.png (pixel value = class index 0..30, 0 = none/ocean) at a few strides that bracket the
app's tile densities, counts 4-neighbour pairs of land pixels, and writes mcp/koppen_adjacency.json:
  groups: 6x6 symmetric matrix of pair SHARES (sum = 1) at the coarsest stride, plus per-stride matrices
  classes: 31x31 pair counts at stride 2
The bridge's climate-jump lint reads the group shares: a pair whose share is below its threshold is a jump.

Usage: python -P mcp/mine_koppen_adjacency.py [--src data/koppen_2048.png] [--out mcp/koppen_adjacency.json]
"""
import argparse, json, os, struct, zlib

KEYS = ['', 'Af', 'Am', 'Aw', 'BWh', 'BWk', 'BSh', 'BSk', 'Csa', 'Csb', 'Csc', 'Cwa', 'Cwb', 'Cwc', 'Cfa', 'Cfb', 'Cfc',
        'Dsa', 'Dsb', 'Dsc', 'Dsd', 'Dwa', 'Dwb', 'Dwc', 'Dwd', 'Dfa', 'Dfb', 'Dfc', 'Dfd', 'ET', 'EF']
GROUP_NAMES = ['ice cap', 'tundra', 'arid', 'tropical', 'temperate', 'continental']


def group(idx):   # mirrors classGroup in core/app.js: 0 EF, 1 ET, 2 arid, 3 tropical, 4 temperate, 5 continental
    c = KEYS[idx] if idx < len(KEYS) else ''
    if not c:
        return 5
    a = c[0]
    return 3 if a == 'A' else 2 if a == 'B' else 4 if a == 'C' else 5 if a == 'D' else (0 if c == 'EF' else 1)


def read_png_gray(path):
    """Minimal PNG reader for 8-bit greyscale / palette / RGB(A) non-interlaced images; returns (w, h, rows of ints)."""
    with open(path, 'rb') as f:
        data = f.read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'not a PNG'
    pos, idat, w = 8, [], None
    while pos < len(data):
        n, = struct.unpack('>I', data[pos:pos + 4]); typ = data[pos + 4:pos + 8]; body = data[pos + 8:pos + 8 + n]; pos += 12 + n
        if typ == b'IHDR':
            w, h, depth, ctype, _, _, interlace = struct.unpack('>IIBBBBB', body)
            assert depth == 8 and interlace == 0, f'unsupported PNG (depth {depth}, interlace {interlace})'
            bpp = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
        elif typ == b'IDAT':
            idat.append(body)
        elif typ == b'IEND':
            break
    raw = zlib.decompress(b''.join(idat))
    stride = w * bpp; rows = []; prev = bytearray(stride); p = 0
    for y in range(h):
        flt = raw[p]; cur = bytearray(raw[p + 1:p + 1 + stride]); p += 1 + stride
        for i in range(stride):
            a = cur[i - bpp] if i >= bpp else 0; b = prev[i]; c = prev[i - bpp] if i >= bpp else 0
            if flt == 1: cur[i] = (cur[i] + a) & 255
            elif flt == 2: cur[i] = (cur[i] + b) & 255
            elif flt == 3: cur[i] = (cur[i] + ((a + b) >> 1)) & 255
            elif flt == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                cur[i] = (cur[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(cur[::bpp]); prev = cur
    return w, h, rows


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__)); root = os.path.dirname(here)
    ap.add_argument('--src', default=os.path.join(root, 'data', 'koppen_2048.png'))
    ap.add_argument('--out', default=os.path.join(here, 'koppen_adjacency.json'))
    ap.add_argument('--strides', default='1,2,4,8')
    a = ap.parse_args()
    w, h, rows = read_png_gray(a.src)
    print(f'{a.src}: {w}x{h}')
    out = {'source': os.path.relpath(a.src, root).replace(os.sep, '/'), 'groupNames': GROUP_NAMES, 'classKeys': KEYS, 'strides': {}}
    cls_counts = None
    for s in [int(x) for x in a.strides.split(',')]:
        G = [[0] * 6 for _ in range(6)]; C = [[0] * 31 for _ in range(31)] if s == 2 else None; total = 0
        for y in range(0, h - s, s):
            r0, r1 = rows[y], rows[y + s]
            for x in range(0, w - s, s):
                k = r0[x]
                if not k or k > 30:
                    continue
                for k2 in (r0[x + s], r1[x]):
                    if not k2 or k2 > 30:
                        continue
                    g1, g2 = group(k), group(k2); G[g1][g2] += 1; G[g2][g1] += 1 if g1 != g2 else 0; total += 1
                    if C is not None:
                        C[k][k2] += 1; C[k2][k] += 1 if k != k2 else 0
        share = [[round(v / total, 6) for v in row] for row in G]
        out['strides'][str(s)] = {'pairs': total, 'groupShare': share}
        if C is not None:
            cls_counts = C
        print(f'stride {s}: {total} land pairs')
        for i in range(6):
            print('  ' + GROUP_NAMES[i].ljust(12) + ' '.join(f'{share[i][j]*100:6.2f}' for j in range(6)))
    out['groups'] = out['strides'][str(max(int(x) for x in a.strides.split(',')))]['groupShare']
    out['classes'] = cls_counts
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(out, f)
    print('wrote', a.out)


if __name__ == '__main__':
    main()
