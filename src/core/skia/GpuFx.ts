/**
 * GpuFx - filtry rozmycia liczone na karcie graficznej (WebGL2) z automatycznym powrotem do procesora.
 *
 * Każda funkcja dostaje bufor RGBA (Uint8ClampedArray, proste kolory) i zapisuje w nim wynik W MIEJSCU. Zwraca `false`,
 * jeśli GPU jest niedostępne (brak WebGL2 / brak tekstur zmiennoprzecinkowych / zbyt duży bufor / błąd) - wtedy filtr
 * liczy się na CPU tak jak dotąd. Semantyka (przycinanie próbek do brzegów bufora, zaokrąglanie położeń próbek,
 * mnożenie przez alfę) jest taka sama jak w wersji procesorowej.
 */

type GL = WebGL2RenderingContext;

interface Prog {
  p: WebGLProgram;
  u: Map<string, WebGLUniformLocation | null>;
}

interface Tex {
  t: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const GL_HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform ivec2 uSize;
out vec4 o;
ivec2 cl(ivec2 p) { return clamp(p, ivec2(0), uSize - 1); }
/** Piksel RGBA8 jako (RGB * alfa, alfa) w skali 0..255. */
vec4 fetchP(sampler2D t, ivec2 p) {
  vec4 c = floor(texelFetch(t, p, 0) * 255.0 + 0.5);
  return vec4(c.rgb * (c.a / 255.0), c.a);
}
/** (RGB * alfa, alfa) 0..255 -> RGBA8 prostych kolorów (0..1); alfa 0 daje zero. */
vec4 unP(vec4 f) {
  if (f.a <= 0.001) return vec4(0.0);
  return vec4(clamp(f.rgb * (255.0 / f.a), 0.0, 255.0) / 255.0, clamp(f.a, 0.0, 255.0) / 255.0);
}
float lum255(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
`;

/** RGBA8 (proste kolory) -> float: RGB * alfa, alfa; skala 0..255 jak w wersji CPU. */
const FS_PREMUL =
  GL_HEAD +
  `uniform sampler2D uSrc;
void main() {
  vec4 c = floor(texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0) * 255.0 + 0.5);
  o = vec4(c.rgb * (c.a / 255.0), c.a);
}`;

/** Jeden przebieg rozmycia pudełkowego; uDir = (1,0) lub (0,1). Brzegi: powtórzenie skrajnego piksela. */
const FS_BOX =
  GL_HEAD +
  `uniform sampler2D uTex;
uniform ivec2 uDir;
uniform int uR;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = vec4(0.0);
  for (int k = -uR; k <= uR; k++) s += texelFetch(uTex, cl(p + uDir * k), 0);
  o = s / float(2 * uR + 1);
}`;

const FS_MOTION =
  GL_HEAD +
  `uniform sampler2D uSrc;
uniform ivec2 uOff[96];
uniform int uN;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = vec4(0.0);
  for (int k = 0; k < uN; k++) s += fetchP(uSrc, cl(p + uOff[k]));
  o = unP(s / float(uN));
}`;

const FS_RADIAL =
  GL_HEAD +
  `uniform sampler2D uSrc;
uniform vec3 uK[64];
uniform vec2 uC;
uniform int uN;
uniform int uSpin;
void main() {
  vec2 p = floor(gl_FragCoord.xy);
  vec2 r = p - uC;
  vec4 s = vec4(0.0);
  for (int k = 0; k < uN; k++) {
    vec2 q;
    if (uSpin == 1) q = uC + vec2(r.x * uK[k].x - r.y * uK[k].y, r.x * uK[k].y + r.y * uK[k].x);
    else q = uC + r * uK[k].z;
    s += fetchP(uSrc, cl(ivec2(floor(q + 0.500001))));
  }
  o = unP(s / float(uN));
}`;

const FS_LENS =
  GL_HEAD +
  `uniform sampler2D uSrc;
uniform ivec2 uOff[120];
uniform int uN;
uniform float uBoost;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = vec4(0.0);
  float sw = 0.0;
  for (int k = 0; k < uN; k++) {
    ivec2 q = cl(p + uOff[k]);
    vec3 c = texelFetch(uSrc, q, 0).rgb;
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    float l2 = l * l;
    float wt = 1.0 + uBoost * 6.0 * l2 * l2;
    s += fetchP(uSrc, q) * wt;
    sw += wt;
  }
  o = unP(s / sw);
}`;

/** Float (RGB * alfa, alfa; 0..255) -> RGBA8 z proste kolory. uKeep=1: alfa oryginału zostaje. */
const FS_UNPREMUL =
  GL_HEAD +
  `uniform sampler2D uTex;
uniform sampler2D uSrc;
uniform int uKeep;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 f = texelFetch(uTex, p, 0);
  vec4 s = texelFetch(uSrc, p, 0);
  if (uKeep == 1) {
    if (s.a == 0.0 || f.a <= 0.001) { o = s; return; }
    o = vec4(clamp(f.rgb * (255.0 / f.a), 0.0, 255.0) / 255.0, s.a);
  } else {
    if (f.a <= 0.001) { o = vec4(0.0); return; }
    o = vec4(clamp(f.rgb * (255.0 / f.a), 0.0, 255.0) / 255.0, clamp(f.a, 0.0, 255.0) / 255.0);
  }
}`;

const FS_SURFACE =
  GL_HEAD +
  `uniform sampler2D uSrc;
uniform int uR;
uniform int uStride;
uniform float uSig2;
uniform float uInv;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s0 = texelFetch(uSrc, p, 0);
  o = s0;
  if (s0.a == 0.0) return;
  vec3 c0 = s0.rgb * 255.0;
  vec3 acc = vec3(0.0);
  float sw = 0.0;
  for (int dy = -uR; dy <= uR; dy += uStride) {
    for (int dx = -uR; dx <= uR; dx += uStride) {
      vec4 sj = texelFetch(uSrc, cl(p + ivec2(dx, dy)), 0);
      if (sj.a == 0.0) continue;
      vec3 cj = sj.rgb * 255.0;
      vec3 e = cj - c0;
      float q = dot(e, e) * uInv;
      if (q >= 12.0) continue;
      float wt = exp(-float(dx * dx + dy * dy) / uSig2 - q) * sj.a * 255.0;
      acc += cj * wt;
      sw += wt;
    }
  }
  if (sw > 0.0) o = vec4(clamp(acc / sw, 0.0, 255.0) / 255.0, s0.a);
}`;

let disabled = false;
let gl: GL | null = null;
const progs = new Map<string, Prog>();
const texPool: Record<string, Tex | undefined> = {};
let maxTex = 0;

/** Wyłączenie GPU (np. `?nogpu` w adresie albo ustawienie użytkownika): wszystkie filtry liczą się na CPU. */
export function setGpuFxEnabled(on: boolean): void {
  disabled = !on;
}

export function gpuFxAvailable(): boolean {
  return !!getGl();
}

function getGl(): GL | null {
  if (disabled) return null;
  if (gl) {
    if (gl.isContextLost()) {
      gl = null;
      progs.clear();
      for (const k of Object.keys(texPool)) delete texPool[k];
    } else return gl;
  }
  if (typeof document === 'undefined') {
    disabled = true;
    return null;
  }
  try {
    if (typeof location !== 'undefined' && /[?&]nogpu\b/.test(location.search)) {
      disabled = true;
      return null;
    }
    const cv = document.createElement('canvas');
    cv.width = 1;
    cv.height = 1;
    const g = cv.getContext('webgl2', { antialias: false, alpha: true, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!g) {
      disabled = true;
      return null;
    }
    if (!g.getExtension('EXT_color_buffer_float')) {
      disabled = true;
      return null;
    }
    maxTex = g.getParameter(g.MAX_TEXTURE_SIZE) as number;
    gl = g;
    return g;
  } catch {
    disabled = true;
    return null;
  }
}

function prog(g: GL, name: string, fs: string): Prog {
  let r = progs.get(name);
  if (r) return r;
  const mk = (type: number, src: string): WebGLShader => {
    const s = g.createShader(type)!;
    g.shaderSource(s, src);
    g.compileShader(s);
    if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s) ?? 'shader');
    return s;
  };
  const p = g.createProgram()!;
  g.attachShader(p, mk(g.VERTEX_SHADER, VERT));
  g.attachShader(p, mk(g.FRAGMENT_SHADER, fs));
  g.linkProgram(p);
  if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(p) ?? 'link');
  r = { p, u: new Map() };
  progs.set(name, r);
  return r;
}

function uni(g: GL, pr: Prog, name: string): WebGLUniformLocation | null {
  let l = pr.u.get(name);
  if (l === undefined) {
    l = g.getUniformLocation(pr.p, name);
    pr.u.set(name, l);
  }
  return l;
}

export type TexFmt = 'r32f' | 'rgba32f' | 'rgba16f' | 'rgba8';

function makeTex(g: GL, w: number, h: number, fmt: TexFmt): Tex {
  const tx = g.createTexture()!;
  g.bindTexture(g.TEXTURE_2D, tx);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  if (fmt === 'rgba32f') g.texImage2D(g.TEXTURE_2D, 0, g.RGBA32F, w, h, 0, g.RGBA, g.FLOAT, null);
  else if (fmt === 'rgba16f') g.texImage2D(g.TEXTURE_2D, 0, g.RGBA16F, w, h, 0, g.RGBA, g.HALF_FLOAT, null);
  else if (fmt === 'r32f') g.texImage2D(g.TEXTURE_2D, 0, g.R32F, w, h, 0, g.RED, g.FLOAT, null);
  else g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, w, h, 0, g.RGBA, g.UNSIGNED_BYTE, null);
  const fbo = g.createFramebuffer()!;
  g.bindFramebuffer(g.FRAMEBUFFER, fbo);
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tx, 0);
  if (g.checkFramebufferStatus(g.FRAMEBUFFER) !== g.FRAMEBUFFER_COMPLETE) throw new Error('fbo');
  return { t: tx, fbo, w, h };
}

function tex(g: GL, slot: string, w: number, h: number, float: boolean): Tex {
  let t = texPool[slot];
  if (t && t.w === w && t.h === h) return t;
  if (t) {
    g.deleteTexture(t.t);
    g.deleteFramebuffer(t.fbo);
  }
  t = makeTex(g, w, h, float ? 'rgba32f' : 'rgba8');
  texPool[slot] = t;
  return t;
}

// --- zestaw narzędzi dla modułów korzystających z tego samego kontekstu (stylizacje) ---
interface KitTex extends Tex {
  fmt: TexFmt;
  used: boolean;
}
const kitPool: KitTex[] = [];

export type { Tex, GL as GL2 };
export { getGl as kitGl, prog as kitProg, uni as kitUni, pass as kitPass, bindIn as kitBind, uploadSrc as kitUpload, readBack as kitRead, makeTex as kitMakeTex };

/** Początek zadania: usuwa tekstury o innym rozmiarze, resztę oznacza jako wolne. */
export function kitBegin(g: GL, w: number, h: number): void {
  for (let i = kitPool.length - 1; i >= 0; i--) {
    const t = kitPool[i];
    if (t.w !== w || t.h !== h) {
      g.deleteTexture(t.t);
      g.deleteFramebuffer(t.fbo);
      kitPool.splice(i, 1);
    } else t.used = false;
  }
}

export function kitAlloc(g: GL, w: number, h: number, fmt: TexFmt): Tex {
  for (const t of kitPool) if (!t.used && t.fmt === fmt) {
    t.used = true;
    return t;
  }
  const t = { ...makeTex(g, w, h, fmt), fmt, used: true } as KitTex;
  kitPool.push(t);
  return t;
}

export function kitRelease(t: Tex): void {
  const k = t as KitTex;
  if (k.used !== undefined) k.used = false;
}

export function kitMaxTex(): number {
  return maxTex;
}

export function kitFail(): void {
  disabled = true;
}

export function kitSrcTex(g: GL, w: number, h: number): Tex {
  return tex(g, 'src', w, h, false);
}

export function kitOutTex(g: GL, w: number, h: number): Tex {
  return tex(g, 'out', w, h, false);
}

function uploadSrc(g: GL, t: Tex, d: Uint8ClampedArray): void {
  g.bindTexture(g.TEXTURE_2D, t.t);
  g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
  g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, 0);
  g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  g.texSubImage2D(g.TEXTURE_2D, 0, 0, 0, t.w, t.h, g.RGBA, g.UNSIGNED_BYTE, new Uint8Array(d.buffer, d.byteOffset, d.length));
}

function bindIn(g: GL, unit: number, t: Tex): void {
  g.activeTexture(g.TEXTURE0 + unit);
  g.bindTexture(g.TEXTURE_2D, t.t);
}

function pass(g: GL, pr: Prog, dst: Tex, w: number, h: number, setup: () => void): void {
  g.bindFramebuffer(g.FRAMEBUFFER, dst.fbo);
  g.viewport(0, 0, w, h);
  g.useProgram(pr.p);
  g.uniform2i(uni(g, pr, 'uSize'), w, h);
  setup();
  g.drawArrays(g.TRIANGLES, 0, 3);
}

function readBack(g: GL, t: Tex, d: Uint8ClampedArray): void {
  g.bindFramebuffer(g.FRAMEBUFFER, t.fbo);
  g.pixelStorei(g.PACK_ALIGNMENT, 1);
  g.readPixels(0, 0, t.w, t.h, g.RGBA, g.UNSIGNED_BYTE, new Uint8Array(d.buffer, d.byteOffset, d.length));
}

/** Wspólny szkielet: wgranie bufora, przygotowanie tekstur, wykonanie `body`, odczyt wyniku. */
function run(d: Uint8ClampedArray, w: number, h: number, body: (g: GL, src: Tex, fa: Tex, fb: Tex, out: Tex) => void, floats = true): boolean {
  if (sess) {
    // tryb sesji: dane zostają na GPU (tekstura bieżąca -> druga, potem zamiana); porażka przerywa całą sesję
    if (sess.failed) return true;
    const gs = sess.g;
    if (sess.w !== w || sess.h !== h) {
      sess.failed = true;
      return true;
    }
    try {
      const fa = floats ? tex(gs, 'fa', w, h, true) : sess.cur;
      const fb = floats ? tex(gs, 'fb', w, h, true) : sess.cur;
      body(gs, sess.cur, fa, fb, sess.other);
      const t = sess.cur;
      sess.cur = sess.other;
      sess.other = t;
    } catch {
      sess.failed = true;
    }
    return true;
  }
  if (w < 1 || h < 1 || w * h < 2048) return false;
  const g = getGl();
  if (!g || w > maxTex || h > maxTex) return false;
  try {
    const src = tex(g, 'src', w, h, false);
    const out = tex(g, 'out', w, h, false);
    const fa = floats ? tex(g, 'fa', w, h, true) : src;
    const fb = floats ? tex(g, 'fb', w, h, true) : src;
    uploadSrc(g, src, d);
    body(g, src, fa, fb, out);
    readBack(g, out, d);
    return true;
  } catch {
    disabled = true;
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Sesja: cały łańcuch korekcji i filtrów na GPU, wejście i wyjście bezpośrednio z płótna (bez kopii przez CPU)
// ---------------------------------------------------------------------------------------------------------------

interface Sess {
  g: GL;
  w: number;
  h: number;
  cur: Tex;
  other: Tex;
  failed: boolean;
}
let sess: Sess | null = null;

export function gpuSessionActive(): boolean {
  return !!sess;
}

/** Rozpoczyna sesję na płótnie `cv` (wgrywa jego zawartość). Zwraca false, gdy GPU nie nadaje się do tego rozmiaru. */
export function gpuSessionBegin(cv: HTMLCanvasElement): boolean {
  if (sess) return false;
  const w = cv.width;
  const h = cv.height;
  if (w < 2 || h < 2) return false;
  const g = getGl();
  if (!g || w > maxTex || h > maxTex) return false;
  try {
    const a = tex(g, 'sA', w, h, false);
    const b = tex(g, 'sB', w, h, false);
    g.bindTexture(g.TEXTURE_2D, a.t);
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, 0);
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, g.RGBA, g.UNSIGNED_BYTE, cv);
    sess = { g, w, h, cur: a, other: b, failed: false };
    return true;
  } catch {
    disabled = true;
    return false;
  }
}

/**
 * Rozpoczyna sesję na istniejącej teksturze `src` (RGBA8, proste kolory, rozmiar w x h): zawartość jest kopiowana do tekstury
 * sesji, więc `src` zostaje nietknięta. Pozwala łączyć łańcuch efektów z kompozytorem GPU bez żadnego odczytu na CPU.
 */
export function gpuSessionBeginTex(src: Tex, w: number, h: number): boolean {
  if (sess) return false;
  if (w < 2 || h < 2 || src.w !== w || src.h !== h) return false;
  const g = getGl();
  if (!g || w > maxTex || h > maxTex) return false;
  try {
    const a = tex(g, 'sA', w, h, false);
    const b = tex(g, 'sB', w, h, false);
    const pr = prog(g, 'copy', FS_COPY);
    pass(g, pr, a, w, h, () => {
      bindIn(g, 0, src);
      g.uniform1i(uni(g, pr, 'uTex'), 0);
    });
    sess = { g, w, h, cur: a, other: b, failed: false };
    return true;
  } catch {
    disabled = true;
    return false;
  }
}

/** Kończy sesję rozpoczętą `gpuSessionBeginTex`; zwraca teksturę z wynikiem (należy do puli sesji: ważna do następnej sesji) albo null. */
export function gpuSessionEndTex(): Tex | null {
  const s = sess;
  sess = null;
  if (!s || s.failed) return null;
  return s.cur;
}

/** Jeden krok własny w sesji (np. stylizacje): `body` czyta `src` i zapisuje wynik do `out`; po kroku tekstury się zamieniają. */
export function gpuSessionRun(w: number, h: number, body: (g: GL, src: Tex, out: Tex) => void): boolean {
  if (!sess) return false;
  return run(new Uint8ClampedArray(0), w, h, (g, src, _fa, _fb, out) => body(g, src, out), false);
}

export function gpuSessionAbort(): void {
  sess = null;
}

/** Oznacza bieżącą sesję jako nieudaną (kolejne kroki są pomijane, a koniec sesji zgłasza porażkę). */
export function gpuSessionFail(): void {
  if (sess) sess.failed = true;
}

const FS_COPY =
  GL_HEAD +
  `uniform sampler2D uTex;
void main() {
  o = texelFetch(uTex, ivec2(gl_FragCoord.xy), 0);
}`;

const FS_BLIT =
  GL_HEAD +
  `uniform sampler2D uTex;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(uTex, ivec2(p.x, uSize.y - 1 - p.y), 0);
  o = vec4(c.rgb * c.a, c.a);
}`;

/** Kończy sesję: wynik trafia na płótno (nadpisuje je). Zwraca false, gdy sesja się nie powiodła (płótno bez zmian). */
export function gpuSessionEnd(cv: HTMLCanvasElement): boolean {
  const s = sess;
  sess = null;
  if (!s || s.failed) return false;
  const g = s.g;
  try {
    const glc = g.canvas as HTMLCanvasElement;
    if (glc.width !== s.w || glc.height !== s.h) {
      glc.width = s.w;
      glc.height = s.h;
    }
    const pr = prog(g, 'blit', FS_BLIT);
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    g.viewport(0, 0, s.w, s.h);
    g.useProgram(pr.p);
    g.uniform2i(uni(g, pr, 'uSize'), s.w, s.h);
    bindIn(g, 0, s.cur);
    g.uniform1i(uni(g, pr, 'uTex'), 0);
    g.drawArrays(g.TRIANGLES, 0, 3);
    const ctx = cv.getContext('2d');
    if (!ctx) return false;
    ctx.save();
    ctx.globalCompositeOperation = 'copy';
    ctx.globalAlpha = 1;
    ctx.drawImage(glc, 0, 0);
    ctx.restore();
    return true;
  } catch {
    disabled = true;
    return false;
  }
}

const FS_REPL =
  GL_HEAD +
  `uniform sampler2D uSrc;
uniform ivec4 uB;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  o = texelFetch(uSrc, clamp(p, uB.xy, uB.zw - 1), 0);
}`;

/** Powtórzenie skrajnych pikseli poza prostokątem `b` (jak replicateOutside na CPU). */
export function gpuReplicate(w: number, h: number, b: { x0: number; y0: number; x1: number; y1: number }): void {
  const cl = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
  const x0 = cl(Math.round(b.x0), 0, w);
  const y0 = cl(Math.round(b.y0), 0, h);
  const x1 = cl(Math.round(b.x1), 0, w);
  const y1 = cl(Math.round(b.y1), 0, h);
  if (x1 <= x0 || y1 <= y0) return;
  if (x0 === 0 && y0 === 0 && x1 === w && y1 === h) return;
  run(new Uint8ClampedArray(0), w, h, (g, src, _fa, _fb, out) => {
    const pr = prog(g, 'repl', FS_REPL);
    pass(g, pr, out, w, h, () => {
      bindIn(g, 0, src);
      g.uniform1i(uni(g, pr, 'uSrc'), 0);
      g.uniform4i(uni(g, pr, 'uB'), x0, y0, x1, y1);
    });
  }, false);
}

const FS_PT =
  GL_HEAD +
  `uniform sampler2D uSrc;
uniform sampler2D uLut;
uniform sampler2D uTbl;
uniform int uOp;
uniform float uP[16];
vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) / 2.0;
  if (mx == mn) return vec3(0.0, 0.0, l);
  float d = mx - mn;
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h;
  if (mx == c.r) h = ((c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0)) / 6.0;
  else if (mx == c.g) h = ((c.b - c.r) / d + 2.0) / 6.0;
  else h = ((c.r - c.g) / d + 4.0) / 6.0;
  return vec3(h, s, l);
}
float hue2rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
vec3 hsl2rgb(float h, float s, float l) {
  if (s <= 0.0) return vec3(l);
  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  return vec3(hue2rgb(p, q, h + 1.0 / 3.0), hue2rgb(p, q, h), hue2rgb(p, q, h - 1.0 / 3.0));
}
float lumf(vec3 c) { return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uSrc, p, 0);
  o = s;
  vec3 c = floor(s.rgb * 255.0 + 0.5);
  if (uOp == 0) {
    ivec3 i = ivec3(c);
    o = vec4(texelFetch(uLut, ivec2(i.r, 0), 0).r, texelFetch(uLut, ivec2(i.g, 0), 0).g, texelFetch(uLut, ivec2(i.b, 0), 0).b, s.a);
    return;
  }
  if (s.a == 0.0) return;
  vec3 r = c;
  if (uOp == 1) {
    vec3 hsl = rgb2hsl(c / 255.0);
    float h = hsl.x + uP[0];
    h -= floor(h);
    float sat = uP[1];
    float lig = uP[2];
    float ss = sat >= 0.0 ? min(1.0, hsl.y * (1.0 + 2.0 * sat)) : hsl.y * (1.0 + sat);
    float ll = lig >= 0.0 ? hsl.z + (1.0 - hsl.z) * lig : hsl.z * (1.0 + lig);
    r = hsl2rgb(h, ss, ll) * 255.0;
  } else if (uOp == 2) {
    float gray = uP[4] > 0.5 ? (max(c.r, max(c.g, c.b)) + min(c.r, min(c.g, c.b))) / 2.0 : uP[0] * c.r + uP[1] * c.g + uP[2] * c.b;
    r = c + (vec3(gray) - c) * uP[3];
  } else if (uOp == 3) {
    float lum = lumf(c) / 255.0;
    float ws = max(0.0, 1.0 - 2.0 * lum);
    float wh = max(0.0, 2.0 * lum - 1.0);
    float wm = 1.0 - abs(2.0 * lum - 1.0);
    float k = uP[9];
    float cr = (uP[0] * ws + uP[3] * wm + uP[6] * wh) * k;
    float mg = (uP[1] * ws + uP[4] * wm + uP[7] * wh) * k;
    float yb = (uP[2] * ws + uP[5] * wm + uP[8] * wh) * k;
    vec3 n = clamp(vec3(c.r + cr - mg / 2.0 - yb / 2.0, c.g + mg - cr / 2.0 - yb / 2.0, c.b + yb - cr / 2.0 - mg / 2.0), 0.0, 255.0);
    if (uP[10] > 0.5) {
      float before = lumf(c);
      float after = lumf(n);
      if (after > 0.5) n = min(vec3(255.0), n * (before / after));
    }
    r = n;
  } else if (uOp == 4) {
    int idx = int(lumf(c) + 0.5);
    r = c + texelFetch(uTbl, ivec2(clamp(idx, 0, 255), 0), 0).r;
  } else if (uOp == 5) {
    float v = lumf(c) >= uP[0] ? uP[1] : uP[2];
    r = vec3(v);
  } else if (uOp == 6) {
    vec3 hsl = rgb2hsl(c / 255.0);
    float n = uP[0];
    float idx = min(n - 1.0, floor(hsl.z * n));
    r = hsl2rgb(hsl.x, hsl.y, idx / (n - 1.0)) * 255.0;
  } else if (uOp == 7) {
    vec3 n = min(vec3(255.0), c * vec3(uP[0], uP[1], uP[2]));
    float before = lumf(c);
    float after = lumf(n);
    if (after > 0.5) n = min(vec3(255.0), n * (before / after));
    r = n;
  }
  o = vec4(clamp(r, 0.0, 255.0) / 255.0, s.a);
}`;

/** Operacje punktowe (korekcje) na bieżącej teksturze sesji; zwraca false, gdy nie ma sesji. */
export function gpuPt(ops: Array<{ k: 'lut'; r: Uint8Array; g: Uint8Array; b: Uint8Array } | { k: 'fn'; id: number; p: number[]; tbl?: Float32Array }>, w: number, h: number): boolean {
  if (!sess) return false;
  for (const op of ops) {
    run(new Uint8ClampedArray(0), w, h, (g, src, _fa, _fb, out) => {
      const pr = prog(g, 'pt', FS_PT);
      const lutTex = g.createTexture()!;
      const tblTex = g.createTexture()!;
      try {
        for (const t of [lutTex, tblTex]) {
          g.bindTexture(g.TEXTURE_2D, t);
          g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
          g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
          g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
          g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
        }
        const lut = new Uint8Array(256 * 4);
        if (op.k === 'lut') for (let i = 0; i < 256; i++) {
          lut[i * 4] = op.r[i];
          lut[i * 4 + 1] = op.g[i];
          lut[i * 4 + 2] = op.b[i];
          lut[i * 4 + 3] = 255;
        }
        g.bindTexture(g.TEXTURE_2D, lutTex);
        g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
        g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, 256, 1, 0, g.RGBA, g.UNSIGNED_BYTE, lut);
        g.bindTexture(g.TEXTURE_2D, tblTex);
        g.texImage2D(g.TEXTURE_2D, 0, g.R32F, 256, 1, 0, g.RED, g.FLOAT, op.k === 'fn' && op.tbl ? op.tbl : new Float32Array(256));
        const pv = new Float32Array(16);
        if (op.k === 'fn') for (let i = 0; i < op.p.length && i < 16; i++) pv[i] = op.p[i];
        pass(g, pr, out, w, h, () => {
          bindIn(g, 0, src);
          g.activeTexture(g.TEXTURE1);
          g.bindTexture(g.TEXTURE_2D, lutTex);
          g.activeTexture(g.TEXTURE2);
          g.bindTexture(g.TEXTURE_2D, tblTex);
          g.uniform1i(uni(g, pr, 'uSrc'), 0);
          g.uniform1i(uni(g, pr, 'uLut'), 1);
          g.uniform1i(uni(g, pr, 'uTbl'), 2);
          g.uniform1i(uni(g, pr, 'uOp'), op.k === 'lut' ? 0 : op.id);
          g.uniform1fv(uni(g, pr, 'uP[0]'), pv);
        });
      } finally {
        g.deleteTexture(lutTex);
        g.deleteTexture(tblTex);
      }
    }, false);
  }
  return true;
}

export function gpuSessionFailed(): boolean {
  return !!sess?.failed;
}

function premulPass(g: GL, src: Tex, dst: Tex, w: number, h: number): void {
  const pr = prog(g, 'premul', FS_PREMUL);
  pass(g, pr, dst, w, h, () => {
    bindIn(g, 0, src);
    g.uniform1i(uni(g, pr, 'uSrc'), 0);
  });
}

function unpremulPass(g: GL, f: Tex, src: Tex, out: Tex, w: number, h: number, keep: boolean): void {
  const pr = prog(g, 'unpremul', FS_UNPREMUL);
  pass(g, pr, out, w, h, () => {
    bindIn(g, 0, f);
    bindIn(g, 1, src);
    g.uniform1i(uni(g, pr, 'uTex'), 0);
    g.uniform1i(uni(g, pr, 'uSrc'), 1);
    g.uniform1i(uni(g, pr, 'uKeep'), keep ? 1 : 0);
  });
}

/** Kolejne przebiegi pudełkowe na tekstorze `fa` (wynik zawsze w `fa`). */
function boxPasses(g: GL, fa: Tex, fb: Tex, w: number, h: number, radii: number[]): void {
  const pr = prog(g, 'box', FS_BOX);
  {
    for (const r of radii) {
      if (r <= 0) continue;
      for (const dir of [[1, 0], [0, 1]]) {
        const from = dir[0] === 1 ? fa : fb;
        const to = dir[0] === 1 ? fb : fa;
        pass(g, pr, to, w, h, () => {
          bindIn(g, 0, from);
          g.uniform1i(uni(g, pr, 'uTex'), 0);
          g.uniform2i(uni(g, pr, 'uDir'), dir[0], dir[1]);
          g.uniform1i(uni(g, pr, 'uR'), r);
        });
      }
    }
  }
}

/** Rozmycie Gaussa jako kolejne przebiegi pudełkowe o podanych promieniach. */
export function gpuGauss(d: Uint8ClampedArray, w: number, h: number, radii: number[], keepAlpha: boolean): boolean {
  return run(d, w, h, (g, src, fa, fb, out) => {
    premulPass(g, src, fa, w, h);
    boxPasses(g, fa, fb, w, h, radii);
    unpremulPass(g, fa, src, out, w, h, keepAlpha);
  });
}

const FS_SHARPEN =
  GL_HEAD +
  `uniform sampler2D uTex;
uniform sampler2D uSrc;
uniform float uK;
uniform float uThr;
uniform int uLum;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uSrc, p, 0);
  o = s;
  if (s.a == 0.0) return;
  vec4 f = texelFetch(uTex, p, 0);
  if (f.a < 0.001) return;
  vec3 c = floor(s.rgb * 255.0 + 0.5);
  vec3 b = f.rgb * (255.0 / f.a);
  if (uLum == 1) {
    float diff = lum255(c) - lum255(b);
    if (abs(diff) < uThr) return;
    c += diff * uK;
  } else {
    vec3 df = c - b;
    if (abs(df.r) >= uThr) c.r += df.r * uK;
    if (abs(df.g) >= uThr) c.g += df.g * uK;
    if (abs(df.b) >= uThr) c.b += df.b * uK;
  }
  o = vec4(clamp(c, 0.0, 255.0) / 255.0, s.a);
}`;

/** Wyostrzenie maską nieostrą: różnica oryginału i rozmycia Gaussa. */
export function gpuSharpen(d: Uint8ClampedArray, w: number, h: number, radii: number[], k: number, thr: number, lumOnly: boolean): boolean {
  return run(d, w, h, (g, src, fa, fb, out) => {
    premulPass(g, src, fa, w, h);
    boxPasses(g, fa, fb, w, h, radii);
    const pr = prog(g, 'sharpen', FS_SHARPEN);
    pass(g, pr, out, w, h, () => {
      bindIn(g, 0, fa);
      bindIn(g, 1, src);
      g.uniform1i(uni(g, pr, 'uTex'), 0);
      g.uniform1i(uni(g, pr, 'uSrc'), 1);
      g.uniform1f(uni(g, pr, 'uK'), k);
      g.uniform1f(uni(g, pr, 'uThr'), thr);
      g.uniform1i(uni(g, pr, 'uLum'), lumOnly ? 1 : 0);
    });
  });
}

const FS_GLOWT =
  GL_HEAD +
  `uniform sampler2D uSrc;
uniform float uThr;
void main() {
  vec4 s = floor(texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0) * 255.0 + 0.5);
  o = vec4(0.0);
  if (s.a == 0.0) return;
  float l = lum255(s.rgb);
  if (l <= uThr) return;
  float q = (l - uThr) / max(1.0, 255.0 - uThr);
  o = vec4(s.rgb * (q * (s.a / 255.0)), s.a * q);
}`;

const FS_GLOWC =
  GL_HEAD +
  `uniform sampler2D uTex;
uniform sampler2D uSrc;
uniform float uK;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s0 = texelFetch(uSrc, p, 0);
  o = s0;
  vec4 s = floor(s0 * 255.0 + 0.5);
  vec4 f = texelFetch(uTex, p, 0);
  vec3 pr = s.rgb * s.a / 255.0;
  float na = min(255.0, s.a + f.a * uK);
  if (na <= 0.0) return;
  vec3 c = min(vec3(255.0), pr + f.rgb * uK) * (255.0 / na);
  o = vec4(clamp(c, 0.0, 255.0) / 255.0, na / 255.0);
}`;

/** Poświata: jasne partie (powyżej progu) rozmyte i dodane do obrazu. */
export function gpuGlow(d: Uint8ClampedArray, w: number, h: number, radii: number[], k: number, thr: number): boolean {
  return run(d, w, h, (g, src, fa, fb, out) => {
    const pt = prog(g, 'glowt', FS_GLOWT);
    pass(g, pt, fa, w, h, () => {
      bindIn(g, 0, src);
      g.uniform1i(uni(g, pt, 'uSrc'), 0);
      g.uniform1f(uni(g, pt, 'uThr'), thr);
    });
    boxPasses(g, fa, fb, w, h, radii);
    const pr = prog(g, 'glowc', FS_GLOWC);
    pass(g, pr, out, w, h, () => {
      bindIn(g, 0, fa);
      bindIn(g, 1, src);
      g.uniform1i(uni(g, pr, 'uTex'), 0);
      g.uniform1i(uni(g, pr, 'uSrc'), 1);
      g.uniform1f(uni(g, pr, 'uK'), k);
    });
  });
}

const FS_WARP =
  GL_HEAD +
  `uniform sampler2D uSrc;
uniform int uMode;
uniform vec2 uC;
uniform float uR;
uniform float uA;
uniform float uK;
uniform float uPh;
uniform vec2 uOrg;
uniform int uHoriz;
uniform int uVert;
vec4 bil(vec2 q) {
  vec2 f0 = floor(q);
  vec2 t = q - f0;
  ivec2 i0 = ivec2(f0);
  vec4 a = fetchP(uSrc, cl(i0));
  vec4 b = fetchP(uSrc, cl(i0 + ivec2(1, 0)));
  vec4 c = fetchP(uSrc, cl(i0 + ivec2(0, 1)));
  vec4 e = fetchP(uSrc, cl(i0 + ivec2(1, 1)));
  return a * ((1.0 - t.x) * (1.0 - t.y)) + b * (t.x * (1.0 - t.y)) + c * ((1.0 - t.x) * t.y) + e * (t.x * t.y);
}
void main() {
  vec2 p = floor(gl_FragCoord.xy);
  vec2 q = p;
  if (uMode == 0) {
    if (uHoriz == 1) q.x = p.x + uA * sin(uK * (p.y + uOrg.y) + uPh);
    if (uVert == 1) q.y = p.y + uA * sin(uK * (p.x + uOrg.x) + uPh);
  } else if (uMode == 1) {
    vec2 dv = p - uC;
    float dist = length(dv);
    if (dist < uR) {
      float t = 1.0 - dist / uR;
      float th = uA * t * t;
      float cs = cos(th);
      float sn = sin(th);
      q = uC + vec2(dv.x * cs - dv.y * sn, dv.x * sn + dv.y * cs);
    }
  } else {
    vec2 dv = p - uC;
    float dist = length(dv);
    if (dist < uR && dist > 0.0) {
      float nd = dist / uR;
      float src = uA >= 0.0 ? pow(nd, 1.0 + uA * 1.2) : pow(nd, 1.0 / (1.0 - uA * 1.2));
      q = uC + dv * (src * uR / dist);
    }
  }
  o = unP(bil(q));
}`;

export interface WarpParams {
  mode: 0 | 1 | 2; // 0 fala, 1 skręcenie, 2 wypukłość
  cx?: number;
  cy?: number;
  R?: number;
  A: number; // fala: amplituda; skręcenie: kąt (rad); wypukłość: siła (-1..1)
  k?: number;
  ph?: number;
  ox?: number;
  oy?: number;
  horiz?: boolean;
  vert?: boolean;
}

/** Zniekształcenia z próbkowaniem dwuliniowym (fala, skręcenie, wypukłość). */
export function gpuWarp(d: Uint8ClampedArray, w: number, h: number, q: WarpParams): boolean {
  return run(
    d,
    w,
    h,
    (g, src, _fa, _fb, out) => {
      const pr = prog(g, 'warp', FS_WARP);
      pass(g, pr, out, w, h, () => {
        bindIn(g, 0, src);
        g.uniform1i(uni(g, pr, 'uSrc'), 0);
        g.uniform1i(uni(g, pr, 'uMode'), q.mode);
        g.uniform2f(uni(g, pr, 'uC'), q.cx ?? 0, q.cy ?? 0);
        g.uniform1f(uni(g, pr, 'uR'), q.R ?? 1);
        g.uniform1f(uni(g, pr, 'uA'), q.A);
        g.uniform1f(uni(g, pr, 'uK'), q.k ?? 0);
        g.uniform1f(uni(g, pr, 'uPh'), q.ph ?? 0);
        g.uniform2f(uni(g, pr, 'uOrg'), q.ox ?? 0, q.oy ?? 0);
        g.uniform1i(uni(g, pr, 'uHoriz'), q.horiz ? 1 : 0);
        g.uniform1i(uni(g, pr, 'uVert'), q.vert ? 1 : 0);
      });
    },
    false
  );
}

/** Rozmycie w ruchu: `offs` = pary całkowitych przesunięć próbek (x, y). */
export function gpuMotion(d: Uint8ClampedArray, w: number, h: number, offs: Int32Array): boolean {
  const n = offs.length / 2;
  if (n < 1 || n > 96) return false;
  return run(
    d,
    w,
    h,
    (g, src, _fa, _fb, out) => {
      const pr = prog(g, 'motion', FS_MOTION);
      pass(g, pr, out, w, h, () => {
        bindIn(g, 0, src);
        g.uniform1i(uni(g, pr, 'uSrc'), 0);
        g.uniform2iv(uni(g, pr, 'uOff[0]'), offs);
        g.uniform1i(uni(g, pr, 'uN'), n);
      });
    },
    false
  );
}

/** Rozmycie radialne: `k` = trójki (cos, sin, zoom) dla każdej próbki. */
export function gpuRadial(d: Uint8ClampedArray, w: number, h: number, cx: number, cy: number, spin: boolean, k: Float32Array): boolean {
  const n = k.length / 3;
  if (n < 1 || n > 64) return false;
  return run(
    d,
    w,
    h,
    (g, src, _fa, _fb, out) => {
      const pr = prog(g, 'radial', FS_RADIAL);
      pass(g, pr, out, w, h, () => {
        bindIn(g, 0, src);
        g.uniform1i(uni(g, pr, 'uSrc'), 0);
        g.uniform3fv(uni(g, pr, 'uK[0]'), k);
        g.uniform2f(uni(g, pr, 'uC'), cx, cy);
        g.uniform1i(uni(g, pr, 'uN'), n);
        g.uniform1i(uni(g, pr, 'uSpin'), spin ? 1 : 0);
      });
    },
    false
  );
}

/** Rozmycie soczewki: `offs` = pary całkowitych przesunięć punktów apertury, `boost` = siła podbicia świateł. */
export function gpuLens(d: Uint8ClampedArray, w: number, h: number, offs: Int32Array, boost: number): boolean {
  const n = offs.length / 2;
  if (n < 1 || n > 120) return false;
  return run(
    d,
    w,
    h,
    (g, src, _fa, _fb, out) => {
      const pr = prog(g, 'lens', FS_LENS);
      pass(g, pr, out, w, h, () => {
        bindIn(g, 0, src);
        g.uniform1i(uni(g, pr, 'uSrc'), 0);
        g.uniform2iv(uni(g, pr, 'uOff[0]'), offs);
        g.uniform1i(uni(g, pr, 'uN'), n);
        g.uniform1f(uni(g, pr, 'uBoost'), boost);
      });
    },
    false
  );
}

/** Rozmycie powierzchniowe (zachowuje krawędzie). */
export function gpuSurface(d: Uint8ClampedArray, w: number, h: number, R: number, stride: number, sig2: number, inv: number): boolean {
  return run(
    d,
    w,
    h,
    (g, src, _fa, _fb, out) => {
      const pr = prog(g, 'surface', FS_SURFACE);
      pass(g, pr, out, w, h, () => {
        bindIn(g, 0, src);
        g.uniform1i(uni(g, pr, 'uSrc'), 0);
        g.uniform1i(uni(g, pr, 'uR'), R);
        g.uniform1i(uni(g, pr, 'uStride'), stride);
        g.uniform1f(uni(g, pr, 'uSig2'), sig2);
        g.uniform1f(uni(g, pr, 'uInv'), inv);
      });
    },
    false
  );
}


// ---------------------------------------------------------------------------------------------------------------
// Pozostałe filtry punktowo-sąsiedzkie: winieta, aberracja chromatyczna, półton, płaskorzeźba, znajdź krawędzie
// ---------------------------------------------------------------------------------------------------------------

const FS_FX2 =
  GL_HEAD +
  `uniform sampler2D uSrc;
uniform int uKind;
uniform float uP[24];
float rnd(float v) { return floor(v + 0.500001); }
ivec2 clampI(ivec2 p) { return clamp(p, ivec2(0), uSize - 1); }
vec4 px(ivec2 p) { return floor(texelFetch(uSrc, clampI(p), 0) * 255.0 + 0.5); }
float lumf(vec3 c) { return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b; }
float hmAt(ivec2 p, int ch) {
  vec4 c = px(p);
  return (ch == 3 ? lumf(c.rgb) : c[ch]) * c.a / 255.0;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s0 = texelFetch(uSrc, p, 0);
  vec4 c = floor(s0 * 255.0 + 0.5);
  o = s0;
  vec3 r = c.rgb;
  float al = c.a;
  if (uKind == 1) {
    // winieta: cxD cyD hw hh R round start end strength dark inv docX0 docY0
    if (c.a == 0.0) return;
    float inv = uP[10];
    float dy = uP[12] + (float(p.y) + 0.5) * inv - uP[1];
    float dx = uP[11] + (float(p.x) + 0.5) * inv - uP[0];
    float dEll = length(vec2(dx / uP[2], dy / uP[3])) / 1.4142136;
    float dCirc = length(vec2(dx, dy)) / uP[4];
    float dist = dEll + (dCirc - dEll) * uP[5];
    float t = (dist - uP[6]) / (uP[7] - uP[6]);
    if (t <= 0.0) return;
    t = min(t, 1.0);
    t = t * t * (3.0 - 2.0 * t) * uP[8];
    r = uP[9] > 0.5 ? c.rgb * (1.0 - t) : c.rgb + (vec3(255.0) - c.rgb) * t;
  } else if (uKind == 2) {
    // aberracja: amt ux uy cx cy maxR radial
    vec2 off;
    if (uP[6] > 0.5) off = (vec2(p) - vec2(uP[3], uP[4])) * (uP[0] / uP[5]);
    else off = vec2(uP[1], uP[2]) * uP[0];
    ivec2 jr = ivec2(rnd(float(p.x) + off.x), rnd(float(p.y) + off.y));
    ivec2 jb = ivec2(rnd(float(p.x) - off.x), rnd(float(p.y) - off.y));
    vec4 cr = px(jr);
    vec4 cb = px(jb);
    float a = max(cr.a, max(c.a, cb.a));
    if (a == 0.0) return;
    vec3 pm = vec3(cr.r * cr.a, c.g * c.a, cb.b * cb.a) / 255.0;
    r = pm * (255.0 / a);
    al = a;
  } else if (uKind == 3) {
    // półton: size s ca sa docX0 docY0 half aa invert color
    if (c.a == 0.0) return;
    float size = uP[0];
    float sc = uP[1];
    float inv = 1.0 / sc;
    float gy = uP[5] + (float(p.y) + 0.5) * inv;
    float gx = uP[4] + (float(p.x) + 0.5) * inv;
    float u = gx * uP[2] + gy * uP[3];
    float v = -gx * uP[3] + gy * uP[2];
    float cu = (floor(u / size) + 0.5) * size;
    float cv = (floor(v / size) + 0.5) * size;
    float cxd = cu * uP[2] - cv * uP[3];
    float cyd = cu * uP[3] + cv * uP[2];
    int bx = int(rnd((cxd - uP[4]) * sc - 0.5));
    int by = int(rnd((cyd - uP[5]) * sc - 0.5));
    int hf = int(uP[6]);
    int stp = max(1, hf);
    vec3 sm = vec3(0.0);
    float n = 0.0;
    for (int yy = -hf; yy <= hf; yy += stp) {
      for (int xx = -hf; xx <= hf; xx += stp) {
        sm += px(ivec2(bx + xx, by + yy)).rgb;
        n += 1.0;
      }
    }
    sm /= n;
    float dark = 1.0 - lumf(sm) / 255.0;
    bool invert = uP[8] > 0.5;
    if (invert) dark = 1.0 - dark;
    float rad = size * 0.5 * 1.2 * sqrt(dark);
    float dist = length(vec2(u - cu, v - cv));
    float cov = clamp((rad - dist) / uP[7] + 0.5, 0.0, 1.0);
    float bg = invert ? 0.0 : 255.0;
    vec3 fg = uP[9] > 0.5 ? sm : vec3(invert ? 255.0 : 0.0);
    r = vec3(bg) + (fg - vec3(bg)) * cov;
  } else if (uKind == 4) {
    // płaskorzeźba: ox oy k keepColor
    if (c.a == 0.0) return;
    ivec2 pa = ivec2(rnd(float(p.x) + uP[0]), rnd(float(p.y) + uP[1]));
    ivec2 pb = ivec2(rnd(float(p.x) - uP[0]), rnd(float(p.y) - uP[1]));
    float diff = (hmAt(pa, 3) - hmAt(pb, 3)) * uP[2];
    r = uP[3] > 0.5 ? c.rgb + diff : vec3(128.0 + diff);
  } else if (uKind == 5) {
    // znajdź krawędzie: st k dark color
    if (c.a == 0.0) { o = vec4(0.0); return; }
    int st = int(uP[0]);
    bool color = uP[3] > 0.5;
    vec3 res = vec3(0.0);
    int nch = color ? 3 : 1;
    for (int ch = 0; ch < 3; ch++) {
      if (ch >= nch) break;
      int cc = color ? ch : 3;
      float tl = hmAt(p + ivec2(-st, -st), cc);
      float tc = hmAt(p + ivec2(0, -st), cc);
      float tr = hmAt(p + ivec2(st, -st), cc);
      float ml = hmAt(p + ivec2(-st, 0), cc);
      float mr = hmAt(p + ivec2(st, 0), cc);
      float bl = hmAt(p + ivec2(-st, st), cc);
      float bc = hmAt(p + ivec2(0, st), cc);
      float br = hmAt(p + ivec2(st, st), cc);
      float gx = tr + 2.0 * mr + br - tl - 2.0 * ml - bl;
      float gy = bl + 2.0 * bc + br - tl - 2.0 * tc - tr;
      float e = min(255.0, length(vec2(gx, gy)) * 0.25 * uP[1]);
      float vv = uP[2] > 0.5 ? 255.0 - e : e;
      res[ch] = vv;
      if (!color) res = vec3(vv);
    }
    r = res;
  }
  o = vec4(clamp(r, 0.0, 255.0) / 255.0, clamp(al, 0.0, 255.0) / 255.0);
}`;

/** Wspólny przebieg dla filtrów z FS_FX2 (1 winieta, 2 aberracja, 3 półton, 4 płaskorzeźba, 5 krawędzie). */
export function gpuFx2(d: Uint8ClampedArray, w: number, h: number, kind: number, params: number[]): boolean {
  return run(
    d,
    w,
    h,
    (g, src, _fa, _fb, out) => {
      const pr = prog(g, 'fx2', FS_FX2);
      const pv = new Float32Array(24);
      for (let i = 0; i < params.length && i < 24; i++) pv[i] = params[i];
      pass(g, pr, out, w, h, () => {
        bindIn(g, 0, src);
        g.uniform1i(uni(g, pr, 'uSrc'), 0);
        g.uniform1i(uni(g, pr, 'uKind'), kind);
        g.uniform1fv(uni(g, pr, 'uP[0]'), pv);
      });
    },
    false
  );
}
