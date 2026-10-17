"use strict";

/* Inspector disclosures affect presentation only; storage is optional. */
document.querySelectorAll('.panel[data-section]').forEach(panel=>{
  const key='terra.ui.panel.'+panel.dataset.section;
  try{const saved=localStorage.getItem(key);if(saved!==null)panel.open=saved==='open';}catch(e){}
  panel.addEventListener('toggle',()=>{
    try{localStorage.setItem(key,panel.open?'open':'closed');}catch(e){}
  });
});
/* ============================================================
   TERRA·FORM — interface prototype (procedural stand-in world)
   ============================================================ */

/* Köppen colours — Beck et al. 2023 (Sci. Data 5:180214) legend RGB. Full 30-class table for when a real raster is wired in. */
const BECK2018={Af:[0,0,255],Am:[0,120,255],Aw:[70,170,250],BWh:[255,0,0],BWk:[255,150,150],BSh:[245,165,0],BSk:[255,220,100],Csa:[255,255,0],Csb:[200,200,0],Csc:[150,150,0],Cwa:[150,255,150],Cwb:[100,200,100],Cwc:[50,150,50],Cfa:[200,255,80],Cfb:[100,255,80],Cfc:[50,200,0],Dsa:[255,0,255],Dsb:[200,0,200],Dsc:[150,50,150],Dsd:[150,100,150],Dwa:[170,175,255],Dwb:[90,120,220],Dwc:[75,80,180],Dwd:[50,0,135],Dfa:[0,255,255],Dfb:[55,200,255],Dfc:[0,125,125],Dfd:[0,70,95],ET:[178,178,178],EF:[102,102,102]};
/* real Köppen (Rubel–Kottek 1976–2000) — class index per pixel, 0 = none. */
const KOPPEN_KEYS=[null,'Af','Am','Aw','BWh','BWk','BSh','BSk','Csa','Csb','Csc','Cwa','Cwb','Cwc','Cfa','Cfb','Cfc','Dsa','Dsb','Dsc','Dsd','Dwa','Dwb','Dwc','Dwd','Dfa','Dfb','Dfc','Dfd','ET','EF'];   // Beck et al. 2023, 30 classes (index 1-30 per legend.txt)
const KOPPEN_PALETTE=KOPPEN_KEYS.map(k=>k?(BECK2018[k]||BECK2018.Aw):[255,255,255]);
/* map a Köppen class index to the 6 terrain-prior groups: 0=EF,1=ET,2=arid,3=tropical,4=temperate,5=continental */
function classGroup(idx){const c=KOPPEN_KEYS[idx];if(!c)return 5;const a=c[0];return a==='A'?3:a==='B'?2:a==='C'?4:a==='D'?5:(c==='EF'?0:1);}
const ZONE_COLOR=[BECK2018.EF,BECK2018.ET,BECK2018.BWh,BECK2018.Af,BECK2018.Cfb,BECK2018.Dfb];   // 6-group colours for the satellite biome synth
/* ---- External raster data. Both are equirectangular (2:1); any resolution works, they are
   nearest-neighbour resampled to the 4096x2048 working grid. Put the files in data/. ----
   KOPPEN_SRC: 8-bit GRAYSCALE PNG whose pixel value IS the Koppen class index into KOPPEN_KEYS
               below -- 0 = ocean/none, 1..30 = classes, 30 = EF. A colour/paletted PNG will NOT
               work (the loader reads the raw index from the red channel). Rasterize your TIFF the
               way scripts/koppen_to_zones.py does, but make the class order match KOPPEN_KEYS
               EXACTLY: that script currently lists 31 classes (incl 'As', 1-based to 31), whereas
               KOPPEN_KEYS has 30 classes (no 'As') with EF=30 -- so verify the mapping. The
               existing data/koppen_2048.png already follows the app's convention.
   SAT_SRC:    RGB PNG, Blue Marble-style true colour. Optional -- if the file is missing the app
               falls back to its procedural colouring.
   NOTE: reading external image pixels requires serving over http(s). Opened via file:// the canvas
   is tainted in Chrome and getImageData throws, so BOTH layers fall back silently (this is why the
   climate view looked broken). Run e.g.  python3 -m http.server  then open http://localhost:8000/
   -- an on-page banner warns you if a read was blocked. */
const KOPPEN_SRC = 'data/koppen_2048.png';   // your class-index grayscale PNG
const SAT_SRC    = 'data/sat_2048.png';      // your satellite RGB PNG (or leave the file absent)

/* ---------- procedural source world ---------- */
const WSRC=4096,HSRC=2048;
const WRAP_MARGIN_DEG=90, WRAP_PX=WRAP_MARGIN_DEG/360*WSRC;   // horizontal wrap: pan/frame up to this far past +/-180
const heightArr=new Float32Array(WSRC*HSRC), colorArr=new Uint8ClampedArray(WSRC*HSRC*3), koppenArr=new Uint8Array(WSRC*HSRC), roughArr=new Float32Array(WSRC*HSRC);
const satArr=new Uint8ClampedArray(WSRC*HSRC*3); let satLoaded=false;   // real satellite colour (Blue Marble); replaces the procedural interior when present
function hash2(x,y){let n=Math.imul(x|0,374761393)^Math.imul(y|0,668265263);n=Math.imul(n^(n>>>13),1274126177);n^=n>>>16;return (n>>>0)/4294967295;}
function smooth(t){return t*t*(3-2*t);}
function vnoise(x,y){const xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi;const a=hash2(xi,yi),b=hash2(xi+1,yi),c=hash2(xi,yi+1),d=hash2(xi+1,yi+1);const u=smooth(xf),v=smooth(yf);return (a*(1-u)+b*u)*(1-v)+(c*(1-u)+d*u)*v;}
function fbm(x,y,oct,gain,lac){let f=0,amp=0.5,fr=1;for(let i=0;i<oct;i++){f+=amp*vnoise(x*fr,y*fr);amp*=gain;fr*=lac;}return f;}
function latOf(sy){return 90-(sy/HSRC)*180;}
function lonOf(sx){return (sx/WSRC)*360-180;}
function hsv(r,g,b){r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;let h=0;if(d){if(mx===r)h=((g-b)/d)%6;else if(mx===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60;if(h<0)h+=360;}return [h,mx?d/mx:0,mx];}
function rampLerp(stops,t){t=Math.max(0,Math.min(1,t));for(let i=1;i<stops.length;i++){if(t<=stops[i][0]){const a=stops[i-1],b=stops[i],f=(t-a[0])/(b[0]-a[0]||1);return [a[1][0]+(b[1][0]-a[1][0])*f,a[1][1]+(b[1][1]-a[1][1])*f,a[1][2]+(b[1][2]-a[1][2])*f];}}return stops[stops.length-1][1].slice();}
const HEAT=[[0,[0,0,0]],[0.16,[0,0,255]],[0.33,[120,0,200]],[0.5,[255,0,0]],[0.66,[255,140,0]],[0.83,[255,255,0]],[1,[255,255,255]]];
const HYPS_LAND=[[0,[40,110,60]],[0.25,[120,175,90]],[0.45,[225,215,130]],[0.65,[180,130,75]],[0.82,[120,85,60]],[1,[245,245,242]]];
const HYPS_SEA=[[0,[8,44,90]],[1,[95,170,210]]];
function heatColor(v){return rampLerp(HEAT,v);}
function elevColor(h,sea){if(h<sea)return rampLerp(HYPS_SEA,sea>0?h/sea:0);return rampLerp(HYPS_LAND,(h-sea)/(1-sea||1));}

/* real coastline (Natural Earth, WGS84 lon/lat) — see scripts/reduce_coastline.py */
let COAST=null;   // reduced coastline, loaded from data/coast_10m.json (external, not embedded)
let LAKES=null;   // reduced lakes, loaded from data/lakes_10m.json (external, not embedded)
function fillPolysGlobal(m,polys){for(const p of polys){m.beginPath();for(const ring of p.r){for(let i=0;i<ring.length;i++){const x=(ring[i][0]+180)/360*WSRC,y=(90-ring[i][1])/180*HSRC;i?m.lineTo(x,y):m.moveTo(x,y);}m.closePath();}m.fill('evenodd');}}
/* source-resolution land/water mask: land MINUS lakes (equirectangular, north-up) */
function buildLandMask(lakes){
  const c=document.createElement('canvas');c.width=WSRC;c.height=HSRC;const m=c.getContext('2d');
  m.fillStyle='#000';m.fillRect(0,0,WSRC,HSRC);
  m.fillStyle='#fff';fillPolysGlobal(m,COAST.polys);   // land
  m.fillStyle='#000';fillPolysGlobal(m,(lakes||LAKES).polys);   // lakes -> water (historic lakes included once hires loads)
  const d=m.getImageData(0,0,WSRC,HSRC).data,mask=new Uint8Array(WSRC*HSRC);
  for(let i=0;i<mask.length;i++)mask[i]=d[i*4]>127?1:0;return mask;
}
let landMask=null;                 // built after COAST/LAKES load (see boot)
/* land-alpha canvas (land opaque, water transparent); lakes punched out */
function buildLandAlpha(lakes){const c=document.createElement('canvas');c.width=WSRC;c.height=HSRC;const m=c.getContext('2d');m.clearRect(0,0,WSRC,HSRC);m.fillStyle='#fff';fillPolysGlobal(m,COAST.polys);m.globalCompositeOperation='destination-out';fillPolysGlobal(m,(lakes||LAKES).polys);m.globalCompositeOperation='source-over';return c;}
let landAlphaCanvas=null;

/* salt-flat ground truth: data/playas.json rasterized into playaArr at the working grid. A tile that is
   mostly playa classifies as a salt flat (desert), overriding the colour/climate salt-vs-snow heuristic --
   this is what disentangles e.g. Salar de Uyuni (high, white, cold) from real snow. */
let PLAYAS=null, playaArr=null;
function buildPlayaMask(){
  if(!PLAYAS||!PLAYAS.polys)return null;
  const c=document.createElement('canvas');c.width=WSRC;c.height=HSRC;const m=c.getContext('2d');
  m.fillStyle='#000';m.fillRect(0,0,WSRC,HSRC);m.fillStyle='#fff';fillPolysGlobal(m,PLAYAS.polys);
  const d=m.getImageData(0,0,WSRC,HSRC).data,mask=new Uint8Array(WSRC*HSRC);
  for(let i=0;i<mask.length;i++)mask[i]=d[i*4]>127?1:0;return mask;
}
function loadPlayas(done){
  fetch('data/playas.json').then(r=>{if(!r.ok)throw new Error('http '+r.status);return r.json();})
    .then(j=>{PLAYAS=(j&&j.polys)?j:null;playaArr=buildPlayaMask();done();})
    .catch(e=>{PLAYAS=null;playaArr=null;console.warn('playas.json not loaded ('+e+') -- salt flats use the colour/climate heuristic. Serve over http(s).');done();});
}
let worldSeed=1;
const elevArr=new Float32Array(WSRC*HSRC);       // real Earth elevation 0..1, decoded from embedded image
const ELEV_SRC='data/elev_4096.png';   // external (not embedded) — loaded like koppen/sat over http(s)
/* height is REAL Earth elevation (relief + colouring). Land/water comes from the coastline,
   so height is decoupled from the coast. Colour & Köppen come from real height + latitude +
   procedural moisture — the moisture is what "reseed climate" regenerates. */
function generateWorld(seed){
  worldSeed=seed|0;const ox=((worldSeed*127.1)%997)+0.5,oy=((worldSeed*311.7)%991)+0.5;
  for(let y=0;y<HSRC;y++){const lat=latOf(y),aLat=Math.abs(lat);
    for(let x=0;x<WSRC;x++){const nx=x/HSRC,ny=y/HSRC;
      const h=elevArr[y*WSRC+x]; heightArr[y*WSRC+x]=h;                                  // REAL height
      let moist=fbm(nx*4.0+31.0+ox,ny*4.0+9.0+oy,4,0.5,2.0)+0.22*Math.cos((aLat-8)/20); moist=Math.max(0,Math.min(1,moist));
      const z=classGroup(koppenArr[y*WSRC+x]);                                           // biome group from REAL Köppen
      let r,g,b;const hs=Math.max(0,h-0.35)*1.6;                                          // snow-cap on real high terrain
      if(z===0){r=236;g=238;b=232;}else if(z===1){r=150;g=158;b=138;}else if(z===2){r=205-moist*40;g=180-moist*30;b=120-moist*20;}else if(z===3){r=46;g=104;b=52;}else if(z===4){r=96;g=140;b=70;}else{r=120;g=138;b=88;}
      r=r*(1-hs)+236*hs;g=g*(1-hs)+236*hs;b=b*(1-hs)+230*hs;
      const i=(y*WSRC+x)*3;colorArr[i]=r;colorArr[i+1]=g;colorArr[i+2]=b;}}
  if(satLoaded)colorArr.set(satArr);   // real Blue Marble colour overrides the procedural interior
}
let imgReadBlocked=false;   // set true when a pixel read is blocked (file:// canvas taint); drives the on-page banner
let baseDataMissing=false;  // set true when core base-data files 404 (e.g. serving a folder without the tiles)
function loadImageInto(src,arr,fallback,done){
  const img=new Image();
  img.onload=()=>{try{const c=document.createElement('canvas');c.width=WSRC;c.height=HSRC;const g=c.getContext('2d');g.imageSmoothingEnabled=false;g.drawImage(img,0,0,WSRC,HSRC);const d=g.getImageData(0,0,WSRC,HSRC).data;for(let i=0;i<WSRC*HSRC;i++)arr[i]=fallback(d[i*4]);done();}catch(e){imgReadBlocked=true;console.error('loadImageInto: could not read image pixels for '+String(img.src||'').slice(0,64)+' — if you opened index.html via file://, the browser taints the canvas and getImageData throws; serve the folder over http(s) instead (e.g. python3 -m http.server). Falling back to empty data for this layer.',e);for(let i=0;i<arr.length;i++)arr[i]=fallback(-1);done();}};
  img.onerror=()=>{for(let i=0;i<arr.length;i++)arr[i]=fallback(-1);done();};
  img.src=src;
}
function loadElevation(done){   // 16-bit two-channel greyscale: R=high byte, G=low byte
  const img=new Image();
  img.onload=()=>{try{const c=document.createElement('canvas');c.width=WSRC;c.height=HSRC;const g=c.getContext('2d');g.imageSmoothingEnabled=false;g.drawImage(img,0,0,WSRC,HSRC);const d=g.getImageData(0,0,WSRC,HSRC).data;for(let i=0;i<WSRC*HSRC;i++)elevArr[i]=(d[i*4]*256+d[i*4+1])/65535;done();}catch(e){imgReadBlocked=true;console.error('loadElevation: pixel read blocked -- serve over http(s) so getImageData works.',e);for(let i=0;i<elevArr.length;i++)elevArr[i]=0.2;done();}};
  img.onerror=()=>{baseDataMissing=true;for(let i=0;i<elevArr.length;i++)elevArr[i]=0.2;done();};
  img.src=ELEV_SRC;
}
function loadKoppen(done){loadImageInto(KOPPEN_SRC,koppenArr,g=>g<0?0:g,done);}   // grayscale value = Koppen class index
function loadColor(done){                                                          // real satellite RGB -> satArr
  if(!SAT_SRC){satLoaded=false;return done();}                                      // no satellite file configured -> procedural colour
  const img=new Image();
  img.onload=()=>{try{const c=document.createElement('canvas');c.width=WSRC;c.height=HSRC;const g=c.getContext('2d');g.imageSmoothingEnabled=false;g.drawImage(img,0,0,WSRC,HSRC);const d=g.getImageData(0,0,WSRC,HSRC).data;for(let p=0;p<WSRC*HSRC;p++){satArr[p*3]=d[p*4];satArr[p*3+1]=d[p*4+1];satArr[p*3+2]=d[p*4+2];}satLoaded=true;done();}catch(e){imgReadBlocked=true;console.error('loadColor: could not read '+SAT_SRC+' -- serve over http(s) (file:// taints the canvas). Using procedural colour.',e);satLoaded=false;done();}};
  img.onerror=()=>{satLoaded=false;done();};                                        // fall back to procedural colour
  img.src=SAT_SRC;
}

/* ---------- offscreen layers (land-only interiors; water applied from the coastline) ---------- */
function newLayer(){const c=document.createElement('canvas');c.width=WSRC;c.height=HSRC;return c;}
function paintTo(canvas,fn){const cx=canvas.getContext('2d');const img=cx.createImageData(WSRC,HSRC);fn(img.data);cx.putImageData(img,0,0);}
const layerColor=newLayer(),layerElev=newLayer(),layerRough=newLayer(),layerClimate=newLayer();
function paintColor(){paintTo(layerColor,d=>{for(let p=0;p<WSRC*HSRC;p++){d[p*4]=colorArr[p*3];d[p*4+1]=colorArr[p*3+1];d[p*4+2]=colorArr[p*3+2];d[p*4+3]=255;}});}
function paintElevation(){paintTo(layerElev,d=>{for(let p=0;p<WSRC*HSRC;p++){const c=rampLerp(HYPS_LAND,heightArr[p]);d[p*4]=c[0];d[p*4+1]=c[1];d[p*4+2]=c[2];d[p*4+3]=255;}});}
function paintClimate(){paintTo(layerClimate,d=>{for(let p=0;p<WSRC*HSRC;p++){const c=KOPPEN_PALETTE[koppenArr[p]]||KOPPEN_PALETTE[0];d[p*4]=c[0];d[p*4+1]=c[1];d[p*4+2]=c[2];d[p*4+3]=255;}});}
/* roughness = NORMALIZED gradient computed on a height workspace downsampled by k;
   k telescopes with zoom (coarse workspace when zoomed out, finer as you zoom in). */
let curRoughK=-1, roughHalo=0, roughSmooth=null;   // roughSmooth = the same smoothed field the Roughness view shows, reused by classification
const HALO_LOG_MIN=0.08;   // roughness halo slider is logarithmic: position 0 = off, first nudge -> this value, exponential up to 1.0 (low blur radii get most of the travel)
function smoothField(a,W,H,r){   // separable box blur, in place
  const t=new Float32Array(W*H);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){let s=0,n=0;for(let dx=-r;dx<=r;dx++){const xx=x+dx;if(xx<0||xx>=W)continue;s+=a[y*W+xx];n++;}t[y*W+x]=s/n;}
  for(let x=0;x<W;x++)for(let y=0;y<H;y++){let s=0,n=0;for(let dy=-r;dy<=r;dy++){const yy=y+dy;if(yy<0||yy>=H)continue;s+=t[yy*W+x];n++;}a[y*W+x]=s/n;}
}
function buildRoughLayer(k){
  const sw=Math.max(2,Math.floor(WSRC/k)),sh=Math.max(2,Math.floor(HSRC/k)),hsm=new Float32Array(sw*sh);
  for(let y=0;y<sh;y++)for(let x=0;x<sw;x++){let s=0,n=0;for(let dy=0;dy<k;dy++)for(let dx=0;dx<k;dx++){const sx=Math.min(WSRC-1,x*k+dx),sy=Math.min(HSRC-1,y*k+dy);s+=heightArr[sy*WSRC+sx];n++;}hsm[y*sw+x]=s/n;}
  const rough=new Float32Array(sw*sh);let gmax=1e-6;
  for(let y=0;y<sh;y++)for(let x=0;x<sw;x++){const gx=hsm[y*sw+Math.min(sw-1,x+1)]-hsm[y*sw+Math.max(0,x-1)],gy=hsm[Math.min(sh-1,y+1)*sw+x]-hsm[Math.max(0,y-1)*sw+x];const g=Math.sqrt(gx*gx+gy*gy);rough[y*sw+x]=g;if(g>gmax)gmax=g;}
  for(let i=0;i<rough.length;i++)rough[i]=Math.pow(Math.min(1,rough[i]/gmax),0.7);   // normalized to [0,1]
  const haloR=Math.round((k<=1?7:k<=2?5:3)*roughHalo);                              // zoom-scaled × halo slider; 0 -> no smoothing
  if(haloR>=1)smoothField(rough,sw,sh,haloR);
  roughSmooth={data:rough,sw,sh,k};                                                // <- classification samples this same field
  paintTo(layerRough,d=>{for(let y=0;y<HSRC;y++)for(let x=0;x<WSRC;x++){const sx=Math.min(sw-1,Math.floor(x/k)),sy=Math.min(sh-1,Math.floor(y/k)),c=heatColor(rough[sy*sw+sx]),p=y*WSRC+x;d[p*4]=c[0];d[p*4+1]=c[1];d[p*4+2]=c[2];d[p*4+3]=255;}});
  curRoughK=k;
}
function roughKForZoom(){const ww=windowWidthDeg();return ww>180?8:ww>90?4:ww>30?2:1;}
function ensureRough(){const k=roughKForZoom();if(k!==curRoughK)buildRoughLayer(k);}
function repaintLayers(){paintColor();paintElevation();paintClimate();curRoughK=-1;ensureRough();}
const LAYERS={color:layerColor,elevation:layerElev,roughness:layerRough,climate:layerClimate};

/* ---------- Koppen climate: crisp windowed VECTOR fill when zoomed past coastThr, else the coarse PNG raster ----------
   Zones are TILED: data/koppen_tiles/<col>_<row>.json (10 deg cells, polygons clipped to the cell), listed in
   data/koppen_tiles/index.json. Only the tiles overlapping the view are fetched, then cached; the view fills in
   progressively as each arrives. All EXTERNAL (never embedded); needs http (fetch is blocked from file://). On
   failure KTILE_INDEX stays null and the climate view falls back to the raster PNG. */
const KOPPEN_CSS=KOPPEN_PALETTE.map(c=>'rgb('+(c[0]|0)+','+(c[1]|0)+','+(c[2]|0)+')');
let KTILE_DEG=10, KTILE_INDEX=null;   // Set of existing "col_row" ids
const KTILE=new Map();                // "col_row" -> {polys:[...]} | 'load' (in flight) | null (empty/failed)
function loadKoppenIndex(done){
  fetch('data/koppen_tiles/index.json').then(r=>{if(!r.ok)throw new Error('http '+r.status);return r.json();})
    .then(j=>{KTILE_DEG=j.deg||10;KTILE_INDEX=new Set(j.tiles||[]);done();})
    .catch(e=>{KTILE_INDEX=null;console.warn('koppen_tiles/index.json not loaded ('+e+') -- climate view uses the raster PNG. Serve over http(s).');done();});
}
function tileIdsForView(R){           // existing "col_row" tiles overlapping the view
  if(!KTILE_INDEX)return [];
  const lonMin=lonOf(R.x),lonMax=lonOf(R.x+R.w),latMax=latOf(R.y),latMin=latOf(R.y+R.h),D=KTILE_DEG;
  const c0=Math.floor((lonMin+180)/D),c1=Math.floor((lonMax+180)/D),r0=Math.floor((90-latMax)/D),r1=Math.floor((90-latMin)/D);
  const ids=[];for(let c=c0;c<=c1;c++)for(let r=r0;r<=r1;r++){const k=c+'_'+r;if(KTILE_INDEX.has(k))ids.push(k);}return ids;
}
function ensureTiles(ids){            // fetch any not-yet-loaded tiles; re-render as each lands
  for(const k of ids){ if(KTILE.has(k))continue; KTILE.set(k,'load');
    fetch('data/koppen_tiles/'+k+'.json').then(r=>{if(!r.ok)throw 0;return r.json();})
      .then(j=>{KTILE.set(k,(j&&j.polys)?j:null);_fineKopKey=null;render();})
      .catch(()=>{KTILE.set(k,null);}); }
}
function vectorKoppenActive(){return mode==='climate'&&!!KTILE_INDEX&&windowWidthDeg()<=coastThr;}
function koppenZoneCull(R){           // gather in-view polys from loaded tiles; kick off fetches for the missing ones
  const ids=tileIdsForView(R);ensureTiles(ids);
  const lonMin=lonOf(R.x),lonMax=lonOf(R.x+R.w),latMax=latOf(R.y),latMin=latOf(R.y+R.h);const vis=[];
  for(const k of ids){const t=KTILE.get(k);if(!t||t==='load')continue;for(const q of t.polys){const b=q.b;if(b[2]<lonMin||b[0]>lonMax||b[3]<latMin||b[1]>latMax)continue;vis.push(q);}}
  return {vis};
}
/* fill each in-view zone with its class colour; holes handled per-polygon by evenodd (closePath supplies closure).
   R is the FRAME rect shifted by this world copy's offset; rotated, vertices are projected world -> frame here
   (same convention as fillPolysWindowed), so the fill is frame-space and never goes inside a rotated transform. */
function fillKoppenZonesWindowed(g,vis,R,W,H){
  const a=rotRad(),rc=Math.cos(a),rs=Math.sin(a),vx=view.cx,vy=view.cy,RX=a?view.cx-view.spanX/2:R.x,ow=RX-R.x;
  for(const p of vis){
    g.fillStyle=KOPPEN_CSS[p.v]||KOPPEN_CSS[0];
    g.beginPath();
    for(const ring of p.r){for(let i=0;i<ring.length;i++){const lon=ring[i][0],lat=ring[i][1];let px=((lon+180)/360*WSRC)+ow,py=(90-lat)/180*HSRC;if(a){const dx=px-vx,dy=py-vy;px=vx+rc*dx+rs*dy;py=vy-rs*dx+rc*dy;}const x=(px-RX)/R.w*W,y=(py-R.y)/R.h*H;i?g.lineTo(x,y):g.moveTo(x,y);}g.closePath();}
    g.fill('evenodd');
  }
}

/* ---------- view state ---------- */
const cv=document.getElementById('view'),ctx=cv.getContext('2d'),mapBox=document.getElementById('mapBox'),wrap=document.querySelector('.viewer-wrap');
let view={cx:WSRC/2,cy:HSRC/2,spanX:WSRC,rot:0};   // rot: frame rotation in degrees, (-180,180]; 0 = north-up
let mode='color';
const P={blendHill:0.9,blendPeak:0.7,hill:0.55,peak:0.8};   // relief: how much each metric leans on roughness vs raw height, and the hills / peak thresholds on the per-view land percentiles
const MOIST_JIT=0.08;    // amplitude of the smooth spatial moisture field offered to classifiers (samples.moistJit): lets uniform-humid regions cross a dryness threshold as an organic directional FRONT, not per-tile speckle
const MOIST_SCALE=4.0;   // blob size (in tiles) of that moisture field
/* --- surrounding-climate witnesses (Norway / Etosha). White pixels (snow OR salt) carry no climate signal, so every
       tile also gets a summary of its NEARBY non-white land tiles (samples.surrArid / surrTemp): a classifier can read
       white as a salt pan in arid surroundings and as snow in cold ones. */
const SURR_R=3;               // neighbourhood radius, in tiles, for the surrounding-climate sample
const SURR_WHITE_TILE=0.15;   // a tile at least this white is itself snow/salt -> excluded as a climate witness
const PROX_SCALE_DEG=8;       // polar proximity (samples.polar) falls to ~1/e this many degrees from the nearest ET/EF zone
const PROX_SCALE_PX=PROX_SCALE_DEG*WSRC/360;
/* per-class base temperature (hot 1 -> cold 0), no latitude; index 0 = ocean/nodata */
const KOPPEN_TEMP=[0.50,0.95,0.95,0.95, 0.90,0.50,0.90,0.50, 0.72,0.58,0.44, 0.72,0.58,0.44, 0.72,0.58,0.44,
                   0.48,0.38,0.28,0.20, 0.48,0.38,0.28,0.20, 0.48,0.38,0.28,0.20, 0.26,0.04];
const clamp01=v=>v<0?0:v>1?1:v;
let out={W:52,H:32}; let lockAR=false,arRatio=52/32;
/* hex mode: compute tiles on Civ5's hex lattice (odd-r: odd CIV rows +0.5 east, row pitch sqrt(3)/2)
   so the Civ4 WBS export lands correctly when Civ5 imports it. App rows are north-origin and the
   serializer flips (grid[(H-1)-y]), so the shifted set is odd in CIV space — it flips with H's parity. */
let hexMode=false;
const HEX_ROW=Math.sqrt(3)/2;
function effH(){return hexMode?out.H*HEX_ROW:out.H;}   // output grid's physical height in tile-width units
function hexShiftX(appY,H){return (hexMode&&(((H-1-appY)&1)===1))?0.5:0;}   // tile units
/* ---------- game modules (window.TerraForm, stub defined before the module scripts) ----------
   The core owns the world: data layers, the viewer, sampling a frame into per-tile measurements (sampleRegion), land
   vs water, relief, rivers, snapshots, compose, the save flow. A game module owns its vocabulary: it turns the samples
   into tiles (classify), optionally lays features once river edges exist, says which tiles are water, colours and
   glyphs the preview, validates imported snapshots, adds its panels to the inspector and builds the export files.
   The active module is TerraForm.game; see games/README.md for the contract. */
const TF=window.TerraForm;
const HEIGHT_SEA_M=-500,HEIGHT_PEAK_M=6000;   // the RG16 height encoding: 0..1 spans [-500, 6000] metres (terraform/elev16.py)
const HEIGHT_SEA_LEVEL=(0-HEIGHT_SEA_M)/(HEIGHT_PEAK_M-HEIGHT_SEA_M);   // sea level on that 0..1 scale
function heightMetres(h){return h*(HEIGHT_PEAK_M-HEIGHT_SEA_M)+HEIGHT_SEA_M;}
TF.util={clamp01,hsv,fhash,vnoise,classGroup,KOPPEN_KEYS,KOPPEN_TEMP,KOPPEN_PALETTE,BECK2018,colorAridity,latOf,lonOf,wrapLon,heightMetres,
  elevColor:h=>rampLerp(HYPS_LAND,h),   // the Elevation view's own ramp (paintElevation)
  elevColorSea:h=>elevColor(h,HEIGHT_SEA_LEVEL),tileRiverDischarge,atRiverCorner,gridRing,hexShiftX:(y,H)=>hexShiftX(y,H),isShoreAt};
function activeGame(){return TF.game||TF.games[TF.order[0]];}
function isWaterTile(t){try{return !!activeGame().isWater(t);}catch(e){return false;}}   // a tile from another game's snapshot may not answer; treat it as land and let the compose warning speak
function finalizeTiles(tiles,W,H){const g=activeGame();if(g.finalize)g.finalize(tiles,W,H);}   // e.g. Civ4's ocean-vs-coast ring; re-run whenever tiles are re-arranged (compose, mask crop)
/* a water tile that touches land on the active lattice -- the game-agnostic reading of Civ4's TERRAIN_COAST, which
   is what the river cleanup used to test; a river edge may not flank one. */
function isShoreAt(tiles,W,H,x,y){if(x<0||x>=W||y<0||y>=H)return false;if(!isWaterTile(tiles[y][x]))return false;
  for(const o of gridRing(y,H)){const nx=x+o[0],ny=y+o[1];if(nx<0||nx>=W||ny<0||ny>=H)continue;if(!isWaterTile(tiles[ny][nx]))return true;}return false;}
function snapshotGameId(s){return s.game||(s.hex?'civ5':'civ4');}   // snapshots predating the game field were Civ4 (hex = the Civ5 layout)
function snapshotGame(s){return TF.games[snapshotGameId(s)]||null;}
function snapDim(v,lo,hi,step){v=Math.round(v)||lo;if(step>1)v=Math.round(v/step)*step;return Math.max(lo,Math.min(hi,v));}
const uiApi={makeMultiSlider:(el,opts)=>makeMultiSlider(el,opts),invalidate(){lastTiles=null;schedule();},rerender(){render();},legendChanged(){drawLegend();},refreshStats(){refreshStats();}};   // what a game's ui.bind / export.bindOptions get
function installGames(){
  const sel=document.getElementById('game');
  if(sel){sel.innerHTML='';for(const id of TF.order){const o=document.createElement('option');o.value=id;o.textContent=TF.games[id].name;sel.appendChild(o);}sel.addEventListener('change',()=>setGame(sel.value));}
  const bound=new Set();
  for(const id of TF.order){const ui=TF.games[id].ui;if(ui&&ui.bind&&!bound.has(ui)){bound.add(ui);try{ui.bind(uiApi);}catch(e){console.error('game '+id+': ui.bind failed',e);}}}
  let want=null;try{want=localStorage.getItem('terra.game');}catch(e){}
  setGame(TF.games[want]?want:TF.order[0]);
}
/* Switching game swaps the lattice (hex rows re-snap every placed patch, see composeSnapY), the grid limits, the
   game's panels, its export options and labels, then re-evaluates the frame. The size is kept when it fits. */
function setGame(id){
  const g=TF.games[id]||TF.games[TF.order[0]];if(!g)return;TF.game=g;
  hexMode=g.grid.kind==='hex';
  const G=g.grid,st=G.step||1;owEl.min=G.min.W;owEl.max=G.max.W;ohEl.min=G.min.H;ohEl.max=G.max.H;owEl.step=ohEl.step=st;
  for(const id of ['cw','chh']){const el=document.getElementById(id);if(el){el.min=id==='cw'?G.min.W:G.min.H;el.max=id==='cw'?G.max.W:G.max.H;el.step=st;}}
  comp.W=snapDim(comp.W,G.min.W,G.max.W,st);comp.H=snapDim(comp.H,G.min.H,G.max.H,st);document.getElementById('cw').value=comp.W;document.getElementById('chh').value=comp.H;
  if(out.W<G.min.W||out.W>G.max.W||out.H<G.min.H||out.H>G.max.H){out.W=G.default.W;out.H=G.default.H;}
  out.W=snapDim(out.W,G.min.W,G.max.W,G.step);out.H=snapDim(out.H,G.min.H,G.max.H,G.step);if(lockAR)arRatio=out.W/out.H;syncInputs();
  document.querySelectorAll('#gamePanels [data-game-ui]').forEach(d=>{const on=!!g.ui&&d.dataset.gameUi===g.ui.__key;d.dataset.rail=on?'tune':'none';d.hidden=!on||mode==='compose';});
  /* export options are mounted once per distinct optionsHTML (Civ4 and Civ5 share theirs) and only shown/hidden, so a value typed into them survives a game switch */
  const eo=document.getElementById('exportGameOptions');
  if(eo){const html=g.export.optionsHTML||'';let box=html?[...eo.children].find(c=>c.dataset.optionsHtml===html):null;
    if(html&&!box){box=document.createElement('div');box.dataset.optionsHtml=html;box.innerHTML=html;eo.appendChild(box);if(g.export.bindOptions)g.export.bindOptions(uiApi);}
    for(const c of eo.children)c.hidden=c!==box;}
  const cap=document.getElementById('exportCaption');if(cap)cap.textContent=g.export.caption||g.name;
  const suf=document.getElementById('destSuffix');if(suf)suf.textContent=g.export.ext||'';
  const gb=document.getElementById('generate');if(gb&&g.export.title)gb.title=g.export.title;
  const sel=document.getElementById('game');if(sel&&sel.value!==g.id)sel.value=g.id;
  try{localStorage.setItem('terra.game',g.id);}catch(e){}
  for(const p of comp.patches)p.y=composeSnapY(p.y);
  composeInvalidate();lastTiles=null;drawLegend();updateArNote();relayout();syncComposeUI();
}
let showGrid=false,showGrat=true,lastTiles=null;
let RMAN=null;             // river tile manifest {gs, tiles:[{id,b:[bbox],n}]} (data/river_tiles/, external)
const RTILE=new Map();     // tile id -> {features:[{d,c,l,bbox,rid}]} | 'load' | null  (terminal-tiled: whole channels per tile)
let _riverGen=0;           // bumps when a tile loads, to invalidate the edge memo
let riverN=12;            // show the top-N rivers by in-frame discharge (WYSIWYG: same set is serialized)
let riverEstuaries=true;  // item 6: trace river mouths down the estuary to the sea (civ view / export)
let showRivers=true;      // VIEW-ONLY: skip the river passes while panning/zooming. Export always renders them.
const RIVER_OFF=new Set();// deselected channels (click a river to cycle): drawn red, never serialized
const RIVER_ON=new Set(); // selected channels (click a river to cycle): drawn green, kept at any zoom regardless of the top-N cutoff
/* coastline level-of-detail: crisp windowed vector when the view is narrower than coastThr degrees */
let coastThr=30;
let nudgeX=0, nudgeY=0;   // sub-tile sampling offset (in game-tile units) for the high-res -> game-tile downsample
const bufCanvas=document.createElement('canvas'),bctx=bufCanvas.getContext('2d');
const lgCanvas=document.createElement('canvas'),lgctx=lgCanvas.getContext('2d');
function windowWidthDeg(){return view.spanX/WSRC*360;}
function vectorCoastActive(){return windowWidthDeg()<=coastThr;}
/* fine height tiles: on past the vector cutoff, OR as soon as a base px would cover >= 1/FINE_HGT_UP CSS px
   (just before the 4096 base starts to magnify) as long as the padded view spans <= FINE_MAX_CELLS tile cells.
   CSS px, not canvas px: on a high-DPI screen the canvas is 2x wider, which would switch the fine tiles on at the
   whole-world view and queue every tile (~5000, ~250 MB) at startup, starving the river tiles and the UI.
   The cell budget keeps the zoom trigger to regional views (~85 deg wide) whatever the monitor size. */
const FINE_HGT_UP=1.25, FINE_MAX_CELLS=1600;
function fineTileRect(){const R=srcRect(),a=rotRad(),w=R.w+2*(Math.ceil(R.w*FINE_PAD)+2),h=R.h+2*(Math.ceil(R.h*FINE_PAD)+2),c=Math.abs(Math.cos(a)),s=Math.abs(Math.sin(a)),W=w*c+h*s,H=w*s+h*c;return {x:view.cx-W/2,y:view.cy-H/2,w:W,h:H};}   // world AABB of the padded FRAME rect the fine buffer covers (view + FINE_PAD ring + snap slack), rotated about the view centre
function fineCellCount(A){const D=HTILE_META.deg,cl=(v,hi)=>v<0?0:v>hi?hi:v;
  const c0=cl(Math.floor((lonOf(A.x)+180)/D),HTILE_META.cols-1),c1=cl(Math.floor((lonOf(A.x+A.w)+180)/D),HTILE_META.cols-1);
  const r0=cl(Math.floor((90-latOf(A.y))/D),HTILE_META.rows-1),r1=cl(Math.floor((90-latOf(A.y+A.h))/D),HTILE_META.rows-1);
  return (c1-c0+1)*(r1-r0+1);}
function fineHgtActive(){if(!HTILE_META)return false;if(windowWidthDeg()<=coastThr)return true;
  return srcRect().w<=mapBox.clientWidth*FINE_HGT_UP&&fineCellCount(fineTileRect())<=FINE_MAX_CELLS;}

/* viewer aspect is locked to the output grid (W/H) */
function maxSpanX(){return Math.min(WSRC,HSRC*(out.W/effH()));}
function spanY(){return view.spanX*(effH()/out.W);}
/* ---------- frame rotation ----------
   FRAME SPACE is the screen-aligned source-px coordinate system centred on (view.cx,view.cy); it
   coincides with world (source-raster) space when view.rot===0. The canvas rect always shows the
   frame rect (srcRect()), so rotating the view spins the WORLD behind a fixed frame — and because
   sampling reads whatever the frame covers, civ preview / capture / export inherit the rotation
   with no compose-side changes. Rotation is defined in plate-carrée px space (the viewer aspect
   lock makes the canvas->source scale uniform, so canvas-centre rotation == view-centre rotation). */
function rotRad(){return (view.rot||0)*Math.PI/180;}
function normDeg(d){d=((d+180)%360+360)%360-180;return d<=-180?d+360:d;}   // (-180,180]
function frameToWorld(fx,fy){const a=rotRad();if(!a)return [fx,fy];const c=Math.cos(a),s=Math.sin(a),dx=fx-view.cx,dy=fy-view.cy;return [view.cx+c*dx-s*dy,view.cy+s*dx+c*dy];}
function worldToFrame(wx,wy){const a=rotRad();if(!a)return [wx,wy];const c=Math.cos(a),s=Math.sin(a),dx=wx-view.cx,dy=wy-view.cy;return [view.cx+c*dx+s*dy,view.cy-s*dx+c*dy];}
/* axis-aligned world-space box covering the rotated frame: use for prefetch, culling and clamping */
function rotAABB(){const R=srcRect(),a=rotRad();if(!a)return R;const c=Math.abs(Math.cos(a)),s=Math.abs(Math.sin(a)),w=R.w*c+R.h*s,h=R.w*s+R.h*c;return {x:view.cx-w/2,y:view.cy-h/2,w,h};}
function clampView(){
  view.rot=normDeg(view.rot||0);
  const a=rotRad(),ca=Math.abs(Math.cos(a)),sa=Math.abs(Math.sin(a)),ky=effH()/out.W;
  /* the rotated frame's AABB must fit the source vertically: AABB h = spanX*(sa+ky*ca) <= HSRC */
  const cap=Math.min(WSRC,HSRC/(sa+ky*ca));
  view.spanX=Math.max(6,Math.min(cap,view.spanX));
  const hh=view.spanX*(sa+ky*ca)/2;
  view.cx=Math.max(-WRAP_PX,Math.min(WSRC+WRAP_PX,view.cx));   // horizontal wrap margin
  view.cy=Math.max(hh,Math.min(HSRC-hh,view.cy));
}
function srcRect(){const sy=spanY();return {x:view.cx-view.spanX/2,y:view.cy-sy/2,w:view.spanX,h:sy};}
function wrapOffsets(R){const k0=Math.floor(R.x/WSRC),k1=Math.floor((R.x+R.w-1e-6)/WSRC),o=[];for(let k=k0;k<=k1;k++)o.push(k*WSRC);return o;}   // world copies the view spans (x*WSRC), [0] unless it straddles +/-180
function wrapLon(l){return ((l%360)+540)%360-180;}   // normalise a longitude into [-180,180) for display

/* The grid the viewer is currently showing: the output frame in every geographic mode, the collage
   canvas in compose mode (which has its own size, independent of the output grid). */
function activeGrid(){return mode==='compose'?{W:comp.W,H:comp.H}:{W:out.W,H:out.H};}
function activeEffH(){const g=activeGrid();return hexMode?g.H*HEX_ROW:g.H;}
/* size the map-box to the largest W/H-aspect rectangle that fits the wrap; window resize only changes box size, never the framing */
function fitMapBox(){
  const availW=wrap.clientWidth-2, availH=wrap.clientHeight-2, ar=activeGrid().W/activeEffH();
  let w=availW,h=w/ar; if(h>availH){h=availH;w=h*ar;}
  mapBox.style.width=Math.max(40,Math.floor(w))+'px';
  mapBox.style.height=Math.max(40,Math.floor(h))+'px';
  const dpr=Math.min(2,window.devicePixelRatio||1);
  cv.width=Math.max(2,Math.round(mapBox.clientWidth*dpr));
  cv.height=Math.max(2,Math.round(mapBox.clientHeight*dpr));
}
function relayout(){ fitMapBox(); clampView(); if(!landAlphaCanvas)return; render(); refreshStats(); updateArNote(); }   // masks are null until boot builds them (boot then relayouts itself); a resize before that only sizes the canvas
window.addEventListener('resize',relayout);
// Tool hints and legends can wrap independently of the window size.
new ResizeObserver(()=>requestAnimationFrame(relayout)).observe(wrap);
function updateArNote(){const g=activeGrid();document.getElementById('arNote').textContent=g.W+' × '+g.H+(hexMode?' · hex':' tiles');}

/* ---------- classification core ---------- */
let islandBias=0, seawayBias=0;
let mtnPass=0, flatSpots=0;   // relief post-pass: mountain passes (demote peaks->hills in peak-dense walls) & flat spots (flats scattered in rough terrain)
/* halo land fraction selects the regime: mostly-water halo -> island (lower the land
   threshold so small islands survive); mostly-land halo -> seaway (raise it so channels open). */
function landThreshold(hf){
  const island=Math.max(0,0.5-hf)*2, seaway=Math.max(0,hf-0.5)*2;
  return Math.max(0.03,Math.min(0.97, 0.5 - islandBias*0.45*island + seawayBias*0.45*seaway));
}
function haloRadius(){
  if(!vectorCoastActive()) return 1;
  const r=Math.round(2*coastThr/Math.max(1,windowWidthDeg()));   // grows as the window narrows past the cutoff
  return Math.max(2,Math.min(14,r));
}
function haloBlur(src,W,H,r){   // separable box blur
  const t=new Float32Array(W*H),out=new Float32Array(W*H);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){let s=0,n=0;for(let dx=-r;dx<=r;dx++){const xx=x+dx;if(xx<0||xx>=W)continue;s+=src[y*W+xx];n++;}t[y*W+x]=s/n;}
  for(let x=0;x<W;x++)for(let y=0;y<H;y++){let s=0,n=0;for(let dy=-r;dy<=r;dy++){const yy=y+dy;if(yy<0||yy>=H)continue;s+=t[yy*W+x];n++;}out[y*W+x]=s/n;}
  return out;
}
/* distance (in source px) from every pixel to the nearest polar (ET/EF) Köppen pixel, via a 2-pass
   chamfer transform. Built once; feeds the boreal tilt's "proximity to tundra / snow-ice" term.
   NB: equirectangular px distance overstates E-W spans near the poles — fine for a soft proximity ramp. */
let distPolar=null;
function buildPolarDistance(){
  const N=WSRC*HSRC,INF=1e9,d=new Float32Array(N);
  for(let i=0;i<N;i++){const g=classGroup(koppenArr[i]);d[i]=(g===0||g===1)?0:INF;}   // ET(1) or EF(0) are the anchors
  const D1=1,D2=Math.SQRT2;
  for(let y=0;y<HSRC;y++)for(let x=0;x<WSRC;x++){const i=y*WSRC+x;let v=d[i];
    if(x>0)v=Math.min(v,d[i-1]+D1); if(y>0)v=Math.min(v,d[i-WSRC]+D1);
    if(x>0&&y>0)v=Math.min(v,d[i-WSRC-1]+D2); if(x<WSRC-1&&y>0)v=Math.min(v,d[i-WSRC+1]+D2); d[i]=v;}
  for(let y=HSRC-1;y>=0;y--)for(let x=WSRC-1;x>=0;x--){const i=y*WSRC+x;let v=d[i];
    if(x<WSRC-1)v=Math.min(v,d[i+1]+D1); if(y<HSRC-1)v=Math.min(v,d[i+WSRC]+D1);
    if(x<WSRC-1&&y<HSRC-1)v=Math.min(v,d[i+WSRC+1]+D2); if(x>0&&y<HSRC-1)v=Math.min(v,d[i+WSRC-1]+D2); d[i]=v;}
  distPolar=d;
}
/* global land-height distribution (sorted, subsampled), for relief-basis normalization: map a tile's
   average height to its GLOBAL land percentile so the raw-height basis spans [0,1] like the (already
   self-normalized) roughness basis. Keeps flat regions flat (low absolute height -> low percentile),
   unlike a per-region stretch. Built once. */
// relief-basis percentiles are computed per-view (per generated region) inside classifyRegion, from the region land tiles
function pctl(sorted,x){if(!sorted||!sorted.length)return x;let lo=0,hi=sorted.length;while(lo<hi){const m=(lo+hi)>>1;if(sorted[m]<=x)lo=m+1;else hi=m;}return lo/sorted.length;}
/* Sample the framed region into per-tile measurements -- the game-agnostic half of the old classifyRegion. Every
   array is W*H, row-major, row 0 north. A game module reads these and nothing else about the world. */
function sampleRegion(W,H){
  const R=srcRect(),N=W*H;
  const fineH=buildFineHeightForView(R);   // fine-scale elevation from the zoom-in height tiles (null when zoomed out / not loaded)
  const fSh=fineH?fineFrameShift(fineH):[0,0],fRx=fineH?fineH.R.x+fSh[0]:0,fRy=fineH?fineH.R.y+fSh[1]:0,fKx=fineH?fineH.fw/fineH.R.w:0,fKy=fineH?fineH.fh/fineH.R.h:0;   // the buffer covers its own padded FRAME rect (shifted for the current centre), so frame px -> buffer px goes through that, not the view rect
  const fineKop=buildFineKoppenForView(R,W,H);   // crisp Köppen from the vector tiles at zoom-in (null -> raster koppenArr)
  const fineC=buildFineColorForView(R);   // high-res satellite colour from the sat tiles at zoom-in (null -> raster colorArr)
  ensureRough();                                                   // build/refresh the smoothed roughness field for the current zoom + halo
  if(!distPolar)buildPolarDistance();                             // one-time: distance-to-polar field (boreal proximity tilt)
  const rf=roughSmooth;                                            // {data,sw,sh,k}
  const lf=new Float32Array(N),hA=new Float32Array(N),rgh=new Float32Array(N),kcA=new Uint8Array(N),rA=new Float32Array(N),gA=new Float32Array(N),bA=new Float32Array(N),ltA=new Float32Array(N),wA=new Float32Array(N),proxA=new Float32Array(N),pA=new Float32Array(N);
  const kcHist=new Uint16Array(31);                                // reused per tile: histogram over the 30 Köppen classes
  const nX=nudgeX*R.w/W, nY=nudgeY*R.h/H;                           // X/Y nudge: shift each tile sampling footprint by a fraction of a tile
  const rotA=rotRad(),rcos=Math.cos(rotA),rsin=Math.sin(rotA),vcx=view.cx,vcy=view.cy;   // the tile lattice and every sample point live in FRAME space; each sample is rotated to world before indexing the global rasters (rotA===0 -> frame IS world, direct index)
  for(let ty=0;ty<H;ty++)for(let tx=0;tx<W;tx++){
    const hX=hexShiftX(ty,H)*R.w/W;   // hex mode: odd CIV rows sample half a tile east
    const x0=R.x+(tx/W)*R.w+nX+hX,x1=R.x+((tx+1)/W)*R.w+nX+hX,y0=R.y+(ty/H)*R.h+nY,y1=R.y+((ty+1)/H)*R.h+nY;
    const sx0=Math.floor(x0),sx1=Math.ceil(x1)-1,sy0=Math.max(0,Math.floor(y0)),sy1=Math.min(HSRC-1,Math.ceil(y1)-1);   // FRAME px; sx may cross +/-180 (wrapped below); frame y stays inside the source (clampView fits the rotated AABB vertically)
    const stepx=Math.max(1,Math.floor((sx1-sx0+1)/12)),stepy=Math.max(1,Math.floor((sy1-sy0+1)/12));
    let n=0,hSum=0,rS=0,gS=0,bS=0,lSum=0,wS=0,pS=0;kcHist.fill(0);
    for(let sy=sy0;sy<=sy1;sy+=stepy)for(let sx=sx0;sx<=sx1;sx+=stepx){let i;
      if(!rotA)i=sy*WSRC+(((sx%WSRC)+WSRC)%WSRC);
      else{const dx=sx-vcx,dy=sy-vcy,wx=vcx+rcos*dx-rsin*dy,wy=vcy+rsin*dx+rcos*dy,iy=wy<0?0:wy>HSRC-1?HSRC-1:Math.floor(wy);i=iy*WSRC+(((Math.floor(wx)%WSRC)+WSRC)%WSRC);}   // frame -> world, wrap X, clamp Y
      const h=heightArr[i],rr=colorArr[i*3],gg=colorArr[i*3+1],bb=colorArr[i*3+2];hSum+=h;rS+=rr;gS+=gg;bS+=bb;const mx=rr>gg?(rr>bb?rr:bb):(gg>bb?gg:bb),mn=rr<gg?(rr<bb?rr:bb):(gg<bb?gg:bb);if(mx>168&&mn>0.75*mx)wS++;kcHist[koppenArr[i]]++;lSum+=landMask[i];pS+=playaArr?playaArr[i]:0;n++;}
    if(!n)n=1; const idx=ty*W+tx; let hAvg=hSum/n;
    const fcx=(x0+x1)/2,fcy=(y0+y1)/2;let wcx=fcx,wcy=fcy;
    if(rotA){const dx=fcx-vcx,dy=fcy-vcy;wcx=vcx+rcos*dx-rsin*dy;wcy=vcy+rsin*dx+rcos*dy;}   // ROTATED tile centre, in world px: drives latitude, base roughness and polar proximity
    let rghV=null;
    if(fineH){let fs=0,fn=0,frs=0;const fx0=Math.max(0,Math.floor((x0-fRx)*fKx)),fx1=Math.min(fineH.fw-1,Math.ceil((x1-fRx)*fKx)-1),fy0=Math.max(0,Math.floor((y0-fRy)*fKy)),fy1=Math.min(fineH.fh-1,Math.ceil((y1-fRy)*fKy)-1);const fsx=Math.max(1,Math.floor((fx1-fx0+1)/10)),fsy=Math.max(1,Math.floor((fy1-fy0+1)/10));for(let fy=fy0;fy<=fy1;fy+=fsy)for(let fx=fx0;fx<=fx1;fx+=fsx){const fi=fy*fineH.fw+fx;fs+=fineH.data[fi];frs+=fineH.rough[fi];fn++;}if(fn){hAvg=fs/fn;rghV=frs/fn;}}   // fine-scale height AND roughness override at zoom-in
    hA[idx]=hAvg; rA[idx]=rS/n;gA[idx]=gS/n;bA[idx]=bS/n; wA[idx]=wS/n;pA[idx]=pS/n;   // wA = fraction of footprint that is snow/salt-white
    if(fineC){const cx0=Math.max(0,Math.floor((x0-R.x)/R.w*fineC.fw)),cx1=Math.min(fineC.fw-1,Math.ceil((x1-R.x)/R.w*fineC.fw)-1),cy0=Math.max(0,Math.floor((y0-R.y)/R.h*fineC.fh)),cy1=Math.min(fineC.fh-1,Math.ceil((y1-R.y)/R.h*fineC.fh)-1);const csx=Math.max(1,Math.floor((cx1-cx0+1)/8)),csy=Math.max(1,Math.floor((cy1-cy0+1)/8));let rs2=0,gs2=0,bs2=0,ws2=0,cn=0;for(let cy=cy0;cy<=cy1;cy+=csy)for(let cx=cx0;cx<=cx1;cx+=csx){const ci=(cy*fineC.fw+cx)*4,rr=fineC.data[ci],gg=fineC.data[ci+1],bb=fineC.data[ci+2];rs2+=rr;gs2+=gg;bs2+=bb;const mx=rr>gg?(rr>bb?rr:bb):(gg>bb?gg:bb),mn=rr<gg?(rr<bb?rr:bb):(gg<bb?gg:bb);if(mx>168&&mn>0.75*mx)ws2++;cn++;}if(cn){rA[idx]=rs2/cn;gA[idx]=gs2/cn;bA[idx]=bs2/cn;wA[idx]=ws2/cn;}}   // high-res satellite colour overrides the base at zoom-in
    if(rghV===null){const rsx=Math.min(rf.sw-1,Math.max(0,Math.floor(wcx/rf.k))),rsy=Math.min(rf.sh-1,Math.max(0,Math.floor(wcy/rf.k)));rghV=rf.data[rsy*rf.sw+rsx];}   // base roughness fallback (zoomed out / tiles not loaded); roughSmooth is the GLOBAL world-space field, so it is sampled at the rotated centre
    rgh[idx]=rghV;
    let kcls=0,kb=0;for(let k=1;k<31;k++)if(kcHist[k]>kb){kb=kcHist[k];kcls=k;} kcA[idx]=kcls;   // dominant non-ocean Köppen class
    if(fineKop){const fx0=Math.max(0,Math.floor((x0-R.x)/R.w*fineKop.fw)),fx1=Math.min(fineKop.fw-1,Math.ceil((x1-R.x)/R.w*fineKop.fw)-1),fy0=Math.max(0,Math.floor((y0-R.y)/R.h*fineKop.fh)),fy1=Math.min(fineKop.fh-1,Math.ceil((y1-R.y)/R.h*fineKop.fh)-1);kcHist.fill(0);for(let fy=fy0;fy<=fy1;fy++)for(let fx=fx0;fx<=fx1;fx++){const kv=fineKop.data[fy*fineKop.fw+fx];if(kv>0&&kv<31)kcHist[kv]++;}let fb=0,fc=0;for(let k=1;k<31;k++)if(kcHist[k]>fb){fb=kcHist[k];fc=k;}if(fb>0)kcA[idx]=fc;}   // crisp vector Köppen overrides the raster dominant at zoom-in
    ltA[idx]=latOf(wcy); lf[idx]=lSum/n;   // per-tile latitude follows the ROTATED centre, so climate tracks the world, not the frame
    const pcx=rotA?(((Math.round(wcx)%WSRC)+WSRC)%WSRC):Math.min(WSRC-1,Math.max(0,Math.round(wcx))),pcy=Math.min(HSRC-1,Math.max(0,Math.round(wcy)));
    proxA[idx]=Math.exp(-distPolar[pcy*WSRC+pcx]/PROX_SCALE_PX);   // 1 at a polar zone, decaying outward
  }
  if(vectorCoastActive()){const vf=rasterizeVectorLandFrac(W,H,R);for(let i=0;i<N;i++)lf[i]=vf[i];}   // crisp fractional land
  const hf=haloBlur(lf,W,H,haloRadius());                                                             // halo land fraction
  const isLandA=new Uint8Array(N);for(let i=0;i<N;i++)isLandA[i]=lf[i]>=landThreshold(hf[i])?1:0;
  if(seawayBias>0){   // seaways: carve straits through thin land necks (same chokepoint stencil as mountain passes — land flanking on two sides, sea either side); extra sweeps push the channel through
    const isLnd=(x,y)=>x>=0&&x<W&&y>=0&&y<H&&isLandA[y*W+x]===1;
    carveChokepoints(W,H,isLnd,(x,y)=>{isLandA[y*W+x]=0;},Math.ceil(seawayBias*4),{minArc:2});   // require real land walls (>=2) so peninsulas aren't bisected
  }
  // surrounding-climate sample: for each tile, summarise nearby NON-white LAND tiles -> arid fraction & mean base temp
  const surrAridA=new Float32Array(N),surrTempA=new Float32Array(N);
  for(let ty=0;ty<H;ty++)for(let tx=0;tx<W;tx++){let bC=0,tSum=0,nn=0;
    for(let dy=-SURR_R;dy<=SURR_R;dy++)for(let dx=-SURR_R;dx<=SURR_R;dx++){const ny=ty+dy,nx=tx+dx;if(ny<0||ny>=H||nx<0||nx>=W)continue;
      const j=ny*W+nx;if(!isLandA[j]||wA[j]>=SURR_WHITE_TILE)continue;                                 // skip sea & snow/salt witnesses
      if(classGroup(kcA[j])===2)bC++; tSum+=KOPPEN_TEMP[kcA[j]]; nn++;}
    const idx=ty*W+tx; surrAridA[idx]=nn?bC/nn:0; surrTempA[idx]=nn?tSum/nn:KOPPEN_TEMP[kcA[idx]];
  }
  // relief-basis normalization: PER-VIEW land percentiles for BOTH height and roughness, so the blend only relocates relief, not its amount
  const hL=[],rL=[];for(let i=0;i<N;i++)if(isLandA[i]){hL.push(hA[i]);rL.push(rgh[i]);}
  const hSort=Float64Array.from(hL).sort(),rSort=Float64Array.from(rL).sort();
  const metricHill=new Float32Array(N),metricPeak=new Float32Array(N);
  for(let i=0;i<N;i++){const hp=pctl(hSort,hA[i]),rp=pctl(rSort,rgh[i]);metricHill[i]=(1-P.blendHill)*hp+P.blendHill*rp;metricPeak[i]=(1-P.blendPeak)*hp+P.blendPeak*rp;}
  // relief class per land tile from the thresholds (0 flat, 1 hills, 2 peak), then the mountain-pass / flat-spot post-passes
  const relief=new Uint8Array(N);for(let i=0;i<N;i++)relief[i]=!isLandA[i]?0:metricPeak[i]>P.peak?2:metricHill[i]>P.hill?1:0;
  if(mtnPass>0||flatSpots>0)reliefPass(relief,metricHill,metricPeak,W,H);
  const moistJit=new Float64Array(N);   // doubles: the old code passed the raw double straight to the classifier, and a float32 round-off could flip a tile sitting exactly on a threshold
  for(let ty=0;ty<H;ty++)for(let tx=0;tx<W;tx++)moistJit[ty*W+tx]=(vnoise(tx/MOIST_SCALE+worldSeed*0.7,ty/MOIST_SCALE+worldSeed*0.3)-0.5)*2*MOIST_JIT;   // SMOOTH low-frequency spatial moisture variation (~MOIST_SCALE-tile blobs); reseed shifts the field via worldSeed
  return {W,H,h:hA,rough:rgh,reliefHill:metricHill,reliefPeak:metricPeak,relief,land:isLandA,landFrac:lf,kc:kcA,r:rA,g:gA,b:bA,white:wA,playa:pA,lat:ltA,polar:proxA,surrArid:surrAridA,surrTemp:surrTempA,moistJit};
}
/* The framed region as the active game's tiles: sample, then hand the samples to the module. land / hills / peaks
   are counted from the samples (every game agrees on what water and relief are; the vocabulary is the module's). */
function classifyRegion(W,H){
  const S=sampleRegion(W,H),g=activeGame();
  const res=g.classify(S,{W,H,hex:hexMode,grid:g.grid});
  let land=0,hills=0,peaks=0;for(let i=0;i<W*H;i++){if(S.land[i]){land++;if(S.relief[i]===1)hills++;else if(S.relief[i]===2)peaks++;}}
  return {tiles:res.tiles,W,H,land,hills,peaks,samples:S};
}
/* Relief post-pass (mirrors the seaway/island-bias idea: a neighbourhood halo shifts a per-tile threshold).
   Mountain passes: a pass is a SADDLE — a local dip in a ridge crest with higher peaks flanking it — so we
   demote only peak tiles that sit below their peak-neighbours' crest (chokepoints), not every low peak in the
   range (which scattered them). The slider lowers the dip a saddle needs, so more passes open. Flat spots:
   scatter FLAT tiles through rough (hill/peak-dense) areas, preferring the lowest-relief tiles, so valleys /
   basins / plateaus appear. Densities are read from the ORIGINAL plots so demotions don't cascade. */
/* Chokepoint stencil, shared by mountain passes and seaways. A barrier tile is a NECK when, walking the 8-cell
   ring around it, the barrier occupies exactly two arcs with two gaps between them (4 transitions) — i.e. barrier
   on two opposite-ish sides, open on the other two. That's precisely a mountain saddle (peaks flanking, lower
   ground either side) or a sea strait (land flanking, water either side). Out-of-bounds counts as open/gap.
   Carving each neck and re-running propagates the passage across a thick barrier: this sweep's cuts become gaps
   that expose the next necks behind them. `sweeps` (from the slider) bounds how far a passage eats in. */
const RING8=[[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];   // 8-neighbourhood in circular order
/* hex 6-neighbourhood (odd-r), in circular order like RING8 so the arc-walk logic below works on either.
   A row shifted +0.5 east reaches columns x and x+1 on the rows above/below; an unshifted row reaches x-1 and x. */
const RING6_SHIFTED  =[[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,0]];   // NW,NE,E,SE,SW,W
const RING6_UNSHIFTED=[[-1,-1],[0,-1],[1,0],[0,1],[-1,1],[-1,0]]; // NW,NE,E,SE,SW,W
function gridRing(y,H){return hexMode?(hexShiftX(y,H)?RING6_SHIFTED:RING6_UNSHIFTED):RING8;}
/* A barrier tile is a NECK when its 8-ring splits into exactly two barrier arcs and two gaps (mountains/land
   flanking on two sides, open on the other two). We additionally require BOTH barrier arcs to span >=2 cells so
   an isolated single neighbour (noise in a scattered peak field) isn't mistaken for a flanking wall — that keeps
   demotions at real chokepoints, not every ragged peak. */
function isNeck(x,y,isBarrier,minArc,H){
  const ring=gridRing(y,H),n=ring.length;                                   // ring-length-agnostic: 8 square / 6 hex
  const m=new Array(n);for(let k=0;k<n;k++)m[k]=isBarrier(x+ring[k][0],y+ring[k][1])?1:0;
  let trans=0;for(let k=0;k<n;k++)if(m[k]!==m[(k+1)%n])trans++;
  if(trans!==4)return false;                                               // exactly 2 barrier arcs + 2 gaps
  if(minArc<=1)return true;
  let start=0;while(m[start]===m[(start+n-1)%n])start=(start+1)%n;          // rotate to a run boundary
  const best=[];let run=0,val=m[start];
  for(let q=0;q<n;q++){const idx=(start+q)%n;if(m[idx]===val)run++;else{if(val)best.push(run);run=1;val=m[idx];}}
  if(val)best.push(run);
  return best.length===2&&best[0]>=minArc&&best[1]>=minArc;                 // both flanking walls span >=minArc cells
}
function carveChokepoints(W,H,isBarrier,carve,sweeps,opts){
  opts=opts||{};const minArc=opts.minArc||1,ok=opts.ok||(()=>true);
  for(let s=0;s<sweeps;s++){
    const hits=[];
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){if(isBarrier(x,y)&&isNeck(x,y,isBarrier,minArc,H)&&ok(x,y))hits.push([x,y]);}
    if(!hits.length)break;                                                  // nothing left to open
    for(const h of hits)carve(h[0],h[1]);
  }
}
function reliefPass(relief,metricHill,metricPeak,W,H){   // relief: 0 flat, 1 hills, 2 peak (0 on water); mutated in place
  // 1) mountain passes: iteratively carve necks in the peak barrier (2 peak arcs + 2 gaps around the ring) that are
  //    also local LOWS (saddles, not summits), so passes open at crossable low points; each extra sweep pushes the
  //    passage deeper into the range (a carved neck becomes a gap that exposes the next saddle behind it).
  if(mtnPass>0){
    const isPk=(x,y)=>x>=0&&x<W&&y>=0&&y<H&&relief[y*W+x]===2;
    const need=0.005+(1-mtnPass)*0.08;   // slider sets how deep a saddle must sit below the local crest: low slider -> only the deepest chokepoints, high -> shallower ones too
    const saddle=(x,y)=>{let sum=0,cnt=0;for(const o of gridRing(y,H)){const nx=x+o[0],ny=y+o[1];if(nx>=0&&nx<W&&ny>=0&&ny<H&&relief[ny*W+nx]===2){sum+=metricPeak[ny*W+nx];cnt++;}}return cnt>=1&&metricPeak[y*W+x]<=sum/cnt-need;};
    carveChokepoints(W,H,isPk,(x,y)=>{relief[y*W+x]=1;},Math.ceil(mtnPass*5),{minArc:1,ok:saddle});   // up to 5 propagating sweeps
  }
  // 2) flat spots: scatter flats through rough (hill/peak-dense) areas, preferring the lowest-relief tiles
  if(flatSpots>0){
    const N=W*H,isRough=new Uint8Array(N);
    for(let i=0;i<N;i++)isRough[i]=relief[i]>=1?1:0;
    const RAD=2,dens=(x,y)=>{let s=0,n=0;for(let dy=-RAD;dy<=RAD;dy++)for(let dx=-RAD;dx<=RAD;dx++){const nx=x+dx,ny=y+dy;if(nx<0||nx>=W||ny<0||ny>=H)continue;s+=isRough[ny*W+nx];n++;}return n?s/n:0;};
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=y*W+x,r=relief[i];
      if(r!==1&&r!==2)continue;
      const rd=dens(x,y),thr=(r===2?P.peak:P.hill),rel=(r===2?metricPeak[i]:metricHill[i]);
      const flatness=1-clamp01((rel-thr)/0.25),p=flatSpots*rd*(0.35+0.65*flatness);   // likelier where rough, and where this tile is barely above its threshold
      if(fhash(x,y,90210)<p*0.7)relief[i]=0;
    }
  }
}
/* colour-only aridity proxy in [0,1] (0 humid -> 1 arid): bright + desaturated reads drier, green reads wetter.
   Fertile green vegetation (forest AND yellow-green cropland) reads wet so it dries last; the per-tile moisture
   dither a classifier adds (samples.moistJit, not this function) is what smooths the slider transition, so croplands stay wet. */
function colorAridity(hue,sat,val){
  const veg=(hue<170)?clamp01((hue-47)/18):0;              // green credit reaches FULL by hue ~65, so fertile yellow-green cropland reads as wet as forest (dries last, not punished)
  const d=0.57+0.55*(val-sat)-0.34*veg;                    // green vegetation pulled well toward wet; drier tiles keep their brightness spread. Smoothness comes from the per-tile moisture dither, not from spreading croplands.
  return clamp01(d);
}
/* ---------- river-edge helpers offered to game modules (TerraForm.util); the feature rules themselves live in the modules ---------- */
function fhash(x,y,s){let h=(Math.imul(x+1,374761393)^Math.imul(y+1,668265263)^Math.imul((s|0)+1,1274126177))>>>0;h=Math.imul(h^(h>>>13),1274126177)>>>0;h^=h>>>16;return (h>>>0)/4294967296;}   // deterministic uniform [0,1) per (tile,seed): preview and export agree
function tileRiverDischarge(rivers,x,y){   // max discharge (m3/s) on any of the tile's 4 edges, or -1 if the tile has no river edge
  if(!rivers)return -1;const nof=rivers.nof,wof=rivers.wof;let d=-1;
  const chk=(m,k)=>{const e=m&&m.get(k);if(e&&e.d>d)d=e.d;};
  chk(nof,(y-1)+','+x);chk(nof,y+','+x);chk(wof,y+','+(x-1));chk(wof,y+','+x);   // N, S, W, E edges of tile (gx,gy)
  return d;
}
/* True if a river BENDS around one of this tile's 4 corner vertices — a horizontal (nof) and a vertical (wof)
   river edge meet at that vertex. Used to turn a would-be oasis that sits diagonally outside a river's corner
   into a flood plain instead. Incident edges at vertex (vx,vy): nof (vy-1,vx),(vy-1,vx-1); wof (vy,vx-1),(vy-1,vx-1). */
function atRiverCorner(rivers,x,y,W,H){
  if(!rivers)return false;const nof=rivers.nof,wof=rivers.wof;
  const bend=(vx,vy)=>{
    const h=nof.has((vy-1)+','+vx)||nof.has((vy-1)+','+(vx-1));
    const v=wof.has(vy+','+(vx-1))||wof.has((vy-1)+','+(vx-1));
    return h&&v;
  };
  return bend(x,y)||bend(x+1,y)||bend(x,y+1)||bend(x+1,y+1);
}
/* ---------- coastline (windowed vector) ---------- */
let COAST_HI=null;   // hires land polygons (data/coast_hires.json); used in the windowed pass when loaded. Coarse land mask keeps the embedded reduced COAST.
function loadCoastHires(done){
  fetch('data/coast_hires.json').then(r=>{if(!r.ok)throw new Error('http '+r.status);return r.json();})
    .then(j=>{COAST_HI=(j&&j.polys)?j:null;done();})
    .catch(e=>{COAST_HI=null;console.warn('coast_hires.json not loaded ('+e+') -- windowed coast uses the reduced set. Serve over http(s).');done();});
}
/* ---------- vector tiles: OSM coast + HydroLAKES lakes (two LODs; built by scripts/build_coast_tiles.py) ----------
   data/<coast|lake>_tiles/index.json lists, per LOD, the cells that have a file ("tiles") and the cells the
   layer covers completely ("full": continent interior / mid-Superior); every other cell has none of the layer.
   lod "c" = 10 deg cells at ~300 m, used from the vector cutoff down to FINE_COAST_DEG; lod "f" = 2.5 deg
   cells at ~22 m below that. A tile is a gzipped stream of quantized delta-varint rings (format in the script
   header); it decodes into the same {b,r} polygons the NE sets use, so fillPolysWindowed / coastPathCull /
   lakePathCull / the island expander need no changes. While a view's tiles are still loading the other LOD
   stands in, then the NE hires set, so neither layer blinks out. */
const VT={coast:{dir:'coast_tiles',meta:null,cache:new Map()},lake:{dir:'lake_tiles',meta:null,cache:new Map()}};
const VT_MAX=600, FINE_COAST_DEG=8;
function loadTileIndex(layer,done){const V=VT[layer];
  fetch('data/'+V.dir+'/index.json').then(r=>{if(!r.ok)throw new Error('http '+r.status);return r.json();})
    .then(j=>{for(const k in j.lods){const L=j.lods[k];L.set=new Set(L.tiles);L.fullSet=new Set(L.full||L.land||[]);L.rects=new Map();}V.meta=j;done();})
    .catch(e=>{V.meta=null;console.warn(V.dir+'/index.json not loaded ('+e+') -- windowed '+layer+' uses the Natural Earth set.');done();});
}
function loadCoastTileIndex(done){loadTileIndex('coast',done);}
function loadLakeTileIndex(done){loadTileIndex('lake',done);}
/* one LOD for both layers so lake cut-outs match the coast they sit in */
function coastLod(){const m=VT.coast.meta||VT.lake.meta;if(!m)return null;const w=windowWidthDeg();if(w>coastThr)return null;const L=m.lods;return (w<=FINE_COAST_DEG&&L.f)?'f':L.c?'c':L.f?'f':null;}
/* cells of one LOD the rect touches, split into files to fetch and fully-covered cells (R may be wrap-shifted; cols clamp) */
function vtileIdsForView(layer,R,lod){
  const L=VT[layer].meta.lods[lod],D=L.deg,lonMin=lonOf(R.x),lonMax=lonOf(R.x+R.w),latMax=latOf(R.y),latMin=latOf(R.y+R.h);
  const c0=Math.max(0,Math.floor((lonMin+180)/D)),c1=Math.min(L.cols-1,Math.floor((lonMax+180)/D));
  const r0=Math.max(0,Math.floor((90-latMax)/D)),r1=Math.min(L.rows-1,Math.floor((90-latMin)/D));
  const fetchIds=[],full=[];for(let c=c0;c<=c1;c++)for(let r=r0;r<=r1;r++){const k=c+'_'+r;if(L.set.has(k))fetchIds.push(k);else if(L.fullSet.has(k))full.push(k);}
  return {fetch:fetchIds,full};
}
function coastTileIdsForView(R,lod){return vtileIdsForView('coast',R,lod);}
function fullRectPoly(layer,lod,id){const L=VT[layer].meta.lods[lod];let p=L.rects.get(id);if(p)return p;const [c,r]=id.split('_').map(Number),D=L.deg,e=D*0.002;   // tiny overlap so abutting fills union to full coverage (no anti-alias seam)
  const x0=-180+c*D-e,x1=x0+D+2*e,y1=90-r*D+e,y0=y1-D-2*e;p={b:[x0,y0,x1,y1],r:[[[x0,y0],[x1,y0],[x1,y1],[x0,y1]]]};L.rects.set(id,p);return p;}
async function decodeVTile(buf){
  let u8=new Uint8Array(buf);
  if(u8[0]===0x1f&&u8[1]===0x8b)u8=new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  if(u8[0]!==0x43||u8[1]!==0x53||u8[2]!==0x54||u8[3]!==0x31)throw new Error('not a CST1 tile');
  const dv=new DataView(u8.buffer,u8.byteOffset,u8.byteLength),lon0=dv.getFloat64(8,true),lat0=dv.getFloat64(16,true),q=dv.getFloat64(24,true);
  let p=32;const vi=()=>{let r=0,s=0,b;do{b=u8[p++];r+=(b&0x7f)*2**s;s+=7;}while(b&0x80);return r;},zz=u=>(u%2?-(u+1)/2:u/2);
  const n=vi(),polys=new Array(n);
  for(let i=0;i<n;i++){const nr=vi(),rings=new Array(nr);let bx0=Infinity,by0=Infinity,bx1=-Infinity,by1=-Infinity;
    for(let j=0;j<nr;j++){const nv=vi(),ring=new Array(nv);let x=0,y=0;
      for(let k=0;k<nv;k++){x+=zz(vi());y+=zz(vi());const lon=lon0+x*q,lat=lat0+y*q;ring[k]=[lon,lat];if(!j){if(lon<bx0)bx0=lon;if(lon>bx1)bx1=lon;if(lat<by0)by0=lat;if(lat>by1)by1=lat;}}
      rings[j]=ring;}
    polys[i]={b:[bx0,by0,bx1,by1],r:rings};}
  return {polys};
}
function ensureVTiles(layer,ids,lod){
  const V=VT[layer],L=V.meta.lods[lod],C=V.cache;
  for(const id of ids){const key=lod+'/'+id;if(C.has(key))continue;C.set(key,'load');
    fetch('data/'+V.dir+'/'+lod+'/'+id+'.'+(L.ext||'bin')).then(r=>{if(!r.ok)throw new Error('http '+r.status);return r.arrayBuffer();}).then(decodeVTile)
      .then(t=>{C.set(key,t);lastTiles=null;schedule();}).catch(e=>{C.set(key,'err');console.warn(layer+' tile '+key+' failed ('+e+')');});}
  if(C.size>VT_MAX){const keep=new Set(),RA=rotAABB();for(const k in V.meta.lods)for(const off of wrapOffsets(RA))for(const id of vtileIdsForView(layer,{x:RA.x-off,y:RA.y,w:RA.w,h:RA.h},k).fetch)keep.add(k+'/'+id);
    for(const [k,v] of C){if(C.size<=VT_MAX)break;if(v!=='load'&&!keep.has(k))C.delete(k);}}
}
/* warm the tiles the current view needs, both layers: the active LOD, plus the fine LOD a little before it switches on */
function warmCoastTiles(RA){
  if(windowWidthDeg()>coastThr)return;const lod=coastLod();if(!lod)return;
  for(const layer in VT){const V=VT[layer];if(!V.meta||!V.meta.lods[lod])continue;
    for(const off of wrapOffsets(RA)){const Rk={x:RA.x-off,y:RA.y,w:RA.w,h:RA.h};ensureVTiles(layer,vtileIdsForView(layer,Rk,lod).fetch,lod);
      if(lod==='c'&&V.meta.lods.f&&windowWidthDeg()<=FINE_COAST_DEG*1.5)ensureVTiles(layer,vtileIdsForView(layer,Rk,'f').fetch,'f');}}
}
/* the layer's polygons covering R from its tiles, or null when some needed tile isn't decoded yet (caller falls back) */
function vtilePolys(layer,R){
  const V=VT[layer];if(!V.meta)return null;const lod=coastLod();if(!lod)return null;
  for(const k of (lod==='f'?['f','c']:['c','f'])){const L=V.meta.lods[k];if(!L)continue;
    const need=vtileIdsForView(layer,R,k),out=[];let ok=true;
    for(const id of need.fetch){const t=V.cache.get(k+'/'+id);if(!t||t==='load'||t==='err'){ok=false;break;}for(const p of t.polys)out.push(p);}
    if(!ok)continue;for(const id of need.full)out.push(fullRectPoly(layer,k,id));return out;}
  return null;
}
function coastTilePolys(R){return vtilePolys('coast',R);}
let LAKES_HI=null;   // hires lakes (data/lakes_hires.json); used in the windowed pass when loaded. Coarse land mask keeps the embedded reduced LAKES.
function loadLakesHires(done){
  fetch('data/lakes_hires.json').then(r=>{if(!r.ok)throw new Error('http '+r.status);return r.json();})
    .then(j=>{LAKES_HI=(j&&j.polys)?j:null;landMask=buildLandMask(LAKES_HI);landAlphaCanvas=buildLandAlpha(LAKES_HI);done();})
    .catch(e=>{LAKES_HI=null;console.warn('lakes_hires.json not loaded ('+e+') -- windowed lakes use the reduced set. Serve over http(s).');done();});
}
function coastPathCull(R){const lonMin=lonOf(R.x),lonMax=lonOf(R.x+R.w),latMax=latOf(R.y),latMin=latOf(R.y+R.h);const vis=[];for(const p of (coastTilePolys(R)||(COAST_HI||COAST).polys)){const b=p.b;if(b[2]<lonMin||b[0]>lonMax||b[3]<latMin||b[1]>latMax)continue;vis.push(p);}return {vis};}   // OSM tiles when loaded, else the NE set
function lakePathCull(R){const lonMin=lonOf(R.x),lonMax=lonOf(R.x+R.w),latMax=latOf(R.y),latMin=latOf(R.y+R.h);const vis=[];for(const p of (vtilePolys('lake',R)||(LAKES_HI||LAKES).polys)){const b=p.b;if(b[2]<lonMin||b[0]>lonMax||b[3]<latMin||b[1]>latMax)continue;vis.push(p);}return {vis};}
function waterColorFor(m){return m==='climate'?'rgb(255,255,255)':m==='roughness'?'rgb(0,0,0)':m==='elevation'?'rgb(24,74,120)':'rgb(20,66,104)';}
let islandExpand=0, expandSteep=1.0, expandMaxMult=1.5, expLmin=0, expLmax=-1, expAreaCap=Infinity;
/* scaled set = islands under 10% of the view area. Target LINEAR extent is a monotonic ramp from
   half-max·mult (smallest) up to max·mult (largest); the max multiplier caps the largest island's
   growth, steepness warps the ramp (1 = linear). Nothing shrinks. */
function updateExpandBounds(vis,R){
  const viewArea=(R.w/WSRC*360)*(R.h/HSRC*180); expAreaCap=0.10*viewArea;
  let mn=Infinity,mx=-Infinity;
  for(const p of vis){const A=(p.b[2]-p.b[0])*(p.b[3]-p.b[1]);if(A>=expAreaCap)continue;const L=Math.max(1e-9,Math.max(p.b[2]-p.b[0],p.b[3]-p.b[1]));if(L<mn)mn=L;if(L>mx)mx=L;}
  if(mx<=mn){expLmin=0;expLmax=-1;return;}          // <2 scaled islands -> disabled
  expLmin=mn;expLmax=mx;
}
function expandFactor(b){
  if(islandExpand<=0||expLmax<=expLmin)return 1;
  const A=(b[2]-b[0])*(b[3]-b[1]); if(A>=expAreaCap)return 1;                    // >=10% of view: never scaled
  const L=Math.max(1e-9,Math.max(b[2]-b[0],b[3]-b[1]));
  const p=Math.min(1,Math.max(0,(L-expLmin)/(expLmax-expLmin))), q=Math.pow(p,expandSteep);
  const targetL=Math.max(L, expLmax*expandMaxMult*(0.5+0.5*q));                  // half-max·mult -> max·mult, no shrink
  return 1+islandExpand*(targetL/L-1);
}
/* fill per-polygon so overlapping polygons UNION (OR), not XOR; holes still cut within each polygon */
/* R is the FRAME rect, shifted by this world copy's wrap offset (callers cull against the AABB separately).
   Rotated, each vertex goes world px -> + that offset -> frame, and the window uses the true frame rect, so
   the output is frame-space and is drawn/indexed 1:1; at rot 0 both rects coincide and this is a direct map. */
function fillPolysWindowed(g,vis,R,W,H,expand){
  if(expand&&islandExpand>0)updateExpandBounds(vis,R);
  const a=rotRad(),rc=Math.cos(a),rs=Math.sin(a),vx=view.cx,vy=view.cy,RX=a?view.cx-view.spanX/2:R.x,ow=RX-R.x;
  for(const p of vis){
    const f=expand?expandFactor(p.b):1,cx=(p.b[0]+p.b[2])/2,cy=(p.b[1]+p.b[3])/2;
    g.beginPath();
    for(const ring of p.r){
      for(let i=0;i<ring.length;i++){
        let lon=ring[i][0],lat=ring[i][1];
        if(f!==1){lon=cx+(lon-cx)*f;lat=cy+(lat-cy)*f;}
        let px=((lon+180)/360*WSRC)+ow,py=(90-lat)/180*HSRC;
        if(a){const dx=px-vx,dy=py-vy;px=vx+rc*dx+rs*dy;py=vy-rs*dx+rc*dy;}
        const x=(px-RX)/R.w*W,y=(py-R.y)/R.h*H;
        i?g.lineTo(x,y):g.moveTo(x,y);
      }
      g.closePath();
    }
    g.fill('evenodd');
  }
}
const aCanvas=document.createElement('canvas'),actx=aCanvas.getContext('2d');
const wcCanvas=document.createElement('canvas'),wctx=wcCanvas.getContext('2d');
/* true-res satellite tiles: data/sat_tiles/<col>_<row>.png (10 deg cells) drawn OVER the 2048 base in the
   colour view when zoomed past coastThr. External PNGs, fetched on demand and cached; the water/background
   colour logic is unchanged (the coastline water pass paints over the tiles' ocean afterwards). */
let STILE_META=null; const STILE=new Map();
let _jeF=null,_jeCanvas=null,HYPS_LUT=null;   // JIT elevation colouring: view cache + 256-entry hypsometric LUT
const RGH_REF=0.14;   // global 99.9th-pct gradient normalizer (matches the former pre-baked roughness tiles)
let _jrF=null,_jrHalo=null,_jrCanvas=null,ROUGH_LUT=null;   // JIT roughness: view cache + 256-entry heat LUT (gamma baked into the index)
function loadSatIndex(done){
  fetch('data/sat_tiles/index.json').then(r=>{if(!r.ok)throw new Error('http '+r.status);return r.json();})
    .then(j=>{STILE_META=j;done();})
    .catch(e=>{STILE_META=null;console.warn('sat_tiles/index.json not loaded ('+e+') -- colour view uses the 2048 base. Serve over http(s).');done();});
}
function satTilesActive(){return mode==='color'&&!!STILE_META&&windowWidthDeg()<=coastThr;}
function satTileIdsForView(R){
  const D=STILE_META.deg,lonMin=lonOf(R.x),lonMax=lonOf(R.x+R.w),latMax=latOf(R.y),latMin=latOf(R.y+R.h);
  const c0=Math.max(0,Math.floor((lonMin+180)/D)),c1=Math.min(STILE_META.cols-1,Math.floor((lonMax+180)/D));
  const r0=Math.max(0,Math.floor((90-latMax)/D)),r1=Math.min(STILE_META.rows-1,Math.floor((90-latMin)/D));
  const ids=[];for(let c=c0;c<=c1;c++)for(let r=r0;r<=r1;r++)ids.push(c+'_'+r);return ids;
}
function ensureSatTiles(ids){
  for(const id of ids){ if(STILE.has(id))continue; STILE.set(id,'load');
    const img=new Image();
    img.onload=()=>{STILE.set(id,img);_fineCKey=null;render();};
    img.onerror=()=>{STILE.set(id,'err');};
    img.src='data/sat_tiles/'+id+'.'+(STILE_META.ext||'png');
  }
}
function drawSatTile(g,img,id,R,W,H){
  const q=id.split('_'),c=+q[0],r=+q[1],D=STILE_META.deg;W=W||cv.width;H=H||cv.height;   // W/H are the (possibly overscanned) dest extent R maps onto, not necessarily the canvas
  const sx=(c*D)/360*WSRC, sy=(r*D)/180*HSRC;                          // tile top-left (lon=c*D-180, lat=90-r*D) in source px
  const dx=(sx-R.x)/R.w*W, dy=(sy-R.y)/R.h*H;
  const dw=(D/360*WSRC)/R.w*W, dh=(D/180*HSRC)/R.h*H;
  g.drawImage(img,dx,dy,dw,dh);
}

// --- JIT elevation colouring: hypsometric tint computed on the fly from the 16-bit height tiles (renderer owns the colour mapping) ---
function buildHypsLUT(){HYPS_LUT=[new Uint8Array(256),new Uint8Array(256),new Uint8Array(256)];for(let k=0;k<256;k++){const c=rampLerp(HYPS_LAND,k/255);HYPS_LUT[0][k]=c[0];HYPS_LUT[1][k]=c[1];HYPS_LUT[2][k]=c[2];}}
function jitElevCanvas(R){
  const F=buildFineHeightForView(R); if(!F) return null;
  if(F===_jeF&&_jeCanvas) return _jeCanvas;   // one colouring per fine buffer; the buffer itself decides when the view has outrun it
  if(!HYPS_LUT) buildHypsLUT();
  const hd=F.data,fw=F.fw,fh=F.fh;
  const cvs=document.createElement('canvas');cvs.width=fw;cvs.height=fh;const c2=cvs.getContext('2d'),img=c2.createImageData(fw,fh),o=img.data,LR=HYPS_LUT[0],LG=HYPS_LUT[1],LB=HYPS_LUT[2];
  for(let i=0;i<fw*fh;i++){let idx=(hd[i]*255)|0;if(idx>255)idx=255;const p=i*4;o[p]=LR[idx];o[p+1]=LG[idx];o[p+2]=LB[idx];o[p+3]=255;}
  c2.putImageData(img,0,0);_jeF=F;_jeCanvas=cvs;return cvs;
}

// --- JIT roughness: fine-scale ruggedness computed on the fly from the grayscale height tiles (no pre-baked image files) ---
function buildRoughLUT(){ROUGH_LUT=[new Uint8Array(256),new Uint8Array(256),new Uint8Array(256)];for(let k=0;k<256;k++){const c=heatColor(Math.pow(k/255,0.7));ROUGH_LUT[0][k]=c[0];ROUGH_LUT[1][k]=c[1];ROUGH_LUT[2][k]=c[2];}}   // gamma folded into index -> colour is a table lookup
function jitRoughCanvas(R){
  const F=buildFineHeightForView(R); if(!F) return null;                             // needs the fine height buffer (zoomed in, tiles loaded, not wrapped)
  if(F===_jrF&&_jrHalo===roughHalo&&_jrCanvas) return _jrCanvas;
  if(!ROUGH_LUT) buildRoughLUT();
  const hd=F.data,fw=F.fw,fh=F.fh,g=new Float32Array(fw*fh),inv=1/RGH_REF;
  for(let y=0;y<fh;y++)for(let x=0;x<fw;x++){const i=y*fw+x,xr=x<fw-1?i+1:i,xl=x>0?i-1:i,yd=y<fh-1?i+fw:i,yu=y>0?i-fw:i;const gx=hd[xr]-hd[xl],gy=hd[yd]-hd[yu];let v=Math.sqrt(gx*gx+gy*gy)*inv;g[i]=v>1?1:v;}
  const haloR=Math.round(7*roughHalo); if(haloR>=1)smoothField(g,fw,fh,haloR);        // same halo the slider drives on the base
  const cvs=document.createElement('canvas');cvs.width=fw;cvs.height=fh;const c2=cvs.getContext('2d'),img=c2.createImageData(fw,fh),o=img.data,LR=ROUGH_LUT[0],LG=ROUGH_LUT[1],LB=ROUGH_LUT[2];
  for(let i=0;i<fw*fh;i++){let idx=(g[i]*255)|0;if(idx>255)idx=255;const p=i*4;o[p]=LR[idx];o[p+1]=LG[idx];o[p+2]=LB[idx];o[p+3]=255;}
  c2.putImageData(img,0,0);_jrF=F;_jrHalo=roughHalo;_jrCanvas=cvs;return cvs;
}
let HTILE_META=null, HTILE_SET=null; const HTILE=new Map();   // grayscale raw-height tiles: fine elevation for the Civ classification when zoomed in. HTILE_SET = Set of existing "col_row" ids (null -> dense/legacy, every tile assumed present)
let _fineH=null;   // {data,rough,fw,fh,R,vw,vh,cx,cy,rot}: FRAME-space buffer covering rect R (the view padded by FINE_PAD each side), built with the view centre at (cx,cy)
const FINE_PAD=0.25;   // padding each side as a fraction of the view: a drag reuses the buffer until the view leaves it, instead of rebuilding (and jumping) at every whole base px
/* Frame-space shift of a fine buffer's content for the CURRENT view centre. The frame rotates about the view centre,
   so moving the centre by d moves every frame point by d - Rot(d): exactly 0 north-up, small but non-zero rotated. */
function fineFrameShift(F){if(!F.rot)return [0,0];const dx=view.cx-F.cx,dy=view.cy-F.cy,a=rotRad(),ca=Math.cos(a),sa=Math.sin(a);return [dx-(ca*dx+sa*dy),dy-(-sa*dx+ca*dy)];}
function fineSameZoom(F,R){return !!F&&F.rot===(view.rot||0)&&Math.abs(F.vw-R.w)<1e-6&&Math.abs(F.vh-R.h)<1e-6;}
function fineCovers(F,R){if(!fineSameZoom(F,R))return false;const [dx,dy]=fineFrameShift(F),B=F.R;return R.x-dx>=B.x&&R.x+R.w-dx<=B.x+B.w&&R.y-dy>=B.y&&R.y+R.h-dy<=B.y+B.h;}
/* Paint a per-fine-buffer canvas onto the view: the buffer's rect is placed sub-pixel exactly against the current frame
   rect, so panning glides instead of stepping by whole base px; anything the buffer does not cover shows the base underneath */
function drawFineBuf(g,cvs,F,R){const [dx,dy]=fineFrameShift(F),B=F.R;g.imageSmoothingEnabled=true;g.drawImage(cvs,(B.x+dx-R.x)/R.w*cv.width,(B.y+dy-R.y)/R.h*cv.height,B.w/R.w*cv.width,B.h/R.h*cv.height);g.imageSmoothingEnabled=false;}
let _fineKopKey=null,_fineKop=null;
let _fineCKey=null,_fineC=null;
function loadHgtIndex(done){
  fetch('data/hgt_tiles/index.json').then(r=>{if(!r.ok)throw new Error('http '+r.status);return r.json();})
    .then(j=>{HTILE_META=j;HTILE_SET=j.tiles?new Set(j.tiles):null;done();})
    .catch(e=>{HTILE_META=null;console.warn('hgt_tiles/index.json not loaded ('+e+') -- Civ classification uses the base elevation. Serve over http(s).');done();});
}
function hgtTileIdsForView(R){
  const D=HTILE_META.deg,lonMin=lonOf(R.x),lonMax=lonOf(R.x+R.w),latMax=latOf(R.y),latMin=latOf(R.y+R.h);
  const c0=Math.max(0,Math.floor((lonMin+180)/D)),c1=Math.min(HTILE_META.cols-1,Math.floor((lonMax+180)/D));
  const r0=Math.max(0,Math.floor((90-latMax)/D)),r1=Math.min(HTILE_META.rows-1,Math.floor((90-latMin)/D));
  const ids=[];for(let c=c0;c<=c1;c++)for(let r=r0;r<=r1;r++){const k=c+'_'+r;if(!HTILE_SET||HTILE_SET.has(k))ids.push(k);}return ids;   // skip dropped ocean tiles (not in manifest)
}
function ensureHgtTiles(ids){
  for(const id of ids){ if(HTILE.has(id))continue; HTILE.set(id,'load');
    const img=new Image();
    img.onload=()=>{HTILE.set(id,img);schedule();};   // schedule, not render: hundreds can land per second, one redraw per frame is plenty. _fineH is only ever a COMPLETE buffer, so a new tile never invalidates it
    img.onerror=()=>{HTILE.set(id,'err');};
    img.src='data/hgt_tiles/'+id+'.'+(HTILE_META.ext||'png');
  }
  if(HTILE.size>HTILE_MAX){const keep=new Set(hgtTileIdsForView(fineTileRect()));for(const id of ids)keep.add(id);for(const [k,v] of HTILE){if(HTILE.size<=HTILE_MAX)break;if(v!=='load'&&!keep.has(k))HTILE.delete(k);}}   // the wider activation can sweep in hundreds of tiles per view: drop ones the current view doesn't use
}
const HTILE_MAX=2500;   // > the tiles FINE_MAX_CELLS can ever ask for, so the cache holds a whole padded view plus recent neighbours
/* Canvas transform taking WORLD source px straight to a per-view buffer that covers the frame rect R
   at W x H, i.e. world -> frame (rotate by -rot about the view centre) -> buffer. Every per-view window
   buffer is FRAME space, so classification and drawing index it with frame coords unchanged. */
function setFrameTransform(g,R,W,H,a){
  const kx=W/R.w,ky=H/R.h,ca=Math.cos(a),sa=Math.sin(a),vx=view.cx,vy=view.cy;
  g.setTransform(kx*ca,-ky*sa,kx*sa,ky*ca,kx*(vx-ca*vx-sa*vy-R.x),ky*(vy+sa*vx-ca*vy-R.y));
}
// assemble a fine-scale height buffer for the current view from the height tiles (null -> fall back to the base grid)
function buildFineHeightForView(R){
  if(!fineHgtActive()) return null;
  const RA=rotAABB();
  if(RA.x<0||RA.x+RA.w>WSRC) return null;                           // antimeridian-crossing SOURCE coverage (rotated corners included) -> base grid
  if(fineCovers(_fineH,R)) return _fineH;                          // same zoom + rotation and the (shifted) view still sits inside the padded buffer: reuse, no rebuild
  const px=Math.ceil(R.w*FINE_PAD),py=Math.ceil(R.h*FINE_PAD);
  const Rk={x:Math.floor(R.x)-px,y:Math.floor(R.y)-py,w:Math.ceil(R.w)+2*px+1,h:Math.ceil(R.h)+2*py+1};   // FRAME rect the buffer covers: the view plus a ring, snapped outward to whole base px
  const fullW=HTILE_META.cols*HTILE_META.tileW, fullH=HTILE_META.rows*HTILE_META.tileH;
  const CAP=Math.min(4096,Math.max(2400,Math.ceil(cv.width*(1+2*FINE_PAD))));   // keeps >= 1 fine px per screen px across the view at the activation zoom (the padded buffer is 1+2*FINE_PAD views wide)
  let fw=Math.round(Rk.w/WSRC*fullW), fh=Math.round(Rk.h/HSRC*fullH);
  if(fw>CAP){fh=Math.max(2,Math.round(fh*CAP/fw));fw=CAP;} if(fh>CAP){fw=Math.max(2,Math.round(fw*CAP/fh));fh=CAP;}
  fw=Math.max(2,fw);fh=Math.max(2,fh);
  const ids=hgtTileIdsForView(fineTileRect()); ensureHgtTiles(ids);   // AABB of the padded frame rect (a rotated ring reaches further than px/py along either axis; over-including only prefetches)
  for(const id of ids){const t=HTILE.get(id);if(!t||t==='load'||t==='err')return fineSameZoom(_fineH,R)?_fineH:null;}   // not fully loaded yet -> keep the previous buffer at this zoom (partial coverage beats a flash back to the base grid), else base grid this pass. Checked before allocating/drawing, so a loading storm costs nothing here
  const cvs=document.createElement('canvas');cvs.width=fw;cvs.height=fh;const g=cvs.getContext('2d');g.imageSmoothingEnabled=false;
  const a=rotRad(),ov=a?Rk.w/fw:0;                                 // FRAME-SPACE buffer: one canvas transform maps world px -> frame px -> buffer px, so the tiles land rotated. ov = 1 buffer px of overlap, so rotated tile edges leave no seam
  if(a)setFrameTransform(g,Rk,fw,fh,a);
  for(const id of ids){const t=HTILE.get(id);{
    const q=id.split('_'),c=+q[0],rr=+q[1],D=HTILE_META.deg;
    const sx=(c*D)/360*WSRC, sy=(rr*D)/180*HSRC;
    if(a){g.drawImage(t,sx,sy,(D/360*WSRC)+ov,(D/180*HSRC)+ov);}
    else{const dx=(sx-Rk.x)/Rk.w*fw, dy=(sy-Rk.y)/Rk.h*fh, dw=(D/360*WSRC)/Rk.w*fw, dh=(D/180*HSRC)/Rk.h*fh;g.drawImage(t,dx,dy,dw,dh);}
  }}
  if(a)g.setTransform(1,0,0,1,0,0);
  const px4=g.getImageData(0,0,fw,fh).data, data=new Float32Array(fw*fh);
  for(let i=0;i<fw*fh;i++)data[i]=(px4[i*4]*256+px4[i*4+1])/65535;   // 16-bit two-channel (R=hi, G=lo) -> encoded height
  const rough=new Float32Array(fw*fh);                             // fine roughness = gradient magnitude of the fine height, so classification ruggedness is fine too (not the 4096 base)
  for(let y=0;y<fh;y++)for(let x=0;x<fw;x++){const i=y*fw+x,xr=x<fw-1?i+1:i,xl=x>0?i-1:i,yd=y<fh-1?i+fw:i,yu=y>0?i-fw:i;const gx=data[xr]-data[xl],gy=data[yd]-data[yu];rough[i]=Math.sqrt(gx*gx+gy*gy);}
  _fineH={data,rough,fw,fh,R:Rk,vw:R.w,vh:R.h,cx:view.cx,cy:view.cy,rot:view.rot||0};return _fineH;
}
// rasterize the in-view Köppen VECTOR zones into a class-indexed buffer (red channel = class), so the Civ classification samples crisp Köppen at zoom-in instead of the coarse raster
function buildFineKoppenForView(R,W,H){
  if(!KTILE_INDEX||windowWidthDeg()>coastThr) return null;
  const RA=rotAABB();
  if(RA.x<0||RA.x+RA.w>WSRC) return null;                           // antimeridian-crossing SOURCE coverage (rotated corners included) -> raster koppenArr
  const ids=tileIdsForView(RA); ensureTiles(ids);
  for(const k of ids){const t=KTILE.get(k); if(t==='load'||t===undefined) return null;}   // not fully loaded -> raster this pass
  const key=Math.round(R.x)+','+Math.round(R.y)+','+Math.round(R.w)+','+Math.round(R.h)+','+(view.rot||0)+','+W+'x'+H;
  if(key===_fineKopKey&&_fineKop) return _fineKop;
  const fw=Math.min(2000,Math.max(2,W*6)), fh=Math.min(2000,Math.max(2,H*6));   // ~6 px per Civ tile -> stable dominant-class histogram
  const cvs=document.createElement('canvas');cvs.width=fw;cvs.height=fh;const g=cvs.getContext('2d');
  g.fillStyle='#000';g.fillRect(0,0,fw,fh);                        // background = class 0 (ocean/none)
  const {vis}=koppenZoneCull(RA);
  const a=rotRad(),ca=Math.cos(a),sa=Math.sin(a),vx=view.cx,vy=view.cy;   // VECTOR source: project each vertex world -> FRAME, so the buffer is frame-space with no rotated resampling
  for(const q of vis){ g.fillStyle='rgb('+(q.v&255)+',0,0)'; g.beginPath();
    for(const ring of q.r){for(let i=0;i<ring.length;i++){const lon=ring[i][0],lat=ring[i][1];let px=(lon+180)/360*WSRC,py=(90-lat)/180*HSRC;
      if(a){const dx=px-vx,dy=py-vy;px=vx+ca*dx+sa*dy;py=vy-sa*dx+ca*dy;}
      const x=(px-R.x)/R.w*fw,y=(py-R.y)/R.h*fh;i?g.lineTo(x,y):g.moveTo(x,y);}g.closePath();}
    g.fill('evenodd'); }
  const px=g.getImageData(0,0,fw,fh).data, data=new Uint8Array(fw*fh);
  for(let i=0;i<fw*fh;i++)data[i]=px[i*4];                         // red channel = class index
  _fineKopKey=key;_fineKop={data,fw,fh};return _fineKop;
}
// assemble a high-res satellite-colour buffer for the current view from the sat tiles, so the colour heuristics (aridity, brightness, redness, white-cover) run on crisp colour instead of the 2048 base
function buildFineColorForView(R){
  if(!STILE_META||windowWidthDeg()>coastThr) return null;
  const RA=rotAABB();
  if(RA.x<0||RA.x+RA.w>WSRC) return null;                           // antimeridian-crossing SOURCE coverage (rotated corners included) -> raster colorArr
  const key=Math.round(R.x)+','+Math.round(R.y)+','+Math.round(R.w)+','+Math.round(R.h)+','+(view.rot||0);
  if(key===_fineCKey&&_fineC) return _fineC;
  const fullW=STILE_META.cols*STILE_META.tileW, fullH=STILE_META.rows*STILE_META.tileH, CAP=2000;
  let fw=Math.round(R.w/WSRC*fullW), fh=Math.round(R.h/HSRC*fullH);
  if(fw>CAP){fh=Math.max(2,Math.round(fh*CAP/fw));fw=CAP;} if(fh>CAP){fw=Math.max(2,Math.round(fw*CAP/fh));fh=CAP;}
  fw=Math.max(2,fw);fh=Math.max(2,fh);
  const ids=satTileIdsForView(RA); ensureSatTiles(ids);            // AABB: a rotated frame reaches tiles outside its own rect
  const cvs=document.createElement('canvas');cvs.width=fw;cvs.height=fh;const g=cvs.getContext('2d');g.imageSmoothingEnabled=true;
  const a=rotRad(),ov=a?R.w/fw:0;                                  // FRAME-SPACE buffer (see setFrameTransform); ov = 1 buffer px of overlap so rotated tile edges leave no seam
  if(a)setFrameTransform(g,R,fw,fh,a);
  let drew=0;
  for(const id of ids){const t=STILE.get(id);if(t&&t!=='load'&&t!=='err'){
    const q=id.split('_'),c=+q[0],rr=+q[1],D=STILE_META.deg;
    const sx=(c*D)/360*WSRC, sy=(rr*D)/180*HSRC;
    if(a){g.drawImage(t,sx,sy,(D/360*WSRC)+ov,(D/180*HSRC)+ov);}
    else{const dx=(sx-R.x)/R.w*fw, dy=(sy-R.y)/R.h*fh, dw=(D/360*WSRC)/R.w*fw, dh=(D/180*HSRC)/R.h*fh;g.drawImage(t,dx,dy,dw,dh);}
    drew++;
  }}
  if(a)g.setTransform(1,0,0,1,0,0);
  if(drew<ids.length) return null;                                 // not fully loaded yet -> raster colorArr this pass
  const data=g.getImageData(0,0,fw,fh).data;                       // RGBA, high-res satellite colour
  _fineCKey=key;_fineC={data,fw,fh};return _fineC;
}
function padRect(R,p){return {x:R.x-p,y:R.y-p,w:R.w+2*p,h:R.h+2*p};}   // grows a rect about its own centre (the rotated-draw composition assumes the source rect stays centred on the view)
function drawLayerWithCoast(R){
  const a=rotRad(), RA=a?padRect(rotAABB(),R.w/cv.width*2):R;            // world AABB of the rotated frame (+2px slack so the corners are not exactly tangent); culls, tile ids and global-raster source rects must use it or the rotated corners come up empty
  const CW=cv.width*(RA.w/R.w), CH=cv.height*(RA.h/R.h);                 // overscanned canvas at the same px scale; exactly the canvas when rot===0
  const offs=wrapOffsets(RA), dw=WSRC/RA.w*CW, up=(R.w/cv.width)<1;
  const koppenVec=(mode==='climate'&&vectorKoppenActive());
  // ---- land interior colouring, drawn once per wrapped world copy (offs=[0] unless the view straddles +/-180) ----
  if(koppenVec){ctx.fillStyle=KOPPEN_CSS[0];ctx.fillRect(0,0,cv.width,cv.height);   // ocean/none background, once
    for(const off of offs){const Rk={x:R.x-off,y:R.y,w:R.w,h:R.h}, RAk={x:RA.x-off,y:RA.y,w:RA.w,h:RA.h};
      fillKoppenZonesWindowed(ctx,koppenZoneCull(RAk).vis,Rk,cv.width,cv.height);}   // frame-space fill: 1:1, never inside the rotated transform
  }else{
    if(a){ctx.save();ctx.translate(cv.width/2,cv.height/2);ctx.rotate(-a);ctx.translate(-CW/2,-CH/2);}   // global rasters only: overscan covers the rotated corners, the canvas clips the rest
    for(const off of offs){
      const RAk={x:RA.x-off,y:RA.y,w:RA.w,h:RA.h}, destX=(off-RA.x)/RA.w*CW;
      ctx.imageSmoothingEnabled=(up&&mode!=='climate');ctx.drawImage(LAYERS[mode],0,RA.y,WSRC,RA.h,destX,0,dw,CH);ctx.imageSmoothingEnabled=false;   // full-width copy positioned by destX
      if(satTilesActive()){ctx.imageSmoothingEnabled=true;const ids=satTileIdsForView(RAk);ensureSatTiles(ids);for(const id of ids){const t=STILE.get(id);if(t&&t!=='load'&&t!=='err')drawSatTile(ctx,t,id,RAk,CW,CH);}ctx.imageSmoothingEnabled=false;}
    }
    if(a)ctx.restore();
  }
  if(mode==='roughness'){const jr=jitRoughCanvas(R);if(jr)drawFineBuf(ctx,jr,_jrF,R);}   // fine-scale roughness, single buffer (no tile seams), placed sub-pixel exactly
  if(mode==='elevation'){const je=jitElevCanvas(R);if(je)drawFineBuf(ctx,je,_jeF,R);}   // fine-scale hypsometric tint, single buffer
  // ---- land-alpha mask, accumulated across copies ----
  if(aCanvas.width!==cv.width||aCanvas.height!==cv.height){aCanvas.width=cv.width;aCanvas.height=cv.height;wcCanvas.width=cv.width;wcCanvas.height=cv.height;}
  actx.imageSmoothingEnabled=false;actx.clearRect(0,0,cv.width,cv.height);
  const vec=vectorCoastActive();
  if(vec){for(const off of offs){const Rk={x:R.x-off,y:R.y,w:R.w,h:R.h}, RAk={x:RA.x-off,y:RA.y,w:RA.w,h:RA.h};   // frame-space fill: 1:1, never inside the rotated transform
    actx.fillStyle='#fff';fillPolysWindowed(actx,coastPathCull(RAk).vis,Rk,cv.width,cv.height,true);actx.globalCompositeOperation='destination-out';fillPolysWindowed(actx,lakePathCull(RAk).vis,Rk,cv.width,cv.height,false);actx.globalCompositeOperation='source-over';}
  }else{
    if(a){actx.save();actx.translate(cv.width/2,cv.height/2);actx.rotate(-a);actx.translate(-CW/2,-CH/2);}   // global raster mask: same overscan as the layer above, so mask and colour stay registered
    for(const off of offs)actx.drawImage(landAlphaCanvas,0,RA.y,WSRC,RA.h,(off-RA.x)/RA.w*CW,0,dw,CH);
    if(a)actx.restore();
  }
  // ---- water (once), only where the coastline says water ----
  wctx.globalCompositeOperation='source-over';wctx.clearRect(0,0,cv.width,cv.height);wctx.fillStyle=waterColorFor(mode);wctx.fillRect(0,0,cv.width,cv.height);
  wctx.globalCompositeOperation='destination-out';wctx.drawImage(aCanvas,0,0);wctx.globalCompositeOperation='source-over';
  ctx.drawImage(wcCanvas,0,0);
}
function rasterizeVectorLandFrac(W,H,R){
  const ss=hexMode?4:3,sw=W*ss,sh=H*ss;   // hex: ss=4 so the half-tile row shift is a whole number of subpixels (2)
  if(lgCanvas.width!==sw||lgCanvas.height!==sh){lgCanvas.width=sw;lgCanvas.height=sh;}
  lgctx.fillStyle='#000';lgctx.fillRect(0,0,sw,sh);
  const RA=rotAABB();                                               // cull against the SOURCE coverage (rotated corners included); the mask itself comes out FRAME-space, so the tile loop below reads it 1:1
  for(const off of wrapOffsets(RA)){const Rk={x:R.x-off,y:R.y,w:R.w,h:R.h},Rc={x:RA.x-off,y:RA.y,w:RA.w,h:RA.h};
    lgctx.fillStyle='#fff';fillPolysWindowed(lgctx,coastPathCull(Rc).vis,Rk,sw,sh,true);   // land (+expander, union)
    lgctx.fillStyle='#000';fillPolysWindowed(lgctx,lakePathCull(Rc).vis,Rk,sw,sh,false);   // lakes -> water
  }
  const d=lgctx.getImageData(0,0,sw,sh).data,frac=new Float32Array(W*H);
  for(let ty=0;ty<H;ty++){const ox=Math.round(hexShiftX(ty,H)*ss);for(let tx=0;tx<W;tx++){let s=0;for(let j=0;j<ss;j++)for(let i=0;i<ss;i++){if(d[((ty*ss+j)*sw+Math.min(sw-1,tx*ss+i+ox))*4]>127)s++;}frac[ty*W+tx]=s/(ss*ss);}}   // shifted rows read half a tile east (clamped at the frame edge; vector regime never wraps)
  return frac;
}

/* ---------- rendering ---------- */
function render(){
  ctx.imageSmoothingEnabled=false;ctx.clearRect(0,0,cv.width,cv.height);const R=srcRect(),RA=rotAABB();
  if(mode==='roughness')ensureRough();
  if(fineHgtActive()&&RA.x>=0&&RA.x+RA.w<=WSRC)ensureHgtTiles(hgtTileIdsForView(fineTileRect()));   // warm the fine-height cache (padded ring included, so the next buffer rebuild finds its tiles loaded; AABB: rotated corners too)
  if(KTILE_INDEX&&windowWidthDeg()<=coastThr&&RA.x>=0&&RA.x+RA.w<=WSRC)ensureTiles(tileIdsForView(RA));   // warm the koppen vector tiles for classification (any mode)
  if(STILE_META&&windowWidthDeg()<=coastThr&&RA.x>=0&&RA.x+RA.w<=WSRC)ensureSatTiles(satTileIdsForView(RA));   // warm the satellite tiles for classification colour (any mode)
  warmCoastTiles(RA);   // OSM coast tiles for the windowed vector pass (wrap copies handled inside)
  if(RMAN&&riverN>0)ensureRiverTiles(riverTileIdsForView(RA));   // warm the river tiles (whole channels) overlapping the view
  if(mode==='compose'){renderCompose();return;}   // compose mode has no geographic frame: no layers, rivers-in-view, graticule or axes
  if(mode==='civ'){
    lastTiles=evaluateFrame();   // classify + river-aware features, exactly as the export does — the preview IS the snapshot
    drawCivGrid(ctx,lastTiles.tiles,out.W,out.H,{hex:hexMode,cw:cv.width,ch:cv.height,glyphs:true});
  }else{drawLayerWithCoast(R);if(showGrid)drawTileGrid();}
  drawRivers(R);
  if(showGrat)drawGraticule(R);drawAxes(R);updateReadout(R);
  drawWorldSelection(R);   // last, so the mask outline sits over every layer
}
/* Source px -> canvas px for the current frame; the mask is stored in source px so it stays pinned
   to the world as you pan and zoom. */
function worldToCanvas(R){const a=rotRad();if(!a)return (sx,sy)=>[(sx-R.x)/R.w*cv.width,(sy-R.y)/R.h*cv.height];
  return (sx,sy)=>{const [fx,fy]=worldToFrame(sx,sy);return [(fx-R.x)/R.w*cv.width,(fy-R.y)/R.h*cv.height];};}
function canvasToWorld(R,px,py){return frameToWorld(R.x+(px/cv.width)*R.w, R.y+(py/cv.height)*R.h);}
function drawWorldSelection(R){
  const live=_selDraw&&mode!=='compose'?_selDraw:null;
  const s=live||worldSel;
  if(s)drawSelection(ctx,s,worldToCanvas(R),!!(live&&live.open));
}
/* One evaluated frame = everything the exporter writes, in a position-independent form: classified
   tiles, the river edges actually selected for serialization, and the frame metadata. render(),
   generate() and captureSnapshot() all go through this, so a snapshot is by construction identical
   to what Generate would have produced for that view with those slider settings. */
function frameBounds(R,RA){const full=R.w>=WSRC-1e-6,nX=nudgeX*R.w/out.W,nY=nudgeY*R.h/out.H;return {W:full?-180:wrapLon(lonOf(RA.x+nX)),S:latOf(RA.y+RA.h+nY),E:full?180:wrapLon(lonOf(RA.x+RA.w+nX)),N:latOf(RA.y+nY)};}   // lon/lat box of the (rotated: bounding) frame, shifted by the X/Y sampling nudge; W > E crosses the antimeridian (the hex half-row shift is per row and not expressible here)
function evaluateFrame(){
  const R=srcRect(),region=classifyRegion(out.W,out.H);
  let rivers={nof:new Map(),wof:new Map()};
  try{rivers=selectedOnly(computeRiverEdges(R,out.W,out.H,riverN,region.tiles));}   // deselected channels dropped here, so features and export agree
  catch(e){console.error('evaluateFrame: river pass failed; continuing with no rivers this frame:',e);}
  {const g=activeGame();if(g.features)g.features(region.tiles,region.samples,rivers,{W:out.W,H:out.H,hex:hexMode,grid:g.grid});}   // the game's features pass (Civ4: flood plains need the river edges, so it comes last)
  const RA=rotAABB();   // rotated: the header's lat span is the world extent the frame reaches (metadata only — per-tile latitude drives classification)
  region.rivers=rivers;region.topLat=latOf(RA.y);region.botLat=latOf(RA.y+RA.h);
  region.hex=hexMode;region.frame={cx:view.cx,cy:view.cy,spanX:view.spanX,rot:view.rot||0};region.wrapX=(view.rot?0:(R.w>=WSRC-1e-6?1:0));region.game=activeGame().id;region.bounds=frameBounds(R,RA);   // a rotated frame cannot X-wrap
  return region;
}
/* ---------- Selection masks: box & lasso ----------
   A mask limits what a capture takes and what an erase clears. It lives in TWO different coordinate
   spaces because the two modes anchor differently: in the geographic viewers a mask is pinned to the
   WORLD (source-raster px), so panning or zooming leaves it around the same coastline you drew it
   around; on the compose canvas there is no geography, so its mask is pinned to TILE coordinates.
   Same shape maths either way — only the transform to canvas pixels differs. */
const SEL_LINE='#b06fe0', SEL_FILL='rgba(176,111,224,0.13)';   // purple: unused by any data layer, so it reads as UI rather than terrain
let selTool='none';        // 'none' | 'rect' | 'lasso' — while not 'none' the pointer draws instead of panning/dragging
let worldSel=null;         // geographic viewers: {kind:'rect'|'lasso', pts:[[sx,sy],...]} in source px
let compSel=null;          // compose canvas: same shape, in tile coords
let _selDraw=null;         // in-progress stroke: {kind,pts,anchor,moved,freehand}
let _selCursor=null;       // live cursor point, for the rubber-band segment of an open lasso
function activeSel(){return mode==='compose'?compSel:worldSel;}
function setActiveSel(s){if(mode==='compose')compSel=s;else worldSel=s;}
/* Rect is stored as its two corners so the same point list serves both kinds; a lasso keeps every
   vertex. Both normalise to a polygon for the inside test, which keeps one code path.
   A geographic box (s.frame) is rectangular IN THE VIEWER at any rotation: its corners are squared
   up in FRAME space and handed back as a world quad, so it always draws as a screen-aligned box and
   always selects a clean tile rectangle (a world-axis-aligned box would cover a staircase of tiles
   under rotation, and capture would crop to a bbox padded with empty corners). The stored diagonal
   stays world-pinned, so the box keeps its grip on the geography through pan, zoom and rotation.
   Compose masks carry no `frame` flag — that canvas has no rotation. */
function selPolygon(s){
  if(!s)return null;
  if(s.kind==='rect'){const [a,b]=s.pts;
    if(s.frame&&view.rot){const A=worldToFrame(a[0],a[1]),B=worldToFrame(b[0],b[1]),fx0=Math.min(A[0],B[0]),fx1=Math.max(A[0],B[0]),fy0=Math.min(A[1],B[1]),fy1=Math.max(A[1],B[1]);
      return [frameToWorld(fx0,fy0),frameToWorld(fx1,fy0),frameToWorld(fx1,fy1),frameToWorld(fx0,fy1)];}
    const x0=Math.min(a[0],b[0]),x1=Math.max(a[0],b[0]),y0=Math.min(a[1],b[1]),y1=Math.max(a[1],b[1]);
    return [[x0,y0],[x1,y0],[x1,y1],[x0,y1]];}
  return s.pts;
}
/* Even-odd ray cast. Points exactly on an edge are not worth special-casing: a tile is tested at its
   CENTRE, so a boundary hit needs the centre to land precisely on the edge. */
function selContains(s,x,y){
  const p=selPolygon(s);if(!p||p.length<3)return false;
  let inside=false;
  for(let i=0,j=p.length-1;i<p.length;j=i++){
    const xi=p[i][0],yi=p[i][1],xj=p[j][0],yj=p[j][1];
    if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)inside=!inside;
  }
  return inside;
}
function selBounds(s){
  const p=selPolygon(s);if(!p||!p.length)return null;
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(const q of p){if(q[0]<x0)x0=q[0];if(q[0]>x1)x1=q[0];if(q[1]<y0)y0=q[1];if(q[1]>y1)y1=q[1];}
  return {x0,y0,x1,y1};
}
function selIsUsable(s){const p=selPolygon(s);return !!(p&&p.length>=3);}
/* Draw the shape in purple. `tf` maps a point from the selection's own space to canvas px; an open
   lasso additionally rubber-bands from its last vertex to the cursor so the next segment is visible. */
function drawSelection(g,s,tf,open){
  if(!s||!s.pts.length)return;
  const p=selPolygon(s),pts=p.map(q=>tf(q[0],q[1]));
  g.save();
  g.lineJoin='round';g.lineCap='round';g.lineWidth=Math.max(1.5,cv.width*0.0022);
  if(pts.length>=3&&!open){
    g.beginPath();g.moveTo(pts[0][0],pts[0][1]);for(let i=1;i<pts.length;i++)g.lineTo(pts[i][0],pts[i][1]);g.closePath();
    g.fillStyle=SEL_FILL;g.fill();
  }
  g.strokeStyle=SEL_LINE;
  g.beginPath();g.moveTo(pts[0][0],pts[0][1]);
  for(let i=1;i<pts.length;i++)g.lineTo(pts[i][0],pts[i][1]);
  if(!open&&pts.length>=3)g.closePath();
  else if(_selCursor){const c=tf(_selCursor[0],_selCursor[1]);g.lineTo(c[0],c[1]);}   // rubber band to the cursor
  g.stroke();
  if(open){   // vertex handles, so a click-by-click polygon shows where its corners landed
    g.fillStyle=SEL_LINE;
    const r=Math.max(2.5,cv.width*0.0032);
    for(const q of pts){g.beginPath();g.arc(q[0],q[1],r,0,7);g.fill();}
  }
  g.restore();
}
/* ---------- Default tile: what a mask leaves behind ----------
   Ocean is the usual filler. Mountains are the alternative when you want the masked-out margin (or an
   erased area) to be impassable land rather than sea — a wall around a region instead of an island. */
let defaultTileKind='ocean';   // 'ocean' | 'peak' (the Mountain-fill toggle): what a mask leaves behind and what Delete fills with
function defaultTile(){return activeGame().blankTile(defaultTileKind==='peak'?'barrier':'water');}

function hexPathPointy(g,cx,cy,w,s){g.beginPath();g.moveTo(cx,cy-s);g.lineTo(cx+w/2,cy-s/2);g.lineTo(cx+w/2,cy+s/2);g.lineTo(cx,cy+s);g.lineTo(cx-w/2,cy+s/2);g.lineTo(cx-w/2,cy-s/2);g.closePath();}   // pointy-top hex: full width w, centre->top-point s (=w/√3); row pitch = 1.5s
function hexLayout(W,H,cw,ch){   // fit the FULL ragged hex block inside the canvas, centred: odd rows indent ½ tile and hexes overhang their row band, so the block is (W+0.5) tiles wide × (H+1/3) rows tall — the leftover margin lets every border show authentic jagged hex teeth
  const tw=Math.min(cw/(W+0.5),(ch/(H+1/3))/HEX_ROW),th=tw*HEX_ROW,s=tw/Math.sqrt(3);
  return {tw,th,s,ox:(cw-(W+0.5)*tw)/2,oy:(ch-((H-1)*th+2*s))/2};   // ox/oy centre the block; hex(x,y) centre = ox+(x+0.5)tw+shift, oy+s+y*th
}
/* ---------- Civ tile grid: geometry, drawing, and the pixel->tile inverse ----------
   Split out of render() so the identical grid can be painted to the viewer, to a snapshot thumbnail,
   and to the compose canvas. `geo` is the single source of truth for tile<->pixel mapping; every
   caller (drawing, hit-testing, patch outlines) goes through it rather than re-deriving tw/th. */
function civGridGeometry(W,H,opts){
  if(opts.hex){const HL=hexLayout(W,H,opts.cw,opts.ch);return {hex:true,tw:HL.tw,th:HL.th,s:HL.s,ox:HL.ox,oy:HL.oy};}
  return {hex:false,tw:opts.cw/W,th:opts.ch/H,ox:0,oy:0};
}
function drawCivGrid(g,tiles,W,H,opts){
  const geo=civGridGeometry(W,H,opts),glyphs=opts.glyphs!==false;
  if(geo.hex){
    for(let y=0;y<H;y++){const sh=hexShiftX(y,H)*geo.tw,cy=geo.oy+geo.s+y*geo.th;
      for(let x=0;x<W;x++){const c=civTileColor(tiles[y][x]),col='rgb('+(c[0]|0)+','+(c[1]|0)+','+(c[2]|0)+')';
        hexPathPointy(g,geo.ox+(x+0.5)*geo.tw+sh,cy,geo.tw,geo.s);g.fillStyle=col;g.fill();g.strokeStyle=col;g.lineWidth=1;g.stroke();}}   // stroke in the fill colour closes hairline seams between hexes
    if(glyphs)for(let y=0;y<H;y++){const sh=hexShiftX(y,H)*geo.tw,py=geo.oy+geo.s+y*geo.th-geo.th/2;for(let x=0;x<W;x++){const t=tiles[y][x],px=geo.ox+x*geo.tw+sh;   // glyphs centred in the hex's tw×th box
      drawTileGlyph(g,t,px,py,geo.tw,geo.th);}}
  }else{
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){const c=civTileColor(tiles[y][x]);
      g.fillStyle='rgb('+(c[0]|0)+','+(c[1]|0)+','+(c[2]|0)+')';g.fillRect(Math.floor(x*geo.tw),Math.floor(y*geo.th),Math.ceil(geo.tw)+1,Math.ceil(geo.th)+1);}
    if(glyphs)for(let y=0;y<H;y++)for(let x=0;x<W;x++){const t=tiles[y][x],px=x*geo.tw,py=y*geo.th;   // relief + oasis + special-bonus glyphs, drawn on top
      drawTileGlyph(g,t,px,py,geo.tw,geo.th);}
  }
  return geo;
}
/* Canvas pixel -> tile. On the hex lattice the hexes ARE the Voronoi cells of their centres, so
   "nearest centre among the neighbouring rows/columns" is exact, not an approximation. */
function tileAtPixel(geo,px,py,W,H){
  if(!geo.hex){const x=Math.floor((px-geo.ox)/geo.tw),y=Math.floor((py-geo.oy)/geo.th);return (x<0||x>=W||y<0||y>=H)?null:{x,y};}
  const ry=Math.floor((py-geo.oy-geo.s)/geo.th);let best=null,bd=Infinity;
  for(let y=ry-1;y<=ry+2;y++){
    if(y<0||y>=H)continue;
    const sh=hexShiftX(y,H)*geo.tw,cy=geo.oy+geo.s+y*geo.th,rx=Math.floor((px-geo.ox-sh)/geo.tw-0.5);
    for(let x=rx;x<=rx+1;x++){
      if(x<0||x>=W)continue;
      const cx=geo.ox+(x+0.5)*geo.tw+sh,d=(px-cx)*(px-cx)+(py-cy)*(py-cy);
      if(d<bd){bd=d;best={x,y};}
    }
  }
  return best;
}
function civTileColor(t){if(t._g)return [255,0,255];try{return activeGame().preview.color(t);}catch(e){return [255,0,255];}}   // magenta: a tile from another game's snapshot, which the active game cannot read
function drawTileGlyph(g,t,px,py,w,h){const pv=activeGame().preview;if(pv.glyph&&!t._g){try{pv.glyph(g,t,px,py,w,h);}catch(e){}}}
function drawTileGrid(){ctx.save();ctx.strokeStyle='rgba(233,227,211,0.18)';ctx.lineWidth=1;
  if(hexMode){const HL=hexLayout(out.W,out.H,cv.width,cv.height);   // hex outlines matching the civ preview's ragged block
    for(let y=0;y<out.H;y++){const sh=hexShiftX(y,out.H)*HL.tw,cy=HL.oy+HL.s+y*HL.th;for(let x=0;x<out.W;x++){hexPathPointy(ctx,HL.ox+(x+0.5)*HL.tw+sh,cy,HL.tw,HL.s);ctx.stroke();}}
    ctx.restore();return;}
  for(let x=0;x<=out.W;x++){const px=Math.round(x/out.W*cv.width)+0.5;ctx.beginPath();ctx.moveTo(px,0);ctx.lineTo(px,cv.height);ctx.stroke();}
  for(let y=0;y<=out.H;y++){const py=Math.round(y/out.H*cv.height)+0.5;ctx.beginPath();ctx.moveTo(0,py);ctx.lineTo(cv.width,py);ctx.stroke();}ctx.restore();}
function niceStep(range){const raw=range/6,p=Math.pow(10,Math.floor(Math.log10(Math.max(1e-6,raw)))),m=raw/p;return (m<1.5?1:m<3.5?2:m<7.5?5:10)*p;}
/* Lines are world-space segments spanning the rotated frame's AABB, mapped through worldToCanvas (affine,
   so two endpoints suffice); ends overshoot the canvas when rotated and are clipped. RA===R when rot===0. */
function drawGraticule(R){ctx.save();ctx.strokeStyle='rgba(69,193,208,0.16)';ctx.lineWidth=1;const RA=view.rot?rotAABB():R,P=worldToCanvas(R);const latT=latOf(RA.y),latB=latOf(RA.y+RA.h),lonL=lonOf(RA.x),lonR=lonOf(RA.x+RA.w),sLat=niceStep(latT-latB),sLon=niceStep(lonR-lonL);for(let L=Math.ceil(latB/sLat)*sLat;L<=latT;L+=sLat){const sy=(90-L)/180*HSRC,p0=P(RA.x,sy),p1=P(RA.x+RA.w,sy);ctx.beginPath();ctx.moveTo(p0[0],p0[1]);ctx.lineTo(p1[0],p1[1]);ctx.stroke();}for(let L=Math.ceil(lonL/sLon)*sLon;L<=lonR;L+=sLon){const sx=(L+180)/360*WSRC,p0=P(sx,RA.y),p1=P(sx,RA.y+RA.h);ctx.beginPath();ctx.moveTo(p0[0],p0[1]);ctx.lineTo(p1[0],p1[1]);ctx.stroke();}ctx.restore();}
function drawAxes(R){const latAx=document.getElementById('latAxis'),lonAx=document.getElementById('lonAxis');latAx.innerHTML='';lonAx.innerHTML='';if(view.rot)return;   // frame edges are not iso-lat/lon once rotated: no tick position is meaningful, the readout carries the angle instead
  const latT=latOf(R.y),latB=latOf(R.y+R.h),lonL=lonOf(R.x),lonR=lonOf(R.x+R.w),sLat=niceStep(latT-latB),sLon=niceStep(lonR-lonL);for(let L=Math.ceil(latB/sLat)*sLat;L<=latT;L+=sLat){const sy=(90-L)/180*HSRC,frac=(sy-R.y)/R.h;if(frac<0.03||frac>0.985)continue;const el=document.createElement('div');el.className='axis-tick';el.style.top=(frac*100)+'%';const v=Math.round(L);el.textContent=(v>0?v+'°N':v<0?(-v)+'°S':'0°');latAx.appendChild(el);}for(let L=Math.ceil(lonL/sLon)*sLon;L<=lonR;L+=sLon){const sx=(L+180)/360*WSRC,frac=(sx-R.x)/R.w;if(frac<0.03||frac>0.985)continue;const el=document.createElement('div');el.className='axis-tick';el.style.left=(frac*100)+'%';const v=Math.round(((L+540)%360)-180);el.textContent=(v>0?v+'°E':v<0?(-v)+'°W':'0°');lonAx.appendChild(el);}}
function updateReadout(R){const latT=latOf(R.y),latB=latOf(R.y+R.h),kmW=(R.w/WSRC)*40075*Math.max(0.05,Math.cos((latT+latB)/2*Math.PI/180));document.getElementById('readout').innerHTML='<span>Center <b>'+latOf(view.cy).toFixed(1)+'°, '+wrapLon(lonOf(view.cx)).toFixed(1)+'°</b></span><span>Span <b>'+Math.round(kmW).toLocaleString()+' km</b> · '+(latT-latB).toFixed(1)+'° lat</span>'+(view.rot?'<span title="Ctrl + double-click the map to reset rotation">Rotation <b>'+view.rot.toFixed(1).replace(/\.0$/,'')+'°</b></span>':'');const vs=document.getElementById('viewSource');if(vs){const vec=vectorCoastActive();vs.textContent=vec?'Vector':'Raster';vs.classList.toggle('vec',vec);}}

/* ---------- Rivers: centerline -> Civ4 river edges (corner-path + per-CHANNEL net-flow) ----------
   Snap each reach vertex to the nearest tile corner and Bresenham-connect consecutive corners.
   Net-flow is accumulated PER CHANNEL (rid): a hairpin that doubles back along the same edge
   cancels to nothing even when the out-leg and the back-leg are DIFFERENT REACHES of the channel
   (per-reach netting missed those, leaving a spurious edge with an arbitrary direction). Channels
   are netted independently, so a tributary (its own rid by the channel decomposition) is never
   cancelled against the river it joins, keeping confluences connected. A reach without a rid is
   its own channel (old per-reach behaviour).
   `proj` (optional) replaces the axis-aligned view-rect projection with a rotation-aware one; the
   lattice it lands on is identical in shape, so nothing downstream of the vertex snap knows or cares. */
/* Rotation-aware lon/lat -> tile grid: lon/lat -> world source px -> worldToFrame -> grid. The grid is
   FRAME space (screen-aligned, view-centred), so every downstream step -- corner snap, staircase,
   net-flow, cleanup, nudge -- keeps working on the lattice the canvas actually shows. At rot=0 this is
   algebraically the axis-aligned FX/FY below, so the north-up path is left literally untouched. */
/* The world copy is chosen ONCE PER POLYLINE and then carried: the first vertex takes the copy
   nearest the view, every later vertex the copy nearest ITS PREDECESSOR. Choosing per vertex
   instead breaks exactly at the antipode, where (cx-wx)/WS sits on the .5 rounding boundary and two
   adjacent vertices of one river land a whole world apart -- the staircase then connects opposite
   frame corners and paints a straight diagonal across the viewer (and its flipped bbox defeats the
   cull, so the antipodal river is always the one that shows up). Carrying the copy also unwraps a
   genuine +/-180 crossing, which is the same operation. Call reset() to start a new polyline. */
function makeRiverProj(o){
  const rad=(o.rot||0)*Math.PI/180,c=Math.cos(rad),s=Math.sin(rad),R=o.rect,WS=o.WSRC,HS=o.HSRC,cx=o.cx,cy=o.cy;
  let ref=null;
  const P=(lon,lat)=>{
    let wx=(lon+180)/360*WS;const wy=(90-lat)/180*HS;
    wx+=Math.round(((ref==null?cx:ref)-wx)/WS)*WS;              // nearest copy: to the view for the first vertex, to the predecessor after
    ref=wx;
    let fx=wx,fy=wy;
    if(rad){const dx=wx-cx,dy=wy-cy;fx=cx+c*dx+s*dy;fy=cy-s*dx+c*dy;}
    return [(fx-R.x)/R.w*o.W,(fy-R.y)/R.h*o.H];
  };
  P.reset=()=>{ref=null;};
  return P;
}
// null while north-up, so reachesToEdges keeps its exact axis-aligned fast path
function riverProj(R,W,H){return (view.rot||0)?makeRiverProj({WSRC,HSRC,rect:R,W,H,rot:view.rot,cx:view.cx,cy:view.cy}):null;}
function reachesToEdges(reaches,view,W,H,proj){
  const nof=new Map(),wof=new Map(),{lonL,lonR,latT,latB}=view,sx=W/(lonR-lonL),sy=H/(latT-latB);
  const FX=lon=>(lon-lonL)*sx,FY=lat=>(latT-lat)*sy;            // fx:0=west..W=east  fy:0=NORTH..H=south
  const cl=(v,hi)=>v<0?0:v>hi?hi:v;
  const chans=new Map();let anon=0;                             // rid -> per-channel signed traversal
  for(const r of reaches){
    const ck=r.rid!=null?r.rid:'~'+(anon++);
    let C=chans.get(ck);if(!C){C={NH:new Map(),VE:new Map(),rid:r.rid};chans.set(ck,C);}
    const accN=(gr,gx,s)=>{if(gr<0||gr>=H||gx<0||gx>=W)return;const k=gr+','+gx;let e=C.NH.get(k);if(!e)C.NH.set(k,e={n:0,d:0});e.n+=s;if(r.d>e.d)e.d=r.d;};
    const accW=(gy,gx,s)=>{if(gy<0||gy>=H||gx<0||gx>=W)return;const k=gy+','+gx;let e=C.VE.get(k);if(!e)C.VE.set(k,e={n:0,d:0});e.n+=s;if(r.d>e.d)e.d=r.d;};
    const step=(x0,y0,x1,y1)=>{                                 // one unit lattice edge, signed (E/S=+1, W/N=-1)
      if(y0===y1)accN(y0-1,Math.min(x0,x1),x1>x0?1:-1);         // horizontal: south edge of north tile
      else accW(Math.min(y0,y1),x0-1,y1>y0?1:-1);              // vertical: east edge of west tile (fy grows south)
    };
    const connect=(ax,ay,bx,by)=>{   // Bresenham staircase, not an L: follows the true line, tile by tile
      let x=ax,y=ay;const adx=Math.abs(bx-ax),ady=Math.abs(by-ay),sx=Math.sign(bx-ax),sy=Math.sign(by-ay);
      let err=adx-ady;
      while(x!==bx||y!==by){const e2=2*err;let moved=false;
        if(e2>-ady&&x!==bx){err-=ady;step(x,y,x+sx,y);x+=sx;moved=true;}
        if(e2<adx&&y!==by){err+=adx;step(x,y,x,y+sy);y+=sy;moved=true;}
        if(!moved)break;}
    };
    let px=null,py=null;if(proj&&proj.reset)proj.reset();        // one world copy per reach, like px/py
    for(const part of r.l)for(const pt of part){
      const g=proj?proj(pt[0],pt[1]):[FX(pt[0]),FY(pt[1])];
      const cx=cl(Math.round(g[0]),W),cy=cl(Math.round(g[1]),H);
      if(px!==null&&(cx!==px||cy!==py))connect(px,py,cx,cy);
      px=cx;py=cy;
    }
  }
  for(const C of chans.values()){                               // merge channels: higher discharge wins an edge
    for(const [k,e] of C.NH){if(!e.n)continue;const cur=nof.get(k);if(!cur||e.d>cur.d)nof.set(k,{dir:e.n>0?1:3,d:e.d,rid:C.rid});}
    for(const [k,e] of C.VE){if(!e.n)continue;const cur=wof.get(k);if(!cur||e.d>cur.d)wof.set(k,{dir:e.n>0?2:0,d:e.d,rid:C.rid});}
  }
  return {nof,wof};
}
function plotRiverLines(nof,wof,gx,civY,H){
  const gr=(H-1)-civY,out=[],n=nof.get(gr+','+gx),w=wof.get(gr+','+gx);
  if(n){out.push('\tisNOfRiver');out.push('\tRiverWEDirection='+n.dir);}
  if(w){out.push('\tisWOfRiver');out.push('\tRiverNSDirection='+w.dir);}
  return out;
}
// Precompute per-reach bbox. Channel id (main-stem decomposition) is precomputed offline
// and carried as f.c; each channel = one river or tributary (ranked independently by the slider).
// Per-tile prep: bbox + rid(=channel id) per reach. Channels are whole within a tile (terminal-tiled).
function prepTile(j){
  const F=(j&&j.features)?j.features:[];
  for(const f of F){
    let mnx=1/0,mny=1/0,mxx=-1/0,mxy=-1/0;
    for(const part of f.l)for(const p of part){if(p[0]<mnx)mnx=p[0];if(p[0]>mxx)mxx=p[0];if(p[1]<mny)mny=p[1];if(p[1]>mxy)mxy=p[1];}
    f.bbox=[mnx,mny,mxx,mxy]; f.rid=f.c;
  }
  return {features:F};
}
function maxRiverLodForZoom(){const ww=windowWidthDeg();return ww>120?0:ww>40?1:ww>12?2:3;}   // load smaller rivers only as the window narrows
function riverTileIdsForView(R){        // manifest tiles overlapping the view whose LOD is coarse enough for this zoom
  if(!RMAN)return [];
  const latT=latOf(R.y),latB=latOf(R.y+R.h),ids=new Set(),maxLod=maxRiverLodForZoom();
  for(const o of wrapOffsets(R)){       // a seam-straddling rect tests each world copy's own lon window (manifest bboxes live in [-180,180])
    const lonL=lonOf(Math.max(R.x,o)-o),lonR=lonOf(Math.min(R.x+R.w,o+WSRC)-o);
    for(const t of RMAN.tiles){if((t.lod||0)>maxLod)continue;const b=t.b;if(b[2]<lonL||b[0]>lonR||b[3]<latB||b[1]>latT)continue;ids.add(t.id);}
  }
  return [...ids];
}
function ensureRiverTiles(ids){         // fetch not-yet-loaded tiles; bump the memo generation + re-render as each lands
  for(const id of ids){ if(RTILE.has(id))continue; RTILE.set(id,'load');
    fetch('data/river_tiles/'+id+'.json').then(r=>{if(!r.ok)throw 0;return r.json();})
      .then(j=>{RTILE.set(id,prepTile(j));_riverGen++;render();})
      .catch(()=>{RTILE.set(id,null);}); }
}
// Select the top-N in-frame rivers by discharge and rasterize to Civ edges.
// If tiles is given, drop edges whose BOTH flanking plots are water (river between two ocean/coast tiles).
let _rivMemo={key:'',raw:null,inView:0};   // memoise the (expensive) filter+group+rasterize per view+N
let _cleanMemo=null;                       // memoise cleanup+estuary tracing per (raw,tiles,estuary flag)
/* ---------- item 6: estuary bridging (fine coastline) ----------
   HydroRIVERS ends rivers at the fall line, so at tile resolution a river stops inland of its
   estuary; the estuary itself is usually narrower than the 10km landMask, so following THAT cuts
   across land (Schuylkill across NJ). Instead we rasterize the hi-res coast vector into a fine
   local patch (~0.7km/px) around each mouth, find the estuary head by proximity, and BFS the
   fine-water channel until it reaches a tile the export grid already calls water -- the "would-be
   estuary tiles" hand us the path to the tiled ocean. Lay a synthetic reach along it. Bridge edges
   are tagged {bridge:true}. Civ mode / export only; toggled by riverEstuaries. */
let _cpCanvas=null;
function rasterCoastPatch(box,RES){
  const coast=(typeof COAST_HI!=='undefined'&&COAST_HI)||(typeof COAST!=='undefined'&&COAST);
  if(!coast||!coast.polys||typeof document==='undefined')return null;
  const c=_cpCanvas||(_cpCanvas=document.createElement('canvas'));c.width=RES;c.height=RES;
  const m=c.getContext('2d',{willReadFrequently:true}),sX=RES/(box.lon1-box.lon0),sY=RES/(box.lat1-box.lat0);
  const X=lon=>(lon-box.lon0)*sX,Y=lat=>(box.lat1-lat)*sY;
  m.fillStyle='#000';m.fillRect(0,0,RES,RES);                                    // water
  const fill=(polys,col)=>{if(!polys)return;m.fillStyle=col;for(const p of polys){const b=p.b;
    if(b[2]<box.lon0||b[0]>box.lon1||b[3]<box.lat0||b[1]>box.lat1)continue;
    m.beginPath();for(const ring of p.r){for(let i=0;i<ring.length;i++){const x=X(ring[i][0]),y=Y(ring[i][1]);i?m.lineTo(x,y):m.moveTo(x,y);}m.closePath();}m.fill('evenodd');}};
  fill(coast.polys,'#fff');                                                      // land
  fill(((typeof LAKES_HI!=='undefined'&&LAKES_HI)||(typeof LAKES!=='undefined'&&LAKES)||{}).polys,'#000');   // lakes -> water
  const d=m.getImageData(0,0,RES,RES).data,mask=new Uint8Array(RES*RES);
  for(let i=0;i<mask.length;i++)mask[i]=d[i*4]>127?1:0;                          // 1=land, 0=water
  return mask;
}
/* Build the estuary field for a patch ONCE (the expensive part): halo-dilate the fine water to close
   the sub-pixel gaps a 1-2px tidal channel leaves when rasterized, then flood-fill from the open
   ocean. Water reached that way is MARINE -- it demonstrably connects to the sea, which is the
   algorithmic form of zooming in and checking. BFS runs *from* the sea, so par[] already points
   seaward: from any marine pixel we can walk straight out. Shared by every mouth in the patch. */
function estuaryField(mask,RES,box,isSeaLL,HALO){
  const N=RES*RES,inB=(px,py)=>px>=0&&px<RES&&py>=0&&py<RES;
  const pxLon=px=>box.lon0+(px+0.5)/RES*(box.lon1-box.lon0),pyLat=py=>box.lat1-(py+0.5)/RES*(box.lat1-box.lat0);
  const tmp=new Uint8Array(N),wH=new Uint8Array(N);   // HALO is passed in: a real distance (~1.5km), not a fixed pixel count
  for(let y=0;y<RES;y++)for(let x=0;x<RES;x++){let w=0;
    for(let k=-HALO;k<=HALO&&!w;k++){const nx=x+k;if(nx>=0&&nx<RES&&mask[y*RES+nx]===0)w=1;}tmp[y*RES+x]=w;}
  for(let y=0;y<RES;y++)for(let x=0;x<RES;x++){let w=0;
    for(let k=-HALO;k<=HALO&&!w;k++){const ny=y+k;if(ny>=0&&ny<RES&&tmp[ny*RES+x])w=1;}wH[y*RES+x]=w;}
  const marine=new Uint8Array(N),par=new Int32Array(N).fill(-1),q=[];
  for(let y=0;y<RES;y++)for(let x=0;x<RES;x++){const i=y*RES+x;
    if(wH[i]&&!marine[i]&&isSeaLL(pxLon(x),pyLat(y))){marine[i]=1;q.push(i);}}   // seeds: fine water inside a SEA tile
  for(let h=0;h<q.length;h++){const c=q[h],px=c%RES,py=(c-px)/RES;
    for(const d of [[1,0],[-1,0],[0,1],[0,-1]]){const nx=px+d[0],ny=py+d[1];
      if(!inB(nx,ny))continue;const ni=ny*RES+nx;
      if(!wH[ni]||marine[ni])continue;marine[ni]=1;par[ni]=c;q.push(ni);}}
  return {mask,marine,par};
}
function traceEstuaryPath(field,RES,box,mouth,isSeaLL,dLon,dLat){
  /* TRUE MOUTH = nearest marine pixel to the river's terminal; then just walk par[] out to the sea.
     Fallback (no marine water near the terminal -- e.g. a river ending in a lake whose outflow isn't
     in the coast vector): 0-1 BFS, water free / land cost 1, so it crosses the minimum land. */
  const {mask,marine,par}=field,N=RES*RES;
  const inB=(px,py)=>px>=0&&px<RES&&py>=0&&py<RES;
  const water=(px,py)=>inB(px,py)&&mask[py*RES+px]===0;
  const pxLon=px=>box.lon0+(px+0.5)/RES*(box.lon1-box.lon0),pyLat=py=>box.lat1-(py+0.5)/RES*(box.lat1-box.lat0);
  const s=[Math.round((mouth.lon-box.lon0)/(box.lon1-box.lon0)*RES),Math.round((box.lat1-mouth.lat)/(box.lat1-box.lat0)*RES)];
  if(!inB(s[0],s[1]))return null;
  let mouthPx=-1;const RAD=Math.floor(RES/8);
  for(let r=0;r<=RAD&&mouthPx<0;r++)for(let dy=-r;dy<=r&&mouthPx<0;dy++)for(let dx=-r;dx<=r;dx++){
    if(r&&Math.max(Math.abs(dx),Math.abs(dy))!==r)continue;
    const nx=s[0]+dx,ny=s[1]+dy;if(!inB(nx,ny))continue;
    if(marine[ny*RES+nx]){mouthPx=ny*RES+nx;break;}}
  let path=null;
  if(mouthPx>=0){path=[];for(let c=mouthPx;c>=0;c=par[c])path.push(c);}          // walk the estuary out to the sea
  else{
    const INF=0x7fffffff,dist=new Int32Array(N).fill(INF),par2=new Int32Array(N).fill(-1);
    const buckets=[[s[1]*RES+s[0]]];dist[s[1]*RES+s[0]]=0;let target=-1,seen=0;
    for(let c=0;c<buckets.length;c++){const b=buckets[c];if(!b)continue;
      for(let i=0;i<b.length;i++){const cur=b[i];
        if(dist[cur]!==c)continue;
        const px=cur%RES,py=(cur-px)/RES;
        if(++seen>200000){c=buckets.length;break;}
        if(isSeaLL(pxLon(px),pyLat(py))){target=cur;c=buckets.length;break;}
        for(const d of [[1,0],[-1,0],[0,1],[0,-1]]){const nx=px+d[0],ny=py+d[1];
          if(!inB(nx,ny))continue;const ni=ny*RES+nx,nd=c+(water(nx,ny)?0:1);
          if(nd>=dist[ni])continue;dist[ni]=nd;par2[ni]=cur;
          (buckets[nd]||(buckets[nd]=[])).push(ni);}
      }
    }
    if(target<0)return null;
    path=[];for(let c=target;c>=0;c=par2[c])path.unshift(c);
  }
  if(!path||!path.length)return null;
  const line=[[mouth.lon,mouth.lat]];                        // sample ~0.4 tile apart so the raster staircases along the estuary
  const stepLon=Math.abs(dLon)*0.4||1e-4,stepLat=Math.abs(dLat)*0.4||1e-4;
  let last=[mouth.lon,mouth.lat];
  for(const c of path){const px=c%RES,py=(c-px)/RES,lo=pxLon(px),la=pyLat(py);
    if(Math.abs(lo-last[0])>=stepLon||Math.abs(la-last[1])>=stepLat){line.push([lo,la]);last=[lo,la];if(line.length>400)break;}}
  const tp=path[path.length-1],tx=tp%RES,ty=(tp-tx)/RES;
  line.push([pxLon(tx),pyLat(ty)]);
  return line;
}
function bridgeEstuaries(nof,wof,tiles,W,H,R,mouths){
  if(!mouths||!mouths.length)return;
  const lonL=lonOf(R.x),lonR=lonOf(R.x+R.w),latT=latOf(R.y),latB=latOf(R.y+R.h);
  const isW=(tx,ty)=>tx>=0&&tx<W&&ty>=0&&ty<H&&isWaterTile(tiles[ty][tx]);
  /* label water bodies: a body of <=LAKE_MAX tiles is a LAKE, not the sea. The estuary course may
     run through lakes, so they are not a valid terminus -- keep tracing until the real ocean, and
     the land tiles between each lake and the sea get river reaches like any other stretch. */
  const LAKE_MAX=10,comp=new Int32Array(W*H).fill(-1),size=[];
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    if(!isW(x,y)||comp[y*W+x]!==-1)continue;
    const id=size.length,st=[[x,y]];comp[y*W+x]=id;let n=0;
    while(st.length){const c=st.pop(),cx=c[0],cy=c[1];n++;
      for(const d of [[1,0],[-1,0],[0,1],[0,-1]]){const nx=cx+d[0],ny=cy+d[1];
        if(!isW(nx,ny)||comp[ny*W+nx]!==-1)continue;comp[ny*W+nx]=id;st.push([nx,ny]);}}
    size.push(n);
  }
  const PJ=riverProj(R,W,H);   // same lon/lat -> frame-grid projection the edges were rasterized with
  const tileAt=PJ?((lon,lat)=>{PJ.reset();const p=PJ(lon,lat);return [Math.floor(p[0]),Math.floor(p[1])];})   // standalone probe: copy nearest the view, never a carried one
                :((lon,lat)=>[Math.floor((lon-lonL)/(lonR-lonL)*W),Math.floor((latT-lat)/(latT-latB)*H)]);
  const isSeaLL=(lon,lat)=>{const t=tileAt(lon,lat);if(!isW(t[0],t[1]))return false;
    const id=comp[t[1]*W+t[0]];return id>=0&&size[id]>LAKE_MAX;};      // stops at the sea, passes through lakes
  const isAnyWaterLL=(lon,lat)=>{const t=tileAt(lon,lat);return isW(t[0],t[1]);};
  const dLon=(lonR-lonL)/W,dLat=(latT-latB)/H,bridges=[];
  /* Adaptive patch. Resolving estuary detail far finer than a TILE is wasted work -- the bridge can
     only ever be expressed at tile granularity -- and the patch only has to reach far enough to hit
     a sea tile. So scale both to the tile size:
       HALF (box half-width): ~8 tiles of reach, clamped [0.6, 2.5] deg
       px  (patch pixel):     ~1/12 of a tile, floored at 0.0065 deg (~0.7km, the old fixed value)
     Cost is RES^2, so a world view now costs a fraction of a zoomed-in one instead of the same. */
  const tileDeg=Math.max(Math.abs(dLon),Math.abs(dLat),1e-6);
  const HALF=Math.max(0.6,Math.min(2.5,8*tileDeg));
  const px=Math.max(0.0065,Math.min(0.05,tileDeg/12));
  const RES=Math.max(128,Math.min(768,Math.round(2*HALF/px)));
  const HALO=Math.max(1,Math.min(2,Math.round(0.013/px)));   // dilation as a real distance (~1.5km), so a coarse patch doesn't merge water across a strait
  const SNAP=HALF/2;   // snap box centres so nearby mouths share a patch, while keeping >=0.75*HALF of margin
  const patches=new Map();
  for(const m of mouths){
    const t0=tileAt(m.lon,m.lat);
    // A mouth outside the view can't be bridged: its edges would be clamped onto the frame border,
    // smearing spurious rivers along the edge. Reject first -- it's also the cheapest reject we have.
    if(t0[0]<0||t0[0]>=W||t0[1]<0||t0[1]>=H)continue;
    if(isAnyWaterLL(m.lon,m.lat)&&isSeaLL(m.lon,m.lat))continue;               // already at the sea
    // cheap reject: if there is no SEA tile anywhere within reach, this terminal is landlocked --
    // no estuary can exist, so never pay for a patch raster + flood fill.
    const rx=Math.ceil(HALF/Math.abs(dLon||1)),ry=Math.ceil(HALF/Math.abs(dLat||1));
    let nearSea=false;
    for(let ty=Math.max(0,t0[1]-ry);ty<=Math.min(H-1,t0[1]+ry)&&!nearSea;ty++)
      for(let tx=Math.max(0,t0[0]-rx);tx<=Math.min(W-1,t0[0]+rx);tx++){
        if(!isW(tx,ty))continue;const id=comp[ty*W+tx];
        if(id>=0&&size[id]>LAKE_MAX){nearSea=true;break;}}
    if(!nearSea)continue;
    const bx=Math.round(m.lon/SNAP)*SNAP,by=Math.round(m.lat/SNAP)*SNAP,pk=bx+','+by;   // mouths nearby share a patch
    let P=patches.get(pk);
    if(P===undefined){
      const box={lon0:bx-HALF,lon1:bx+HALF,lat0:by-HALF,lat1:by+HALF};
      const mask=rasterCoastPatch(box,RES);
      P=mask?{box,field:estuaryField(mask,RES,box,isSeaLL,HALO)}:null;
      patches.set(pk,P);
    }
    if(!P)return;                                                              // coast vector not ready
    const line=traceEstuaryPath(P.field,RES,P.box,m,isSeaLL,dLon,dLat);
    if(line&&line.length>1)bridges.push({d:1,rid:m.rid,l:[line]});
  }
  if(bridges.length){const be=reachesToEdges(bridges,{lonL,lonR,latT,latB},W,H,PJ);
    for(const [k,v] of be.nof)if(!nof.has(k)){v.bridge=true;nof.set(k,v);}
    for(const [k,v] of be.wof)if(!wof.has(k)){v.bridge=true;wof.set(k,v);}}
}
/* ---------- river nudge (final pass) ----------
   nudgeRiverEdges: clear every four-sided tile (river on all 4 sides -- invalid in Civ) and straighten
   single-channel hairpin wraps (river on 3 sides of one tile), preserving PER-CHANNEL connectivity.
   Phase 1 (deletion only; one sweep reaches the fixpoint):
     single channel: the 4 edges are a same-channel cycle. Junctions J = corners with external edges.
       |J|<=1 -> drop the whole zero-net-displacement loop; |J|==2 -> drop the junction-free longer arc;
       |J|>=3 -> drop one edge (cycle => channel stays connected), preferring no new tips, then low d.
     multi channel: prefer deleting the WEAKEST channel's whole edge-group when clean (every corner it
       fully owns carries nothing external) -- each severed end lands on a corner shared with the
       surviving channel, so the tributary braids into the bigger river for one tile: no stub, no
       leftover wrap. Otherwise delete the single edge that hurts its own channel least
       (redundant > tip-trim > mid-course split), ties by discharge, stubs, side order.
   Phase 2 (the actual nudge, to a fixpoint): a tile with river on exactly 3 sides, all one channel,
     interior corners bare, is a one-tile detour: replace the 3-edge arc with the missing-side chord
     (identical endpoints -> exact connectivity; flow direction carried over). Guarded: chord in-grid,
     edgeOk (rivers may not touch coast/water), and the neighbour tile may not exceed 2 edges unless
     all its edges are the same channel (the wrap merely moves and a later sweep collapses it too).
   (Kept in sync with core/rivers_core.js; validated by core/rivers_test.js.) */
function nudgeRiverEdges(nof,wof,W,H,edgeOk){
  const ok=edgeOk||(()=>true),M=(m)=>(m==='nof'?nof:wof);
  const deg=new Map(),bump=(cx,cy,s)=>{const k=cx+','+cy,v=(deg.get(k)||0)+s;if(v)deg.set(k,v);else deg.delete(k);};
  const cornersOf=(m,key)=>{const p=key.split(',').map(Number),a=p[0],b=p[1];
    return m==='nof'?[[b,a+1],[b+1,a+1]]:[[b+1,a],[b+1,a+1]];};
  const applyDeg=(m,key,s)=>{for(const c of cornersOf(m,key))bump(c[0],c[1],s);};
  for(const k of nof.keys())applyDeg('nof',k,1);for(const k of wof.keys())applyDeg('wof',k,1);
  const D=(c)=>deg.get(c[0]+','+c[1])||0;
  const delE=(m,key)=>{M(m).delete(key);applyDeg(m,key,-1);};
  const setE=(m,key,v)=>{M(m).set(key,v);applyDeg(m,key,1);};
  const tileC=(gx,gy)=>[[gx,gy],[gx+1,gy],[gx+1,gy+1],[gx,gy+1]];   // NW,NE,SE,SW; edge i joins corner i,(i+1)%4
  const tileE=(gx,gy)=>[{s:'N',m:'nof',key:(gy-1)+','+gx},{s:'E',m:'wof',key:gy+','+gx},{s:'S',m:'nof',key:gy+','+gx},{s:'W',m:'wof',key:gy+','+(gx-1)}];
  const ord={N:0,E:1,S:2,W:3};
  const chanAt=(rid,cx,cy)=>{let n=0;   // per-channel probes: channels are tiny subgraphs, scans only run on violations
    for(const m of ['nof','wof'])for(const [k,e] of M(m).entries()){if(e.rid!==rid)continue;
      for(const c of cornersOf(m,k))if(c[0]===cx&&c[1]===cy){n++;break;}}
    return n;};
  const chanComps=(rid,skipM,skipKey)=>{
    const adj=new Map(),link=(a,b)=>{(adj.get(a)||adj.set(a,new Set()).get(a)).add(b);(adj.get(b)||adj.set(b,new Set()).get(b)).add(a);};
    for(const m of ['nof','wof'])for(const [k,e] of M(m).entries()){if(e.rid!==rid||(m===skipM&&k===skipKey))continue;
      const cs=cornersOf(m,k);link(cs[0].join(','),cs[1].join(','));}
    let c=0;const seen=new Set();
    for(const s of adj.keys()){if(seen.has(s))continue;c++;const st=[s];
      while(st.length){const v=st.pop();if(seen.has(v))continue;seen.add(v);for(const w of adj.get(v))if(!seen.has(w))st.push(w);}}
    return c;};
  // phase 1: four-sided tiles (every such tile has both horizontal edges, so nof keys find them all)
  const seenT=new Set();
  for(const k0 of [...nof.keys()]){
    const p0=k0.split(',').map(Number);
    for(const gy of [p0[0],p0[0]+1]){                   // k0 = S edge of (gx,gy0) and N edge of (gx,gy0+1)
      const gx=p0[1],tk=gx+','+gy;if(seenT.has(tk))continue;seenT.add(tk);
      const E4=tileE(gx,gy),V4=E4.map(e=>M(e.m).get(e.key));
      if(V4.some(v=>!v))continue;
      const C4=tileC(gx,gy),rid0=V4[0].rid;
      if(rid0!=null&&V4.every(v=>v.rid===rid0)){
        const J=[];for(let i=0;i<4;i++)if(D(C4[i])>2)J.push(i);
        if(J.length<=1){for(const e of E4)delE(e.m,e.key);continue;}
        if(J.length===2){
          const a=J[0],fl=J[1]-a,from=fl>=4-fl?a:J[1],n=Math.max(fl,4-fl);
          for(let i=0;i<n;i++){const e=E4[(from+i)%4];delE(e.m,e.key);}
          continue;}
        let pick=null;
        for(let i=0;i<4;i++){const stubs=(D(C4[i])<=2?1:0)+(D(C4[(i+1)%4])<=2?1:0),d=V4[i].d||0;
          if(!pick||stubs<pick.stubs||(stubs===pick.stubs&&d<pick.d))pick={i,stubs,d};}
        delE(E4[pick.i].m,E4[pick.i].key);continue;
      }
      const groups=new Map();                           // corner c touches edges c and (c+3)%4
      for(let i=0;i<4;i++){const gk=V4[i].rid==null?('~'+i):('r'+V4[i].rid);
        let g=groups.get(gk);if(!g)groups.set(gk,g={idx:[],maxd:0});g.idx.push(i);if((V4[i].d||0)>g.maxd)g.maxd=V4[i].d||0;}
      let minMaxd=Infinity;for(const g of groups.values())if(g.maxd<minMaxd)minMaxd=g.maxd;
      let sac=null;                                     // clean whole-group deletion of the WEAKEST channel: braid, not split
      for(const g of groups.values()){
        if(g.maxd>minMaxd)continue;                     // never sacrifice a dominant channel's line
        let clean=true;
        for(let c=0;c<4&&clean;c++)if(g.idx.includes(c)&&g.idx.includes((c+3)%4)&&D(C4[c])>2)clean=false;
        if(clean&&(!sac||g.idx.length<sac.idx.length||(g.idx.length===sac.idx.length&&Math.min(...g.idx)<Math.min(...sac.idx))))sac=g;
      }
      if(sac){for(const i of sac.idx)delE(E4[i].m,E4[i].key);continue;}
      let pick=null;
      for(let i=0;i<4;i++){const v=V4[i],e=E4[i];let cls;
        if(v.rid==null)cls=1;
        else if(chanAt(v.rid,C4[i][0],C4[i][1])===1||chanAt(v.rid,C4[(i+1)%4][0],C4[(i+1)%4][1])===1)cls=1;
        else cls=(chanComps(v.rid,e.m,e.key)===chanComps(v.rid,null,null))?0:2;
        const stubs=(D(C4[i])<=2?1:0)+(D(C4[(i+1)%4])<=2?1:0),d=v.d||0;
        if(!pick||cls<pick.cls||(cls===pick.cls&&(d<pick.d||(d===pick.d&&(stubs<pick.stubs||(stubs===pick.stubs&&ord[e.s]<ord[pick.e.s]))))))pick={e,cls,d,stubs};
      }
      delE(pick.e.m,pick.e.key);
    }
  }
  // phase 2: collapse single-channel 3-edge wraps onto the missing-side chord (fixpoint)
  let guard=0;
  for(let changed=true;changed&&guard++<10000;){
    changed=false;
    for(const k0 of [...nof.keys()]){
      if(!nof.has(k0))continue;                         // consumed by an earlier collapse this sweep
      const p0=k0.split(',').map(Number);
      for(const gy of [p0[0],p0[0]+1]){
        const gx=p0[1],E4=tileE(gx,gy),V4=E4.map(e=>M(e.m).get(e.key));
        if(V4.filter(Boolean).length!==3)continue;
        const mi=V4.findIndex(v=>!v),ch=E4[mi];
        const kp=ch.key.split(',').map(Number);
        if(kp[0]<0||kp[0]>=H||kp[1]<0||kp[1]>=W)continue;   // chord not representable
        const C4=tileC(gx,gy),arcI=[(mi+1)%4,(mi+2)%4,(mi+3)%4];
        const rid=V4[arcI[0]].rid;
        if(rid==null||arcI.some(i=>V4[i].rid!==rid))continue;
        if(D(C4[(mi+2)%4])!==2||D(C4[(mi+3)%4])!==2)continue;   // interior corners must carry nothing else
        if(!ok(ch.m,ch.key))continue;
        const nb=mi===0?[gx,gy-1]:mi===1?[gx+1,gy]:mi===2?[gx,gy+1]:[gx-1,gy];
        const nbV=tileE(nb[0],nb[1]).map(e=>M(e.m).get(e.key)).filter(Boolean);
        if(nbV.length>2||(nbV.length===2&&!nbV.every(v=>v.rid===rid)))continue;
        let vote=0,cur=C4[(mi+1)%4];                    // flow orientation along the arc path C[mi+1] -> C[mi]
        for(const i of arcI){const nxt=C4[(i+1)%4],v=V4[i];
          vote+=(E4[i].m==='nof'?(nxt[0]>cur[0]?v.dir===1:v.dir===3):(nxt[1]>cur[1]?v.dir===2:v.dir===0))?1:-1;
          cur=nxt;}
        const A=vote>=0?C4[(mi+1)%4]:C4[mi],B=vote>=0?C4[mi]:C4[(mi+1)%4];
        const dir=ch.m==='nof'?(B[0]>A[0]?1:3):(B[1]>A[1]?2:0);
        let d=0,br=false;
        for(const i of arcI){if((V4[i].d||0)>d)d=V4[i].d||0;if(V4[i].bridge)br=true;}
        for(const i of arcI)delE(E4[i].m,E4[i].key);
        const entc={dir,d,rid};if(br)entc.bridge=true;
        setE(ch.m,ch.key,entc);
        changed=true;break;                             // this tile's other flank no longer applies
      }
    }
  }
}
function computeRiverEdges(R,W,H,N,tiles){
  const empty={nof:new Map(),wof:new Map()};
  if(!RMAN||N<=0)return empty;
  const onSig=[...RIVER_ON].sort().join(',');   // selected rivers alter `keep`, so they must be part of the memo key
  const key=_riverGen+'|'+R.x.toFixed(3)+'_'+R.y.toFixed(3)+'_'+R.w.toFixed(3)+'_'+R.h.toFixed(3)+'_'+(view.rot||0).toFixed(3)+'_'+W+'_'+H+'_'+N+'_'+onSig;
  let raw;
  if(_rivMemo.key===key){raw=_rivMemo.raw;}
  else{
    const PJ=riverProj(R,W,H);
    const lonL=lonOf(R.x),lonR=lonOf(R.x+R.w),latT=latOf(R.y),latB=latOf(R.y+R.h);
    /* In-frame test, and with it the top-N "in-frame discharge" ranking. North-up: the view rect in
       lon/lat, exactly as before. Rotated: the projection is affine, so the grid AABB of the four
       projected bbox corners IS the image of the bbox -- test that against the tile lattice. Tighter
       than the world-space AABB both ways: rivers reaching into the rotated corners are kept, and
       reaches sitting in the AABB's own corners (outside the frame) don't get clamped into a smear
       along the frame border. */
    const vis=PJ?(b=>{PJ.reset();const p=[PJ(b[0],b[1]),PJ(b[0],b[3]),PJ(b[2],b[1]),PJ(b[2],b[3])];   // reset: all four corners in ONE copy, else a flipped bbox spans the frame and nothing is ever culled
        let x0=1/0,y0=1/0,x1=-1/0,y1=-1/0;for(const q of p){if(q[0]<x0)x0=q[0];if(q[0]>x1)x1=q[0];if(q[1]<y0)y0=q[1];if(q[1]>y1)y1=q[1];}
        return !(x1<0||x0>W||y1<0||y0>H);}):(b=>!(b[2]<lonL||b[0]>lonR||b[3]<latB||b[1]>latT));
    const inv=[];for(const t of RTILE.values()){if(!t||t==='load')continue;for(const f of t.features){if(!vis(f.bbox))continue;inv.push(f);}}
    if(!inv.length){raw=empty;_rivMemo={key,raw,inView:0};}
    else{
      const best=new Map();for(const f of inv){const c=best.get(f.rid);if(c==null||f.d>c)best.set(f.rid,f.d);}
      const keep=new Set([...best.entries()].sort((a,b)=>b[1]-a[1]).slice(0,N).map(e=>e[0]));
      for(const rid of RIVER_ON)if(best.has(rid))keep.add(rid);   // selected rivers stay in view even below the top-N discharge cutoff
      const sel=inv.filter(f=>keep.has(f.rid));
      raw=reachesToEdges(sel,{lonL,lonR,latT,latB},W,H,PJ);
      // per-channel mouths for estuary bridging. A channel's downstream terminal is only a real
      // MOUTH if it doesn't land on another channel -- a tributary ends at a CONFLUENCE, and must
      // never go hunting for an estuary (it's usually far inland, and the search is expensive).
      const byc=new Map();for(const f of sel){(byc.get(f.rid)||byc.set(f.rid,[]).get(f.rid)).push(f);}
      const vtx=new Map();   // vertex -> channels touching it
      for(const f of sel)for(const part of f.l)for(const p of part){const k=p[0]+','+p[1];
        let s=vtx.get(k);if(!s){s=new Set();vtx.set(k,s);}s.add(f.rid);}
      const mouths=[];
      for(const [rid,rs] of byc){const firsts=new Set();for(const f of rs)for(const part of f.l)firsts.add(part[0][0]+','+part[0][1]);
        for(const f of rs)for(const part of f.l){const lp=part[part.length-1],k=lp[0]+','+lp[1];
          if(firsts.has(k))continue;                                   // continues within its own channel
          const s=vtx.get(k);let conf=false;if(s)for(const r of s)if(r!==rid){conf=true;break;}
          if(conf)continue;                                            // confluence with another channel -> not a mouth
          const pv=part.length>1?part[part.length-2]:part[0];
          mouths.push({lon:lp[0],lat:lp[1],dlon:lp[0]-pv[0],dlat:lp[1]-pv[1],rid});}}
      _rivMemo={key,raw,inView:best.size,mouths};
    }
  }
  const mouths=_rivMemo.mouths||[];
  // The cleanup + estuary trace depend on the classified tiles, so memoise on (raw, tiles, estuary flag):
  // the fine-coastline BFS is expensive and would otherwise re-run on every render and every click.
  const ck=_rivMemo.key+'|'+(riverEstuaries?1:0);
  if(_cleanMemo&&_cleanMemo.ck===ck&&_cleanMemo.tiles===tiles)return _cleanMemo.out;
  // clone (never mutate the memoised raw) and apply cleanup with the CURRENT tiles:
  // drop any edge that touches a COAST tile, or sits between two water tiles.
  const nof=new Map(raw.nof),wof=new Map(raw.wof);
  if(tiles){
    cleanupRiverEdges(nof,wof,tiles,W,H);
    if(riverEstuaries)bridgeEstuaries(nof,wof,tiles,W,H,R,mouths);   // item 6: trace mouths down the estuary, through lakes, to the sea
    cleanupRiverEdges(nof,wof,tiles,W,H);   // bridges obey the same rule: no river edge may border a sea tile
    // final pass: clear four-sided tiles + straighten hairpin wraps. A nudged-in chord edge must obey
    // the same land rule as cleanupRiverEdges, so pass it in as the edgeOk predicate.
    const isWt=(x,y)=>(x<0||x>=W||y<0||y>=H)?true:isWaterTile(tiles[y][x]);
    const isCt=(x,y)=>isShoreAt(tiles,W,H,x,y);
    nudgeRiverEdges(nof,wof,W,H,(m,key)=>{const p=key.split(',').map(Number);
      if(m==='nof'){const gr=p[0],gx=p[1];return !isCt(gx,gr)&&!isCt(gx,gr+1)&&!(isWt(gx,gr)&&isWt(gx,gr+1));}
      const gy=p[0],gx=p[1];return !isCt(gx,gy)&&!isCt(gx+1,gy)&&!(isWt(gx,gy)&&isWt(gx+1,gy));});
  }
  const out2={nof,wof};_cleanMemo={ck,tiles,out:out2};
  return out2;
}
/* Rivers never border water: drop any edge touching a shore tile (water adjacent to land on the active
   lattice; Civ4's TERRAIN_COAST) or sitting between two water tiles. Applied BEFORE and AFTER estuary bridging, so a
   bridge stops at the last land-land edge instead of running out onto the sea. */
function cleanupRiverEdges(nof,wof,tiles,W,H){
  const isW=(x,y)=>(x<0||x>=W||y<0||y>=H)?true:isWaterTile(tiles[y][x]);
  const isC=(x,y)=>isShoreAt(tiles,W,H,x,y);   // the game's shore: water touching land on the active lattice
  for(const k of [...nof.keys()]){const p=k.split(',');const gr=+p[0],gx=+p[1];
    if(isC(gx,gr)||isC(gx,gr+1)||(isW(gx,gr)&&isW(gx,gr+1)))nof.delete(k);}   // flanks: (gx,gr) N, (gx,gr+1) S
  for(const k of [...wof.keys()]){const p=k.split(',');const gy=+p[0],gx=+p[1];
    if(isC(gx,gy)||isC(gx+1,gy)||(isW(gx,gy)&&isW(gx+1,gy)))wof.delete(k);}   // flanks: (gx,gy) W, (gx+1,gy) E
}
// Drop deselected channels: they are shown (red) but never serialized.
function selectedOnly(rv){if(!rv)return rv;const nof=new Map(),wof=new Map();
  for(const [k,e] of rv.nof)if(!RIVER_OFF.has(e.rid))nof.set(k,e);
  for(const [k,e] of rv.wof)if(!RIVER_OFF.has(e.rid))wof.set(k,e);
  return {nof,wof};}
const riverLineWidth=()=>Math.max(2.5,Math.min(9,cv.width*0.0042));   // scale with the viewer, not the tile grid, so width stays sane at any out.W and stays clickable
// Blue overlay drawn along the exact tile edges that get serialized.
function drawRivers(R){
  if(!RMAN||riverN<=0||!showRivers)return;
  try{
    const tiles=(mode==='civ'&&lastTiles)?lastTiles.tiles:null;
    const {nof,wof}=computeRiverEdges(R,out.W,out.H,riverN,tiles);
    if(!nof.size&&!wof.size)return;
    const tw=cv.width/out.W,th=cv.height/out.H;
    ctx.save();ctx.lineWidth=riverLineWidth();ctx.lineCap='round';ctx.lineJoin='round';
    const stateOf=rid=>RIVER_OFF.has(rid)?'off':RIVER_ON.has(rid)?'on':'def';
    // pass order (default -> selected -> deselected) so highlighted edges paint over neighbours at crossings
    for(const st of ['def','on','off']){               // default (blue) · selected (green, kept at any zoom) · deselected (red)
      ctx.strokeStyle=st==='off'?'#e04a3a':st==='on'?'#2ec26a':'#3aa0e0';ctx.beginPath();
      for(const [k,e] of nof){if(stateOf(e.rid)!==st)continue;const p=k.split(',');const gr=+p[0],gx=+p[1];const y=(gr+1)*th;ctx.moveTo(gx*tw,y);ctx.lineTo((gx+1)*tw,y);}
      for(const [k,e] of wof){if(stateOf(e.rid)!==st)continue;const p=k.split(',');const gy=+p[0],gx=+p[1];const x=(gx+1)*tw;ctx.moveTo(x,gy*th);ctx.lineTo(x,(gy+1)*th);}
      ctx.stroke();
    }
    ctx.restore();
  }catch(e){try{ctx.restore();}catch(_){}console.error('drawRivers skipped this frame:',e);}
}
/* ---------- save destination (File System Access API where available, else classic download) ----------
   showDirectoryPicker (Chromium/WebView2) lets the user pick a folder once -- e.g. Civ4's PublicMaps --
   and every Generate writes straight into it; the handle persists across restarts via IndexedDB
   (permission is re-confirmed inside the Generate click, which is a user gesture). Where the folder API
   is missing (plain serve.py in Firefox) we fall back to showSaveFilePicker, then to an <a download>. */
const FS_DIR='showDirectoryPicker' in window, FS_SAVE='showSaveFilePicker' in window;
let saveDir=null,saveDirName='';
function idbKV(mode,fn){return new Promise((res,rej)=>{const o=indexedDB.open('terra-form',1);o.onupgradeneeded=()=>o.result.createObjectStore('kv');o.onerror=()=>rej(o.error);o.onsuccess=()=>{const db=o.result,tx=db.transaction('kv',mode);const r=fn(tx.objectStore('kv'));tx.oncomplete=()=>{db.close();res(r&&r.result);};tx.onerror=()=>{db.close();rej(tx.error);};};});}
const idbSet=(k,v)=>idbKV('readwrite',s=>s.put(v,k)),idbGet=k=>idbKV('readonly',s=>s.get(k));
async function ensureRW(h){if(!h)return false;const o={mode:'readwrite'};if(await h.queryPermission(o)==='granted')return true;return await h.requestPermission(o)==='granted';}
function saveBaseName(){let n=(document.getElementById('saveName').value||'').trim();const ext=activeGame().export.ext||'';if(ext&&n.toLowerCase().endsWith(ext.toLowerCase()))n=n.slice(0,n.length-ext.length);n=n.replace(/[\\/:*?"<>|]+/g,'_');return n||'terra_generated';}
function setDestHint(m){document.getElementById('destHint').textContent=m||'';}
function updateDestUI(){const f=document.getElementById('destFolder');if(saveDir){f.textContent=saveDirName+'\\';f.title=saveDirName;}else{f.textContent=FS_DIR?'Ask each time':(FS_SAVE?'Save As…':'Downloads');f.title='';}}
async function pickFolder(){if(!FS_DIR)return;try{const dir=await window.showDirectoryPicker({id:'terra-form-out',mode:'readwrite'});if(!await ensureRW(dir)){setDestHint('Write permission for that folder was declined.');return;}saveDir=dir;saveDirName=dir.name;try{await idbSet('saveDir',dir);}catch(_){}updateDestUI();setDestHint('Saving into "'+saveDirName+'". (Browsers expose only the folder name, not its full path.)');}catch(e){if(e&&e.name!=='AbortError')setDestHint('Could not open the folder picker: '+e.message);}}
function downloadBlob(f,prefix){const blob=f.data instanceof Blob?f.data:new Blob([f.data],{type:f.mime||'application/octet-stream'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=(prefix||'')+f.name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000);}
/* built = {files:[{name,data:string|Blob,mime}], dir?}: a game's export. One file goes through the Save As dialog when no
   folder is set; several (OpenFront's image.png + info.json) go into built.dir under the chosen folder, or download
   with the dir name as a prefix. */
async function writeFiles(built){
  const files=built.files||[];if(!files.length){setDestHint('Nothing to write.');return;}
  const names=files.map(f=>f.name).join(', '),prefix=built.dir?built.dir+'_':'';
  if(saveDir){                                                   // (1) chosen folder -> silent direct write
    if(await ensureRW(saveDir)){
      try{let dir=saveDir;if(built.dir)dir=await saveDir.getDirectoryHandle(built.dir,{create:true});
        for(const f of files){const fh=await dir.getFileHandle(f.name,{create:true}),w=await fh.createWritable();await w.write(f.data);await w.close();}
        setDestHint('Saved '+names+' → '+saveDirName+'\\'+(built.dir?built.dir+'\\':''));return;}
      catch(e){for(const f of files)downloadBlob(f,prefix);setDestHint('Could not write to "'+saveDirName+'" ('+e.message+') — downloaded '+names+' to Downloads instead.');return;}
    }
    for(const f of files)downloadBlob(f,prefix);setDestHint('Write permission for "'+saveDirName+'" was declined — downloaded '+names+' to Downloads instead.');return;
  }
  if(FS_SAVE&&files.length===1){                                 // (2) no folder set -> native Save As dialog
    const f=files[0],pt=activeGame().export.pickerType;
    try{const fh=await window.showSaveFilePicker(Object.assign({id:'terra-form-out',suggestedName:f.name},pt?{types:[pt]}:{}));const w=await fh.createWritable();await w.write(f.data);await w.close();setDestHint('Saved '+fh.name+'.');return;}
    catch(e){if(e&&e.name==='AbortError'){setDestHint('Save cancelled.');return;}}
  }
  for(const f of files)downloadBlob(f,prefix);setDestHint('Downloaded '+names+' to your browser Downloads folder.');   // (3) fallback
}
async function generate(){
  /* Compose mode exports the collage instead of the framed region: the composite is already a grid of
     evaluated tiles + merged river edges, so it drops straight into the game's exporter. Its latitudes
     are meaningless (patches come from all over the world), so COMPOSE_LAT is written as a plain span. */
  let r;
  try{r=await buildExport();}catch(e){console.error('export failed:',e);setDestHint('Export failed: '+e.message);return;}
  await writeFiles(r.built);
  if(r.note)setDestHint((document.getElementById('destHint').textContent||'')+'  '+r.note);
}
/* The game's export for the current mode plus its validation rows (shown in the Validation list). Shared by
   Generate and by TerraForm.api.export (core/bridge.js), which may hand the files to the MCP server instead of writeFiles. */
async function buildExport(){
  const g=activeGame(),region=(mode==='compose')?composeRegion():evaluateFrame();
  const ctx={mode:mode==='compose'?'compose':'frame',hex:hexMode,riverN,patches:comp.patches.length,baseName:saveBaseName()};
  const built=await g.export.build(region,ctx);
  const rows=g.export.validate?g.export.validate(region,built,ctx):[];showValidation(rows);
  return {g,region,ctx,built,rows,note:g.export.note?(g.export.note(region,ctx)||''):''};
}

(async()=>{const pf=document.getElementById('pickFolder');if(!FS_DIR){pf.style.display='none';}else{pf.addEventListener('click',pickFolder);try{const h=await idbGet('saveDir');if(h){saveDir=h;saveDirName=h.name;}}catch(_){}}updateDestUI();if(!saveDir)setDestHint(FS_DIR?'Tip: choose your Civ4 “PublicMaps” (or “…\\My Games\\Beyond the Sword\\CustomMaps”) folder to save straight there.':(FS_SAVE?'A Save As dialog will let you pick the location each time.':'This browser downloads to the default folder — move the file into Civ4’s CustomMaps/PublicMaps afterward.'));})();
function showValidation(rows){document.getElementById('validBody').innerHTML=rows.length?rows.map(r=>'<div class="vline '+(r[1]?'vok':'vwarn')+'"><span class="dot '+(r[1]?'ok':'warn')+'"></span>'+r[0]+' · <span style="color:var(--muted)">'+r[2]+'</span></div>').join(''):'<div class="vline" style="color:var(--dim)"><span>This game adds no checks.</span></div>';}

/* ---------- stats ---------- */
function fmtBlend(b){return b<=0.02?'raw height':b>=0.98?'roughness':(Math.round((1-b)*100)+'/'+Math.round(b*100)+' H·R');}
function refreshStats(){
  if(typeof updateRiverReadout==='function')updateRiverReadout();
  {const g=activeGame();if(g.ui&&g.ui.refresh)g.ui.refresh();}   // the game's own readouts
  if(typeof updateMultiReadouts==='function')updateMultiReadouts();
  {const g=activeGame();document.getElementById('stWorld').textContent=g.sizeLabel?g.sizeLabel(out.W,out.H):'—';}document.getElementById('stTiles').textContent=(out.W*out.H).toLocaleString()+'  ('+out.W+'×'+out.H+')';
  const R=srcRect();document.getElementById('stPerTile').textContent=(R.w/out.W).toFixed(1)+' × '+(R.h/out.H).toFixed(1);
  const minEdge=Math.min(R.w/out.W,R.h/out.H);document.getElementById('perTileNote').textContent=minEdge<2?'⚠ under ~2 source px/tile — upsampling; averages are noisy at this zoom.':'healthy averaging regime.';
  /* compose mode never populates lastTiles, so classifying here would run a full region pass on every
     drag frame just to fill two labels the collage doesn't describe — leave them at their last values. */
  if(mode!=='compose'){const reg=lastTiles||classifyRegion(out.W,out.H),tot=out.W*out.H;document.getElementById('stLand').textContent=Math.round(reg.land/tot*100)+'%';document.getElementById('stRelief').textContent=Math.round(reg.hills/tot*100)+'% / '+Math.round(reg.peaks/tot*100)+'%';}
  document.getElementById('vCoast').textContent=coastThr.toFixed(0)+'° wide';document.getElementById('vNudgeX').textContent=nudgeX.toFixed(2);document.getElementById('vNudgeY').textContent=nudgeY.toFixed(2);
  document.getElementById('vIsland').textContent=islandBias.toFixed(2);document.getElementById('vSeaway').textContent=seawayBias.toFixed(2);document.getElementById('vExpand').textContent=islandExpand.toFixed(2);document.getElementById('vRough').textContent=roughHalo.toFixed(2);
  document.getElementById('vPass').textContent=mtnPass.toFixed(2);document.getElementById('vFlat').textContent=flatSpots.toFixed(2);
}

/* ---------- interactions ---------- */
let raf=null;function schedule(){if(raf)return;raf=requestAnimationFrame(()=>{raf=null;render();refreshStats();});}
document.getElementById('generate').addEventListener('click',()=>{document.getElementById('exportOptions').open=true;});
document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(x=>x.setAttribute('aria-pressed','false'));t.setAttribute('aria-pressed','true');mode=t.dataset.mode;lastTiles=null;_selDraw=null;_selCursor=null;drawLegend();syncComposeUI();syncSelUI();relayout();}));   // relayout, not schedule: compose has its own grid size, so the map-box aspect changes with the mode. An in-progress stroke is abandoned: the two modes' masks live in different coordinate spaces.

/* ---------- multi-knob slider (coupled thumbs) ---------- */
/* segMode 'knots'  : thumbs ARE the boundaries -> N+1 segments split at the thumbs (relief, temperature, boreal)
   segMode 'centers': thumbs are set-points    -> N segments split at the midpoints between thumbs (dryness) */
function makeMultiSlider(el,opts){
  const {min,max,step=0.01,segColors=null,thumbColors=null,segMode='knots',independent=false,onInput}=opts;
  const values=opts.values.slice(),n=values.length,nSeg=segMode==='centers'?n:n+1;
  el.classList.add('mslider');el.innerHTML='';
  const track=document.createElement('div');track.className='mslider-track';el.appendChild(track);
  const segs=[];for(let s=0;s<nSeg;s++){const d=document.createElement('div');d.className='mslider-seg';if(segColors&&segColors[s])d.style.background=segColors[s];track.appendChild(d);segs.push(d);}
  const thumbs=values.map((_,ti)=>{const t=document.createElement('div');t.className='mslider-thumb';t.tabIndex=0;t.setAttribute('role','slider');t.setAttribute('aria-valuemin',min);t.setAttribute('aria-valuemax',max);if(thumbColors&&thumbColors[ti])t.style.background=thumbColors[ti];el.appendChild(t);return t;});
  const pct=v=>(v-min)/(max-min)*100;
  const round=v=>Math.max(min,Math.min(max,+(Math.round(v/step)*step).toFixed(6)));
  function layout(){
    values.forEach((v,i)=>{thumbs[i].style.left=pct(v)+'%';thumbs[i].setAttribute('aria-valuenow',v);});
    for(let s=0;s<nSeg;s++){
      let lo,hi;
      if(segMode==='centers'){lo=s===0?0:(pct(values[s-1])+pct(values[s]))/2;hi=s===n-1?100:(pct(values[s])+pct(values[s+1]))/2;}
      else{lo=s===0?0:pct(values[s-1]);hi=s===n?100:pct(values[s]);}
      segs[s].style.left=lo+'%';segs[s].style.width=Math.max(0,hi-lo)+'%';
    }
  }
  function set(i,raw){
    const v=independent?round(raw):Math.max(i>0?values[i-1]:min,Math.min(i<n-1?values[i+1]:max,round(raw)));   // coupling keeps thumbs ordered unless independent
    if(v===values[i])return;values[i]=v;layout();onInput&&onInput(values.slice(),i);
  }
  const xToVal=cx=>{const r=el.getBoundingClientRect();return min+((cx-r.left)/r.width)*(max-min);};
  const nearest=cx=>{const r=el.getBoundingClientRect(),f=(cx-r.left)/r.width*100;let bi=0,bd=1e9;values.forEach((v,i)=>{const d=Math.abs(pct(v)-f);if(d<bd){bd=d;bi=i;}});return bi;};
  let active=-1;
  el.addEventListener('pointerdown',e=>{const i=e.target.classList.contains('mslider-thumb')?thumbs.indexOf(e.target):nearest(e.clientX);active=i;thumbs[i].focus();try{el.setPointerCapture(e.pointerId);}catch{}set(i,xToVal(e.clientX));e.preventDefault();});
  el.addEventListener('pointermove',e=>{if(active<0)return;set(active,xToVal(e.clientX));});
  const end=e=>{active=-1;try{el.releasePointerCapture(e.pointerId);}catch{}};
  el.addEventListener('pointerup',end);el.addEventListener('pointercancel',end);
  thumbs.forEach((t,i)=>t.addEventListener('keydown',e=>{let d=0;const k=e.key;if(k==='ArrowLeft'||k==='ArrowDown')d=-step;else if(k==='ArrowRight'||k==='ArrowUp')d=step;else if(k==='PageDown')d=-step*10;else if(k==='PageUp')d=step*10;else return;e.preventDefault();set(i,values[i]+d);}));
  layout();
  return {get:()=>values.slice(),set:vs=>{for(let i=0;i<vs.length;i++)values[i]=round(vs[i]);layout();}};
}
const TC={hills:'rgba(120,138,88,.5)',peak:'rgba(180,186,190,.65)'};
function fmt2(v){return v.toFixed(2);}
function updateMultiReadouts(){
  document.getElementById('vBlend').innerHTML='hills <b>'+fmtBlend(P.blendHill)+'</b> · peak <b>'+fmtBlend(P.blendPeak)+'</b>';
  document.getElementById('vRelief').innerHTML='hills <b>'+fmt2(P.hill)+'</b> · peak <b>'+fmt2(P.peak)+'</b>';
}
const commit=()=>{lastTiles=null;updateMultiReadouts();schedule();};
const reliefMS=makeMultiSlider(document.getElementById('reliefRange'),{min:0,max:1,step:0.005,values:[P.hill,P.peak],segMode:'knots',segColors:['',TC.hills,TC.peak],
  onInput:v=>{P.hill=v[0];P.peak=v[1];commit();}});
// relief BASIS: two independent thumbs (green = hills basis, grey = peak basis), 0 = raw height .. 1 = roughness
const reliefBasisMS=makeMultiSlider(document.getElementById('reliefBasisRange'),{min:0,max:1,step:0.02,values:[P.blendHill,P.blendPeak],independent:true,segMode:'centers',thumbColors:['#7e9a52','#b9bfc4'],
  onInput:v=>{P.blendHill=v[0];P.blendPeak=v[1];commit();}});
document.querySelectorAll('.seg button[data-blend]').forEach(b=>b.addEventListener('click',()=>{const v=parseFloat(b.dataset.blend);P.blendHill=v;P.blendPeak=v;reliefBasisMS.set([v,v]);commit();}));
updateMultiReadouts();
const coastThrEl=document.getElementById('coastThr');
coastThrEl.addEventListener('input',()=>{coastThr=parseFloat(coastThrEl.value);lastTiles=null;schedule();});
const riverNEl=document.getElementById('riverN');
function updateRiverReadout(){const el=document.getElementById('vRiverN');if(!el)return;el.textContent=(riverN<=0?'off':'top '+riverN)+((RMAN&&riverN>0)?' / '+_rivMemo.inView+' in view':'');}
riverNEl.addEventListener('input',()=>{riverN=parseInt(riverNEl.value)||0;updateRiverReadout();render();});updateRiverReadout();
document.getElementById('riverEstuaries').addEventListener('change',e=>{riverEstuaries=e.target.checked;render();});
/* aspect changes -> full relayout, not just render. Toggling hex also re-snaps every placed patch:
   patches parked on odd rows while square would land their shifted rows on unshifted ones and mirror
   the hex adjacency inside them (see composeSnapY). */
/* the lattice (square / hex) now follows the game: see setGame() */
document.getElementById('nudgeX').addEventListener('input',e=>{nudgeX=parseFloat(e.target.value);document.getElementById('vNudgeX').textContent=nudgeX.toFixed(2);lastTiles=null;schedule();});
document.getElementById('nudgeY').addEventListener('input',e=>{nudgeY=parseFloat(e.target.value);document.getElementById('vNudgeY').textContent=nudgeY.toFixed(2);lastTiles=null;schedule();});
document.getElementById('islandBias').addEventListener('input',e=>{islandBias=parseFloat(e.target.value);document.getElementById('vIsland').textContent=islandBias.toFixed(2);lastTiles=null;schedule();});
document.getElementById('seawayBias').addEventListener('input',e=>{seawayBias=parseFloat(e.target.value);document.getElementById('vSeaway').textContent=seawayBias.toFixed(2);lastTiles=null;schedule();});
document.getElementById('mtnPass').addEventListener('input',e=>{mtnPass=parseFloat(e.target.value);document.getElementById('vPass').textContent=mtnPass.toFixed(2);lastTiles=null;schedule();});
document.getElementById('flatSpots').addEventListener('input',e=>{flatSpots=parseFloat(e.target.value);document.getElementById('vFlat').textContent=flatSpots.toFixed(2);lastTiles=null;schedule();});
document.getElementById('islandExpand').addEventListener('input',e=>{islandExpand=parseFloat(e.target.value);document.getElementById('vExpand').textContent=islandExpand.toFixed(2);lastTiles=null;schedule();});
const expandSteepEl=document.getElementById('expandSteep');
expandSteepEl.addEventListener('input',()=>{expandSteep=Math.max(0.2,Math.min(8,parseFloat(expandSteepEl.value)||1));lastTiles=null;schedule();});
expandSteepEl.addEventListener('wheel',e=>{e.preventDefault();expandSteep=Math.max(0.2,Math.min(8,+(expandSteep+(e.deltaY<0?0.1:-0.1)).toFixed(1)));expandSteepEl.value=expandSteep;lastTiles=null;schedule();},{passive:false});
const expandMaxMultEl=document.getElementById('expandMaxMult');
expandMaxMultEl.addEventListener('input',()=>{expandMaxMult=Math.max(1,Math.min(5,parseFloat(expandMaxMultEl.value)||1.5));lastTiles=null;schedule();});
expandMaxMultEl.addEventListener('wheel',e=>{e.preventDefault();expandMaxMult=Math.max(1,Math.min(5,+(expandMaxMult+(e.deltaY<0?0.1:-0.1)).toFixed(1)));expandMaxMultEl.value=expandMaxMult;lastTiles=null;schedule();},{passive:false});
document.getElementById('roughHalo').addEventListener('input',e=>{const pp=parseFloat(e.target.value);roughHalo=pp<=0?0:HALO_LOG_MIN*Math.pow(1/HALO_LOG_MIN,pp);document.getElementById('vRough').textContent=roughHalo.toFixed(2);curRoughK=-1;lastTiles=null;schedule();});

/* output grid: typing, wheel-scroll, aspect lock — changing W/H reshapes the viewer to match */
const owEl=document.getElementById('ow'),ohEl=document.getElementById('oh');
function syncInputs(){owEl.value=out.W;ohEl.value=out.H;}
function afterGridChange(){syncInputs();lastTiles=null;relayout();}
function setW(v){const G=activeGame().grid;out.W=snapDim(v,G.min.W,G.max.W,G.step);if(lockAR)out.H=snapDim(out.W/arRatio,G.min.H,G.max.H,G.step);afterGridChange();}
function setH(v){const G=activeGame().grid;out.H=snapDim(v,G.min.H,G.max.H,G.step);if(lockAR)out.W=snapDim(out.H*arRatio,G.min.W,G.max.W,G.step);afterGridChange();}
owEl.addEventListener('input',()=>setW(parseFloat(owEl.value)));
ohEl.addEventListener('input',()=>setH(parseFloat(ohEl.value)));
owEl.addEventListener('wheel',e=>{e.preventDefault();setW(out.W+(e.deltaY<0?1:-1)*(e.shiftKey?10:1)*(activeGame().grid.step||1));},{passive:false});
ohEl.addEventListener('wheel',e=>{e.preventDefault();setH(out.H+(e.deltaY<0?1:-1)*(e.shiftKey?10:1)*(activeGame().grid.step||1));},{passive:false});
const lockBtn=document.getElementById('lockAR');
lockBtn.addEventListener('click',()=>{lockAR=!lockAR;lockBtn.setAttribute('aria-pressed',lockAR?'true':'false');lockBtn.innerHTML=lockAR?'&#128274;':'&#128275;';if(lockAR)arRatio=out.W/out.H;});

document.getElementById('tgGrid').addEventListener('change',e=>{showGrid=e.target.checked;render();});
document.getElementById('tgGrat').addEventListener('change',e=>{showGrat=e.target.checked;render();});
document.getElementById('zin').addEventListener('click',()=>{view.spanX*=0.7;clampView();lastTiles=null;schedule();});
document.getElementById('zout').addEventListener('click',()=>{view.spanX/=0.7;clampView();lastTiles=null;schedule();});
document.getElementById('zreset').addEventListener('click',()=>{view={cx:WSRC/2,cy:HSRC/2,spanX:1e9,rot:0};clampView();lastTiles=null;schedule();});
document.getElementById('regen').addEventListener('click',()=>{generateWorld((Math.random()*1e6)|0);repaintLayers();lastTiles=null;render();refreshStats();});
document.getElementById('generate').addEventListener('click',generate);

/* pan + cursor-anchored wheel zoom */
let drag=null,dragMoved=false;
document.getElementById('tgRivers').addEventListener('change',e=>{showRivers=e.target.checked;render();});
/* Hit test in client pixels, so the clickable band matches the drawn line width regardless of out.W. */
function riverHitAt(clientX,clientY){
  if(!RMAN||riverN<=0||!showRivers)return null;
  const tiles=(mode==='civ'&&lastTiles)?lastTiles.tiles:null;
  let rv;try{rv=computeRiverEdges(srcRect(),out.W,out.H,riverN,tiles);}catch(_){return null;}
  const r=mapBox.getBoundingClientRect();if(!r.width||!r.height)return null;
  const sx=r.width/out.W,sy=r.height/out.H,mx=clientX-r.left,my=clientY-r.top;
  const drawn=riverLineWidth()*(r.width/(cv.width||r.width));
  let best=null,bd=Math.max(7,drawn*1.6);                                  // grab band ~ the drawn width
  const segd=(x1,y1,x2,y2)=>{const dx=x2-x1,dy=y2-y1,L=dx*dx+dy*dy;
    let t=L?((mx-x1)*dx+(my-y1)*dy)/L:0;t=t<0?0:t>1?1:t;
    return Math.hypot(mx-(x1+t*dx),my-(y1+t*dy));};
  for(const [k,ed] of rv.nof){const p=k.split(',');const gr=+p[0],gx=+p[1];
    const d=segd(gx*sx,(gr+1)*sy,(gx+1)*sx,(gr+1)*sy);if(d<bd){bd=d;best=ed.rid;}}
  for(const [k,ed] of rv.wof){const p=k.split(',');const gy=+p[0],gx=+p[1];
    const d=segd((gx+1)*sx,gy*sy,(gx+1)*sx,(gy+1)*sy);if(d<bd){bd=d;best=ed.rid;}}
  return best;
}
/* Click a river to cycle its state: default (blue, WYSIWYG top-N) -> deselected (red, never written)
   -> selected (green, kept on the map at any zoom and always written) -> default. */
mapBox.addEventListener('click',e=>{
  if(dragMoved)return;
  if(mode==='compose')return;   // compose owns the pointer in its own mode (place / select / drag patches)
  if(selTool!=='none')return;   // a selection tool owns the pointer too: a click is a lasso vertex, not a river toggle
  const rid=riverHitAt(e.clientX,e.clientY);if(rid==null)return;
  if(RIVER_OFF.has(rid)){RIVER_OFF.delete(rid);RIVER_ON.add(rid);}      // deselected -> selected
  else if(RIVER_ON.has(rid)){RIVER_ON.delete(rid);}                     // selected -> default
  else{RIVER_OFF.add(rid);}                                             // default -> deselected
  render();
});
let _hoverT=0;
mapBox.addEventListener('mousemove',e=>{           // cursor hints that rivers are clickable
  if(drag||mode==='compose'||selTool!=='none')return;const now=performance.now();if(now-_hoverT<50)return;_hoverT=now;
  mapBox.style.cursor=riverHitAt(e.clientX,e.clientY)!=null?'pointer':'';
});
mapBox.addEventListener('mouseleave',()=>{if(selTool==='none')mapBox.style.cursor='';});
/* Plain drag pans; CTRL+drag rotates the world about the frame centre (-180..180]. Rotation happens
   BEFORE capture, so snapshots arrive in compose already rotated at full sampling fidelity. */
function rotDragAngle(e){const r=mapBox.getBoundingClientRect();return Math.atan2(e.clientY-(r.top+r.height/2),e.clientX-(r.left+r.width/2))*180/Math.PI;}
const ROT_SOFT_SNAP=3;   // degrees: snap to 0/±90/180 when this close (Shift: hard 15° detents)
mapBox.addEventListener('mousedown',e=>{if(mode==='compose'||selTool!=='none')return;
  if(e.ctrlKey){drag={kind:'rot',rot0:view.rot||0,a0:rotDragAngle(e)};dragMoved=false;mapBox.classList.add('dragging');return;}
  drag={x:e.clientX,y:e.clientY};dragMoved=false;mapBox.classList.add('dragging');});   // no view panning in compose (no geographic frame) or while a selection tool is armed (the drag draws the mask)
window.addEventListener('mouseup',()=>{drag=null;mapBox.classList.remove('dragging');});
window.addEventListener('mousemove',e=>{if(!drag)return;
  if(drag.kind==='rot'){
    dragMoved=true;
    let rot=drag.rot0-(rotDragAngle(e)-drag.a0);              // minus: the world follows the cursor
    if(e.shiftKey)rot=Math.round(rot/15)*15;
    else for(const s of [-180,-90,0,90,180])if(Math.abs(rot-s)<=ROT_SOFT_SNAP)rot=s;
    view.rot=normDeg(rot);clampView();lastTiles=null;schedule();return;
  }
  const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)>2||Math.abs(dy)>2)dragMoved=true;drag={x:e.clientX,y:e.clientY};const r=mapBox.getBoundingClientRect();
  const a=rotRad(),c=Math.cos(a),s=Math.sin(a),fdx=dx*(view.spanX/r.width),fdy=dy*(spanY()/r.height);
  view.cx-=c*fdx-s*fdy;view.cy-=s*fdx+c*fdy;               // screen delta rotated into world space, so the map follows the cursor at any rotation
  clampView();lastTiles=null;schedule();});
mapBox.addEventListener('dblclick',e=>{if(mode==='compose'||selTool!=='none'||!e.ctrlKey)return;view.rot=0;clampView();lastTiles=null;schedule();});   // ctrl+double-click: reset rotation
mapBox.addEventListener('wheel',e=>{if(mode==='compose')return;e.preventDefault();const r=mapBox.getBoundingClientRect(),px=(e.clientX-r.left)*(cv.width/r.width),py=(e.clientY-r.top)*(cv.height/r.height);
  const [ux,uy]=canvasToWorld(srcRect(),px,py);view.spanX*=(e.deltaY<0?0.85:1/0.85);clampView();
  const [nx,ny]=canvasToWorld(srcRect(),px,py);view.cx+=ux-nx;view.cy+=uy-ny;clampView();lastTiles=null;schedule();},{passive:false});

/* ---------- selection input (shared by the geographic viewers and the compose canvas) ----------
   One gesture vocabulary in both places:
     box    — press, drag, release.
     lasso  — click, click, click… lays down vertices; click the first vertex again (or Enter /
              double-click) to close. Press-and-DRAG instead lays down a continuous freehand outline
              and closes it on release.
   Click-vs-drag is decided by how far the pointer travelled before release (SEL_DRAG_PX), so the two
   lasso styles share one mousedown without a modifier key. Listeners are capture-phase on window for
   the same reason the compose drag ones are: a stroke must survive the pointer leaving the map. */
const SEL_DRAG_PX=4;         // travel (canvas px) past which a press counts as a drag, not a click
const selClosePx=()=>Math.max(10,cv.width*0.012);   // click within this of the first vertex closes an open lasso; scales with the backing store so the target stays the same size on screen at any DPR
const SEL_FREEHAND_PX=3;     // minimum spacing between sampled freehand points, to keep polygons light
/* The selection's own space differs per mode, so every gesture converts through here. */
function selSpacePoint(e){
  const r=mapBox.getBoundingClientRect();if(!r.width||!r.height)return null;
  const px=(e.clientX-r.left)*(cv.width/r.width),py=(e.clientY-r.top)*(cv.height/r.height);
  if(mode==='compose'){const geo=composeGeo();
    return [(px-geo.ox)/geo.tw, geo.hex?((py-geo.oy-geo.s)/geo.th+0.5):((py-geo.oy)/geo.th)];}   // fractional tile coords
  return canvasToWorld(srcRect(),px,py);
}
function selCanvasPoint(e){
  const r=mapBox.getBoundingClientRect();if(!r.width||!r.height)return null;
  return [(e.clientX-r.left)*(cv.width/r.width),(e.clientY-r.top)*(cv.height/r.height)];
}
function selRepaint(){if(mode==='compose'){if(_compDeps&&_compDeps.rerender)_compDeps.rerender();else render();}else schedule();}
function selCommit(s){setActiveSel(selIsUsable(s)?s:null);_selDraw=null;_selCursor=null;syncSelUI();selRepaint();}
function selCancel(){_selDraw=null;_selCursor=null;syncSelUI();selRepaint();}
function selOnDown(e){
  if(selTool==='none'||e.button!==0)return;
  const p=selSpacePoint(e),c=selCanvasPoint(e);if(!p||!c)return;
  e.stopPropagation();if(e.cancelable)e.preventDefault();
  if(selTool==='rect'){_selDraw={kind:'rect',pts:[p,p],anchor:c,moved:false,open:false,frame:mode!=='compose'};return;}
  if(_selDraw&&_selDraw.open){                       // continuing a click-by-click polygon
    const first=_selDraw.pts[0],fc=selToCanvas(first);
    if(_selDraw.pts.length>=3&&fc&&Math.hypot(c[0]-fc[0],c[1]-fc[1])<=selClosePx()){selCommit({kind:'lasso',pts:_selDraw.pts.slice()});return;}
    _selDraw.pts.push(p);_selDraw.anchor=c;_selDraw.moved=false;selRepaint();return;
  }
  _selDraw={kind:'lasso',pts:[p],anchor:c,moved:false,open:true};   // stays open until we learn it is a drag
  selRepaint();
}
function selToCanvas(p){
  if(mode==='compose'){const geo=composeGeo();return [geo.ox+p[0]*geo.tw, geo.hex?(geo.oy+geo.s+(p[1]-0.5)*geo.th):(geo.oy+p[1]*geo.th)];}
  const R=srcRect();return worldToCanvas(R)(p[0],p[1]);
}
/* The button state is what separates the two lasso styles, and it must be checked on every move:
   between the clicks of a click-by-click polygon the pointer travels just as far as it does during a
   freehand drag, so distance alone cannot tell them apart. With the button UP a move only slides the
   rubber band; the stroke itself is extended (or converted to freehand) solely while it is HELD. */
function selOnMove(e){
  if(selTool==='none')return;
  const p=selSpacePoint(e),c=selCanvasPoint(e);if(!p||!c)return;
  _selCursor=p;
  if(!_selDraw)return;
  const held=(e.buttons&1)===1;
  const far=_selDraw.anchor&&Math.hypot(c[0]-_selDraw.anchor[0],c[1]-_selDraw.anchor[1])>SEL_DRAG_PX;
  if(_selDraw.kind==='rect'){if(held){if(far)_selDraw.moved=true;_selDraw.pts[1]=p;}selRepaint();return;}
  if(!held){selRepaint();return;}                                                            // open polygon awaiting its next vertex
  if(far&&!_selDraw.moved){_selDraw.moved=true;_selDraw.open=false;_selDraw.freehand=true;}   // a HELD press that travels is a freehand stroke
  if(_selDraw.freehand){
    const last=_selDraw.pts[_selDraw.pts.length-1],lc=selToCanvas(last);
    if(!lc||Math.hypot(c[0]-lc[0],c[1]-lc[1])>=SEL_FREEHAND_PX)_selDraw.pts.push(p);
  }
  selRepaint();
}
function selOnUp(e){
  if(selTool==='none'||!_selDraw)return;
  if(_selDraw.kind==='rect'){const s=_selDraw;_selDraw=null;selCommit(s.moved?{kind:'rect',pts:s.pts.slice(),frame:s.frame}:null);return;}
  if(_selDraw.freehand){const s=_selDraw;_selDraw=null;selCommit({kind:'lasso',pts:s.pts.slice()});return;}
  selRepaint();   // a plain click: the polygon stays open, waiting for the next vertex
}
function selOnDblClick(e){if(selTool==='lasso'&&_selDraw&&_selDraw.open&&_selDraw.pts.length>=3){e.stopPropagation();selCommit({kind:'lasso',pts:_selDraw.pts.slice()});}}
function selOnKey(e){
  const ae=document.activeElement,tn=ae?(ae.tagName||'').toLowerCase():'';
  if(tn==='input'||tn==='textarea'||tn==='select'||(ae&&ae.isContentEditable))return;
  if(e.key==='Escape'&&_selDraw){e.preventDefault();selCancel();return;}
  if(e.key==='Enter'&&_selDraw&&_selDraw.open&&_selDraw.pts.length>=3){e.preventDefault();selCommit({kind:'lasso',pts:_selDraw.pts.slice()});return;}
}
mapBox.addEventListener('mousedown',selOnDown,true);
mapBox.addEventListener('dblclick',selOnDblClick,true);
window.addEventListener('mousemove',selOnMove,true);
window.addEventListener('mouseup',selOnUp,true);
window.addEventListener('keydown',selOnKey);

/* ---------- selection toolbar ---------- */
function setSelTool(t){
  if(selTool===t)t='none';                                  // clicking the armed tool disarms it
  selTool=t;_selDraw=null;_selCursor=null;
  mapBox.style.cursor=selTool==='none'?'':'crosshair';
  syncSelUI();selRepaint();
}
function clearSelection(){setActiveSel(null);_selDraw=null;_selCursor=null;syncSelUI();selRepaint();}
function syncSelUI(){
  document.querySelectorAll('#selTools [data-sel]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.sel===selTool?'true':'false'));
  const s=activeSel(),n=document.getElementById('selNote');
  document.getElementById('selClear').disabled=!s;
  if(!n)return;
  if(_selDraw&&_selDraw.open)n.textContent='lasso: click to add points · click the first point, Enter or double-click to close · Esc cancels';
  else if(!s)n.textContent=selTool==='none'?'':(selTool==='rect'?'box: drag a rectangle over the map':'lasso: click points, or press and drag to draw freehand');
  else{const b=selBounds(s);n.textContent=(mode==='compose'?'mask · ':'capture mask · ')+(s.kind==='rect'?'box':'lasso '+s.pts.length+' pts')
    +(mode==='compose'?' · Del fills with '+(defaultTileKind==='peak'?'mountains':'ocean'):' · capture crops to it');}
}

/* ---------- legend (per mode) ---------- */
function rampCSS(stops){return 'linear-gradient(90deg,'+stops.map(s=>'rgb('+s[1].map(v=>v|0).join(',')+') '+(s[0]*100).toFixed(0)+'%').join(',')+')';}
function drawLegend(){const el=document.getElementById('legend');
  if(mode==='civ'||mode==='compose'){el.innerHTML=activeGame().preview.legend().map(it=>'<div class="lg"><span class="sw" style="background:'+(it[1]?'rgb('+it[1].join(',')+')':'transparent;text-align:center;line-height:12px')+'">'+(it[2]||'')+'</span>'+it[0]+'</div>').join('');}   // [label, [r,g,b]] or [label, null, glyph text]
  else if(mode==='roughness'){el.innerHTML='<div class="lg"><span class="ramp" style="background:'+rampCSS(HEAT)+'"></span>low &rarr; high relief</div>';}
  else if(mode==='elevation'){el.innerHTML='<div class="lg"><span class="ramp" style="background:'+rampCSS(HYPS_SEA)+'"></span>bathymetry</div><div class="lg"><span class="ramp" style="background:'+rampCSS(HYPS_LAND)+'"></span>elevation</div>';}
  else if(mode==='climate'){const keys=['Af','BWh','Cfb','Dfb','ET','EF'];el.innerHTML=keys.map(k=>'<div class="lg"><span class="sw" style="background:rgb('+BECK2018[k].join(',')+')"></span>'+k+'</div>').join('')+'<div class="lg"><span class="sw" style="background:#fff"></span>ocean</div><div class="lg" style="color:var(--dim)">Beck et al. 2023</div>';}
  else{el.innerHTML='<div class="lg" style="color:var(--dim)">real elevation, coastline &amp; '+(satLoaded?'satellite colour (Blue Marble)':'procedural climate colour')+'</div>';}
}

/* ---------- COMPOSE MODE: collage a world out of frozen snapshots ----------
   A snapshot is an already-evaluated tile grid (its own sliders, its own frame) that the user
   parks on a blank canvas map. Compose owns nothing geographic: no lat/lon, no rasters, no
   classify pass. It is pure grid arithmetic — stamp tiles, re-key river edges, heal the seams.
   The composite is what gets serialized, so it must obey the same invariants classifyRegion
   produces (coast ring around every landmass, no river on a water edge); hence the two repair
   passes at the end of compositeCompose. */
/* patch = {id,snap,x,y,landOnly}; array order IS z-order (later = on top).
   `erased` is a sparse "y,x" set painted by mask+Delete and applied AFTER every patch is stamped, so
   an erasure survives moving the patches underneath it — it is a property of the canvas, not of a patch. */
let comp={W:60,H:40,patches:[],sel:null,nextId:1,erased:new Set(),eraseGen:0};
let _compMemo=null;          // {sig,out} — the composite is rebuilt on every drag mousemove, so memoise it
let _compDeps=null,_compBound=false;
let _compPending=null;       // snapshot picked in the shelf, following the cursor, not yet placed
let _compGhost=null;         // {snap,x,y} tile-space position of whatever is being previewed (pending or dragged)
let _compDrag=null;          // {id,tx,ty,x0,y0,moved} — tile-space anchor so the patch never jumps under the cursor
let _compHover=null;         // patch id under the cursor, for the grab cursor

/* ---------- snapshot readers ----------
   The shelf hands snapshots in their JSON-safe form: tiles flat row-major, river maps as [k,v]
   entry arrays. Never assume they have been rehydrated — and never mutate them, a snapshot is
   shared by every patch that references it. */
function composeTileReader(s){const two=Array.isArray(s.tiles[0]);return two?function(x,y){return s.tiles[y][x];}:function(x,y){return s.tiles[y*s.W+x];};}
function composeEdgeEntries(r){return !r?[]:(typeof r.forEach==='function'&&typeof r.set==='function')?Array.from(r):r;}
function composeOceanTile(){return defaultTile();}   // the blank canvas is whatever the default-tile toggle says: sea, or a slab of mountain to carve into
function composeCopyTile(t,foreignGame){const c=Object.assign({},t);if(t.rgb)c.rgb=[t.rgb[0],t.rgb[1],t.rgb[2]];if(foreignGame)c._g=foreignGame;return c;}   // _g: the tile came from another game's snapshot (the preview paints it magenta; the export writes it as it is)   // a tile is the game's own object; copy it flat so stamping never aliases a snapshot

/* ---------- compositing ---------- */
/* eraseGen, not erased.size: erasing one region and then another of equal size would leave the size
   unchanged and serve a stale composite. A monotonic counter can't collide. */
function composeSig(){let s=comp.W+'x'+comp.H+':'+defaultTileKind+':e'+comp.eraseGen+':r'+(comp.riverGen|0);for(const p of comp.patches)s+='|'+p.id+':'+p.x+','+p.y+':'+(p.landOnly?1:0)+':'+(p.snap&&p.snap.id)+':'+(p.editGen|0);return s;}   // editGen / riverGen: bumped by the per-patch and canvas river edits (TerraForm.api.compose), so the memo cannot serve a stale composite
function composeInvalidate(){_compMemo=null;}
/* Translating a river edge is a pure re-key: the map keys are grid coordinates and `dir` is an
   ABSOLUTE cardinal, so moving a patch east by 3 tiles cannot rotate its rivers. No direction
   math here, deliberately — see the nof/wof contract. */
function composeMergeEdges(dst,ents,px,py,W,H,keep){
  for(let i=0;i<ents.length;i++){
    const c=(''+ents[i][0]).split(','),ly=+c[0],lx=+c[1],gy=ly+py,gx=lx+px,v=ents[i][1];
    if(gx<0||gx>=W||gy<0||gy>=H)continue;                        // edge slid off the canvas
    if(keep&&!keep(lx,ly))continue;                               // per-patch river edit (trim) or a flank the patch does not stamp (ragged seam)
    dst.set(gy+','+gx,{dir:v.dir,d:v.d,rid:v.rid,bridge:v.bridge});   // later patch wins a collision, matching tile z-order
  }
}
/* Per-patch edits the MCP bridge makes (core/bridge.js): p.skip is a Set of the patch's own flat tile indices
   it must NOT stamp (a ragged seam cut through an overlap, or a feathered mask edge); p.riverSkip a Set of
   'n:gy,gx' / 'w:gy,gx' local edge keys to drop (trim_rivers). comp.riverAdd holds canvas-space edges added
   on top of every patch (extend_river): [kind, 'gy,gx', {dir,d,rid}]. All three are properties of the
   collage, serialized with it, and never touch the snapshots. */
function patchKeep(p,s){
  const sk=p.skip,rs=p.riverSkip;if(!sk&&!rs)return null;
  const skipped=(x,y)=>!!(sk&&x>=0&&y>=0&&x<s.W&&y<s.H&&sk.has(y*s.W+x));
  return {n:(lx,ly)=>!(rs&&rs.has('n:'+ly+','+lx))&&!skipped(lx,ly)&&!skipped(lx,ly-1),   // north edge of (lx,ly): flanks (lx,ly-1) and (lx,ly)
          w:(lx,ly)=>!(rs&&rs.has('w:'+ly+','+lx))&&!skipped(lx,ly)&&!skipped(lx-1,ly)};  // west edge of (lx,ly): flanks (lx-1,ly) and (lx,ly)
}
function compositeCompose(){
  const sig=composeSig();
  if(_compMemo&&_compMemo.sig===sig)return _compMemo.out;
  const W=comp.W,H=comp.H,tiles=new Array(H);
  for(let y=0;y<H;y++){const row=new Array(W);for(let x=0;x<W;x++)row[x]=composeOceanTile();tiles[y]=row;}   // fresh object per tile: the game's finalize pass mutates them in place
  const nof=new Map(),wof=new Map();
  for(const p of comp.patches){
    const s=p.snap;if(!s||!s.tiles)continue;
    const at=composeTileReader(s),foreign=snapshotGameId(s)!==activeGame().id?snapshotGameId(s):null,sk=p.skip,keep=patchKeep(p,s);
    for(let sy=0;sy<s.H;sy++){const dy=p.y+sy;if(dy<0||dy>=H)continue;
      for(let sx=0;sx<s.W;sx++){const dx=p.x+sx;if(dx<0||dx>=W)continue;
        const t=at(sx,sy);if(!t)continue;
        if(sk&&sk.has(sy*s.W+sx))continue;                       // ragged seam / feathered cut edge: this tile is left to whatever lies below
        /* landOnly (the default) makes a patch a cut-out of its own coastline rather than a
           rectangle: the snapshot's sea is skipped so patches can be nudged together until
           their landmasses nearly touch without one's ocean punching a hole in the other's
           continent. Turn it off to stamp the rectangle verbatim (useful to carve a sea). */
        if(p.landOnly&&isWaterTile(t))continue;
        tiles[dy][dx]=composeCopyTile(t,foreign);}}
    composeMergeEdges(nof,composeEdgeEntries(s.rivers&&s.rivers.nof),p.x,p.y,W,H,keep&&keep.n);
    composeMergeEdges(wof,composeEdgeEntries(s.rivers&&s.rivers.wof),p.x,p.y,W,H,keep&&keep.w);
  }
  if(comp.riverAdd&&comp.riverAdd.length)for(const [kind,k,v] of comp.riverAdd){const c=k.split(','),gy=+c[0],gx=+c[1];if(gx<0||gx>=W||gy<0||gy>=H)continue;(kind==='w'?wof:nof).set(gy+','+gx,{dir:v.dir,d:v.d,rid:v.rid,bridge:v.bridge});}   // extend_river: canvas-space edges over every patch
  /* Erasures are applied after every patch, so they read as holes punched in the finished collage
     rather than edits to any one snapshot — drag a patch out from under an erased area and the hole
     stays where it was drawn. River edges flanking an erased tile go with it, for the same reason
     maskFrame drops them: with a land default, cleanupRiverEdges would let them survive in the fill. */
  if(comp.erased.size){
    for(const k of comp.erased){const p=k.split(','),y=+p[0],x=+p[1];
      if(x<0||x>=W||y<0||y>=H)continue;tiles[y][x]=defaultTile();}
    const er=(x,y)=>comp.erased.has(y+','+x);
    for(const k of [...nof.keys()]){const p=k.split(','),gy=+p[0],gx=+p[1];if(er(gx,gy)||er(gx,gy+1))nof.delete(k);}
    for(const k of [...wof.keys()]){const p=k.split(','),gy=+p[0],gx=+p[1];if(er(gx,gy)||er(gx+1,gy))wof.delete(k);}
  }
  /* Both repair passes MUST run on the composite, not per patch: a snapshot's coast ring was
     computed against its own sea, and that sea may now be another patch's land (the ring has to
     become inland terrain-adjacent... i.e. re-derived) or the canvas ocean may now touch land it
     never saw. finalizeTiles lets the game re-derive its shore from the flattened tiles; cleanupRiverEdges
     then drops the edges that the reshuffle left flanked by water/coast, which Civ4 rejects. */
  finalizeTiles(tiles,W,H);
  cleanupRiverEdges(nof,wof,tiles,W,H);
  const out2={tiles,rivers:{nof,wof},W,H};
  _compMemo={sig,out:out2};
  return out2;
}

/* ---------- rendering ---------- */
function composeSelPatch(){return composePatchById(comp.sel);}
function composePatchById(id){if(id==null)return null;for(const p of comp.patches)if(p.id===id)return p;return null;}
function composeDpr(){return cv.width/Math.max(1,mapBox.clientWidth||cv.width);}   // canvas is backing-store sized; text/handles must scale with it or they shrink on hidpi
/* Patch outline in canvas pixels. In hex the block is ragged, so this is the bounding box:
   odd rows lean half a tile east (hence +0.5 tw of width) and hexes overhang their row band by
   s-th/2 top and bottom. */
function composePatchRect(geo,p){
  if(!geo.hex)return [geo.ox+p.x*geo.tw,geo.oy+p.y*geo.th,p.snap.W*geo.tw,p.snap.H*geo.th];
  return [geo.ox+p.x*geo.tw,geo.oy+p.y*geo.th,(p.snap.W+0.5)*geo.tw,(p.snap.H-1)*geo.th+2*geo.s];
}
function composeFillTile(geo,x,y){
  if(!geo.hex){ctx.fillRect(Math.floor(geo.ox+x*geo.tw),Math.floor(geo.oy+y*geo.th),Math.ceil(geo.tw)+1,Math.ceil(geo.th)+1);return;}
  hexPathPointy(ctx,geo.ox+(x+0.5)*geo.tw+hexShiftX(y,comp.H)*geo.tw,geo.oy+geo.s+y*geo.th,geo.tw,geo.s);ctx.fill();
}
/* Rivers ride the square lattice even in hex mode (app-wide decision), so there is no honest hex
   edge geometry to draw — skip the overlay there rather than invent one. Mapping copied from
   drawRivers: nof key (gy,gx) is the south edge of that tile, wof key the east edge. */
function composeDrawRivers(geo,R){
  if(geo.hex||!R||(!R.nof.size&&!R.wof.size))return;
  const tw=geo.tw,th=geo.th;
  ctx.save();ctx.lineWidth=riverLineWidth();ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle='#3aa0e0';ctx.beginPath();
  for(const k of R.nof.keys()){const p=k.split(',');const gr=+p[0],gx=+p[1],y=geo.oy+(gr+1)*th;ctx.moveTo(geo.ox+gx*tw,y);ctx.lineTo(geo.ox+(gx+1)*tw,y);}
  for(const k of R.wof.keys()){const p=k.split(',');const gy=+p[0],gx=+p[1],x=geo.ox+(gx+1)*tw;ctx.moveTo(x,geo.oy+gy*th);ctx.lineTo(x,geo.oy+(gy+1)*th);}
  ctx.stroke();ctx.restore();
}
/* The ghost draws the WHOLE snapshot, sea included, even though landOnly will not stamp that sea:
   while you are moving a patch you need to see its footprint, not just the land that will survive. */
function composeDrawGhost(geo,g){
  const s=g.snap;if(!s||!s.tiles)return;
  const at=composeTileReader(s);
  ctx.save();ctx.globalAlpha=0.6;
  for(let sy=0;sy<s.H;sy++){const dy=g.y+sy;if(dy<-1||dy>comp.H)continue;
    for(let sx=0;sx<s.W;sx++){const dx=g.x+sx;if(dx<-1||dx>comp.W)continue;
      const t=at(sx,sy);if(!t)continue;const c=civTileColor(t);
      ctx.fillStyle='rgb('+(c[0]|0)+','+(c[1]|0)+','+(c[2]|0)+')';composeFillTile(geo,dx,dy);}}
  ctx.restore();
}
function composeDrawOutlines(geo){
  const k=composeDpr();
  ctx.save();
  ctx.strokeStyle='rgba(233,227,211,0.25)';ctx.lineWidth=Math.max(1,k);
  for(const p of comp.patches){if(p.id===comp.sel)continue;const r=composePatchRect(geo,p);ctx.strokeRect(r[0]+0.5,r[1]+0.5,r[2],r[3]);}
  if(_compGhost){const g=_compGhost,r=[geo.ox+g.x*geo.tw,geo.oy+g.y*geo.th,(g.snap.W+(geo.hex?0.5:0))*geo.tw,geo.hex?((g.snap.H-1)*geo.th+2*geo.s):g.snap.H*geo.th];
    ctx.setLineDash([6*k,4*k]);ctx.strokeStyle='#45c1d0';ctx.strokeRect(r[0]+0.5,r[1]+0.5,r[2],r[3]);ctx.setLineDash([]);}
  const sp=composeSelPatch();
  if(sp){const r=composePatchRect(geo,sp);
    ctx.strokeStyle='#45c1d0';ctx.lineWidth=2*k;ctx.strokeRect(r[0]+0.5,r[1]+0.5,r[2],r[3]);
    ctx.fillStyle='#45c1d0';const h=Math.max(4,Math.min(9,geo.tw*0.4));
    const cs=[[r[0],r[1]],[r[0]+r[2],r[1]],[r[0],r[1]+r[3]],[r[0]+r[2],r[1]+r[3]]];
    for(const c of cs)ctx.fillRect(c[0]-h/2,c[1]-h/2,h,h);}
  ctx.restore();
}
function renderCompose(){
  ctx.imageSmoothingEnabled=false;ctx.clearRect(0,0,cv.width,cv.height);
  const C=compositeCompose();
  const geo=drawCivGrid(ctx,C.tiles,C.W,C.H,{hex:hexMode,cw:cv.width,ch:cv.height,glyphs:true});
  composeDrawRivers(geo,C.rivers);
  composeDrawOutlines(geo);
  if(_compGhost)composeDrawGhost(geo,_compGhost);
  if(!comp.patches.length&&!_compGhost&&!comp.erased.size){const k=composeDpr();
    ctx.save();ctx.fillStyle='#5f7c88';ctx.font=(14*k)+"px 'IBM Plex Mono',monospace";ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.fillText('Click a snapshot in the shelf to place it',cv.width/2,cv.height/2);ctx.restore();}
  const live=_selDraw,s=live||compSel;   // the compose mask, in fractional-tile space
  if(s)drawSelection(ctx,s,(tx,ty)=>[geo.ox+tx*geo.tw, geo.hex?(geo.oy+geo.s+(ty-0.5)*geo.th):(geo.oy+ty*geo.th)],!!(live&&live.open));
}

/* ---------- host API ---------- */
/* Hex parity: hexShiftX keys off (H-1-y)&1, i.e. row parity counted from the BOTTOM row, because
   the serializer flips north/south and Civ5's odd rows must be the shifted ones. Within one
   compose canvas H is fixed, so parity is fixed too — but a patch moved an ODD number of rows
   lands its once-shifted rows on unshifted rows, which mirrors every hex adjacency inside it
   (a river-mouth valley that ran NE now runs NW). So y is quantised to even offsets in hex mode.
   x needs no such rule: a whole-tile east/west step preserves the lattice. */
function composeSnapY(y){return (hexMode&&(y&1))?y-1:y;}
function composeAddPatch(snapshot,x,y){
  const p={id:comp.nextId++,snap:snapshot,x:x|0,y:composeSnapY(y|0),landOnly:true};
  comp.patches.push(p);comp.sel=p.id;composeDirty();return p;
}
function composeRemovePatch(id){const i=comp.patches.findIndex(p=>p.id===id);if(i<0)return false;comp.patches.splice(i,1);if(comp.sel===id)comp.sel=null;composeDirty();return true;}
function composeRaise(id){const i=comp.patches.findIndex(p=>p.id===id);if(i<0||i===comp.patches.length-1)return false;const p=comp.patches[i];comp.patches[i]=comp.patches[i+1];comp.patches[i+1]=p;composeDirty();return true;}
function composeLower(id){const i=comp.patches.findIndex(p=>p.id===id);if(i<=0)return false;const p=comp.patches[i];comp.patches[i]=comp.patches[i-1];comp.patches[i-1]=p;composeDirty();return true;}
function composeSetLandOnly(id,on){const p=composePatchById(id);if(!p)return false;p.landOnly=!!on;composeDirty();return true;}
function composeClear(){comp.patches=[];comp.sel=null;_compPending=null;_compGhost=null;_compDrag=null;comp.erased.clear();comp.eraseGen++;comp.riverAdd=[];comp.riverGen=(comp.riverGen|0)+1;composeDirty();}
/* Fill every tile whose CENTRE falls inside the compose mask with the default tile. Centres, not
   corners, so a shape drawn tight around a coastline takes the tiles it visibly covers. */
function composeEraseSelection(){
  if(!selIsUsable(compSel))return 0;
  let n=0;
  for(let y=0;y<comp.H;y++)for(let x=0;x<comp.W;x++){
    const cx=x+0.5, cy=y+0.5;                            // tile centre in the mask's fractional-tile space
    if(!selContains(compSel,cx,cy))continue;
    const k=y+','+x;if(!comp.erased.has(k)){comp.erased.add(k);n++;}
  }
  if(n){comp.eraseGen++;composeDirty();}
  return n;
}
function composeUnerase(){if(!comp.erased.size)return;comp.erased.clear();comp.eraseGen++;composeDirty();}
function composeSetSize(W,H){const G=activeGame().grid;comp.W=snapDim(W|0,G.min.W,G.max.W,G.step);comp.H=snapDim(H|0,G.min.H,G.max.H,G.step);composeDirty();}   // the canvas obeys the game's grid limits
function composeStats(){const C=compositeCompose();let land=0;for(let y=0;y<C.H;y++)for(let x=0;x<C.W;x++)if(!isWaterTile(C.tiles[y][x]))land++;
  return {patches:comp.patches.length,land,water:C.W*C.H-land,W:C.W,H:C.H};}
/* Persist patch->snapshot by REFERENCE only: a snapshot is a full tile grid plus a thumbnail, and
   a collage reuses the same one many times — inlining them would blow up localStorage by megabytes
   and desync the copies. The shelf owns snapshot storage and resolves ids back on load. */
function composeSerializeState(){return {v:1,kind:'terra-form-compose',W:comp.W,H:comp.H,
  patches:comp.patches.map(p=>Object.assign({snap:p.snap&&p.snap.id,x:p.x,y:p.y,landOnly:!!p.landOnly},p.skip&&p.skip.size?{skip:[...p.skip]}:{},p.riverSkip&&p.riverSkip.size?{riverSkip:[...p.riverSkip]}:{})),
  riverAdd:(comp.riverAdd&&comp.riverAdd.length)?comp.riverAdd:undefined};}
function composeLoadState(obj,resolve){
  if(!obj||!Array.isArray(obj.patches))return 0;
  comp.patches=[];comp.sel=null;comp.nextId=1;_compPending=null;_compGhost=null;_compDrag=null;
  if(obj.W!=null)comp.W=Math.max(8,Math.min(160,obj.W|0));
  if(obj.H!=null)comp.H=Math.max(8,Math.min(120,obj.H|0));
  let dropped=0;
  for(const r of obj.patches){
    const s=resolve?resolve(r.snap):null;
    if(!s||!s.tiles){dropped++;continue;}                       // snapshot deleted since the save: drop the patch silently, the rest of the collage is still valid
    const p={id:comp.nextId++,snap:s,x:r.x|0,y:composeSnapY(r.y|0),landOnly:r.landOnly!==false};
    if(Array.isArray(r.skip)&&r.skip.length)p.skip=new Set(r.skip.map(i=>i|0));
    if(Array.isArray(r.riverSkip)&&r.riverSkip.length)p.riverSkip=new Set(r.riverSkip.map(String));
    comp.patches.push(p);
  }
  comp.riverAdd=Array.isArray(obj.riverAdd)?obj.riverAdd:[];comp.riverGen=(comp.riverGen|0)+1;
  composeDirty();return dropped;
}

/* ---------- interaction ---------- */
function composeActive(){return !!_compDeps&&_compDeps.getMode()==='compose';}
function composeDirty(){composeInvalidate();if(_compDeps){if(_compDeps.rerender)_compDeps.rerender();if(_compDeps.onChange)_compDeps.onChange();}}
function composeGeo(){return civGridGeometry(comp.W,comp.H,{hex:hexMode,cw:cv.width,ch:cv.height});}
function composeCanvasXY(e){const r=mapBox.getBoundingClientRect();if(!r.width||!r.height)return null;
  return [(e.clientX-r.left)*(cv.width/r.width),(e.clientY-r.top)*(cv.height/r.height)];}
/* Two inverse mappings on purpose. tileAtPixel is authoritative INSIDE the grid (it knows the hex
   half-row test) and is used for hit-testing and placement; composeFreeTile is a plain linear
   inverse that keeps counting past the edges, and is used only for drag DELTAS — a patch must be
   draggable half off the canvas, and a delta only needs to be self-consistent. */
function composeFreeTile(geo,px,py){
  if(!geo.hex)return {x:Math.floor((px-geo.ox)/geo.tw),y:Math.floor((py-geo.oy)/geo.th)};
  const y=Math.round((py-geo.oy-geo.s)/geo.th);
  return {x:Math.floor((px-geo.ox)/geo.tw-hexShiftX(y,comp.H)),y};
}
function composePatchAtTile(tx,ty){for(let i=comp.patches.length-1;i>=0;i--){const p=comp.patches[i];   // reverse: topmost first
  if(tx>=p.x&&tx<p.x+p.snap.W&&ty>=p.y&&ty<p.y+p.snap.H)return p;}return null;}
function composeCursor(){if(!composeActive())return;mapBox.style.cursor=_compPending?'copy':_compDrag?'grabbing':(_compHover!=null?'grab':'');}
function composeBeginPlace(snapshot){if(!snapshot)return;_compPending=snapshot;_compGhost=null;comp.sel=null;composeCursor();composeDirty();}
function composeCancelPending(){if(!_compPending)return false;_compPending=null;_compGhost=null;composeCursor();composeDirty();return true;}

/* Phase matters here, and getting it wrong is silent. mapBox's listeners are CAPTURE-phase so they
   see the event before the canvas does; the drag/release listeners are on WINDOW so a drag survives
   the cursor leaving the map. Those two facts collide: calling stopPropagation() from a capture
   listener on mapBox cancels the whole bubble phase, so a bubble-phase window listener never fires
   while the pointer is over the map — i.e. exactly where dragging has to work. Hence:
     - no blanket stopPropagation on mousemove (the geographic modes' hover/pan handlers already
       return early on mode==='compose', so there is nothing left to suppress), and
     - the window drag listeners are CAPTURE too, so they run ahead of anything on mapBox and cannot
       be starved by a future stopPropagation added there.
   click/wheel are still swallowed: those fire once and carry no drag state. */
function installComposeInput(deps){
  _compDeps=deps;if(_compBound)return;_compBound=true;
  mapBox.addEventListener('mousedown',composeOnDown,true);
  mapBox.addEventListener('click',composeSwallow,true);
  mapBox.addEventListener('wheel',composeSwallow,{capture:true,passive:false});
  mapBox.addEventListener('mouseleave',composeOnLeave,true);
  window.addEventListener('mousemove',composeOnMove,true);
  window.addEventListener('mouseup',composeOnUp,true);
  window.addEventListener('keydown',composeOnKey);
}
function composeSwallow(e){if(!composeActive())return;e.stopPropagation();if(e.cancelable)e.preventDefault();}   // compose has no zoom, so a wheel over the collage must not scroll the page either
function composeOnLeave(e){if(!composeActive())return;e.stopPropagation();if(_compGhost&&!_compDrag&&_compPending){_compGhost=null;if(_compDeps.rerender)_compDeps.rerender();}mapBox.style.cursor='';}
function composeOnDown(e){
  if(!composeActive())return;
  /* An armed selection tool owns the pointer: its listener runs first but sits on the SAME element,
     where stopPropagation cannot suppress a sibling, so the gate has to be explicit. */
  if(selTool!=='none')return;
  e.stopPropagation();if(e.button!==0)return;
  const c=composeCanvasXY(e);if(!c)return;
  const geo=composeGeo(),free=composeFreeTile(geo,c[0],c[1]),hit=tileAtPixel(geo,c[0],c[1],comp.W,comp.H);
  if(_compPending){                                    // drop the pending snapshot centred on the cursor tile
    const s=_compPending,q=hit||free;
    _compPending=null;_compGhost=null;
    composeAddPatch(s,q.x-(s.W>>1),q.y-(s.H>>1));composeCursor();return;
  }
  const q=hit||free,p=composePatchAtTile(q.x,q.y);
  comp.sel=p?p.id:null;                                // clicking bare canvas deselects
  _compDrag=p?{id:p.id,tx:free.x,ty:free.y,x0:p.x,y0:p.y,moved:false}:null;
  composeCursor();composeDirty();
}
function composeOnMove(e){
  if(!composeActive())return;
  const c=composeCanvasXY(e);if(!c)return;
  const geo=composeGeo(),free=composeFreeTile(geo,c[0],c[1]);
  if(_compDrag){
    const p=composePatchById(_compDrag.id);if(!p){_compDrag=null;return;}
    const nx=_compDrag.x0+(free.x-_compDrag.tx),ny=composeSnapY(_compDrag.y0+(free.y-_compDrag.ty));
    if(nx!==p.x||ny!==p.y){p.x=nx;p.y=ny;_compDrag.moved=true;_compGhost={snap:p.snap,x:nx,y:ny};composeDirty();}
    return;
  }
  if(_compPending){_compGhost={snap:_compPending,x:free.x-(_compPending.W>>1),y:composeSnapY(free.y-(_compPending.H>>1))};if(_compDeps.rerender)_compDeps.rerender();return;}
  const hov=composePatchAtTile(free.x,free.y),id=hov?hov.id:null;
  if(id!==_compHover){_compHover=id;composeCursor();}
}
function composeOnUp(e){
  if(!_compDrag)return;
  _compDrag=null;_compGhost=null;
  if(composeActive()){composeCursor();composeDirty();}
}
/* Arrow nudges step 2 rows in hex mode for the same parity reason as the drag snap; Shift scales
   the step, so a shifted vertical nudge is 10 rows there and 5 in square. */
function composeOnKey(e){
  if(!composeActive())return;
  const ae=document.activeElement,tn=ae?(ae.tagName||'').toLowerCase():'';
  if(tn==='input'||tn==='textarea'||tn==='select'||(ae&&ae.isContentEditable))return;   // don't steal keys from the slider panel
  if(e.key==='Escape'){if(!composeCancelPending()&&comp.sel!=null){comp.sel=null;composeDirty();}e.preventDefault();return;}
  /* Delete is overloaded, and the mask wins: with a shape drawn it fills that area with the default
     tile; with no shape it falls through to removing the selected patch, as it always did. */
  if((e.key==='Delete'||e.key==='Backspace')&&selIsUsable(compSel)){e.preventDefault();composeEraseSelection();syncSelUI();return;}
  const p=composeSelPatch();if(!p)return;
  const s=e.shiftKey?5:1,sy=hexMode?s*2:s;
  let dx=0,dy=0;
  if(e.key==='ArrowLeft')dx=-s;else if(e.key==='ArrowRight')dx=s;
  else if(e.key==='ArrowUp')dy=-sy;else if(e.key==='ArrowDown')dy=sy;   // y=0 is NORTH, so up decreases y
  else if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();composeRemovePatch(p.id);return;}
  else if(e.key==='['){e.preventDefault();composeLower(p.id);return;}
  else if(e.key===']'){e.preventDefault();composeRaise(p.id);return;}
  else return;
  e.preventDefault();p.x+=dx;p.y=composeSnapY(p.y+dy);composeDirty();
}

/* ============================================================
   Snapshot shelf — format, capture, thumbnails, persistence, UI
   ============================================================
   A snapshot freezes one evaluateFrame() result (the same tiles Generate would
   write) so the user can tune a region, freeze it, tune a different region,
   freeze that too, and later drag several onto a blank Compose canvas. This
   file owns the snapshot object format, capturing/importing/exporting it,
   its thumbnail, its IndexedDB persistence, and the shelf panel UI. It does
   NOT own compose/arrange (composeBeginPlace) or export — those read the
   snapshot object this file produces. */

/* ---------- format + capture ---------- */

/* Tiles are stored FLAT (row-major, index y*W+x) rather than as tiles[y][x]:
   JSON.stringify of a flat array has none of the nested-array bracket/comma
   bloat a 2-D array would add (matters once you're pasting this into a
   textarea), and flat-vs-2D is a one-line convert at each end (see
   snapshotTiles2D below), so nothing is lost by not keeping the 2-D shape. */

let snapshotSeq=0;
/* counter+timestamp+random: never needs to be globally unique, only unique enough that two
   snapshots captured in the same browser session (or pasted from two different sessions) don't
   collide. Math.random() alone would be fine too, but the counter+time makes ids sort roughly by
   capture order at a glance, which is convenient while debugging the shelf. */
function nextSnapshotId(){return 'snap_'+Date.now().toString(36)+'_'+(snapshotSeq++)+'_'+Math.random().toString(36).slice(2,8);}

function fmtLatDeg(v){const r=Math.round(v);return r>0?r+'°N':r<0?(-r)+'°S':'0°';}
function fmtLonDeg(v){const r=Math.round(wrapLon(v));return r>0?r+'°E':r<0?(-r)+'°W':'0°';}
/* readable auto-name, e.g. "52×32 · 12°S 74°W" (centre of the framed region). Wrapped in try/catch
   because it's cosmetic only — a naming hiccup should never block a capture. */
function autoSnapshotName(ev){
  try{
    const clat=(ev.topLat+ev.botLat)/2,clon=lonOf(ev.frame.cx);
    return ev.W+'×'+ev.H+' · '+fmtLatDeg(clat)+' '+fmtLonDeg(clon);
  }catch(e){return 'Snapshot '+(SHELF.length+1);}
}

/* Calls evaluateFrame() so a captured snapshot is, by construction, identical to what Generate
   would have written for the current view + slider settings (see the comment on evaluateFrame). */
/* Apply the world-space mask to a freshly evaluated frame, in place of `ev`:
   crop to the mask's tile bounding box, and replace everything inside that box but outside the shape
   with the default tile. Each tile is tested at the CENTRE of its own sampling footprint — the same
   point classifyRegion averaged around, including the X/Y nudge and the hex half-row shift — so the
   mask lines up with the tiles the user actually sees rather than an idealised grid. */
function maskFrame(ev){
  const s=worldSel;
  if(!selIsUsable(s))return ev;
  const R=srcRect(),W=ev.W,H=ev.H;
  const nX=nudgeX*R.w/W, nY=nudgeY*R.h/H;
  const inside=new Uint8Array(W*H);
  let x0=W,y0=H,x1=-1,y1=-1;
  const rotA=rotRad();
  for(let ty=0;ty<H;ty++)for(let tx=0;tx<W;tx++){
    const hX=hexShiftX(ty,H)*R.w/W;
    const cx=R.x+((tx+0.5)/W)*R.w+nX+hX, cy=R.y+((ty+0.5)/H)*R.h+nY;   // footprint centre in FRAME space; the mask lives in world px, so rotate before testing
    if(rotA){const w=frameToWorld(cx,cy);if(!selContains(s,w[0],w[1]))continue;}
    else if(!selContains(s,cx,cy))continue;
    inside[ty*W+tx]=1;
    if(tx<x0)x0=tx;if(tx>x1)x1=tx;if(ty<y0)y0=ty;if(ty>y1)y1=ty;
  }
  if(x1<x0)return null;   // mask misses the grid entirely -> nothing to capture
  /* Hex parity: hexShiftX keys off (H-1-y), so which rows lean east depends on the row count. Keeping
     the CROPPED bottom row at the same parity as the original bottom row preserves every tile's shift
     (see composeSnapY for the same rule applied to patches). Extend downward when we can. */
  if(hexMode&&(((y1-(H-1))&1)!==0))y1=Math.min(H-1,y1+1);
  const nw=x1-x0+1, nh=y1-y0+1, tiles=[], cut=[];   // cut: flat indices (cropped grid) of the tiles the mask replaced with fill — artificial water/wall, not real coast (the bridge reports and lints them)
  for(let ty=y0;ty<=y1;ty++){const row=[];
    for(let tx=x0;tx<=x1;tx++){if(inside[ty*W+tx])row.push(ev.tiles[ty][tx]);else{row.push(defaultTile());cut.push((ty-y0)*nw+(tx-x0));}}
    tiles.push(row);}
  finalizeTiles(tiles,nw,nh);   // the default fill is new sea (or new land) against the kept region: the game re-derives its shore
  /* Rivers: shift into the cropped frame and drop any edge with a flank outside the mask — a river
     must not run out into the default fill, and with a land default cleanupRiverEdges would not catch it. */
  const nof=new Map(),wof=new Map();
  const inMask=(x,y)=>(x>=0&&x<W&&y>=0&&y<H)&&!!inside[y*W+x];
  for(const [k,e] of ev.rivers.nof){const p=k.split(','),gy=+p[0],gx=+p[1];
    if(!inMask(gx,gy)||!inMask(gx,gy+1))continue;
    const ny=gy-y0,nx=gx-x0;if(nx<0||nx>=nw||ny<0||ny>=nh)continue;nof.set(ny+','+nx,e);}
  for(const [k,e] of ev.rivers.wof){const p=k.split(','),gy=+p[0],gx=+p[1];
    if(!inMask(gx,gy)||!inMask(gx+1,gy))continue;
    const ny=gy-y0,nx=gx-x0;if(nx<0||nx>=nw||ny<0||ny>=nh)continue;wof.set(ny+','+nx,e);}
  cleanupRiverEdges(nof,wof,tiles,nw,nh);
  const latOfRow=r=>{const fy=R.y+(r/H)*R.h+nY;return latOf(rotA?frameToWorld(R.x+R.w/2,fy)[1]:fy);};   // row boundaries, so the cropped span matches the kept tiles; rotated, a row is not one latitude — take the frame's centre column
  return {tiles,W:nw,H:nh,rivers:{nof,wof},topLat:latOfRow(y0),botLat:latOfRow(y1+1),
    hex:ev.hex,frame:ev.frame,land:ev.land,hills:ev.hills,peaks:ev.peaks,masked:true,cut};
}
function captureSnapshot(name){
  const ev=maskFrame(evaluateFrame());
  if(!ev)throw new Error('The mask does not cover any tile of the framed region.');
  const tiles=new Array(ev.W*ev.H);
  for(let y=0;y<ev.H;y++)for(let x=0;x<ev.W;x++)tiles[y*ev.W+x]=ev.tiles[y][x];
  const snap={
    v:1,kind:'terra-form-snapshot',
    id:nextSnapshotId(),
    name:(name&&name.trim())||autoSnapshotName(ev),
    W:ev.W,H:ev.H,hex:!!ev.hex,game:activeGame().id,
    topLat:ev.topLat,botLat:ev.botLat,
    frame:{cx:ev.frame.cx,cy:ev.frame.cy,spanX:ev.frame.spanX,rot:ev.frame.rot||0},
    createdAt:Date.now(),
    tiles,
    rivers:{nof:Array.from(ev.rivers.nof.entries()),wof:Array.from(ev.rivers.wof.entries())},
    cut:(ev.cut&&ev.cut.length)?ev.cut:null,   // mask fill tiles (flat indices), so a cut edge is never mistaken for coastline downstream
    thumb:null
  };
  snap.thumb=renderSnapshotThumb(snap);
  return snap;
}

function snapshotTiles2D(snap){
  const g=new Array(snap.H);
  for(let y=0;y<snap.H;y++){const row=new Array(snap.W);for(let x=0;x<snap.W;x++)row[x]=snap.tiles[y*snap.W+x];g[y]=row;}
  return g;
}
function snapshotRiverMaps(snap){return {nof:new Map(snap.rivers.nof),wof:new Map(snap.rivers.wof)};}

function snapshotToJSON(snap){return JSON.stringify(snap,null,1);}

/* Never trust pasted input: this is the only path by which arbitrary text becomes a snapshot object
   that later gets iterated, drawn, and (eventually, in someone else's code) serialized into a WBS
   file, so every field that downstream code indexes into (terrain -> a colour table, plot -> a 0..3 switch,
   river keys -> gy/gx) is checked here first. Throws a plain Error with a human-readable message;
   the paste UI shows message text directly to the user. */
function assertSnapshotShape(s){
  if(!s||typeof s!=='object')throw new Error('Snapshot is not a JSON object.');
  if(s.kind!=='terra-form-snapshot'&&s.kind!=='terra-wbs-snapshot')throw new Error('Not a Terra Form snapshot (kind is "'+s.kind+'", expected "terra-form-snapshot").');   // terra-wbs-: the app's old name, still in snapshots copied before the rename
  if(s.v!==1)throw new Error('Unsupported snapshot version '+s.v+' (this build only reads v1).');
  const sg=snapshotGame(s);if(!sg)throw new Error('Unknown game "'+s.game+'" — its module (games/'+s.game+'/module.js) is not loaded.');
  const G=sg.grid;
  if(!Number.isInteger(s.W)||s.W<1||s.W>G.max.W)throw new Error('Width (W) must be a whole number 1..'+G.max.W+' for '+sg.name+' (got '+s.W+').');   // a mask crop can be smaller than the game's minimum map
  if(!Number.isInteger(s.H)||s.H<1||s.H>G.max.H)throw new Error('Height (H) must be a whole number 1..'+G.max.H+' for '+sg.name+' (got '+s.H+').');
  if(!Array.isArray(s.tiles))throw new Error('Missing "tiles" array.');
  if(s.tiles.length!==s.W*s.H)throw new Error('tiles.length is '+s.tiles.length+' but W×H = '+(s.W*s.H)+' — the array must be exactly one entry per tile.');
  for(let i=0;i<s.tiles.length;i++){
    const t=s.tiles[i];
    if(!t||typeof t!=='object')throw new Error('tiles['+i+'] is not an object.');
    const err=sg.validateTile?sg.validateTile(t):null;if(err)throw new Error('tiles['+i+'] has an '+err+'.');
  }
  if(!s.rivers||typeof s.rivers!=='object')throw new Error('Missing "rivers" object.');
  assertRiverEntries(s.rivers.nof,'nof');
  assertRiverEntries(s.rivers.wof,'wof');
}
function assertRiverEntries(entries,label){
  if(!Array.isArray(entries))throw new Error('rivers.'+label+' must be an array of [key,value] pairs.');
  for(let i=0;i<entries.length;i++){
    const e=entries[i];
    if(!Array.isArray(e)||e.length!==2)throw new Error('rivers.'+label+'['+i+'] is not a [key,value] pair.');
    const key=e[0],val=e[1];
    if(typeof key!=='string'||!/^-?\d+,-?\d+$/.test(key))throw new Error('rivers.'+label+'['+i+'] has a malformed key "'+key+'" (expected "gy,gx").');
    if(!val||typeof val!=='object')throw new Error('rivers.'+label+'['+i+'] value is not an object.');
  }
}
/* Fresh id on import, always: pasting a snapshot the shelf already has (round-tripped through
   copy/paste, or shared from another browser) must add a second entry, never silently collide with
   or overwrite the existing one — the shelf is a collection you build up, not a keyed store the user
   is expected to manage ids for. */
function snapshotFromJSON(str){
  let raw;
  try{raw=JSON.parse(str);}catch(e){throw new Error('That isn\'t valid JSON ('+e.message+').');}
  assertSnapshotShape(raw);
  return Object.assign({},raw,{id:nextSnapshotId()});
}

/* ---------- thumbnail ---------- */

/* Offscreen canvas sized to the snapshot's own aspect ratio (long edge = maxPx) and handed to
   drawCivGrid with glyphs:false — hill/peak/oasis/bonus glyphs are a few px each at thumbnail scale
   and just read as noise, the flat terrain colour block is what's actually recognizable. */
function renderSnapshotThumb(snap,maxPx){
  maxPx=maxPx||160;
  const long=Math.max(snap.W,snap.H),scale=maxPx/long;
  const cw=Math.max(1,Math.round(snap.W*scale)),ch=Math.max(1,Math.round(snap.H*scale));
  const c=document.createElement('canvas');c.width=cw;c.height=ch;
  const g=c.getContext('2d');
  drawCivGrid(g,snapshotTiles2D(snap),snap.W,snap.H,{hex:!!snap.hex,cw,ch,glyphs:false});
  return c.toDataURL('image/png');
}

/* ---------- persistence ----------
   Lives inside the existing 'kv' object store (idbKV/idbSet/idbGet, defined elsewhere in this file)
   instead of a new store: idbKV hardcodes indexedDB.open('terra-form',1) and only creates 'kv' in
   onupgradeneeded, so adding a second store means bumping the DB version — which re-runs
   onupgradeneeded and risks the folder handle already saved under 'saveDir'. Not worth the risk for
   a feature that fits fine as extra keys in the store that's already there.
   One key per snapshot ('shelf:item:<id>') plus a small index key ('shelf:index', just the id list)
   rather than one giant blob: snapshots run 50-200KB each once a thumbnail's baked in, and a rename
   or delete should touch its own key, not rewrite every snapshot on the shelf. */
const SHELF_INDEX_KEY='shelf:index';
const shelfItemKey=id=>'shelf:item:'+id;
const idbDel=k=>idbKV('readwrite',s=>s.delete(k));   // idbKV only ships get/put wrappers (idbGet/idbSet); delete needs the store directly

let SHELF=[];   // in-memory live list the UI renders from; shelf*() functions below keep it in sync with IndexedDB

async function shelfIndexIds(){
  try{const ids=await idbGet(SHELF_INDEX_KEY);return Array.isArray(ids)?ids:[];}
  catch(e){return [];}
}

/* Never throws into the boot path: a missing or corrupt store just means an empty shelf. */
async function shelfLoad(){
  let ids;
  try{ids=await shelfIndexIds();}
  catch(e){console.warn('shelf: index unreadable, starting empty —',e);SHELF=[];return SHELF;}
  const got=await Promise.all(ids.map(id=>idbGet(shelfItemKey(id)).catch(e=>{console.warn('shelf: item '+id+' unreadable —',e);return null;})));
  SHELF=got.filter(s=>s&&s.id).sort((a,b)=>b.createdAt-a.createdAt);   // newest first
  return SHELF;
}

/* In-memory list and UI first, IndexedDB after. The first open of the store costs a noticeable beat,
   and waiting on it made a capture look like it had not registered — which matters more now that the
   shelf panel is hidden outside compose mode and the button's count is the only feedback. The write
   still happens; a failure just means this snapshot won't survive a reload, so it only warns. */
async function shelfSave(snap){
  const i=SHELF.findIndex(s=>s.id===snap.id);
  if(i>=0)SHELF[i]=snap;else SHELF.unshift(snap);
  SHELF.sort((a,b)=>b.createdAt-a.createdAt);
  renderShelf();
  try{
    const ids=await shelfIndexIds();
    if(!ids.includes(snap.id)){ids.push(snap.id);await idbSet(SHELF_INDEX_KEY,ids);}
    await idbSet(shelfItemKey(snap.id),snap);
  }catch(e){console.warn('shelf: could not persist "'+snap.name+'" — it will vanish on reload.',e);}
  return snap;
}

async function shelfDelete(id){
  const ids=(await shelfIndexIds()).filter(x=>x!==id);
  await idbSet(SHELF_INDEX_KEY,ids);
  await idbDel(shelfItemKey(id));
  SHELF=SHELF.filter(s=>s.id!==id);
  renderShelf();
}

async function shelfRename(id,name){
  const snap=SHELF.find(s=>s.id===id);
  if(!snap)return;
  const trimmed=(name||'').trim();
  if(trimmed)snap.name=trimmed;
  await idbSet(shelfItemKey(id),snap);
  renderShelf();
}

async function shelfClearAll(){
  const ids=await shelfIndexIds();
  await Promise.all(ids.map(id=>idbDel(shelfItemKey(id)).catch(()=>{})));
  await idbSet(SHELF_INDEX_KEY,[]);
  SHELF=[];
  renderShelf();
}
/* ---------- session scope: the shelf does not outlive the program ----------
   Snapshots are scratch, so a new run must start with an empty shelf. Doing that on close is not
   actually possible to guarantee — an unload handler cannot reliably finish an async IndexedDB
   transaction, and a crash or a force-quit never runs one at all — so the wipe happens on the next
   START instead, which covers all three cases. sessionStorage is the discriminator: it survives a
   reload (Ctrl+F5, which must NOT cost you the shelf you just filled) but not the process, so its
   absence is precisely "this is a fresh run". The within-session IndexedDB writes stay, and are what
   make the shelf survive an accidental reload or a crash mid-run. */
const SHELF_SESSION_KEY='terra-form:shelf-session';
async function shelfStartSession(){
  let fresh=true;
  try{fresh=!sessionStorage.getItem(SHELF_SESSION_KEY);sessionStorage.setItem(SHELF_SESSION_KEY,'1');}
  catch(e){fresh=true;}   // no sessionStorage (private mode, blocked storage): fall back to always-clear, which errs toward the requested behaviour
  if(fresh){try{await shelfClearAll();}catch(e){console.warn('shelf: could not clear last run —',e);}}
  return fresh;
}

/* ---------- shelf panel UI ---------- */

function renderShelf(){
  /* The shelf panel is hidden outside compose mode, so the button carries the count — otherwise a
     capture taken from a geographic viewer would have no visible destination. */
  const cnt=document.getElementById('shelfCount');
  if(cnt)cnt.textContent=SHELF.length?' · '+SHELF.length:'';
  const list=document.getElementById('shelfList');
  if(!list)return;
  list.textContent='';
  if(!SHELF.length){
    const p=document.createElement('p');
    p.className='note shelf-empty';
    p.textContent='Your snapshot shelf is empty. Switch to a map view and choose Capture snapshot, then return here to arrange your regions.';
    list.appendChild(p);
    return;
  }
  for(const snap of SHELF)list.appendChild(buildShelfItem(snap));
}

function buildShelfItem(snap){
  const el=document.createElement('div');el.className='shelf-item';

  const img=document.createElement('img');img.className='shelf-thumb';img.src=snap.thumb;img.alt='';img.width=64;img.height=64;
  el.appendChild(img);

  const meta=document.createElement('div');meta.className='shelf-meta';el.appendChild(meta);

  const nameRow=document.createElement('div');nameRow.className='shelf-name-row';meta.appendChild(nameRow);
  const nameEl=document.createElement('span');nameEl.className='shelf-name';nameEl.textContent=snap.name;nameRow.appendChild(nameEl);   // textContent only — snap.name can come from pasted JSON
  const renameBtn=document.createElement('button');renameBtn.type='button';renameBtn.className='shelf-icon-btn';renameBtn.title='Rename';renameBtn.textContent='✎';
  nameRow.appendChild(renameBtn);
  renameBtn.addEventListener('click',()=>{
    const input=document.createElement('input');input.className='numin shelf-rename-input';input.type='text';input.value=snap.name;
    nameRow.replaceChild(input,nameEl);input.focus();input.select();
    let done=false;
    const commit=()=>{if(done)return;done=true;const v=input.value;if(input.parentNode)nameRow.replaceChild(nameEl,input);shelfRename(snap.id,v);};
    const cancel=()=>{if(done)return;done=true;if(input.parentNode)nameRow.replaceChild(nameEl,input);};
    input.addEventListener('keydown',e=>{if(e.key==='Enter')commit();else if(e.key==='Escape')cancel();});
    input.addEventListener('blur',commit);
  });

  const dims=document.createElement('div');dims.className='shelf-dims';
  dims.textContent=snap.W+'×'+snap.H+' · '+(snap.W*snap.H).toLocaleString()+' tiles · '+snapshotGameId(snap)+(snap.hex?' · hex':'');
  meta.appendChild(dims);

  const btns=document.createElement('div');btns.className='shelf-btns';meta.appendChild(btns);

  const placeBtn=document.createElement('button');placeBtn.type='button';placeBtn.className='vbtn';placeBtn.textContent='place';
  placeBtn.addEventListener('click',()=>composeBeginPlace(snap));
  btns.appendChild(placeBtn);

  const copyBtn=document.createElement('button');copyBtn.type='button';copyBtn.className='vbtn';copyBtn.textContent='copy JSON';
  copyBtn.addEventListener('click',()=>{
    const json=snapshotToJSON(snap),was=copyBtn.textContent;
    const flash=ok=>{copyBtn.textContent=ok?'copied ✓':'copy failed';setTimeout(()=>{copyBtn.textContent=was;},1400);};
    if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(json).then(()=>flash(true),()=>flash(false));
    else flash(false);   // clipboard API unavailable (insecure context, old browser, denied permission) — "copy JSON" via Paste JSON's textarea is the fallback path
  });
  btns.appendChild(copyBtn);

  const delBtn=document.createElement('button');delBtn.type='button';delBtn.className='vbtn';delBtn.textContent='delete';
  btns.appendChild(delBtn);
  delBtn.addEventListener('click',()=>{
    if(delBtn.dataset.confirm==='1'){shelfDelete(snap.id);return;}   // inline "sure?" toggle rather than window.confirm, to match the app's no-native-dialog feel
    delBtn.dataset.confirm='1';delBtn.textContent='sure?';delBtn.classList.add('shelf-confirm');
    setTimeout(()=>{delBtn.dataset.confirm='';delBtn.textContent='delete';delBtn.classList.remove('shelf-confirm');},2500);
  });

  return el;
}

/* Wires the toolbar's #snapshot button (freeze current view) and this panel's paste/clear controls,
   then loads whatever's already on the shelf. Call once at boot. */
function initShelf(){
  /* Clear last run's shelf BEFORE loading, so a fresh start never briefly shows stale snapshots. */
  shelfStartSession().then(shelfLoad).then(renderShelf).catch(e=>{console.warn('shelf: load failed —',e);SHELF=[];renderShelf();});

  const snapBtn=document.getElementById('snapshot');
  if(snapBtn)snapBtn.addEventListener('click',()=>{
    let snap;
    try{snap=captureSnapshot();}   // no name typed anywhere in the toolbar -> always auto-named; rename later from the shelf entry
    catch(e){console.error('captureSnapshot failed:',e);alert('Could not capture snapshot: '+e.message);return;}
    shelfSave(snap);
    /* Flash the LABEL span, never the button's textContent — that would delete the count span beside it. */
    const lab=document.getElementById('snapLabel');
    if(lab){const was=lab.textContent;lab.textContent='saved ✓';setTimeout(()=>{lab.textContent=was;},900);}
  });

  const pasteToggle=document.getElementById('shelfPasteToggle'),pasteWrap=document.getElementById('shelfPasteWrap'),
        pasteArea=document.getElementById('shelfPasteArea'),pasteErr=document.getElementById('shelfPasteErr');
  if(pasteToggle&&pasteWrap)pasteToggle.addEventListener('click',async()=>{
    const opening=pasteWrap.hidden;
    pasteWrap.hidden=!opening;
    if(!opening)return;
    if(pasteErr)pasteErr.textContent='';
    if(navigator.clipboard&&navigator.clipboard.readText){
      try{const text=await navigator.clipboard.readText();if(text&&pasteArea)pasteArea.value=text;}
      catch(e){/* read permission denied (common — it's a more sensitive permission than writeText) — textarea stays empty, user pastes manually with Ctrl+V, this is the required fallback, not a bug */}
    }
    if(pasteArea)pasteArea.focus();
  });
  const pasteCancel=document.getElementById('shelfPasteCancel');
  if(pasteCancel)pasteCancel.addEventListener('click',()=>{pasteWrap.hidden=true;if(pasteArea)pasteArea.value='';if(pasteErr)pasteErr.textContent='';});
  const pasteCommit=document.getElementById('shelfPasteCommit');
  if(pasteCommit)pasteCommit.addEventListener('click',()=>{
    let snap;
    try{snap=snapshotFromJSON(pasteArea?pasteArea.value:'');}
    catch(e){if(pasteErr)pasteErr.textContent=e.message;return;}
    shelfSave(snap);
    pasteWrap.hidden=true;if(pasteArea)pasteArea.value='';if(pasteErr)pasteErr.textContent='';
  });

  const clearBtn=document.getElementById('shelfClearAll');
  if(clearBtn)clearBtn.addEventListener('click',()=>{
    if(clearBtn.dataset.confirm==='1'){shelfClearAll();clearBtn.dataset.confirm='';clearBtn.textContent='clear all';return;}
    clearBtn.dataset.confirm='1';clearBtn.textContent='clear all — sure?';
    setTimeout(()=>{clearBtn.dataset.confirm='';clearBtn.textContent='clear all';},2500);
  });
}

/* ---------- compose mode: host glue (panel, stats, export bridge) ----------
   The compose engine owns `comp` and the canvas interaction; this section is only the wiring between
   it and the rest of the app: the rail panel, the snapshot button, and the export hand-off. */
const COMPOSE_LAT=45;   // a collage has no real latitude span — patches come from anywhere on Earth. Civ4 uses top/bottom latitude for its own resource & feature scatter, so we write a plain temperate span rather than a fabricated one.
function composeRegion(){const c=compositeCompose();c.topLat=comp.latTop!=null?comp.latTop:COMPOSE_LAT;c.botLat=comp.latBot!=null?comp.latBot:-COMPOSE_LAT;c.wrapX=0;c.game=activeGame().id;return c;}   // wrapX=0: a collage never spans the full 360. latTop/latBot: a virtual latitude span declared through TerraForm.api (the MCP bridge), else the nominal temperate span
function selectedPatch(){return comp.sel==null?null:comp.patches.find(p=>p.id===comp.sel)||null;}
/* The rail carries two disjoint sets of controls. Everything tagged data-rail="tune" shapes how a
   region is EVALUATED — coast, relief, terrain, features, rivers — and none of it can affect a
   collage, whose tiles were evaluated when their snapshots were taken. Compose swaps that whole
   block out for the two panels that do apply (the canvas and the shelf it draws from). The Generate
   pane is untagged and stays in both, since it is the exit from either path. */
function syncRailPanels(){
  const on=(mode==='compose');
  document.body.classList.toggle('composing',on);
  document.getElementById('viewSource').hidden=on;
  ['zin','zout','zreset','regen','tgGrat'].forEach(id=>{document.getElementById(id).disabled=on;});
  document.getElementById('inspectorTitle').textContent=on?'Composition':'Map settings';
  document.getElementById('interactionHint').textContent=on?'Drag to move · Arrows to nudge · [ / ] to reorder':'Drag to pan · Scroll to zoom · Ctrl + drag to rotate';
  document.getElementById('generate').firstChild.textContent=on?'Export composition ':'Export map ';
  document.querySelectorAll('.rail [data-rail="tune"]').forEach(el=>{el.hidden=on;});
  document.querySelectorAll('.rail [data-rail="compose"]').forEach(el=>{el.hidden=!on;});
}
function syncComposeUI(){
  const on=(mode==='compose');
  syncRailPanels();
  document.getElementById('snapshot').disabled=on;   // snapshots are captured FROM a geographic frame, not from the collage
  if(!on)return;
  const p=selectedPatch(),ctl=document.getElementById('patchCtl');
  ctl.hidden=!p;
  if(p){document.getElementById('vPatch').textContent=p.snap.name+' · '+p.snap.W+'×'+p.snap.H+' @ '+p.x+','+p.y;
    document.getElementById('patchLandOnly').checked=!!p.landOnly;}
  const s=composeStats();
  document.getElementById('stPatches').textContent=s.patches;
  document.getElementById('stCompLand').textContent=s.land+' / '+s.water;
  document.getElementById('stErased').textContent=comp.erased.size;
  document.getElementById('compUnerase').disabled=!comp.erased.size;
  /* A snapshot carries the lattice it was evaluated on: its tiles were classified, its coasts traced
     and its relief passes run against square 8-neighbourhoods or hex 6-neighbourhoods. Stamping one
     onto the other lattice keeps the terrain but silently re-reads every adjacency, so warn rather
     than block — the collage is still exportable, it just won't match what the preview showed. */
  const mixed=comp.patches.filter(p=>snapshotGameId(p.snap)!==activeGame().id||!!p.snap.hex!==!!hexMode).length,warn=document.getElementById('composeWarn');
  warn.hidden=!mixed;
  if(mixed)warn.textContent='⚠ '+mixed+' patch'+(mixed===1?'':'es')+' captured for another game or lattice '+(mixed===1?'is':'are')+' placed on this '+activeGame().name+(hexMode?' (hex)':' (square)')+' canvas — tiles are stamped as they are, so the preview and the export may not read them as this game does.';
}
function composeChanged(){syncComposeUI();}
document.getElementById('cw').addEventListener('change',e=>{composeSetSize(parseInt(e.target.value)||60,comp.H);e.target.value=comp.W;relayout();syncComposeUI();});
document.getElementById('chh').addEventListener('change',e=>{composeSetSize(comp.W,parseInt(e.target.value)||40);e.target.value=comp.H;relayout();syncComposeUI();});
document.getElementById('patchLandOnly').addEventListener('change',e=>{const p=selectedPatch();if(p){composeSetLandOnly(p.id,e.target.checked);render();syncComposeUI();}});
document.getElementById('patchRaise').addEventListener('click',()=>{const p=selectedPatch();if(p){composeRaise(p.id);render();syncComposeUI();}});
document.getElementById('patchLower').addEventListener('click',()=>{const p=selectedPatch();if(p){composeLower(p.id);render();syncComposeUI();}});
document.getElementById('patchDel').addEventListener('click',()=>{const p=selectedPatch();if(p){composeRemovePatch(p.id);render();syncComposeUI();}});
document.getElementById('compClear').addEventListener('click',()=>{if(comp.patches.length&&!window.confirm('Remove all '+comp.patches.length+' patches from the canvas?'))return;composeClear();render();syncComposeUI();});
document.getElementById('compUnerase').addEventListener('click',()=>{composeUnerase();render();syncComposeUI();});
/* the #snapshot button is wired inside initShelf() — capture belongs with the shelf that stores it */
document.querySelectorAll('#selTools [data-sel]').forEach(b=>b.addEventListener('click',()=>setSelTool(b.dataset.sel)));
document.getElementById('selClear').addEventListener('click',clearSelection);
document.getElementById('tgMtnDefault').addEventListener('change',e=>{defaultTileKind=e.target.checked?'peak':'ocean';composeInvalidate();syncSelUI();syncComposeUI();render();});
installComposeInput({getMode:()=>mode,rerender:()=>schedule(),onChange:composeChanged});

/* ---------- boot ---------- */
installGames();   // mount + bind each game's panels, then select the saved game (sets the lattice, limits and export labels)
drawLegend();updateArNote();syncComposeUI();syncSelUI();initShelf();
/* Data-health probe: after the load chain, confirm each raster layer actually has pixels. This catches the
   "coastline only" failure (raster interiors blank) regardless of cause — a caught taint, a silent decode
   failure, or an empty array — and names the offending layer so it's diagnosable without opening DevTools. */
function checkDataHealth(){
  const nonzero=(arr,stride,n)=>{let c=0;for(let i=0;i<n;i+=1000){if(arr[i*stride])c++;}return c;};
  const N=WSRC*HSRC, bad=[];
  if(nonzero(heightArr,1,N)===0) bad.push('elevation');
  if(nonzero(koppenArr,1,N)===0) bad.push('Köppen');
  if(nonzero(colorArr,3,N)===0) bad.push('satellite/colour');
  if(!bad.length) return;
  const b=document.createElement('div');
  b.style.cssText='position:fixed;top:0;left:0;right:0;z-index:9999;padding:10px 16px;font:12px/1.4 var(--mono),ui-monospace,monospace;color:#111;background:#ffd24a;border-bottom:1px solid #c9982a;box-shadow:0 2px 8px rgba(0,0,0,.35)';
  b.innerHTML='Raster layer(s) empty after load: <b>'+bad.join(', ')+'</b> — the coastline still draws but land interiors are blank. '
    +(imgReadBlocked?'A pixel read was blocked (canvas taint). ':'')+(baseDataMissing?'A base file returned 404. ':'')
    +'If this is TerraForm.exe, press <b>Ctrl+F5</b> to reload past any cached page. If it persists, open <b>F12</b> and send the red console errors.'
    +'<span style="float:right;cursor:pointer;font-weight:700;padding-left:12px" onclick="this.parentNode.remove()">✕</span>';
  document.body.appendChild(b);
}
function maybeWarnMissingData(){
  if(!baseDataMissing) return;
  const b=document.createElement('div');
  b.style.cssText='position:fixed;top:0;left:0;right:0;z-index:9999;padding:10px 16px;font:12px/1.4 var(--mono),ui-monospace,monospace;color:#111;background:#ff8a5a;border-bottom:1px solid #c25a2f;box-shadow:0 2px 8px rgba(0,0,0,.35)';
  b.innerHTML='Base map data not found (elevation / coast / climate / satellite returned 404). Only the river layer loaded. This directory is missing the <code>data/</code> tiles &mdash; serve the full project folder (the one containing <code>data/coast_hires.json</code>, <code>data/sat_tiles/</code>, etc.), not a partial copy.<span style="float:right;cursor:pointer;font-weight:700;padding-left:12px" onclick="this.parentNode.remove()">&#10005;</span>';
  document.body.appendChild(b);
}
function maybeWarnFileProtocol(){
  if(!imgReadBlocked) return;
  const b=document.createElement('div');
  b.style.cssText='position:fixed;top:0;left:0;right:0;z-index:9999;padding:10px 16px;font:12px/1.4 var(--mono),ui-monospace,monospace;color:#111;background:#ffd54a;border-bottom:1px solid #b8952f;box-shadow:0 2px 8px rgba(0,0,0,.35)';
  b.innerHTML='Climate / satellite data could not be read. External images cannot be decoded from <b>file://</b> in Chrome (tainted canvas), so those layers fell back. Serve this folder over http instead &mdash; e.g. <code>python3 -m http.server</code>, then open <code>http://localhost:8000/</code>.<span style="float:right;cursor:pointer;font-weight:700;padding-left:12px" onclick="this.parentNode.remove()">&#10005;</span>';
  document.body.appendChild(b);
}
function loadCoast(done){fetch('data/coast_10m.json').then(r=>{if(!r.ok)throw new Error('http '+r.status);return r.json();}).then(j=>{COAST=(j&&j.polys)?j:{polys:[]};done();}).catch(e=>{baseDataMissing=true;COAST={polys:[]};console.warn('coast_10m.json not loaded ('+e+') -- serve over http(s).');done();});}
function loadLakes(done){fetch('data/lakes_10m.json').then(r=>{if(!r.ok)throw new Error('http '+r.status);return r.json();}).then(j=>{LAKES=(j&&j.polys)?j:{polys:[]};done();}).catch(e=>{LAKES={polys:[]};console.warn('lakes_10m.json not loaded ('+e+').');done();});}
function loadRivers(done){fetch('data/river_tiles/manifest.json').then(r=>{if(!r.ok)throw new Error('http '+r.status);return r.json();}).then(j=>{RMAN=j;updateRiverReadout();done();}).catch(e=>{RMAN=null;console.warn('river tiles manifest not loaded ('+e+') -- serve over http(s).');done();});}
loadElevation(()=>loadKoppen(()=>loadColor(()=>loadCoast(()=>loadLakes(()=>{landMask=buildLandMask();landAlphaCanvas=buildLandAlpha();generateWorld(1);repaintLayers();relayout();maybeWarnFileProtocol();maybeWarnMissingData();checkDataHealth();loadKoppenIndex(()=>render());loadLakesHires(()=>render());loadCoastHires(()=>render());loadCoastTileIndex(()=>render());loadLakeTileIndex(()=>render());loadPlayas(()=>render());loadSatIndex(()=>render());loadHgtIndex(()=>render());loadRivers(()=>render());})))));

/* ---------- TerraForm.api: the entry points core/bridge.js drives (the MCP server in mcp/) ----------
   Thin wrappers over the functions above, with none of their own logic. Each one also does what the
   equivalent UI handler would have done around the call (clamp the view, drop the tile memo, redraw,
   refresh the readouts), so a remote command leaves the page exactly as the same clicks would. render()
   is called directly rather than through schedule(): requestAnimationFrame does not fire in a hidden tab,
   and the bridge must not wait on it. */
TF.api={
  WSRC,HSRC,WRAP_PX,HALO_LOG_MIN,lonOf,latOf,wrapLon,
  state(){const R=srcRect(),RA=rotAABB();return {mode,game:activeGame().id,games:TF.order.slice(),hex:hexMode,W:out.W,H:out.H,effH:effH(),
    view:{cx:view.cx,cy:view.cy,spanX:view.spanX,rot:view.rot||0},bounds:frameBounds(R,RA),fill:defaultTileKind,
    selection:worldSel?worldSel.kind:null,shelf:SHELF.length,compose:{W:comp.W,H:comp.H,patches:comp.patches.length,erased:comp.erased.size},pending:TF.api.loadsPending()};},
  ready(){return !!landMask;},   // the base load chain (elevation, Köppen, colour, coast, lakes) has finished; nothing is worth evaluating before
  loadsPending(){let n=0;const c=m=>{for(const v of m.values())if(v==='load')n++;};c(KTILE);c(STILE);c(HTILE);c(RTILE);c(VT.coast.cache);c(VT.lake.cache);return n;},   // tile fetches in flight for the current view: the bridge waits for 0 before it evaluates, so a command sees the same data the page will draw
  render(){render();refreshStats();},
  setGame(id){if(!TF.games[id])throw new Error('unknown game "'+id+'" (loaded: '+TF.order.join(', ')+')');setGame(id);},
  setMode(m){const b=document.querySelector('.tab[data-mode="'+m+'"]');if(!b)throw new Error('unknown mode "'+m+'"');if(mode!==m)b.click();},
  setSize(W,H){const G=activeGame().grid;if(W!=null)out.W=snapDim(W,G.min.W,G.max.W,G.step);if(H!=null)out.H=snapDim(H,G.min.H,G.max.H,G.step);if(lockAR)arRatio=out.W/out.H;afterGridChange();},
  setView(v){if(v.cx!=null)view.cx=+v.cx;if(v.cy!=null)view.cy=+v.cy;if(v.spanX!=null)view.spanX=+v.spanX;if(v.rot!=null)view.rot=+v.rot;clampView();lastTiles=null;render();refreshStats();},
  evaluate(){return evaluateFrame();},
  params(){return {islandBias,seawayBias,islandExpand,expandSteep,expandMaxMult,roughHalo,mtnPass,flatSpots,coastThr,nudgeX,nudgeY,riverN,riverEstuaries,hill:P.hill,peak:P.peak,blendHill:P.blendHill,blendPeak:P.blendPeak,fill:defaultTileKind};},
  setRelief(o){if(o.hill!=null)P.hill=+o.hill;if(o.peak!=null)P.peak=+o.peak;if(o.blendHill!=null)P.blendHill=+o.blendHill;if(o.blendPeak!=null)P.blendPeak=+o.blendPeak;
    reliefMS.set([P.hill,P.peak]);reliefBasisMS.set([P.blendHill,P.blendPeak]);updateMultiReadouts();lastTiles=null;render();refreshStats();},
  setFill(kind){const el=document.getElementById('tgMtnDefault'),want=(kind==='barrier'||kind==='peak');if(el.checked!==want){el.checked=want;el.dispatchEvent(new Event('change'));}},
  /* masks: world-pinned, in source px ({kind:'lasso',pts:[[sx,sy],...]} | {kind:'rect',pts:[a,b],frame:true} | null) */
  getWorldSelection(){return worldSel;},
  setWorldSelection(s){worldSel=s;_selDraw=null;_selCursor=null;syncSelUI();render();},
  capture(name){return captureSnapshot(name);},
  tiles2D:snapshotTiles2D,
  shelf:{list(){return SHELF;},get(id){return SHELF.find(s=>s.id===id)||null;},save:shelfSave,remove:shelfDelete,rename:shelfRename},
  compose:{
    state(){return comp;},composite:compositeCompose,stats:composeStats,region:composeRegion,patchById:composePatchById,
    setSize(W,H){composeSetSize(W,H);document.getElementById('cw').value=comp.W;document.getElementById('chh').value=comp.H;relayout();syncComposeUI();},
    clear:composeClear,
    add(snap,x,y,landOnly){const p=composeAddPatch(snap,x,y);if(landOnly===false)composeSetLandOnly(p.id,false);return p;},
    move(id,x,y){const p=composePatchById(id);if(!p)return false;p.x=x|0;p.y=composeSnapY(y|0);comp.sel=id;composeDirty();return true;},
    remove:composeRemovePatch,raise:composeRaise,lower:composeLower,setLandOnly:composeSetLandOnly,
    select(id){comp.sel=id;composeDirty();},
    eraseRect(x0,y0,x1,y1){const prev=compSel;compSel={kind:'rect',pts:[[x0,y0],[x1+1,y1+1]]};let n=0;try{n=composeEraseSelection();}finally{compSel=prev;syncSelUI();}return n;},   // inclusive tile rect; the mask tests tile centres, so +1 on the far corner
    unerase:composeUnerase,
    setLatitudes(top,bot){comp.latTop=top==null?null:+top;comp.latBot=bot==null?null:+bot;},   // declared virtual latitudes for the collage (export header + the bridge's latitude lint)
    /* bridge-declared collage metadata (not persisted, like the latitudes): a land-share target for the budget line, the canvas' nominal tile size in degrees for the landform codebook */
    setBudget(lo,hi){comp.targetLand=(lo==null&&hi==null)?null:[lo==null?0:+lo,hi==null?1:+hi];},
    setScale(deg){comp.degPerTile=deg==null?null:+deg;},
    /* per-patch edits (see patchKeep): skip = flat snapshot tile indices not to stamp; riverSkip = local edge keys to drop; null clears */
    setSkip(id,idx){const p=composePatchById(id);if(!p)return false;p.skip=(idx&&idx.length)?new Set(Array.from(idx,i=>i|0)):null;p.editGen=(p.editGen|0)+1;composeDirty();return true;},
    setRiverSkip(id,keys){const p=composePatchById(id);if(!p)return false;p.riverSkip=(keys&&keys.length)?new Set(Array.from(keys,String)):null;p.editGen=(p.editGen|0)+1;composeDirty();return true;},
    addRivers(ents){comp.riverAdd=(comp.riverAdd||[]).concat(ents||[]);comp.riverGen=(comp.riverGen|0)+1;composeDirty();return comp.riverAdd.length;},   // [[kind 'n'|'w', 'gy,gx', {dir,d,rid}], ...] in canvas tiles
    clearAddedRivers(){comp.riverAdd=[];comp.riverGen=(comp.riverGen|0)+1;composeDirty();}
  },
  thumb:renderSnapshotThumb,newId:nextSnapshotId,
  async export(name){if(name!=null)document.getElementById('saveName').value=name;return buildExport();},   // {g,region,ctx,built,rows,note}: the caller decides between writeFiles (the app's destination) and shipping built.files elsewhere
  writeFiles,destHint(){return document.getElementById('destHint').textContent||'';},
  isWater:isWaterTile,gridRing,hexShiftX,
  /* frame geometry for the bridge's lasso suggestions: the frame rect in source px, the sampling nudge, and frame -> world px under rotation */
  frameRect(){const R=srcRect();return {x:R.x,y:R.y,w:R.w,h:R.h,nudgeX,nudgeY};},frameToWorld
};
