#!/usr/bin/env python3
"""Build the optional Colchuck/Asgard 3DEP Terrarium pack from a USGS COG.

Install rasterio, numpy and Pillow, then run this script from the repository root.
Only fully covered tiles are emitted; all other positions retain the AWS DEM.
"""

import json
import math
import io
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.vrt import WarpedVRT


ROOT = Path(__file__).resolve().parent.parent
ZOOM = 15
XS = range(5383, 5389)
YS = range(11457, 11462)
SOURCE_URL = (
    "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/"
    "WA_EasternCascades_2019_B19/TIFF/"
    "USGS_1M_10_x66y527_WA_EasternCascades_2019_B19.tif"
)
OUT = ROOT / "public" / "dem" / "enchantments-3dep-2019" / str(ZOOM)
MANIFEST = ROOT / "src" / "terrain" / "data" / "enchantments-3dep-2019.json"
WEB_MERCATOR_HALF = math.pi * 6378137
EDGE_BLEND_PIXELS = 24


def tile_transform(x: int, y: int):
    span = 2 * WEB_MERCATOR_HALF / (2**ZOOM)
    left = -WEB_MERCATOR_HALF + x * span
    top = WEB_MERCATOR_HALF - y * span
    return from_bounds(left, top - span, left + span, top, 256, 256)


def aws_heights(x: int, y: int):
    url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{ZOOM}/{x}/{y}.png"
    with urllib.request.urlopen(url, timeout=20) as response:
        rgb = np.asarray(Image.open(io.BytesIO(response.read())).convert("RGB"), dtype=np.float64)
    return rgb[:, :, 0] * 256 + rgb[:, :, 1] + rgb[:, :, 2] / 256 - 32768


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    heights_by_tile = {}
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
        with rasterio.open(f"/vsicurl/{SOURCE_URL}") as source:
            for y in YS:
                for x in XS:
                    with WarpedVRT(
                        source,
                        crs="EPSG:3857",
                        transform=tile_transform(x, y),
                        width=256,
                        height=256,
                        resampling=Resampling.bilinear,
                        nodata=-999999,
                    ) as vrt:
                        heights = vrt.read(1)
                    valid = np.isfinite(heights) & (heights > -1000) & (heights < 10000)
                    if not valid.all():
                        print(f"skip {ZOOM}/{x}/{y}: {valid.mean():.3%} source coverage")
                        continue
                    heights_by_tile[(x, y)] = heights.astype(np.float64)

    tiles = []
    for (x, y), heights in heights_by_tile.items():
        missing_neighbors = {
            "left": (x - 1, y) not in heights_by_tile,
            "right": (x + 1, y) not in heights_by_tile,
            "top": (x, y - 1) not in heights_by_tile,
            "bottom": (x, y + 1) not in heights_by_tile,
        }
        if any(missing_neighbors.values()):
            aws = aws_heights(x, y)
            yy, xx = np.indices((256, 256))
            distance = np.full((256, 256), EDGE_BLEND_PIXELS, dtype=np.float64)
            if missing_neighbors["left"]:
                distance = np.minimum(distance, xx)
            if missing_neighbors["right"]:
                distance = np.minimum(distance, 255 - xx)
            if missing_neighbors["top"]:
                distance = np.minimum(distance, yy)
            if missing_neighbors["bottom"]:
                distance = np.minimum(distance, 255 - yy)
            weight = np.clip(distance / EDGE_BLEND_PIXELS, 0, 1)
            heights = heights * weight + aws * (1 - weight)
        encoded = np.rint((heights + 32768) * 256).astype(np.uint32)
        rgb = np.stack(
            ((encoded >> 16) & 255, (encoded >> 8) & 255, encoded & 255), axis=-1
        ).astype(np.uint8)
        target = OUT / str(x) / f"{y}.png"
        target.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(rgb, mode="RGB").save(target, optimize=True)
        tiles.append(f"{x}/{y}")
        print(f"write {ZOOM}/{x}/{y}: {target.stat().st_size} bytes")

    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps({
        "id": "usgs-3dep-enchantments-2019-v1",
        "zoom": ZOOM,
        "tiles": tiles,
        "source": SOURCE_URL,
        "sourceTitle": "USGS 1 Meter 10 x66y527 WA_EasternCascades_2019_B19",
        "sourceDataset": "USGS 3D Elevation Program 1 meter DEM",
        "horizontalCRS": "EPSG:26910",
        "outputCRS": "EPSG:3857",
        "resampling": "bilinear",
        "encoding": "Terrarium RGB, 1/256 metre",
        "edgeBlendPixels": EDGE_BLEND_PIXELS,
        "note": "Only tiles with complete source coverage are packaged; their outer edges blend to AWS Terrarium where neighboring USGS tiles are absent.",
    }, indent=2) + "\n")
    print(f"{len(tiles)} complete tiles; manifest: {MANIFEST}")


if __name__ == "__main__":
    main()
