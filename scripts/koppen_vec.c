#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <sys/resource.h>

static int H,W,Hp,Wp;
static int *Ap,*comp,*lab2val; static int nlabels;
static unsigned char *Vc,*Hc,*NODEa; static int *node_id; static int nnodes;
#define AP(y,x) Ap[(long)(y)*Wp+(x)]
#define COMP(y,x) comp[(long)(y)*Wp+(x)]
#define VC(cy,cx) Vc[(long)(cy)*(Wp+1)+(cx)]
#define HC(cy,cx) Hc[(long)(cy)*Wp+(cx)]
#define NODEc(cy,cx) NODEa[(long)(cy)*(Wp+1)+(cx)]
#define NID(cy,cx) node_id[(long)(cy)*(Wp+1)+(cx)]
static inline int vc(int cy,int cx){ return (cy>=0&&cy<Hp&&cx>=0&&cx<=Wp)?VC(cy,cx):0; }
static inline int hc(int cy,int cx){ return (cy>=0&&cy<=Hp&&cx>=0&&cx<Wp)?HC(cy,cx):0; }
static inline int opp(int d){ return (d+2)&3; }

static void label_cc(){
    comp=calloc((long)Hp*Wp,sizeof(int)); lab2val=malloc(sizeof(int)*((long)Hp*Wp+1));
    int *q=malloc(sizeof(int)*(long)Hp*Wp); nlabels=0;
    for(long i=0;i<(long)Hp*Wp;i++){ if(comp[i])continue; int y=i/Wp,x=i%Wp,v=Ap[i];
        int lab=++nlabels; lab2val[lab]=v; long qh=0,qt=0; q[qt++]=i; comp[i]=lab;
        while(qh<qt){ int p=q[qh++],py=p/Wp,px=p%Wp;
            int ny,nx,r;
            if(py>0){r=(py-1)*Wp+px; if(!comp[r]&&Ap[r]==v){comp[r]=lab;q[qt++]=r;}}
            if(py<Hp-1){r=(py+1)*Wp+px; if(!comp[r]&&Ap[r]==v){comp[r]=lab;q[qt++]=r;}}
            if(px>0){r=py*Wp+px-1; if(!comp[r]&&Ap[r]==v){comp[r]=lab;q[qt++]=r;}}
            if(px<Wp-1){r=py*Wp+px+1; if(!comp[r]&&Ap[r]==v){comp[r]=lab;q[qt++]=r;}}
        } }
    free(q);
}
static void cracks_nodes(){
    Vc=calloc((long)Hp*(Wp+1),1); Hc=calloc((long)(Hp+1)*Wp,1);
    for(int cy=0;cy<Hp;cy++)for(int cx=1;cx<Wp;cx++) VC(cy,cx)=(AP(cy,cx-1)!=AP(cy,cx));
    for(int cy=1;cy<Hp;cy++)for(int cx=0;cx<Wp;cx++) HC(cy,cx)=(AP(cy-1,cx)!=AP(cy,cx));
    NODEa=calloc((long)(Hp+1)*(Wp+1),1); node_id=malloc(sizeof(int)*(long)(Hp+1)*(Wp+1));
    for(long i=0;i<(long)(Hp+1)*(Wp+1);i++)node_id[i]=-1; nnodes=0;
    for(int cy=0;cy<=Hp;cy++)for(int cx=0;cx<=Wp;cx++){
        int deg=vc(cy-1,cx)+vc(cy,cx)+hc(cy,cx-1)+hc(cy,cx);
        if(deg>=3){ NODEc(cy,cx)=1; NID(cy,cx)=nnodes++; } }
}
/* arcs */
static int *ax,*ay; static long acap,aptn; static long *aoff; static int *alen;
static int *msnx,*msny,*menx,*meny,*msd,*med,*mrF,*mrR; static long narcs,mcap;
static void pushpt(int x,int y){ if(aptn>=acap){acap=acap?acap*2:(1L<<20); ax=realloc(ax,acap*sizeof(int)); ay=realloc(ay,acap*sizeof(int));} ax[aptn]=x;ay[aptn]=y;aptn++; }
static void grow_meta(){ mcap=mcap?mcap*2:(1<<16);
    aoff=realloc(aoff,mcap*sizeof(long)); alen=realloc(alen,mcap*sizeof(int));
    msnx=realloc(msnx,mcap*sizeof(int));msny=realloc(msny,mcap*sizeof(int));
    menx=realloc(menx,mcap*sizeof(int));meny=realloc(meny,mcap*sizeof(int));
    msd=realloc(msd,mcap*sizeof(int));med=realloc(med,mcap*sizeof(int));
    mrF=realloc(mrF,mcap*sizeof(int));mrR=realloc(mrR,mcap*sizeof(int)); }
static void trace(int cx0,int cy0,int d0){
    int rF,rR;
    if(d0==0){rF=COMP(cy0-1,cx0);rR=COMP(cy0,cx0);} else if(d0==1){rF=COMP(cy0,cx0);rR=COMP(cy0,cx0-1);}
    else if(d0==2){rF=COMP(cy0,cx0-1);rR=COMP(cy0-1,cx0-1);} else {rF=COMP(cy0-1,cx0-1);rR=COMP(cy0-1,cx0);}
    long off=aptn; pushpt(cx0,cy0); int cx=cx0,cy=cy0,d=d0,ld=d0;
    while(1){
        if(d==3){VC(cy-1,cx)=0;cy--;} else if(d==1){VC(cy,cx)=0;cy++;} else if(d==2){HC(cy,cx-1)=0;cx--;} else {HC(cy,cx)=0;cx++;}
        pushpt(cx,cy); ld=d;
        if((cx==cx0&&cy==cy0)||NODEc(cy,cx))break;
        int nd=-1; if(vc(cy,cx))nd=1; else if(hc(cy,cx))nd=0; else if(hc(cy,cx-1))nd=2; else if(vc(cy-1,cx))nd=3;
        if(nd<0)break; d=nd;
    }
    if(narcs>=mcap)grow_meta();
    aoff[narcs]=off; alen[narcs]=aptn-off; msnx[narcs]=cx0;msny[narcs]=cy0;menx[narcs]=cx;meny[narcs]=cy;
    msd[narcs]=d0;med[narcs]=ld;mrF[narcs]=rF;mrR[narcs]=rR; narcs++;
}
static void trace_all(){
    for(int cy=0;cy<=Hp;cy++)for(int cx=0;cx<=Wp;cx++) if(NODEc(cy,cx)){
        while(1){ int nd=-1; if(vc(cy,cx))nd=1; else if(hc(cy,cx))nd=0; else if(hc(cy,cx-1))nd=2; else if(vc(cy-1,cx))nd=3;
            if(nd<0)break; trace(cx,cy,nd); } }
    for(int cy=0;cy<Hp;cy++)for(int cx=1;cx<Wp;cx++) if(VC(cy,cx)) trace(cx,cy,1);
    for(int cy=1;cy<Hp;cy++)for(int cx=0;cx<Wp;cx++) if(HC(cy,cx)) trace(cx,cy,3);
}
/* VW per arc -> simplified into sax/say with soff/slen */
static int *sax,*say; static long scap,sptn; static long *soff; static int *slen;
static double *harea; static int *hidx,*hver,*pv,*nx,*ver; static char *alive; static double *evarea;
static long hn, scratchcap;
static void heap_push(double a,int i,int v){ long k=hn++; harea[k]=a;hidx[k]=i;hver[k]=v;
    while(k>0){ long p=(k-1)/2; if(harea[p]<=harea[k])break; double ta=harea[p];harea[p]=harea[k];harea[k]=ta; int ti=hidx[p];hidx[p]=hidx[k];hidx[k]=ti; ti=hver[p];hver[p]=hver[k];hver[k]=ti; k=p;} }
static int heap_pop(double*a,int*i,int*v){ if(hn==0)return 0; *a=harea[0];*i=hidx[0];*v=hver[0]; hn--; if(hn>0){harea[0]=harea[hn];hidx[0]=hidx[hn];hver[0]=hver[hn]; long k=0; for(;;){ long l=2*k+1,r=2*k+2,m=k; if(l<hn&&harea[l]<harea[m])m=l; if(r<hn&&harea[r]<harea[m])m=r; if(m==k)break; double ta=harea[k];harea[k]=harea[m];harea[m]=ta; int ti=hidx[k];hidx[k]=hidx[m];hidx[m]=ti; ti=hver[k];hver[k]=hver[m];hver[m]=ti; k=m; } } return 1; }
static double tri(int i){ int a=pv[i],c=nx[i]; double ax0=ax[a],ay0=ay[a],bx=ax[i],by=ay[i],cx0=ax[c],cy0=ay[c];
    return fabs((bx-ax0)*(cy0-ay0)-(cx0-ax0)*(by-ay0))*0.5; }
static void vw_arc(long aid,double thr){
    long off=aoff[aid]; int n=alen[aid]; long so=sptn;
    int closed=(ax[off]==ax[off+n-1]&&ay[off]==ay[off+n-1]); int mink=closed?4:2;
    if(n<=mink){ for(int i=0;i<n;i++){ if(sptn>=scap){scap=scap?scap*2:(1L<<20);sax=realloc(sax,scap*sizeof(int));say=realloc(say,scap*sizeof(int));} sax[sptn]=ax[off+i];say[sptn]=ay[off+i];sptn++; } soff[aid]=so;slen[aid]=n; return; }
    /* work on global point indices off..off+n-1 ; use pv/nx/ver/alive sized to n via local offset */
    for(int i=0;i<n;i++){ pv[i]=i-1; nx[i]=i+1; ver[i]=0; alive[i]=1; }
    hn=0; int cnt=n;
    /* areas use pv/nx as LOCAL indices but tri() needs global ax/ay: adapt */
    #define GA(i) ax[off+(i)]
    #define GAY(i) ay[off+(i)]
    for(int i=1;i<n-1;i++){ double a=fabs(((double)GA(i)-GA(i-1))*((double)GAY(i+1)-GAY(i-1))-((double)GA(i+1)-GA(i-1))*((double)GAY(i)-GAY(i-1)))*0.5; heap_push(a,i,0); }
    while(hn>0&&cnt>mink){ double a; int i,v; heap_pop(&a,&i,&v); if(!alive[i]||v!=ver[i])continue; if(a>=thr)break;
        alive[i]=0;cnt--; int p=pv[i],q=nx[i]; nx[p]=q;pv[q]=p;
        int nb[2]={p,q};
        for(int t=0;t<2;t++){ int j=nb[t]; if(j>0&&j<n-1&&alive[j]){ ver[j]++; double aj=fabs(((double)GA(j)-GA(pv[j]))*((double)GAY(nx[j])-GAY(pv[j]))-((double)GA(nx[j])-GA(pv[j]))*((double)GAY(j)-GAY(pv[j])))*0.5; heap_push(aj,j,ver[j]); } }
    }
    for(int i=0;i<n;i++) if(alive[i]){ if(sptn>=scap){scap=scap?scap*2:(1L<<20);sax=realloc(sax,scap*sizeof(int));say=realloc(say,scap*sizeof(int));} sax[sptn]=GA(i);say[sptn]=GAY(i);sptn++; }
    soff[aid]=so; slen[aid]=sptn-so;
    #undef GA
    #undef GAY
}
/* assembly */
static int *leaving; /* nnodes*4 */
static void emit_ring_pts(long aid,int fwd,int**buf,long*bn,long*bcap){ long so=soff[aid]; int sl=slen[aid];
    for(int k=0;k<sl;k++){ int idx=fwd? k : sl-1-k; int X=sax[so+idx],Y=say[so+idx];
        if(*bn>0 && (*buf)[(*bn-1)*2]==X && (*buf)[(*bn-1)*2+1]==Y) continue;
        if(*bn>=*bcap){*bcap=*bcap?*bcap*2:256; *buf=realloc(*buf,*bcap*2*sizeof(int));}
        (*buf)[(*bn)*2]=X;(*buf)[(*bn)*2+1]=Y;(*bn)++; } }
int main(int argc,char**argv){
    struct timespec t0,t1; clock_gettime(CLOCK_MONOTONIC,&t0);
    double thr=atof(argv[1]); FILE*f=fopen(argv[2],"rb");
    fread(&H,4,1,f); fread(&W,4,1,f); Hp=H+2;Wp=W+2;
    int *raw=malloc(sizeof(int)*(long)H*W); fread(raw,4,(long)H*W,f); fclose(f);
    Ap=malloc(sizeof(int)*(long)Hp*Wp); for(long i=0;i<(long)Hp*Wp;i++)Ap[i]=-1;
    for(int y=0;y<H;y++)for(int x=0;x<W;x++)AP(y+1,x+1)=raw[(long)y*W+x]; free(raw);
    label_cc(); cracks_nodes(); trace_all();
    /* VW scratch sized to max arc len */
    int maxlen=0; for(long a=0;a<narcs;a++) if(alen[a]>maxlen)maxlen=alen[a];
    long hcap=4L*(maxlen+4); harea=malloc(sizeof(double)*hcap); hidx=malloc(sizeof(int)*hcap); hver=malloc(sizeof(int)*hcap);
    pv=malloc(sizeof(int)*(maxlen+4));nx=malloc(sizeof(int)*(maxlen+4));ver=malloc(sizeof(int)*(maxlen+4));alive=malloc(maxlen+4);
    soff=malloc(sizeof(long)*narcs); slen=malloc(sizeof(int)*narcs);
    for(long a=0;a<narcs;a++) vw_arc(a,thr);
    /* half-edges leaving[] */
    leaving=malloc(sizeof(int)*(long)nnodes*4); for(long i=0;i<(long)nnodes*4;i++)leaving[i]=-1;
    for(long a=0;a<narcs;a++){ if(NODEc(msny[a],msnx[a])){ int ns=NID(msny[a],msnx[a]),ne=NID(meny[a],menx[a]);
        leaving[ns*4+msd[a]]=2*a; leaving[ne*4+opp(med[a])]=2*a+1; } }
    /* rings: walk node-arc half-edges + node-free loops */
    char *vis=calloc(2*narcs,1);
    /* output buffers: collect rings tagged by label */
    long *rlabel=NULL,*roff=NULL; int *rlen=NULL; long rn=0,rcap=0; int *rpts=NULL; long rptn=0,rptcap=0;
    int *rb=NULL; long rbn=0,rbcap=0;
    for(long a=0;a<narcs;a++){
        if(!NODEc(msny[a],msnx[a])){ /* node-free loop: emit both sides */
            for(int side=0;side<2;side++){ int he=2*a+side; if(vis[he])continue; vis[he]=1; int lab=side==0?mrF[a]:mrR[a];
                rbn=0; emit_ring_pts(a, side==0?1:0, &rb,&rbn,&rbcap);
                if(rbn>=4){ if(rn>=rcap){rcap=rcap?rcap*2:4096; rlabel=realloc(rlabel,rcap*sizeof(long));roff=realloc(roff,rcap*sizeof(long));rlen=realloc(rlen,rcap*sizeof(int));}
                    if(rptn+rbn>rptcap){rptcap=(rptn+rbn)*2; rpts=realloc(rpts,rptcap*2*sizeof(int));}
                    rlabel[rn]=lab;roff[rn]=rptn;rlen[rn]=rbn; memcpy(rpts+rptn*2,rb,rbn*2*sizeof(int)); rptn+=rbn; rn++; } }
            continue;
        }
        for(int side=0;side<2;side++){ int he=2*a+side; if(vis[he])continue; int lab=side==0?mrF[a]:mrR[a];
            rbn=0; int cur=he;
            while(!vis[cur]){ vis[cur]=1; long aid=cur/2; int fwd=(cur%2==0); emit_ring_pts(aid,fwd,&rb,&rbn,&rbcap);
                /* next */ int endnode,din; if(fwd){endnode=NID(meny[aid],menx[aid]);din=med[aid];} else {endnode=NID(msny[aid],msnx[aid]);din=opp(msd[aid]);}
                int rev=opp(din),nh=-1; for(int k=1;k<4;k++){int dd=(rev+k)&3; if(leaving[endnode*4+dd]>=0){nh=leaving[endnode*4+dd];break;}}
                if(nh<0)break; cur=nh; }
            if(rbn>=4){ if(rn>=rcap){rcap=rcap?rcap*2:4096; rlabel=realloc(rlabel,rcap*sizeof(long));roff=realloc(roff,rcap*sizeof(long));rlen=realloc(rlen,rcap*sizeof(int));}
                if(rptn+rbn>rptcap){rptcap=(rptn+rbn)*2; rpts=realloc(rpts,rptcap*2*sizeof(int));}
                rlabel[rn]=lab;roff[rn]=rptn;rlen[rn]=rbn; memcpy(rpts+rptn*2,rb,rbn*2*sizeof(int)); rptn+=rbn; rn++; } }
    }
    /* output: group rings by label(value>0). counting approach: iterate labels */
    /* build per-label ring lists via bucket */
    long *cnt=calloc(nlabels+1,sizeof(long)); for(long r=0;r<rn;r++)cnt[rlabel[r]]++;
    long *bstart=malloc(sizeof(long)*(nlabels+2)); bstart[0]=0; for(int l=1;l<=nlabels+1;l++)bstart[l]=bstart[l-1]+ (l-1<=nlabels?cnt[l-1]:0);
    long *order=malloc(sizeof(long)*rn); long *cur=malloc(sizeof(long)*(nlabels+1)); for(int l=0;l<=nlabels;l++)cur[l]=bstart[l];
    for(long r=0;r<rn;r++){ long L=rlabel[r]; order[cur[L]++]=r; }
    /* count output faces */
    int nfaces=0; for(int l=1;l<=nlabels;l++) if(lab2val[l]>0 && cnt[l]>0) nfaces++;
    fwrite(&nfaces,4,1,stdout);
    for(int l=1;l<=nlabels;l++){ if(lab2val[l]<=0||cnt[l]==0)continue; int val=lab2val[l]; int nr=cnt[l];
        fwrite(&val,4,1,stdout); fwrite(&nr,4,1,stdout);
        for(long j=bstart[l];j<bstart[l+1];j++){ long r=order[j]; int np=rlen[r]; fwrite(&np,4,1,stdout);
            fwrite(rpts+roff[r]*2,sizeof(int),np*2,stdout); } }
    clock_gettime(CLOCK_MONOTONIC,&t1); double el=(t1.tv_sec-t0.tv_sec)+(t1.tv_nsec-t0.tv_nsec)/1e9;
    struct rusage ru; getrusage(RUSAGE_SELF,&ru);
    fprintf(stderr,"C: %.3fs peak=%ldMB | aptn=%ld(cap%ld) sptn=%ld(cap%ld) rptn=%ld(cap%ld) grids=%ldMB arcs=%ld faces=%d\n",el,ru.ru_maxrss/1024,aptn,acap,sptn,scap,rptn,rptcap,((long)Hp*Wp*4L*3+(long)(Hp+1)*(Wp+1)*4L)/1048576,narcs,nfaces);
    return 0;
}
