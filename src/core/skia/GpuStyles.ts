/**
 * GpuStyles - stylizacje warstw liczone na GPU (WebGL2). Odpowiada krok po kroku `applyLayerStyles` z Styles.ts:
 * te same kształty (mapy odległości, rozszerzenie / zwężenie, rozmycie z przesunięciem), ta sama kolejność składania
 * i te same tryby mieszania. Zwraca `false`, gdy GPU jest niedostępne albo parametry wykraczają poza zakres
 * (wtedy liczy procesor).
 */

import {
  GL2 as GL,
  GL_HEAD,
  Tex,
  kitAlloc,
  kitBegin,
  kitBind,
  kitFail,
  kitGl,
  kitMaxTex,
  kitOutTex,
  kitPass,
  kitProg,
  kitRead,
  kitRelease,
  kitSrcTex,
  kitUni,
  kitUpload,
  gpuSessionActive,
  gpuSessionRun,
} from './GpuFx.ts';
import { LayerStyles, StyleBlend, StyleFx, boxRadii, gradientLut, parseColor, styleOn, stylesActive, stylesMargin } from './Styles.ts';

const MODE: Record<StyleBlend, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  hardLight: 4,
  softLight: 5,
  darken: 6,
  lighten: 7,
  colorDodge: 8,
  colorBurn: 9,
  difference: 10,
  exclusion: 11,
};

const COMMON =
  GL_HEAD +
  `uniform sampler2D uSrc;
float OAat(ivec2 p) { return texelFetch(uSrc, p, 0).a; }
float clamp01(float v) { return clamp(v, 0.0, 1.0); }
float smth(float t) { return t * t * (3.0 - 2.0 * t); }
`;

const FS_PLANE =
  COMMON +
  `uniform sampler2D uP0;
uniform sampler2D uP1;
uniform int uKind;
uniform float uR;
uniform vec2 uD;
uniform int uFlag;
uniform float uBevSize;
uniform int uBev;
uniform float uSgn;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float oa = OAat(p);
  float v = 0.0;
  if (uKind == 0) {
    v = max(clamp01(uR + 1.0 - texelFetch(uP0, p, 0).r), oa);
  } else if (uKind == 1) {
    v = min(clamp01(texelFetch(uP0, p, 0).r - uR), oa);
  } else if (uKind == 2) {
    v = 1.0 - texelFetch(uP0, p, 0).r;
  } else if (uKind == 3) {
    float fx0 = floor(-uD.x);
    float fy0 = floor(-uD.y);
    float fx = -uD.x - fx0;
    float fy = -uD.y - fy0;
    ivec2 b = p + ivec2(int(fx0), int(fy0));
    float a = texelFetch(uP0, cl(b), 0).r * (1.0 - fx) + texelFetch(uP0, cl(b + ivec2(1, 0)), 0).r * fx;
    float c = texelFetch(uP0, cl(b + ivec2(0, 1)), 0).r * (1.0 - fx) + texelFetch(uP0, cl(b + ivec2(1, 1)), 0).r * fx;
    v = a * (1.0 - fy) + c * fy;
  } else if (uKind == 4) {
    float t = abs(texelFetch(uP0, p, 0).r - texelFetch(uP1, p, 0).r);
    v = uFlag == 1 ? 1.0 - t : t;
  } else if (uKind == 5) {
    v = texelFetch(uP0, p, 0).r * clamp01(texelFetch(uP1, p, 0).r / uR);
  } else if (uKind == 6) {
    float di = texelFetch(uP0, p, 0).r;
    float dout = texelFetch(uP1, p, 0).r;
    bool inside = oa >= 0.5;
    float sd = inside ? dout - 0.5 : -(di - 0.5);
    float hv = 0.0;
    if (uBev == 0) hv = inside ? smth(clamp01(sd / uBevSize)) : 0.0;
    else if (uBev == 1) hv = inside ? 1.0 : 1.0 - smth(clamp01(-sd / uBevSize));
    else if (uBev == 2) hv = smth(clamp01(0.5 + sd / (2.0 * uBevSize)));
    else hv = smth(clamp01(abs(sd) / uBevSize));
    v = hv * uSgn;
  } else {
    v = oa;
  }
  o = vec4(v, 0.0, 0.0, 1.0);
}`;

const FS_EDT1 =
  COMMON +
  `uniform int uC;
uniform int uMode;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float best = 1e12;
  for (int dy = -uC; dy <= uC; dy++) {
    int y = p.y + dy;
    if (y < 0 || y >= uSize.y) continue;
    bool ins = OAat(ivec2(p.x, y)) >= 0.5;
    if (ins == (uMode == 0)) best = min(best, float(dy * dy));
  }
  o = vec4(best, 0.0, 0.0, 1.0);
}`;

const FS_EDT2 =
  GL_HEAD +
  `uniform sampler2D uTex;
uniform int uC;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float best = 1e12;
  for (int dx = -uC; dx <= uC; dx++) {
    int x = p.x + dx;
    if (x < 0 || x >= uSize.x) continue;
    best = min(best, float(dx * dx) + texelFetch(uTex, ivec2(x, p.y), 0).r);
  }
  o = vec4(best >= 1e11 ? 1e6 : sqrt(best), 0.0, 0.0, 1.0);
}`;

const FS_STAGE =
  COMMON +
  `uniform sampler2D uSurf;
uniform sampler2D uP0;
uniform sampler2D uP1;
uniform sampler2D uLut;
uniform int uKind;
uniform vec3 uColor;
uniform float uOp;
uniform int uMode;
uniform float uR;
// wytłoczenie
uniform vec3 uL;
uniform float uDepth;
uniform vec3 uHc;
uniform float uHo;
uniform int uHm;
uniform vec3 uSc;
uniform float uSo;
uniform int uSm;
uniform int uMaskKind;
// gradient
uniform int uShape;
uniform vec2 uCtr;
uniform vec2 uU;
uniform float uTh;
uniform float uHalf;
uniform float uRad;
uniform vec2 uDoc;
uniform float uScale;

float blendCh(int m, float b, float s) {
  if (m == 1) return b * s;
  if (m == 2) return b + s - b * s;
  if (m == 3) return b <= 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
  if (m == 4) return s <= 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
  if (m == 5) {
    if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
    float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
    return b + (2.0 * s - 1.0) * (d - b);
  }
  if (m == 6) return b < s ? b : s;
  if (m == 7) return b > s ? b : s;
  if (m == 8) return b == 0.0 ? 0.0 : (s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s)));
  if (m == 9) return b >= 1.0 ? 1.0 : (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s));
  if (m == 10) return abs(b - s);
  if (m == 11) return b + s - 2.0 * b * s;
  return s;
}

vec4 paintOn(vec4 S, vec3 c, float sa, int mode) {
  if (sa <= 0.0005) return S;
  float ab = S.a;
  float ao = sa + ab * (1.0 - sa);
  vec3 col;
  if (mode == 0 || ab <= 0.0) {
    float k = ab * (1.0 - sa);
    col = (c * sa + S.rgb * k) / ao;
  } else {
    float kb = (1.0 - sa) * ab;
    float ks = sa * (1.0 - ab);
    float km = sa * ab;
    col = (kb * S.rgb + ks * c + km * vec3(blendCh(mode, S.r, c.r), blendCh(mode, S.g, c.g), blendCh(mode, S.b, c.b))) / ao;
  }
  return vec4(col, ao);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 S = texelFetch(uSurf, p, 0);
  vec4 src = texelFetch(uSrc, p, 0);
  float oa = src.a;
  o = S;
  if (uKind == 0) {
    float k = texelFetch(uP0, p, 0).r * (1.0 - oa) * uOp;
    o = paintOn(S, uColor, k, 0);
  } else if (uKind == 1) {
    float di = texelFetch(uP0, p, 0).r;
    float dout = texelFetch(uP1, p, 0).r;
    if (dout > 1.5) return;
    o = paintOn(S, uColor, clamp01(uR + 1.0 - di) * uOp, 0);
  } else if (uKind == 2) {
    if (oa <= 0.0) return;
    if (oa >= 0.999 || S.a == 0.0) o = vec4(src.rgb, oa);
    else o = paintOn(S, src.rgb, oa, 0);
  } else if (uKind == 3) {
    o = paintOn(S, uColor, texelFetch(uP0, p, 0).r * oa * uOp, uMode);
  } else if (uKind == 4) {
    o = paintOn(S, uColor, oa * uOp, uMode);
  } else if (uKind == 5) {
    if (oa <= 0.0) return;
    vec2 q = uDoc + (vec2(p) + 0.5) / uScale - uCtr;
    float t;
    if (uShape == 1) t = length(q) / uRad;
    else if (uShape == 2) {
      t = (atan(-q.y, q.x) - uTh) / 6.283185307179586;
      t = t - floor(t);
    } else if (uShape == 3) t = abs((q.x * uU.x + q.y * uU.y) / uHalf);
    else if (uShape == 4) t = (abs(q.x) + abs(q.y)) / uRad;
    else t = 0.5 + (q.x * uU.x + q.y * uU.y) / (2.0 * uHalf);
    int li = int(clamp(floor(clamp01(t) * 255.0 + 0.5), 0.0, 255.0));
    vec4 g = texelFetch(uLut, ivec2(li, 0), 0);
    o = paintOn(S, g.rgb, g.a * oa * uOp, uMode);
  } else if (uKind == 6) {
    float dout = texelFetch(uP0, p, 0).r;
    float band = oa - clamp01(dout - uR);
    o = paintOn(S, uColor, max(band, 0.0) * uOp, uMode);
  } else if (uKind == 7) {
    float m = uMaskKind == 0 ? oa : (uMaskKind == 1 ? 1.0 - oa : 1.0);
    if (m <= 0.0005) return;
    int xm = p.x > 0 ? p.x - 1 : p.x;
    int xp = p.x < uSize.x - 1 ? p.x + 1 : p.x;
    int ym = p.y > 0 ? p.y - 1 : p.y;
    int yp = p.y < uSize.y - 1 ? p.y + 1 : p.y;
    float gx = (texelFetch(uP0, ivec2(xp, p.y), 0).r - texelFetch(uP0, ivec2(xm, p.y), 0).r) / float(max(xp - xm, 1));
    float gy = (texelFetch(uP0, ivec2(p.x, yp), 0).r - texelFetch(uP0, ivec2(p.x, ym), 0).r) / float(max(yp - ym, 1));
    if (gx == 0.0 && gy == 0.0) return;
    float nx = -gx * uDepth;
    float ny = -gy * uDepth;
    float inv = 1.0 / sqrt(nx * nx + ny * ny + 1.0);
    float I = (nx * uL.x + ny * uL.y + uL.z) * inv;
    float I0 = uL.z;
    if (I > I0) o = paintOn(S, uHc, clamp01((I - I0) / (1.0 - I0 + 1e-3)) * uHo * m, uHm);
    else o = paintOn(S, uSc, clamp01((I0 - I) / (I0 + 1e-3)) * uSo * m, uSm);
  }
}`;

const FS_OUT =
  GL_HEAD +
  `uniform sampler2D uSurf;
void main() {
  o = clamp(texelFetch(uSurf, ivec2(gl_FragCoord.xy), 0), 0.0, 1.0);
}`;

const FS_CLEAR = GL_HEAD + `void main() { o = vec4(0.0); }`;

const BOX_FS =
  GL_HEAD +
  `uniform sampler2D uTex;
uniform ivec2 uDir;
uniform int uR;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float s = 0.0;
  for (int k = -uR; k <= uR; k++) s += texelFetch(uTex, cl(p + uDir * k), 0).r;
  o = vec4(s / float(2 * uR + 1), 0.0, 0.0, 1.0);
}`;

const ui = (g: GL, pr: ReturnType<typeof kitProg>, n: string, v: number): void => g.uniform1i(kitUni(g, pr, n), v);
const uf = (g: GL, pr: ReturnType<typeof kitProg>, n: string, v: number): void => g.uniform1f(kitUni(g, pr, n), v);
const u2 = (g: GL, pr: ReturnType<typeof kitProg>, n: string, a: number, b: number): void => g.uniform2f(kitUni(g, pr, n), a, b);
const u3 = (g: GL, pr: ReturnType<typeof kitProg>, n: string, c: [number, number, number]): void => g.uniform3f(kitUni(g, pr, n), c[0], c[1], c[2]);

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const MAX_CAP = 300;

/** Zasięg (piksele) potrzebnych map odległości dla włączonych stylizacji. */
function distanceCap(st: LayerStyles, sc: number): number {
  let m = 2;
  if (styleOn(st, 'dropShadow')) m = Math.max(m, (st.dropShadow.spread / 100) * st.dropShadow.size * sc + 2);
  if (styleOn(st, 'outerGlow')) m = Math.max(m, (st.outerGlow.spread / 100) * st.outerGlow.size * sc + 2);
  if (styleOn(st, 'stroke')) m = Math.max(m, (st.stroke.position === 'center' ? st.stroke.width / 2 : st.stroke.width) * sc + 2);
  if (styleOn(st, 'innerShadow')) m = Math.max(m, (st.innerShadow.choke / 100) * st.innerShadow.size * sc + 2);
  if (styleOn(st, 'innerGlow')) {
    const x = st.innerGlow;
    const size = x.size * sc;
    m = Math.max(m, x.source === 'edge' ? (x.choke / 100) * size + 2 : size * (1 + x.choke / 100) + 2);
  }
  if (styleOn(st, 'bevel')) m = Math.max(m, Math.max(1, st.bevel.size * sc) + 2);
  return Math.ceil(m) + 1;
}

/** Stylizacje na GPU; piksele `d` (RGBA, proste kolory) zapisywane w miejscu. */
export function gpuApplyStyles(d: Uint8ClampedArray, w: number, h: number, st: LayerStyles, fx: StyleFx, inner = false): boolean {
  if (!stylesActive(st) || w <= 0 || h <= 0) return true;
  const g = kitGl();
  if (!g) return false;
  const sc = fx.scale || 1;
  if (!inner) {
    // jak w wersji CPU: praca tylko w prostokącie zawartości powiększonym o zasięg efektów
    let bx0 = w;
    let by0 = h;
    let bx1 = -1;
    let by1 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4 + 3;
      for (let x = 0; x < w; x++) {
        if (d[row + x * 4] !== 0) {
          if (x < bx0) bx0 = x;
          if (x > bx1) bx1 = x;
          if (y < by0) by0 = y;
          by1 = y;
        }
      }
    }
    if (bx1 < 0) return true;
    const m = Math.ceil(stylesMargin(st) * sc) + 2;
    const x0 = Math.max(0, bx0 - m);
    const y0 = Math.max(0, by0 - m);
    const x1 = Math.min(w, bx1 + 1 + m);
    const y1 = Math.min(h, by1 + 1 + m);
    const sw = x1 - x0;
    const sh = y1 - y0;
    if (sw * sh < w * h * 0.6) {
      const sub = new Uint8ClampedArray(sw * sh * 4);
      for (let y = 0; y < sh; y++) sub.set(d.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + sw) * 4), y * sw * 4);
      const sfx = { ...fx, docX0: fx.docX0 + x0 / sc, docY0: fx.docY0 + y0 / sc, bounds: undefined } as StyleFx;
      if (!gpuApplyStyles(sub, sw, sh, st, sfx, true)) return false;
      for (let y = 0; y < sh; y++) d.set(sub.subarray(y * sw * 4, (y + 1) * sw * 4), ((y0 + y) * w + x0) * 4);
      return true;
    }
  }
  if (w * h < 4096 || w > kitMaxTex() || h > kitMaxTex()) return false;
  const cap = distanceCap(st, sc);
  if (cap > MAX_CAP) return false;
  try {
    run(g, d, w, h, st, fx, sc, cap);
    return true;
  } catch (e) {
    console.warn('GpuStyles', e);
    kitFail();
    return false;
  }
}

function run(g: GL, d: Uint8ClampedArray, w: number, h: number, st: LayerStyles, fx: StyleFx, sc: number, cap: number): void {
  kitBegin(g, w, h);
  const src = kitSrcTex(g, w, h);
  const out = kitOutTex(g, w, h);
  kitUpload(g, src, d);
  runStyles(g, src, out, w, h, st, fx, sc, cap);
  kitRead(g, out, d);
}

/**
 * Stylizacje jako krok sesji GPU (dane zostają na karcie): czyta bieżącą teksturę sesji i zapisuje wynik do drugiej.
 * false = parametry poza zakresem albo błąd (sesja jest wtedy przerwana, a wynik trzeba policzyć inaczej).
 */
export function gpuStylesInSession(st: LayerStyles, w: number, h: number, fx: StyleFx): boolean {
  if (!gpuSessionActive()) return false;
  if (!stylesActive(st)) return true;
  const g = kitGl();
  if (!g) return false;
  const sc = fx.scale || 1;
  if (w * h < 4096 || w > kitMaxTex() || h > kitMaxTex()) return false;
  const cap = distanceCap(st, sc);
  if (cap > MAX_CAP) return false;
  try {
    kitBegin(g, w, h);
    return gpuSessionRun(w, h, (gl, src, out) => runStyles(gl, src, out, w, h, st, fx, sc, cap));
  } catch (e) {
    console.warn('GpuStyles', e);
    kitFail();
    return false;
  }
}

/** Czy stylizacje da się policzyć w sesji GPU dla okna o rozmiarze w x h (bez wykonywania). */
export function gpuStylesFit(st: LayerStyles, w: number, h: number, scale: number): boolean {
  if (!stylesActive(st)) return true;
  if (w * h < 4096 || w > kitMaxTex() || h > kitMaxTex()) return false;
  return distanceCap(st, scale || 1) <= MAX_CAP;
}

function runStyles(g: GL, src: Tex, out: Tex, w: number, h: number, st: LayerStyles, fx: StyleFx, sc: number, cap: number): void {
  const prPlane = kitProg(g, 'st_plane', FS_PLANE);
  const prE1 = kitProg(g, 'st_edt1', FS_EDT1);
  const prE2 = kitProg(g, 'st_edt2', FS_EDT2);
  const prStage = kitProg(g, 'st_stage', FS_STAGE);
  const prBox = kitProg(g, 'st_box', BOX_FS);
  const prOut = kitProg(g, 'st_out', FS_OUT);
  const prClear = kitProg(g, 'st_clear', FS_CLEAR);

  let dInT: Tex | null = null;
  let dOutT: Tex | null = null;
  let oaT: Tex | null = null;
  const rel = (t: Tex): void => {
    if (t === oaT || t === dInT || t === dOutT) return;
    kitRelease(t);
  };
  const bindAll = (pr: ReturnType<typeof kitProg>, p0: Tex | null, p1: Tex | null, extra?: { surf?: Tex; lut?: Tex }): void => {
    // wszystkie próbniki muszą wskazywać istniejące tekstury (nieużywane dostają dowolną inną niż cel)
    kitBind(g, 0, src);
    ui(g, pr, 'uSrc', 0);
    if (kitUni(g, pr, 'uP0')) {
      kitBind(g, 1, p0 ?? src);
      ui(g, pr, 'uP0', 1);
    }
    if (kitUni(g, pr, 'uP1')) {
      kitBind(g, 2, p1 ?? src);
      ui(g, pr, 'uP1', 2);
    }
    if (extra?.surf && kitUni(g, pr, 'uSurf')) {
      kitBind(g, 3, extra.surf);
      ui(g, pr, 'uSurf', 3);
    }
    if (kitUni(g, pr, 'uLut')) {
      kitBind(g, 4, extra?.lut ?? src);
      ui(g, pr, 'uLut', 4);
    }
  };

  // --- płaszczyzny ---
  const plane = (kind: number, p0: Tex | null, p1: Tex | null, set?: () => void): Tex => {
    const dst = kitAlloc(g, w, h, 'r32f');
    kitPass(g, prPlane, dst, w, h, () => {
      bindAll(prPlane, p0, p1);
      ui(g, prPlane, 'uKind', kind);
      uf(g, prPlane, 'uR', 0);
      u2(g, prPlane, 'uD', 0, 0);
      ui(g, prPlane, 'uFlag', 0);
      uf(g, prPlane, 'uBevSize', 1);
      ui(g, prPlane, 'uBev', 0);
      uf(g, prPlane, 'uSgn', 1);
      set?.();
    });
    return dst;
  };
  const edt = (mode: 0 | 1): Tex => {
    const t1 = kitAlloc(g, w, h, 'r32f');
    kitPass(g, prE1, t1, w, h, () => {
      kitBind(g, 0, src);
      ui(g, prE1, 'uSrc', 0);
      ui(g, prE1, 'uC', cap);
      ui(g, prE1, 'uMode', mode);
    });
    const t2 = kitAlloc(g, w, h, 'r32f');
    kitPass(g, prE2, t2, w, h, () => {
      kitBind(g, 0, t1);
      ui(g, prE2, 'uTex', 0);
      ui(g, prE2, 'uC', cap);
    });
    kitRelease(t1);
    return t2;
  };
  const dIn = (): Tex => dInT ?? (dInT = edt(0));
  const dOut = (): Tex => dOutT ?? (dOutT = edt(1));
  const OA = (): Tex => oaT ?? (oaT = plane(7, null, null));

  const grow = (r: number): { t: Tex; own: boolean } => {
    if (r <= 0.01) return { t: OA(), own: false };
    return { t: plane(0, dIn(), null, () => uf(g, prPlane, 'uR', r)), own: true };
  };
  const shrink = (r: number): { t: Tex; own: boolean } => {
    if (r <= 0.01) return { t: OA(), own: false };
    return { t: plane(1, dOut(), null, () => uf(g, prPlane, 'uR', r)), own: true };
  };
  const blurPlaneT = (t: Tex, sigma: number): Tex => {
    if (sigma < 0.3) return t;
    let cur = t;
    let own = false;
    for (const r0 of boxRadii(sigma)) {
      const r = Math.max(0, Math.round(r0));
      if (r === 0) continue;
      for (const dir of [[1, 0], [0, 1]]) {
        const dst = kitAlloc(g, w, h, 'r32f');
        const from = cur;
        kitPass(g, prBox, dst, w, h, () => {
          kitBind(g, 0, from);
          ui(g, prBox, 'uTex', 0);
          g.uniform2i(kitUni(g, prBox, 'uDir'), dir[0], dir[1]);
          ui(g, prBox, 'uR', r);
        });
        if (own) rel(cur);
        cur = dst;
        own = true;
      }
    }
    return cur;
  };
  /** Rozmycie z przesunięciem; zwraca nową płaszczyznę (nie zmienia wejścia). */
  const blurShift = (base: Tex, sigma: number, dx: number, dy: number): Tex => {
    let cur = base;
    let own = false;
    if (Math.abs(dx) >= 1e-3 || Math.abs(dy) >= 1e-3) {
      cur = plane(3, base, null, () => u2(g, prPlane, 'uD', dx, dy));
      own = true;
    }
    const b = blurPlaneT(cur, sigma);
    if (b !== cur && own) rel(cur);
    return b;
  };
  const free = (t: Tex, own: boolean): void => {
    if (own) rel(t);
  };

  // --- powierzchnia (ping-pong) ---
  let surf = kitAlloc(g, w, h, 'rgba32f');
  let surf2 = kitAlloc(g, w, h, 'rgba32f');
  kitPass(g, prClear, surf, w, h, () => {});
  const stage = (kind: number, p0: Tex | null, p1: Tex | null, set: () => void, lut?: Tex): void => {
    kitPass(g, prStage, surf2, w, h, () => {
      bindAll(prStage, p0, p1, { surf, lut });
      ui(g, prStage, 'uKind', kind);
      u3(g, prStage, 'uColor', [0, 0, 0]);
      uf(g, prStage, 'uOp', 0);
      ui(g, prStage, 'uMode', 0);
      uf(g, prStage, 'uR', 0);
      u3(g, prStage, 'uL', [0, 0, 1]);
      uf(g, prStage, 'uDepth', 0);
      u3(g, prStage, 'uHc', [0, 0, 0]);
      uf(g, prStage, 'uHo', 0);
      ui(g, prStage, 'uHm', 0);
      u3(g, prStage, 'uSc', [0, 0, 0]);
      uf(g, prStage, 'uSo', 0);
      ui(g, prStage, 'uSm', 0);
      ui(g, prStage, 'uMaskKind', 0);
      ui(g, prStage, 'uShape', 0);
      u2(g, prStage, 'uCtr', 0, 0);
      u2(g, prStage, 'uU', 1, 0);
      uf(g, prStage, 'uTh', 0);
      uf(g, prStage, 'uHalf', 1);
      uf(g, prStage, 'uRad', 1);
      u2(g, prStage, 'uDoc', 0, 0);
      uf(g, prStage, 'uScale', 1);
      set();
    });
    const t = surf;
    surf = surf2;
    surf2 = t;
  };
  const color = (hex: string, op: number, mode: StyleBlend = 'normal'): (() => void) => () => {
    u3(g, prStage, 'uColor', parseColor(hex));
    uf(g, prStage, 'uOp', clamp01(op / 100));
    ui(g, prStage, 'uMode', MODE[mode]);
  };

  const lightAngle = (own: boolean, a: number): number => (own ? st.globalAngle : a);
  const offsetOf = (angDeg: number, dist: number): [number, number] => {
    const t = (angDeg * Math.PI) / 180;
    return [-Math.cos(t) * dist * sc, Math.sin(t) * dist * sc];
  };

  if (styleOn(st, 'dropShadow')) {
    const x = st.dropShadow;
    const size = x.size * sc;
    const [ox, oy] = offsetOf(lightAngle(x.useGlobalLight, x.angle), x.distance);
    const gr = grow((x.spread / 100) * size);
    const sh = blurShift(gr.t, size / 2, ox, oy);
    free(gr.t, gr.own);
    stage(0, sh, null, color(x.color, x.opacity));
    rel(sh);
  }
  if (styleOn(st, 'outerGlow')) {
    const x = st.outerGlow;
    const size = x.size * sc;
    const gr = grow((x.spread / 100) * size);
    const sh = blurShift(gr.t, size / 2, 0, 0);
    free(gr.t, gr.own);
    stage(0, sh, null, color(x.color, x.opacity));
    rel(sh);
  }
  if (styleOn(st, 'stroke') && st.stroke.position !== 'inside') {
    const x = st.stroke;
    const r = (x.position === 'center' ? x.width / 2 : x.width) * sc;
    stage(1, dIn(), dOut(), () => {
      color(x.color, x.opacity)();
      uf(g, prStage, 'uR', r);
    });
  }

  stage(2, null, null, () => {});

  if (styleOn(st, 'satin')) {
    const x = st.satin;
    const size = x.size * sc;
    const [ox, oy] = offsetOf(x.angle, x.distance);
    const a1 = blurShift(OA(), size / 2, ox, oy);
    const a2 = blurShift(OA(), size / 2, -ox, -oy);
    const pl = plane(4, a1, a2, () => ui(g, prPlane, 'uFlag', x.invert ? 1 : 0));
    rel(a1);
    rel(a2);
    stage(3, pl, null, color(x.color, x.opacity, x.blend));
    rel(pl);
  }
  if (styleOn(st, 'colorOverlay')) {
    const x = st.colorOverlay;
    stage(4, null, null, color(x.color, x.opacity, x.blend));
  }
  if (styleOn(st, 'gradientOverlay')) {
    const x = st.gradientOverlay;
    const lut = gradientLut(x.stops, x.reverse);
    const lutTex = makeLut(g, lut);
    const lb = x.align === 'layer' && fx.layerBounds ? fx.layerBounds : { x0: 0, y0: 0, x1: fx.docW, y1: fx.docH };
    const bw = Math.max(1, lb.x1 - lb.x0);
    const bh = Math.max(1, lb.y1 - lb.y0);
    const cx = (lb.x0 + lb.x1) / 2;
    const cy = (lb.y0 + lb.y1) / 2;
    const th = (x.angle * Math.PI) / 180;
    const ux = Math.cos(th);
    const uy = -Math.sin(th);
    const k = Math.max(0.01, x.scale / 100);
    const half = Math.max(1e-3, ((Math.abs(bw * ux) + Math.abs(bh * uy)) / 2) * k);
    const rad = Math.max(1e-3, (Math.hypot(bw, bh) / 2) * k);
    const shape = { linear: 0, radial: 1, angle: 2, reflected: 3, diamond: 4 }[x.shape] ?? 0;
    stage(
      5,
      null,
      null,
      () => {
        uf(g, prStage, 'uOp', clamp01(x.opacity / 100));
        ui(g, prStage, 'uMode', MODE[x.blend]);
        ui(g, prStage, 'uShape', shape);
        u2(g, prStage, 'uCtr', cx, cy);
        u2(g, prStage, 'uU', ux, uy);
        uf(g, prStage, 'uTh', th);
        uf(g, prStage, 'uHalf', half);
        uf(g, prStage, 'uRad', rad);
        u2(g, prStage, 'uDoc', fx.docX0, fx.docY0);
        uf(g, prStage, 'uScale', sc);
      },
      lutTex
    );
    g.deleteTexture(lutTex.t);
    g.deleteFramebuffer(lutTex.fbo);
  }
  if (styleOn(st, 'innerGlow')) {
    const x = st.innerGlow;
    const size = x.size * sc;
    let pl: Tex;
    if (x.source === 'edge') {
      const e = shrink((x.choke / 100) * size);
      const inv = plane(2, e.t, null);
      free(e.t, e.own);
      pl = blurShift(inv, size / 2, 0, 0);
      rel(inv);
    } else {
      const b = blurShift(OA(), Math.max(0.5, size / 2), 0, 0);
      const reach = Math.max(1, size * (1 + x.choke / 100));
      pl = plane(5, b, dOut(), () => uf(g, prPlane, 'uR', reach));
      rel(b);
    }
    stage(3, pl, null, color(x.color, x.opacity, x.blend));
    rel(pl);
  }
  if (styleOn(st, 'innerShadow')) {
    const x = st.innerShadow;
    const size = x.size * sc;
    const [ox, oy] = offsetOf(lightAngle(x.useGlobalLight, x.angle), x.distance);
    const e = shrink((x.choke / 100) * size);
    const inv = plane(2, e.t, null);
    free(e.t, e.own);
    const pl = blurShift(inv, size / 2, ox, oy);
    rel(inv);
    stage(3, pl, null, color(x.color, x.opacity, x.blend));
    rel(pl);
  }
  if (styleOn(st, 'bevel')) {
    const x = st.bevel;
    const size = Math.max(1, x.size * sc);
    const bevIdx = { inner: 0, outer: 1, emboss: 2, pillow: 3 }[x.kind] ?? 3;
    const hm = plane(6, dIn(), dOut(), () => {
      uf(g, prPlane, 'uBevSize', size);
      ui(g, prPlane, 'uBev', bevIdx);
      uf(g, prPlane, 'uSgn', x.direction === 'up' ? 1 : -1);
    });
    const hb = blurPlaneT(hm, Math.max(0.7, x.soften * sc));
    if (hb !== hm) rel(hm);
    const depth = (x.depth / 100) * size * 1.5;
    const ang = ((x.useGlobalLight ? st.globalAngle : x.angle) * Math.PI) / 180;
    const alt = ((x.useGlobalLight ? st.globalAltitude : x.altitude) * Math.PI) / 180;
    const L: [number, number, number] = [Math.cos(alt) * Math.cos(ang), -Math.cos(alt) * Math.sin(ang), Math.sin(alt)];
    stage(7, hb, null, () => {
      u3(g, prStage, 'uL', L);
      uf(g, prStage, 'uDepth', depth);
      u3(g, prStage, 'uHc', parseColor(x.highlightColor));
      uf(g, prStage, 'uHo', clamp01(x.highlightOpacity / 100));
      ui(g, prStage, 'uHm', MODE[x.highlightBlend]);
      u3(g, prStage, 'uSc', parseColor(x.shadowColor));
      uf(g, prStage, 'uSo', clamp01(x.shadowOpacity / 100));
      ui(g, prStage, 'uSm', MODE[x.shadowBlend]);
      ui(g, prStage, 'uMaskKind', x.kind === 'inner' ? 0 : x.kind === 'outer' ? 1 : 2);
    });
    rel(hb);
  }
  if (styleOn(st, 'stroke') && st.stroke.position !== 'outside') {
    const x = st.stroke;
    const r = (x.position === 'center' ? x.width / 2 : x.width) * sc;
    stage(6, dOut(), null, () => {
      color(x.color, x.opacity, x.blend)();
      uf(g, prStage, 'uR', r);
    });
  }

  kitPass(g, prOut, out, w, h, () => {
    kitBind(g, 3, surf);
    ui(g, prOut, 'uSurf', 3);
  });
  kitRelease(surf);
  kitRelease(surf2);
}

function makeLut(g: GL, lut: Float32Array): Tex & { fbo: WebGLFramebuffer } {
  const tx = g.createTexture()!;
  g.bindTexture(g.TEXTURE_2D, tx);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA32F, 256, 1, 0, g.RGBA, g.FLOAT, lut);
  return { t: tx, fbo: g.createFramebuffer()!, w: 256, h: 1 };
}
