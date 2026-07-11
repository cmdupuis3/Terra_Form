# 16-bit two-channel greyscale elevation: base 4096x2048 + fine hgt tiles (300px/10deg). R=high byte, G=low byte.
import numpy as np, rasterio, os, json
from rasterio.enums import Resampling
from rasterio.windows import Window
from PIL import Image
DEM='/mnt/user-data/uploads/ETOPO_2022_v1_60s_N90W180_surface.tif'
SEA,PEAK=-500.0,6000.0
def enc16(a):
    g=np.rint(np.clip((a-SEA)/(PEAK-SEA),0,1)*65535.0).astype(np.uint16)
    return np.stack([(g>>8).astype(np.uint8),(g&255).astype(np.uint8),np.zeros(g.shape,np.uint8)],-1)
src=rasterio.open(DEM)
# --- base 4096x2048 (decimated average, 16-bit) ---
base=src.read(1,out_shape=(2048,4096),resampling=Resampling.average).astype('float32')
Image.fromarray(enc16(base),'RGB').save('../data/elev_4096.png',optimize=True)
print('elev_4096 16-bit:', os.path.getsize('../data/elev_4096.png')//1024,'KB')
# --- fine height tiles 300px / 10deg: average float elevation 600->300 THEN pack (never decimate packed bytes) ---
OUT='../data/hgt_tiles'; DEG=10; TILE=300; cols,rows=360//DEG,180//DEG
bw=int(round(DEG*src.width/360.0)); bh=int(round(DEG*src.height/180.0))   # 600x600 native per cell
for r in range(rows):
    band=src.read(1,window=Window(0,r*bh,src.width,bh)).astype('float32')
    fy=bh//TILE; fx=bw//TILE                                             # 2,2
    for c in range(cols):
        cell=band[:,c*bw:(c+1)*bw][:fy*TILE,:fx*TILE].reshape(TILE,fy,TILE,fx).mean(axis=(1,3))
        Image.fromarray(enc16(cell),'RGB').save(os.path.join(OUT,f'{c}_{r}.png'),optimize=True)
json.dump({"deg":DEG,"cols":cols,"rows":rows,"tileW":TILE,"tileH":TILE,"ext":"png","enc":"rg16"},open(os.path.join(OUT,'index.json'),'w'))
print('hgt_tiles 16-bit 300px: 648 tiles')
