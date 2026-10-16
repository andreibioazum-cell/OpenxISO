/* Полный Canvas 2D бэкенд вместо Vulkan. Подключается в web_main.c и заменяет
 * engine/graphics.c. Минимум кода: текстуры не грузим (рисуем цветные квадраты),
 * шрифт — встроенный monospace Canvas-шрифт, все геометрические примитивы —
 * напрямую через Canvas 2D API через EM_JS. */
#ifndef CB_CANVAS_GFX_CORE_INC
#define CB_CANVAS_GFX_CORE_INC
#include <emscripten.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---- Минимальные определения типов, чтобы game-команды работали ---- */
typedef struct DSFont { int dummy; } DSFont;
typedef struct Texture {
    struct Texture *next;
    char *name;
    int w, h, opaque;
    int upload_tries;
    uint32_t *pixels;
    uint32_t *gray_backup;
    struct { int image, memory, view, desc, uploaded; } gpu;
} Texture;
typedef enum {
    DS_CMD_RECT, DS_CMD_ROUND, DS_CMD_CIRCLE, DS_CMD_RING, DS_CMD_LINE,
    DS_CMD_TEX, DS_CMD_TEXT, DS_CMD_TEX_TINT, DS_CMD_RECT_ROT,
    DS_CMD_TEX_ROUND, DS_CMD_TEX_FADE
} DSCommand;
typedef struct {
    DSCommand t;
    union {
        struct { float x,y,w,h; uint32_t c; } rc;
        struct { float x,y,w,h,r; uint32_t c; } rr;
        struct { float x,y,r; uint32_t c; } ci;
        struct { float x,y,r,th; uint32_t c; } rg;
        struct { float x1,y1,x2,y2,th; uint32_t c; } ln;
        struct { float x,y,a,sc; Texture *tx; uint32_t c; } tx;
        struct { float x,y,a,sc; Texture *tx; uint32_t c; } tx2;
        struct { float x,y,sc,r; Texture *tx; } txr;
        struct { float x,y,w,h,ang; uint32_t c; } rot;
        struct { char *s; float x,y,sc; uint32_t c; } tt;
    } v;
} DSCmd;

static int gfx_gray_on = 0;
static float gfx_shake_dx=0, gfx_shake_dy=0, gfx_shake_amp=0, gfx_shake_left=0, gfx_shake_dur=0;
static Buffer *cur_buf = NULL;
static DSCmd *cmds = NULL;
static size_t cmd_n=0, cmd_cap=0;
static int frame_open=0;
static AAssetManager *amgr = NULL;
static Texture *textures = NULL;
static DSFont *font = NULL;
static int font_tried=0;
static int vk_rebuild_tries=0;
static void *vk_rebuild_window=NULL;
static struct { uint32_t w,h; } vk_off={0,0}, vk_sw_extent={0,0};
static int gfx_auto_scale=1;

static uint32_t pack_c(uint32_t c) {
    uint32_t a=(c>>24)&0xff, r=(c>>16)&0xff, g=(c>>8)&0xff, b=c&0xff;
    if (!a) a=255;
    if (gfx_gray_on) { uint32_t y=(299*r+587*g+114*b)/1000; r=g=b=y; }
    return r|(g<<8)|(b<<16)|(a<<24);
}
static char *strdup_safe(const char *s) {
    if (!s) { char *o=malloc(1); if(o)o[0]=0; return o; }
    size_t n=strlen(s)+1; char *o=malloc(n); if(o) memcpy(o,s,n); return o;
}
static int utf8_dec(const char **c) {
    const unsigned char *p=(const unsigned char*)*c; int r;
    if(!p||!*p) return -1;
    if(*p<0x80) r=*p++;
    else if((*p&0xe0)==0xc0&&(p[1]&0xc0)==0x80) { r=((*p&0x1f)<<6)|(p[1]&0x3f); p+=2; }
    else if((*p&0xf0)==0xe0&&(p[1]&0xc0)==0x80&&(p[2]&0xc0)==0x80) { r=((*p&0x0f)<<12)|((p[1]&0x3f)<<6)|(p[2]&0x3f); p+=3; }
    else if((*p&0xf8)==0xf0&&(p[1]&0xc0)==0x80&&(p[2]&0xc0)==0x80&&(p[3]&0xc0)==0x80) { r=((*p&7)<<18)|((p[1]&0x3f)<<12)|((p[2]&0x3f)<<6)|(p[3]&0x3f); p+=4; }
    else r=*p++;
    *c=(const char*)p; return r;
}
static Texture *find_tx(const char *n) {
    for(Texture *t=textures;t;t=t->next) if(strcmp(t->name,n)==0) return t;
    return NULL;
}
static const char *norm_name(const char *n) {
    if(!n) return NULL;
    while(strncmp(n,"./",2)==0) n+=2;
    if(strncmp(n,"assets/textures/",16)==0) n+=16;
    else if(strncmp(n,"textures/",9)==0) n+=9;
    else if(strncmp(n,"assets/",7)==0) n+=7;
    return n;
}
static Texture *load_png(const char *req) {
    const char *n = norm_name(req); if(!n) return NULL;
    Texture *t = find_tx(n);
    if(t) return t;
    t = calloc(1,sizeof(*t)); if(!t) return NULL;
    t->name=strdup_safe(n); t->w=64; t->h=64; t->opaque=1;
    t->pixels=malloc(64*64*4);
    if(t->pixels) {
        /* заглушка-текстура: залить серо-фиолетовым, чтобы было видно */
        for(int i=0;i<64*64;i++) t->pixels[i]=0xFF8888AAu;
    }
    t->gpu.uploaded=1;
    t->next=textures; textures=t;
    return t;
}
static int ensure_font(void) { return 1; } /* встроенный canvas-шрифт */
static DSCmd *push(DSCommand tc) {
    if(!frame_open) return NULL;
    if(cmd_n==cmd_cap) {
        size_t cap = cmd_cap?cmd_cap*2:256;
        DSCmd *nc=realloc(cmds,cap*sizeof(*cmds));
        if(!nc) return NULL;
        cmds=nc; cmd_cap=cap;
    }
    DSCmd *c=&cmds[cmd_n++]; memset(c,0,sizeof(*c)); c->t=tc; return c;
}
static void discard_commands(void) {
    for(size_t i=0;i<cmd_n;i++) if(cmds[i].t==DS_CMD_TEXT) { free(cmds[i].v.tt.s); cmds[i].v.tt.s=NULL; }
    cmd_n=0;
}

/* ---- EM_JS для рисования Canvas 2D примитивов ---- */
EM_JS(void, cv_rect, (float x,float y,float w,float h,uint32_t c), {
    var ctx=Module._ctx; if(!ctx) return;
    var r=c&0xff,g=(c>>8)&0xff,b=(c>>16)&0xff,a=((c>>24)&0xff)/255;
    ctx.fillStyle="rgba("+r+","+g+","+b+","+a+")";
    ctx.fillRect(x,y,w,h);
});
EM_JS(void, cv_roundrect, (float x,float y,float w,float h,float r,uint32_t c), {
    var ctx=Module._ctx; if(!ctx) return;
    var rr=c&0xff,gg=(c>>8)&0xff,bb=(c>>16)&0xff,aa=((c>>24)&0xff)/255;
    ctx.fillStyle="rgba("+rr+","+gg+","+bb+","+aa+")";
    ctx.beginPath();
    if(ctx.roundRect) ctx.roundRect(x,y,w,h,r);
    else { ctx.rect(x,y,w,h); }
    ctx.fill();
});
EM_JS(void, cv_circle, (float x,float y,float r,uint32_t c), {
    var ctx=Module._ctx; if(!ctx) return;
    var rr=c&0xff,gg=(c>>8)&0xff,bb=(c>>16)&0xff,aa=((c>>24)&0xff)/255;
    ctx.fillStyle="rgba("+rr+","+gg+","+bb+","+aa+")";
    ctx.beginPath(); ctx.arc(x+r,y+r,r,0,Math.PI*2); ctx.fill();
});
EM_JS(void, cv_ring, (float x,float y,float r,float th,uint32_t c), {
    var ctx=Module._ctx; if(!ctx) return;
    var rr=c&0xff,gg=(c>>8)&0xff,bb=(c>>16)&0xff,aa=((c>>24)&0xff)/255;
    ctx.strokeStyle="rgba("+rr+","+gg+","+bb+","+aa+")";
    ctx.lineWidth=th; ctx.beginPath(); ctx.arc(x+r,y+r,r,0,Math.PI*2); ctx.stroke();
});
EM_JS(void, cv_line, (float x1,float y1,float x2,float y2,float th,uint32_t c), {
    var ctx=Module._ctx; if(!ctx) return;
    var rr=c&0xff,gg=(c>>8)&0xff,bb=(c>>16)&0xff,aa=((c>>24)&0xff)/255;
    ctx.strokeStyle="rgba("+rr+","+gg+","+bb+","+aa+")";
    ctx.lineWidth=th; ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
});
EM_JS(void, cv_tex, (float x,float y,float w,float h,float a,uint32_t c), {
    var ctx=Module._ctx; if(!ctx) return;
    var rr=c&0xff,gg=(c>>8)&0xff,bb=(c>>16)&0xff,aa=((c>>24)&0xff)/255 * a;
    ctx.fillStyle="rgba("+rr+","+gg+","+bb+","+aa+")";
    ctx.fillRect(x,y,w,h);
});
EM_JS(void, cv_text, (const char *s,float x,float y,float sc,uint32_t c), {
    var ctx=Module._ctx; if(!ctx) return;
    var rr=c&0xff,gg=(c>>8)&0xff,bb=(c>>16)&0xff,aa=((c>>24)&0xff)/255;
    ctx.fillStyle="rgba("+rr+","+gg+","+bb+","+aa+")";
    ctx.font=Math.floor(20*sc)+"px monospace, sans-serif";
    ctx.textBaseline="top";
    ctx.fillText(UTF8ToString(s), x, y);
});
EM_JS(void, cv_begin, (int w,int h), {
    var cv=Module._canvas, ctx=Module._ctx; if(!ctx) return;
    cv.width=w; cv.height=h;
    ctx.setTransform(1,0,0,1,0,0);
    ctx.imageSmoothingEnabled=false;
    ctx.fillStyle="#101018"; ctx.fillRect(0,0,w,h);
});
EM_JS(void, cv_end, (), {});
EM_JS(void, cv_apply_shake, (float dx,float dy), {
    if(!Module._ctx) return;
    Module._ctx.setTransform(1,0,0,1,dx,dy);
});

/* ---- Публичные функции рисования ---- */
void rect(float x,float y,float w,float h,uint32_t c){DSCmd*p=push(DS_CMD_RECT);if(p){p->v.rc.x=x;p->v.rc.y=y;p->v.rc.w=w;p->v.rc.h=h;p->v.rc.c=pack_c(c);}}
void roundrect(float x,float y,float w,float h,float r,uint32_t c){DSCmd*p=push(DS_CMD_ROUND);if(p){p->v.rr.x=x;p->v.rr.y=y;p->v.rr.w=w;p->v.rr.h=h;p->v.rr.r=r;p->v.rr.c=pack_c(c);}}
void rect_rot(float x,float y,float w,float h,float ang,uint32_t c){(void)ang;DSCmd*p=push(DS_CMD_RECT_ROT);if(p){p->v.rc.x=x;p->v.rc.y=y;p->v.rc.w=w;p->v.rc.h=h;p->v.rc.c=pack_c(c);}}
void circle(float x,float y,float r,uint32_t c){DSCmd*p=push(DS_CMD_CIRCLE);if(p){p->v.ci.x=x;p->v.ci.y=y;p->v.ci.r=r;p->v.ci.c=pack_c(c);}}
void ring(float x,float y,float r,float t,uint32_t c){DSCmd*p=push(DS_CMD_RING);if(p){p->v.rg.x=x;p->v.rg.y=y;p->v.rg.r=r;p->v.rg.th=t;p->v.rg.c=pack_c(c);}}
void line(float x1,float y1,float x2,float y2,float th,uint32_t c){DSCmd*p=push(DS_CMD_LINE);if(p){p->v.ln.x1=x1;p->v.ln.y1=y1;p->v.ln.x2=x2;p->v.ln.y2=y2;p->v.ln.th=th;p->v.ln.c=pack_c(c);}}
void tex(float x,float y,const char *name,float a,float s){Texture*t=load_png(name);DSCmd*p=push(DS_CMD_TEX);if(p&&t){p->v.tx.x=x;p->v.tx.y=y;p->v.tx.a=a;p->v.tx.sc=s;p->v.tx.tx=t;p->v.tx.c=0xFFFFFFFFu;}}
void tex_tint(float x,float y,const char *name,float a,float s,uint32_t c){Texture*t=load_png(name);DSCmd*p=push(DS_CMD_TEX_TINT);if(p&&t){p->v.tx2.x=x;p->v.tx2.y=y;p->v.tx2.a=a;p->v.tx2.sc=s;p->v.tx2.tx=t;p->v.tx2.c=pack_c(c);}}
void tex_alpha(float x,float y,const char *n,float a,float s,double al){(void)al; tex(x,y,n,(float)(a*al),s);}
void tex_round(float x,float y,const char *n,float s,float r){(void)r;Texture*t=load_png(n);DSCmd*p=push(DS_CMD_TEX_ROUND);if(p&&t){p->v.txr.x=x;p->v.txr.y=y;p->v.txr.sc=s;p->v.txr.r=r;p->v.txr.tx=t;}}
void cb_button_gradient(float x,float y,float w,float h,float r,uint32_t c){roundrect(x,y,w,h,r,c);}

static uint32_t text_force_white(uint32_t c) {
    if(c==0xFFFF4444u||c==0xFF4FC3F7u||c==0xFFFF3333u||c==0xFF33A8FFu) return c;
    if((c&0x00ffffffu)==0x00202020u) return c;
    return (c&0xff000000u)|0x00ffffffu;
}
void text_scaled(const char *s,float x,float y,uint32_t c,float sc){
    if(!frame_open||!s) return;
    DSCmd *p=push(DS_CMD_TEXT); if(!p) return;
    p->v.tt.s=strdup_safe(s); if(!p->v.tt.s) { cmd_n--; return; }
    p->v.tt.x=x; p->v.tt.y=y; p->v.tt.sc=sc; p->v.tt.c=pack_c(text_force_white(c));
}
void text(const char *s,float x,float y,uint32_t c){text_scaled(s,x,y,c,1.0f);}

int text_ink_width(const char *s){if(!s)return 0;return (int)strlen(s)*12;}
int text_ink_height(const char *s){(void)s;return 20;}
int text_ink_top(const char *s){(void)s;return 0;}

/* ---- Font API (заглушки: встроенный canvas-шрифт) ---- */
typedef struct { uint32_t codepoint; float advance; float bearing_x,bearing_top; int width,height; float u0,v0,u1,v1; } DSFontGlyph;
DSFont *ds_font_create(const uint8_t*d,size_t sz,int ph){(void)d;(void)sz;(void)ph;static DSFont f;return &f;}
void ds_font_destroy(DSFont*f){(void)f;}
const DSFontGlyph *ds_font_glyph(const DSFont*f,uint32_t cp){(void)f;(void)cp;static DSFontGlyph g={0,10,0,0,10,20,0,0,0,0};return &g;}
int ds_font_aw(const DSFont*f){(void)f;return 10;}
int ds_font_ah(const DSFont*f){(void)f;return 20;}
const uint8_t *ds_font_alpha(const DSFont*f){(void)f;return NULL;}
float ds_font_lineh(const DSFont*f){(void)f;return 20;}
float ds_font_ascent(const DSFont*f){(void)f;return 16;}

/* ---- Asset & graphics init/shutdown ---- */
void ds_set_asset_manager(AAssetManager *a) { amgr=a; }
int png_load(const char *n){return load_png(n)!=NULL;}
int tex_ready(const char *name){return load_png(name)!=NULL;}

static void gfx_autoscale_new_window(void){gfx_auto_scale=1;}
void ds_release_assets(void){
    Texture *t=textures;
    while(t){Texture*n=t->next;free(t->pixels);free(t->gray_backup);free(t->name);free(t);t=n;}
    textures=NULL; font=NULL; font_tried=0; amgr=NULL;
}
void ds_gfx_gray(double on){gfx_gray_on=on?1:0;}
void ds_gfx_shake(double amp,double seconds){
    if(seconds<=0||amp<=0){gfx_shake_amp=0;gfx_shake_left=0;return;}
    if(gfx_shake_left>0&&gfx_shake_amp>=(float)amp)return;
    gfx_shake_amp=(float)amp;gfx_shake_dur=(float)seconds;gfx_shake_left=(float)seconds;
}

int ds_graphics_pixel_scale(void){return 1;}
void ds_graphics_report_frame_interval(double sec){(void)sec;}
static const char *gfx_failure = NULL;
const char *ds_graphics_failure(void){return gfx_failure?gfx_failure:"";}
static const char *ds_vk_present_mode_name(int m){(void)m;return "canvas2d";}
static void geo_trig_free(void){}

int ds_graphics_init(AAssetManager *a, struct ANativeWindow *w){
    (void)w; ds_set_asset_manager(a); gfx_autoscale_new_window(); return 1;
}
int ds_graphics_begin_frame(Buffer *b){
    if(!b||b->width<=0||b->height<=0) return 0;
    vk_off.w=b->width; vk_off.h=b->height; vk_sw_extent.w=b->width; vk_sw_extent.h=b->height;
    cv_begin(b->width,b->height);
    if(gfx_shake_left>0){
        gfx_shake_left-=(float)dt; if(gfx_shake_left<0)gfx_shake_left=0;
        float k=gfx_shake_dur>0?gfx_shake_left/gfx_shake_dur:0; float a=gfx_shake_amp*k*k;
        gfx_shake_dx=((float)rand()/(float)RAND_MAX*2-1)*a;
        gfx_shake_dy=((float)rand()/(float)RAND_MAX*2-1)*a;
    } else gfx_shake_dx=gfx_shake_dy=0;
    cv_apply_shake(gfx_shake_dx,gfx_shake_dy);
    discard_commands(); cur_buf=b; frame_open=1;
    return 1;
}
/* Выполняет накопленные команды рендеринга */
static void execute_cmds(void) {
    for(size_t i=0;i<cmd_n;i++){
        DSCmd *c=&cmds[i];
        switch(c->t){
        case DS_CMD_RECT: cv_rect(c->v.rc.x,c->v.rc.y,c->v.rc.w,c->v.rc.h,c->v.rc.c); break;
        case DS_CMD_ROUND: cv_roundrect(c->v.rr.x,c->v.rr.y,c->v.rr.w,c->v.rr.h,c->v.rr.r,c->v.rr.c); break;
        case DS_CMD_RECT_ROT: cv_rect(c->v.rot.x,c->v.rot.y,c->v.rot.w,c->v.rot.h,c->v.rot.c); break;
        case DS_CMD_CIRCLE: cv_circle(c->v.ci.x,c->v.ci.y,c->v.ci.r,c->v.ci.c); break;
        case DS_CMD_RING: cv_ring(c->v.rg.x,c->v.rg.y,c->v.rg.r,c->v.rg.th,c->v.rg.c); break;
        case DS_CMD_LINE: cv_line(c->v.ln.x1,c->v.ln.y1,c->v.ln.x2,c->v.ln.y2,c->v.ln.th,c->v.ln.c); break;
        case DS_CMD_TEX:{Texture*t=c->v.tx.tx;cv_tex(c->v.tx.x,c->v.tx.y,(float)t->w*c->v.tx.sc,(float)t->h*c->v.tx.sc,c->v.tx.a,0xFFAA88CCu);break;}
        case DS_CMD_TEX_TINT:{Texture*t=c->v.tx2.tx;cv_tex(c->v.tx2.x,c->v.tx2.y,(float)t->w*c->v.tx2.sc,(float)t->h*c->v.tx2.sc,c->v.tx2.a,c->v.tx2.c);break;}
        case DS_CMD_TEX_FADE:{Texture*t=c->v.tx2.tx;cv_tex(c->v.tx2.x,c->v.tx2.y,(float)t->w*c->v.tx2.sc,(float)t->h*c->v.tx2.sc,c->v.tx2.a,c->v.tx2.c);break;}
        case DS_CMD_TEX_ROUND:{Texture*t=c->v.txr.tx;cv_tex(c->v.txr.x,c->v.txr.y,(float)t->w*c->v.txr.sc,(float)t->h*c->v.txr.sc,1.0f,0xFFAA88CCu);break;}
        case DS_CMD_TEXT: cv_text(c->v.tt.s,c->v.tt.x,c->v.tt.y,c->v.tt.sc,c->v.tt.c); break;
        }
    }
}
void ds_graphics_end_frame(void){if(!frame_open)return; execute_cmds(); cv_end(); discard_commands(); frame_open=0; cur_buf=NULL;}
void ds_graphics_cancel_frame(void){discard_commands();frame_open=0;cur_buf=NULL;}
void ds_graphics_error_screen(const char *m){
    if(!frame_open)return;
    discard_commands();
    rect(0,0,(float)(cur_buf?cur_buf->width:screen_w),(float)(cur_buf?cur_buf->height:screen_h),0xff1c0b10);
    if(m&&*m) text_scaled(m,16,40,0xffc98f8f,0.6f);
    execute_cmds();
}
void ds_graphics_window_lost(void){ds_graphics_cancel_frame();}
void ds_graphics_shutdown(void){ds_graphics_cancel_frame();ds_release_assets();free(cmds);cmds=NULL;cmd_cap=cmd_n=0;geo_trig_free();}
int ds_graphics_show_failure(struct ANativeWindow *w, int attempts){(void)w;(void)attempts;js_alert(ds_graphics_failure());return 1;}

/* stb_image: нам не нужен настоящий PNG-декодер на вебе в минимальной версии,
 * но игра может вызывать stbi_. Предоставляем пустые определения, чтобы
 * компоновка прошла (текстуры-заглушки уже создаются в load_png выше). */
#define STBI_NO_STDIO
typedef unsigned char stbi_uc;
static stbi_uc *stbi_load_from_memory(const unsigned char *b,int l,int *x,int *y,int *c,int r){
    (void)b;(void)l;(void)x;(void)y;(void)c;(void)r; return NULL;
}
static void stbi_image_free(void *p){(void)p;}
static const char *stbi_failure_reason(void){return "web: stub";}
#endif /* CB_CANVAS_GFX_CORE_INC */
