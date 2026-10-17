#!/usr/bin/env python3
"""Compile an OpenFront map (image.png + info.json) into the runtime files the game loads.

OpenFront ships a Go tool (map-generator/) that turns a hand-painted PNG into five files under
resources/maps/<name>/: map.bin, map4x.bin, map16x.bin (one byte per tile at full, half and quarter
resolution), manifest.json (info.json plus the three sizes) and thumbnail.webp. This module is a
numpy port of that pipeline, byte-identical on the .bin files, so the maps this repo exports can be
compiled and previewed without a Go toolchain. It reproduces, from map-generator/map_generator.go:

  GenerateMap                       crop to a multiple of 4, classify pixels, orchestrate the scales
  removeSmallIslands                4-connected land bodies under 30 tiles (15 at 4x) are replaced by
                                    the majority type of their unique outside neighbours
  processWater                      the largest 4-connected water body is the ocean; other bodies under
                                    200 tiles are filled (full scale only); ties and votes as in Go
  processShore / processDistToLand  shoreline flags, then a BFS through water from shoreline water
  setImpassableNeighborWaterDepth   water beside impassable terrain is forced to magnitude 20
  createMiniMap                     2x2 -> 1, water wins, then impassable, else the last land tile
  packTerrain                       land<<7 | shore<<6 | ocean<<5 | magnitude; impassable is 0x9F
  createMapThumbnail / getThumbnailColor / convertToWebP
  majorityNeighborType, neighborCoords, getArea

and from map-generator/main.go the manifest layout and the output file set. Pixel values are what
Go's image.At(x, y).RGBA() >> 8 yields for each PNG kind (palette, RGB, RGBA, grey, 16-bit): alpha
premultiplied before the 8-bit cut, which is where anti-aliased edges differ from a naive read.
render_preview() draws a packed .bin with the in-game palette from
src/client/render/gl/utils/ColorUtils.ts (encodeTerrainTile) and render-settings.json.

OpenFront's source is (c) OpenFront and Contributors, AGPL-3.0 (MIT before 2025-09-04); its map assets
are CC BY-SA 4.0. This file is written from the documented behaviour, not copied from it.

API
  load_image(path) -> HxWx4 uint8 RGBA, as the Go generator sees it
  compile_map(rgba, remove_small=True) -> Compiled
  thumbnail(compiled) -> PIL.Image RGBA;  write_thumbnail(path, compiled)
  manifest(info, compiled) -> dict
  write_resources(out_dir, info, compiled)
  render_preview(bin_bytes, width, height, mark_lakes=False) -> PIL.Image RGB

CLI
  python games/openfront/openfront_compile.py <folder with image.png + info.json> --out <resources folder>
                                      [--preview preview.png] [--keep-small]
"""
from __future__ import annotations

import argparse, io, json, os, struct, sys, time, zlib
from dataclasses import dataclass, field

import numpy as np
from PIL import Image
from scipy import ndimage

LAND, WATER, IMPASSABLE = 0, 1, 2          # Go's TerrainType order
MIN_ISLAND = 30                            # tiles; the 4x scale uses half
MIN_LAKE = 200
DEEP_BY_IMPASSABLE = 20.0                  # raw magnitude, packs as 10
IMPASSABLE_BYTE = 0x9F
FOUR = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=bool)

# in-game palette: render-settings.json "terrain" defaults, which Renderer.ts hands to
# ColorUtils.encodeTerrainTile as its colour overrides
BACKGROUND_RGB = (0x3C, 0x3C, 0x3C)
OCEAN_RGB = (0x47, 0x85, 0xB5)
SAND_RGB = (0xCC, 0xCB, 0x9E)
PLAINS_RGB = (0xBE, 0xDC, 0x8A)
HIGHLAND_RGB = (0xDC, 0xCB, 0x9E)
MOUNTAIN_RGB = (0xE6, 0xE6, 0xE6)


# ----------------------------------------------------------------------------------------------
# PNG loading, the way Go's image/png + color.RGBA() see it
# ----------------------------------------------------------------------------------------------

@dataclass
class _PngHeader:
    width: int
    height: int
    bit_depth: int
    color_type: int
    interlace: int
    trns: bytes = b""
    plte: bytes = b""


def _png_chunks(data):
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG file")
    pos = 8
    while pos + 8 <= len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        yield kind, data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if kind == b"IEND":
            break


def _png_header(data):
    hdr = None
    for kind, body in _png_chunks(data):
        if kind == b"IHDR":
            w, h, bd, ct, _, _, il = struct.unpack(">IIBBBBB", body[:13])
            hdr = _PngHeader(w, h, bd, ct, il)
        elif kind == b"tRNS" and hdr is not None:
            hdr.trns = bytes(body)
        elif kind == b"PLTE" and hdr is not None:
            hdr.plte = bytes(body)
        elif kind == b"IDAT":
            break
    if hdr is None:
        raise ValueError("PNG without IHDR")
    return hdr


def _premul8(rgb, alpha):
    """Go's color.NRGBA.RGBA() followed by >> 8: c*0x101*a/0xff, then the high byte."""
    c = rgb.astype(np.uint32) * 0x101
    c = (c * alpha.astype(np.uint32)[..., None]) // 0xFF
    return (c >> 8).astype(np.uint8)


def _premul16(c16, a16):
    """Go's color.NRGBA64.RGBA() followed by >> 8: c*a/0xffff, then the high byte."""
    c = (c16.astype(np.uint64) * a16.astype(np.uint64)[..., None]) // 0xFFFF
    return (c >> 8).astype(np.uint8)


def _reheader(data, bit_depth, color_type):
    """Rewrite the IHDR so Pillow decodes the same filtered bytes under another sample layout.

    Only used where the bytes-per-pixel (and so the PNG filters) are unchanged: 16-bit grey -> 8-bit
    grey+alpha, 16-bit grey+alpha -> 8-bit RGBA. Ancillary chunks are dropped."""
    out = [data[:8]]
    for kind, body in _png_chunks(data):
        if kind == b"IHDR":
            body = struct.pack(">IIBBBBB", *struct.unpack(">II", body[:8]), bit_depth, color_type, *body[10:13])
        elif kind not in (b"PLTE", b"IDAT", b"IEND"):
            continue
        out.append(struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF))
    return b"".join(out)


def _unfilter_rows(data, hdr, bpp):
    """Decode a non-interlaced PNG's scanlines to raw bytes (rows x stride). Sub/Up/None rows are
    vectorised; Average and Paeth rows fall back to a byte loop (only 16-bit RGB(A) comes here)."""
    if hdr.interlace:
        raise NotImplementedError("interlaced 16-bit RGB/RGBA PNGs are not supported")
    raw = zlib.decompress(b"".join(body for kind, body in _png_chunks(data) if kind == b"IDAT"))
    stride = hdr.width * bpp
    rows = np.frombuffer(raw, dtype=np.uint8).reshape(hdr.height, stride + 1)
    out = np.zeros((hdr.height, stride), dtype=np.uint8)
    prior = np.zeros(stride, dtype=np.uint8)
    for y in range(hdr.height):
        ftype, line = rows[y, 0], rows[y, 1:]
        if ftype == 0:
            cur = line.copy()
        elif ftype == 1:
            cur = line.copy()
            for r in range(bpp):
                cur[r::bpp] = np.cumsum(line[r::bpp], dtype=np.uint32) & 0xFF
        elif ftype == 2:
            cur = ((line.astype(np.uint16) + prior) & 0xFF).astype(np.uint8)
        elif ftype in (3, 4):
            cur = np.zeros(stride, dtype=np.uint8)
            ln, pr, cu = line.tolist(), prior.tolist(), [0] * stride
            for i in range(stride):
                a = cu[i - bpp] if i >= bpp else 0
                b = pr[i]
                if ftype == 3:
                    cu[i] = (ln[i] + ((a + b) >> 1)) & 0xFF
                else:
                    c = pr[i - bpp] if i >= bpp else 0
                    p = a + b - c
                    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                    pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                    cu[i] = (ln[i] + pred) & 0xFF
            cur[:] = cu
        else:
            raise ValueError(f"bad PNG filter type {ftype}")
        out[y] = cur
        prior = cur
    return out


def go_rgba(png_bytes):
    """RGBA (HxWx4 uint8) exactly as map_generator.go reads it: Go's image/png decoder yields
    Paletted/RGBA/NRGBA/Gray/Gray16/RGBA64/NRGBA64 images, and At().RGBA() premultiplies the
    non-premultiplied kinds before the generator keeps the high byte."""
    hdr = _png_header(png_bytes)
    ct, bd = hdr.color_type, hdr.bit_depth
    im = Image.open(io.BytesIO(png_bytes))

    if ct == 3:                                              # palette -> image.Paletted
        idx = np.asarray(im.convert("P") if im.mode != "P" else im)
        n = len(hdr.plte) // 3
        pal = np.zeros((256, 4), dtype=np.uint8)
        pal[:, 3] = 255                                      # out-of-range indices decode as opaque black in Go
        pal[:n, :3] = np.frombuffer(hdr.plte[:3 * n], dtype=np.uint8).reshape(n, 3)
        t = np.frombuffer(hdr.trns[:n], dtype=np.uint8)      # entries with a tRNS alpha become color.NRGBA
        pal[:len(t), 3] = t
        rgba = pal[idx]
        if len(t):
            rgba = np.dstack([_premul8(rgba[..., :3], rgba[..., 3]), rgba[..., 3]])
        return np.ascontiguousarray(rgba)

    if bd <= 8:
        if ct == 0:                                          # grey -> image.Gray (NRGBA with a tRNS)
            arr = np.asarray(im.convert("L"))
            alpha = np.full(arr.shape, 255, dtype=np.uint8)
            if len(hdr.trns) >= 2:
                key = struct.unpack(">H", hdr.trns[:2])[0] * (255 // ((1 << bd) - 1))
                alpha[arr == key] = 0
            rgb = np.repeat(arr[..., None], 3, axis=2)
            return np.dstack([_premul8(rgb, alpha) if len(hdr.trns) else rgb, alpha])
        if ct == 2:                                          # RGB -> image.RGBA (NRGBA with a tRNS)
            rgb = np.asarray(im.convert("RGB"))
            alpha = np.full(rgb.shape[:2], 255, dtype=np.uint8)
            if len(hdr.trns) >= 6:
                key = np.array(struct.unpack(">HHH", hdr.trns[:6]), dtype=np.uint16) & 0xFF
                alpha[np.all(rgb == key.astype(np.uint8), axis=2)] = 0
                rgb = _premul8(rgb, alpha)
            return np.dstack([rgb, alpha])
        if ct == 4:                                          # grey+alpha -> image.NRGBA
            la = np.asarray(im.convert("LA"))
            rgb = np.repeat(la[..., :1], 3, axis=2)
            return np.dstack([_premul8(rgb, la[..., 1]), la[..., 1]])
        if ct == 6:                                          # RGBA -> image.NRGBA
            rgba = np.asarray(im.convert("RGBA"))
            return np.dstack([_premul8(rgba[..., :3], rgba[..., 3]), rgba[..., 3]])
        raise ValueError(f"unsupported PNG colour type {ct}")

    # 16-bit samples
    if ct == 0:                                              # grey -> image.Gray16 (NRGBA64 with a tRNS)
        y16 = np.asarray(im).astype(np.uint16)
        if len(hdr.trns) >= 2:
            a16 = np.where(y16 == struct.unpack(">H", hdr.trns[:2])[0], 0, 0xFFFF).astype(np.uint16)
            rgb = _premul16(np.repeat(y16[..., None], 3, axis=2), a16)
            return np.dstack([rgb, (a16 >> 8).astype(np.uint8)])
        hi = (y16 >> 8).astype(np.uint8)
        return np.dstack([hi, hi, hi, np.full(hi.shape, 255, dtype=np.uint8)])
    if ct == 2 and not hdr.trns:                             # RGB -> image.RGBA64: high bytes
        rgb = np.asarray(im.convert("RGB"))
        return np.dstack([rgb, np.full(rgb.shape[:2], 255, dtype=np.uint8)])
    if ct == 4:                                              # grey+alpha -> image.NRGBA64; same bpp as RGBA8
        b = np.asarray(Image.open(io.BytesIO(_reheader(png_bytes, 8, 6))).convert("RGBA")).astype(np.uint16)
        y16 = (b[..., 0] << 8) | b[..., 1]
        a16 = (b[..., 2] << 8) | b[..., 3]
        return np.dstack([_premul16(np.repeat(y16[..., None], 3, axis=2), a16), (a16 >> 8).astype(np.uint8)])
    if ct in (2, 6):                                         # RGB with tRNS, or RGBA -> image.NRGBA64
        chans = 3 if ct == 2 else 4
        raw = _unfilter_rows(png_bytes, hdr, 2 * chans).reshape(hdr.height, hdr.width, chans, 2).astype(np.uint16)
        s16 = (raw[..., 0] << 8) | raw[..., 1]
        if ct == 2:
            key = np.array(struct.unpack(">HHH", hdr.trns[:6]), dtype=np.uint16)
            a16 = np.where(np.all(s16 == key, axis=2), 0, 0xFFFF).astype(np.uint16)
            rgb16 = s16
        else:
            rgb16, a16 = s16[..., :3], s16[..., 3]
        return np.dstack([_premul16(rgb16, a16), (a16 >> 8).astype(np.uint8)])
    raise ValueError(f"unsupported PNG colour type {ct} at {bd} bits")


def load_image(path):
    """HxWx4 uint8 RGBA of image.png, holding what the Go generator sees (premultiplied, 8-bit)."""
    with open(path, "rb") as f:
        return go_rgba(f.read())


# ----------------------------------------------------------------------------------------------
# Terrain processing. Arrays are row-major (H, W); Go's terrain[x][y] is the same grid transposed.
# ----------------------------------------------------------------------------------------------

def _neighbour_votes(labels, is_small, typ, self_type):
    """Per small body (label id), how many distinct outside 4-neighbour tiles are of each type.

    This is Go's majorityNeighborType: body members are skipped and each outside tile votes once,
    however many body tiles it touches. Tiles of self_type next to a body belong to that body
    (4-connectivity), so only other types are counted. Returns counts[(nlabels+1), 3]."""
    h, w = labels.shape
    n = h * w
    flat = np.arange(n, dtype=np.int64).reshape(h, w)
    keys = []
    for nb, me in (((slice(None), slice(None, -1)), (slice(None), slice(1, None))),     # left neighbour
                   ((slice(None), slice(1, None)), (slice(None), slice(None, -1))),     # right
                   ((slice(None, -1), slice(None)), (slice(1, None), slice(None))),     # up
                   ((slice(1, None), slice(None)), (slice(None, -1), slice(None)))):    # down
        lab = labels[nb]
        hit = is_small[lab] & (typ[me] != self_type)
        keys.append(lab[hit].astype(np.int64) * n + flat[me][hit])
    keys = np.unique(np.concatenate(keys)) if keys else np.zeros(0, np.int64)
    lab, idx = keys // n, keys % n
    t = typ.reshape(-1)[idx]
    counts = np.zeros((len(is_small), 3), dtype=np.int64)
    for k in (LAND, WATER, IMPASSABLE):
        counts[:, k] = np.bincount(lab[t == k], minlength=len(is_small))
    return counts


def _label(mask):
    labels, nlab = ndimage.label(mask, structure=FOUR)
    return labels, nlab, np.bincount(labels.ravel(), minlength=nlab + 1)


def _remove_small_islands(typ, mag, min_size, stats):
    """removeSmallIslands: land bodies under min_size become the majority outside type; ties go to
    Water (Water > Impassable > Land). Replaced tiles get magnitude 0."""
    labels, nlab, sizes = _label(typ == LAND)
    small = (sizes < min_size)
    small[0] = False
    stats["islands_removed"] = int(small.sum())
    stats["island_tiles"] = int(sizes[small].sum())
    stats["islands_to_impassable"] = 0
    if not small.any():
        return
    counts = _neighbour_votes(labels, small, typ, LAND)
    repl = np.where(counts[:, IMPASSABLE] > counts[:, WATER], IMPASSABLE, WATER).astype(np.uint8)
    hit = small[labels]
    typ[hit] = repl[labels[hit]]
    mag[hit] = 0
    stats["islands_to_impassable"] = int((repl[small] == IMPASSABLE).sum())


def _water_distance(typ, mag, shore, stats):
    """processDistToLand: BFS through water from shoreline water tiles; magnitude = steps. Water
    the BFS never reaches keeps whatever magnitude it had (0, or the value copied from the
    larger scale by the minimap)."""
    h, w = typ.shape
    n = h * w
    water = (typ == WATER).reshape(-1)
    magf = mag.reshape(-1)
    visited = np.zeros(n, dtype=bool)
    frontier = np.flatnonzero((shore & (typ == WATER)).reshape(-1))
    visited[frontier] = True
    magf[frontier] = 0
    d = 0
    while frontier.size:
        d += 1
        x = frontier % w
        nxt = []
        for cand in (frontier[x > 0] - 1, frontier[x < w - 1] + 1, frontier[frontier >= w] - w, frontier[frontier < n - w] + w):
            cand = cand[water[cand] & ~visited[cand]]      # a direction never repeats a tile; marking between
            visited[cand] = True                             # directions keeps the frontier duplicate-free
            nxt.append(cand)
        frontier = np.concatenate(nxt)
        magf[frontier] = d
    stats["max_water_distance"] = d - 1 if d else 0
    stats["water_unreached"] = int((water & ~visited).sum())


def _process_water(typ, mag, shore, ocean, remove_small, stats):
    """processWater: largest water body (ties: first found scanning x then y) is the ocean; with
    remove_small, other bodies under MIN_LAKE become their majority outside type (Impassable beats
    Land on a tie). Then shorelines and the BFS distances. No water at all: nothing else runs."""
    ocean[:] = False
    labels, nlab, sizes = _label(typ == WATER)
    stats["water_bodies"] = int(nlab)
    stats["lakes_filled"] = stats["lake_tiles"] = stats["lakes_to_impassable"] = 0
    if nlab == 0:
        stats["ocean_tiles"] = 0
        return
    sizes[0] = -1
    biggest = np.flatnonzero(sizes == sizes.max())
    if len(biggest) > 1:                                     # Go's sort keeps the first body found scanning x, then y
        order = labels.T.reshape(-1)
        biggest = biggest[[np.argmin([np.argmax(order == b) for b in biggest])]]
    ocean_label = int(biggest[0])
    ocean[labels == ocean_label] = True
    stats["ocean_tiles"] = int(sizes[ocean_label])

    if remove_small:
        small = (sizes < MIN_LAKE)
        small[0] = False
        small[ocean_label] = False
        stats["lakes_filled"] = int(small.sum())
        stats["lake_tiles"] = int(sizes[small].sum())
        if small.any():
            counts = _neighbour_votes(labels, small, typ, WATER)
            repl = np.where(counts[:, LAND] > counts[:, IMPASSABLE], LAND,
                            np.where(counts[:, IMPASSABLE] > 0, IMPASSABLE, WATER)).astype(np.uint8)
            hit = small[labels]
            typ[hit] = repl[labels[hit]]
            mag[hit] = 0
            stats["lakes_to_impassable"] = int((repl[small] == IMPASSABLE).sum())

    # processShore: land beside water and water beside land; impassable is never shoreline
    land, water = typ == LAND, typ == WATER
    near_water = ndimage.binary_dilation(water, structure=FOUR)
    near_land = ndimage.binary_dilation(land, structure=FOUR)
    shore[:] = (land & near_water) | (water & near_land)
    stats["shoreline_land"] = int((land & near_water).sum())
    stats["shoreline_water"] = int((water & near_land).sum())
    _water_distance(typ, mag, shore, stats)


def _deepen_by_impassable(typ, mag, stats):
    """setImpassableNeighborWaterDepth: water with an impassable 4-neighbour is magnitude 20."""
    hit = (typ == WATER) & ndimage.binary_dilation(typ == IMPASSABLE, structure=FOUR)
    mag[hit] = DEEP_BY_IMPASSABLE
    stats["deep_by_impassable"] = int(hit.sum())


def _mini_map(typ, mag, shore, ocean):
    """createMiniMap: each 2x2 block becomes one tile. Go visits the block as (x,y), (x,y+1),
    (x+1,y), (x+1,y+1) into a zero-valued (Land) tile: the first Water tile wins outright, else the
    first Impassable, else every Land tile overwrites so the last one stays. All four fields of the
    chosen tile are copied, magnitude and flags included."""
    h, w = typ.shape[0] // 2, typ.shape[1] // 2

    def stacked(a):
        b = a[:2 * h, :2 * w].reshape(h, 2, w, 2)           # [y, dy, x, dx]
        return np.stack([b[:, 0, :, 0], b[:, 1, :, 0], b[:, 0, :, 1], b[:, 1, :, 1]])

    t = stacked(typ)
    is_w, is_i = t == WATER, t == IMPASSABLE
    choice = np.where(is_w.any(0), is_w.argmax(0), np.where(is_i.any(0), is_i.argmax(0), 3))[None]
    pick = lambda a: np.ascontiguousarray(np.take_along_axis(stacked(a), choice, 0)[0])
    return pick(typ), pick(mag), pick(shore), pick(ocean)


def _pack(typ, mag, shore, ocean):
    """packTerrain. Returns (bytes, num_land_tiles); impassable tiles are 0x9F and not counted."""
    land, imp = typ == LAND, typ == IMPASSABLE
    m = np.minimum(np.where(land, np.ceil(mag), np.ceil(mag / 2)), 31).astype(np.uint8)
    out = (land.astype(np.uint8) << 7) | (shore.astype(np.uint8) << 6) | (ocean.astype(np.uint8) << 5) | m
    out[imp] = IMPASSABLE_BYTE
    return out.tobytes(), int(land.sum())


def _thumb_rgba(typ, mag, shore):
    """createMapThumbnail(terrain4x, 0.5) + getThumbnailColor: every other tile, water and
    impassable transparent (with Go's RGB left under the zero alpha), land by magnitude band."""
    typ, mag, shore = (a[::2, ::2] for a in (typ, mag, shore))
    water, imp, land = typ == WATER, typ == IMPASSABLE, typ == LAND
    out = np.zeros(typ.shape + (4,), dtype=np.uint8)
    wadj = 1.0 - np.minimum(mag / 2, 10)                     # 11 - min(mag/2, 10) - 10
    for i, base in enumerate((70, 132, 180)):
        out[..., i] = np.maximum(base + wadj, 0).astype(np.uint8)
    out[water & shore] = (100, 143, 255, 0)
    plains = land & (mag < 10)
    out[plains] = np.stack([np.full(plains.sum(), 190), (220 - 2 * mag[plains]), np.full(plains.sum(), 138),
                            np.full(plains.sum(), 255)], axis=1).astype(np.uint8)
    high = land & (mag >= 10) & (mag < 20)
    adj = 2 * mag[high]
    out[high] = np.stack([200 + adj, 183 + adj, 138 + adj, np.full(high.sum(), 255)], axis=1).astype(np.uint8)
    mount = land & (mag >= 20)
    grey = np.floor(230 + mag[mount] / 2)
    out[mount] = np.stack([grey, grey, grey, np.full(mount.sum(), 255)], axis=1).astype(np.uint8)
    out[land & shore] = (204, 203, 158, 255)
    out[imp] = (0, 0, 0, 0)
    return out


@dataclass
class Compiled:
    width: int
    height: int
    bins: dict = field(default_factory=dict)       # "map" / "map4x" / "map16x" -> bytes
    sizes: dict = field(default_factory=dict)      # same keys -> {"width", "height", "num_land_tiles"}
    stats: dict = field(default_factory=dict)      # same keys -> per-scale counters, plus "seconds"
    thumb: np.ndarray = None                       # RGBA array the thumbnail is encoded from


def classify(rgba):
    """GenerateMap's pixel pass on an already cropped RGBA array -> (type, magnitude)."""
    r, g, b, a = (rgba[..., i] for i in range(4))
    water = (a < 20) | (b == 106)
    imp = ~water & (r == 0) & (g == 0) & (b == 0)
    typ = np.where(water, WATER, np.where(imp, IMPASSABLE, LAND)).astype(np.uint8)
    mag = np.where(typ == LAND, (np.clip(b.astype(np.float64), 140, 200) - 140) / 2, 0.0)
    return typ, mag


def compile_map(rgba, remove_small=True):
    """Run the whole generator on an HxWx4 RGBA array (see load_image). remove_small=False is what
    Go uses for its test maps: no island or lake removal at any scale."""
    t0 = time.time()
    h, w = rgba.shape[0] - rgba.shape[0] % 4, rgba.shape[1] - rgba.shape[1] % 4
    if w == 0 or h == 0:
        raise ValueError(f"image {rgba.shape[1]}x{rgba.shape[0]} is smaller than 4x4")
    typ, mag = classify(np.ascontiguousarray(rgba[:h, :w]))
    shore = np.zeros(typ.shape, dtype=bool)
    ocean = np.zeros(typ.shape, dtype=bool)
    out = Compiled(w, h)

    def scale_stats(key, typ, t_start):
        s = out.stats[key]
        s["land_tiles"] = int((typ == LAND).sum())
        s["impassable_tiles"] = int((typ == IMPASSABLE).sum())
        s["seconds"] = round(time.time() - t_start, 3)

    no_islands = dict(islands_removed=0, island_tiles=0, islands_to_impassable=0)

    out.stats["map"] = {}
    if remove_small:
        _remove_small_islands(typ, mag, MIN_ISLAND, out.stats["map"])
    else:
        out.stats["map"].update(no_islands)
    _process_water(typ, mag, shore, ocean, remove_small, out.stats["map"])
    _deepen_by_impassable(typ, mag, out.stats["map"])
    scale_stats("map", typ, t0)

    t1 = time.time()
    typ4, mag4, shore4, ocean4 = _mini_map(typ, mag, shore, ocean)
    out.stats["map4x"] = {}
    if remove_small:
        _remove_small_islands(typ4, mag4, MIN_ISLAND // 2, out.stats["map4x"])
    else:
        out.stats["map4x"].update(no_islands)
    _process_water(typ4, mag4, shore4, ocean4, False, out.stats["map4x"])
    _deepen_by_impassable(typ4, mag4, out.stats["map4x"])
    scale_stats("map4x", typ4, t1)

    t2 = time.time()
    typ16, mag16, shore16, ocean16 = _mini_map(typ4, mag4, shore4, ocean4)
    out.stats["map16x"] = dict(no_islands)
    _process_water(typ16, mag16, shore16, ocean16, False, out.stats["map16x"])
    _deepen_by_impassable(typ16, mag16, out.stats["map16x"])
    scale_stats("map16x", typ16, t2)

    out.thumb = _thumb_rgba(typ4, mag4, shore4)
    for key, fields in (("map", (typ, mag, shore, ocean)), ("map4x", (typ4, mag4, shore4, ocean4)),
                        ("map16x", (typ16, mag16, shore16, ocean16))):
        data, n_land = _pack(*fields)
        out.bins[key] = data
        out.sizes[key] = {"width": fields[0].shape[1], "height": fields[0].shape[0], "num_land_tiles": n_land}
    if out.sizes["map"]["num_land_tiles"] == 0:
        raise ValueError("map has 0 land tiles")
    out.stats["seconds"] = round(time.time() - t0, 3)
    return out


# ----------------------------------------------------------------------------------------------
# Outputs
# ----------------------------------------------------------------------------------------------

def thumbnail(compiled):
    """The thumbnail as a PIL RGBA image (map4x sampled every other tile, transparent water)."""
    return Image.fromarray(compiled.thumb, "RGBA")


def write_thumbnail(fp, compiled):
    """WebP as convertToWebP: quality 45, method 4. Lossy, so not byte-equal to Go's libwebp build."""
    thumbnail(compiled).save(fp, "WEBP", quality=45, method=4)


def manifest(info, compiled):
    """info.json passed through, plus the three {width, height, num_land_tiles} blocks."""
    out = dict(info)
    for key in ("map", "map4x", "map16x"):
        out[key] = dict(compiled.sizes[key])
    return out


def write_resources(out_dir, info, compiled):
    """Write map.bin, map4x.bin, map16x.bin, manifest.json and thumbnail.webp into out_dir."""
    os.makedirs(out_dir, exist_ok=True)
    for key in ("map", "map4x", "map16x"):
        with open(os.path.join(out_dir, key + ".bin"), "wb") as f:
            f.write(compiled.bins[key])
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest(info, compiled), f, indent=2, sort_keys=True, ensure_ascii=False)
        f.write("\n")
    write_thumbnail(os.path.join(out_dir, "thumbnail.webp"), compiled)


def unpack(bin_bytes, width, height):
    """Decode a .bin into (land, shore, ocean, magnitude, impassable) boolean/uint8 arrays."""
    b = np.frombuffer(bin_bytes, dtype=np.uint8)
    if b.size != width * height:
        raise ValueError(f"{b.size} bytes is not {width}x{height}")
    b = b.reshape(height, width)
    land = (b & 0x80) != 0
    mag = b & 0x1F
    return land, (b & 0x40) != 0, (b & 0x20) != 0, mag, land & (mag == 31)


def render_preview(bin_bytes, width, height, mark_lakes=False):
    """Draw a packed .bin the way the game does (ColorUtils.encodeTerrainTile with the default
    palette). mark_lakes tints non-ocean water (bit 5 clear), which the game itself does not."""
    land, shore, ocean, mag, imp = unpack(bin_bytes, width, height)
    m = mag.astype(np.int32)
    out = np.zeros((height, width, 3), dtype=np.int32)
    deep = np.minimum(m, 10)
    for i, base in enumerate(OCEAN_RGB):                     # deep water: base shade minus depth
        out[..., i] = np.maximum(0, base - deep)
    wshore = ~land & shore                                   # shoreline water: 70% ocean + 30% white
    out[wshore] = [int(np.floor(0.7 * c + 76.5 + 0.5)) for c in OCEAN_RGB]
    if mark_lakes:
        lake = ~land & ~ocean
        out[lake] = out[lake] * np.array([0.8, 1.0, 0.9]) + np.array([0, 10, 0])
    plains = land & (m < 10)
    out[plains] = np.stack([np.full(plains.sum(), PLAINS_RGB[0]), PLAINS_RGB[1] - 2 * m[plains],
                            np.full(plains.sum(), PLAINS_RGB[2])], axis=1)
    high = land & (m >= 10) & (m < 20)
    d = 2 * (m[high] - 10)
    out[high] = np.stack([np.minimum(255, c + d) for c in HIGHLAND_RGB], axis=1)
    mount = land & (m >= 20)
    d = m[mount] // 2
    out[mount] = np.stack([np.minimum(255, c + d) for c in MOUNTAIN_RGB], axis=1)
    out[land & shore] = SAND_RGB
    out[imp] = BACKGROUND_RGB
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGB")


def _log_stats(compiled, out=sys.stdout):
    for key in ("map", "map4x", "map16x"):
        s, z = compiled.stats[key], compiled.sizes[key]
        line = (f"{key:6s} {z['width']}x{z['height']}: land {z['num_land_tiles']}, impassable {s['impassable_tiles']}, "
                f"water bodies {s['water_bodies']} (ocean {s['ocean_tiles']}), islands removed {s['islands_removed']} "
                f"({s['island_tiles']} tiles, {s['islands_to_impassable']} to impassable), lakes filled {s['lakes_filled']} "
                f"({s['lake_tiles']} tiles, {s['lakes_to_impassable']} to impassable)")
        if "shoreline_land" in s:
            line += (f", shore {s['shoreline_land']} land / {s['shoreline_water']} water, water distance max "
                     f"{s['max_water_distance']}, unreached {s['water_unreached']}")
        line += f", deep by impassable {s['deep_by_impassable']}, {s['seconds']:.2f}s"
        print(line, file=out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", help="map folder holding image.png and info.json")
    ap.add_argument("--out", required=True, help="resources folder to write map.bin, map4x.bin, map16x.bin, manifest.json, thumbnail.webp into")
    ap.add_argument("--preview", help="also render map.bin with the in-game palette to this PNG")
    ap.add_argument("--preview-lakes", action="store_true", help="tint non-ocean water in the preview")
    ap.add_argument("--keep-small", action="store_true", help="skip island and lake removal (Go's test-map mode)")
    args = ap.parse_args(argv)

    t0 = time.time()
    rgba = load_image(os.path.join(args.folder, "image.png"))
    with open(os.path.join(args.folder, "info.json"), encoding="utf-8") as f:
        info = json.load(f)
    print(f"image {rgba.shape[1]}x{rgba.shape[0]} -> {rgba.shape[1] - rgba.shape[1] % 4}x{rgba.shape[0] - rgba.shape[0] % 4}, "
          f"loaded in {time.time() - t0:.2f}s")
    compiled = compile_map(rgba, remove_small=not args.keep_small)
    _log_stats(compiled)
    write_resources(args.out, info, compiled)
    print(f"wrote {args.out} ({compiled.thumb.shape[1]}x{compiled.thumb.shape[0]} thumbnail) in {time.time() - t0:.2f}s")
    if args.preview:
        render_preview(compiled.bins["map"], compiled.width, compiled.height, args.preview_lakes).save(args.preview)
        print(f"preview {args.preview}")


if __name__ == "__main__":
    main()
