/**
 * GpuTilePool - rzadka (kafelkowa) pamięć tekstur warstw dla kompozytora GPU.
 *
 * Wcześniej każda warstwa (i każda maska) dostawała na GPU teksturę wielkości całego dokumentu, także gdy była pusta
 * albo zamalowana tylko w małym fragmencie (10000 x 10000 px = 381 MiB na warstwę, więc budżet 1400 MiB kończył się na
 * trzech warstwach i kompozytor GPU wyłączał się). Teraz:
 *
 *  - wszystkie warstwy dzielą jedną pulę „slotów” (kafelek tileSize x tileSize, domyślnie 64 x 64) w tablicach tekstur
 *    (`TEXTURE_2D_ARRAY`, strony 1024 x 1024). Slot dostaje wyłącznie kafelek, który ma treść;
 *  - warstwa zna swoje sloty przez „tablicę stron” (`SparseSurface`): mała tekstura RGBA32I o rozmiarze siatki kafelków
 *    (np. 157 x 157 dla 10000 x 10000), w której komórka zawiera adres slotu, 0 (kafelek pusty) albo -1 (kafelek
 *    jednolity: jego kolor leży w samej komórce, więc np. białe tło nie zajmuje ani slotów, ani wgrań);
 *  - shader pobiera piksel dokumentu przez tę tablicę (`srcTexel`), więc wszystko, co działa na `texelFetch`
 *    (w tym ręczne filtrowanie dwuliniowe przy zmniejszaniu), działa bez zmian i bez marginesów na stykach kafelków;
 *  - gdy pula się zapełni, wypierane są najdawniej używane kafelki spoza bieżącej klatki. Brak miejsca nawet po
 *    wyparciu (`acquire` zwraca -1) oznacza, że kompozytor oddaje klatkę ścieżce procesorowej, jak dotychczas.
 *
 * Plik nie zna silnika ani warstw: zna tylko GL, rozmiary i numery klatek, dzięki czemu logikę slotów da się testować
 * osobno.
 */

type GL = WebGL2RenderingContext;

/** Bok strony atlasu w pikselach. */
export const POOL_PAGE = 1024;
/** Największa liczba stron w jednym kawałku (tablicy tekstur). Stały „stride” adresu slotu. */
const MAX_PAGES = 32;
/** Głębokość kolejnych kawałków: małe dokumenty nie płacą za duży kawałek, duże dorastają do ~1,1 GiB. */
const CHUNK_DEPTHS = [2, 4, 8, 16, 32, 32, 32, 32, 32, 32, 32, 32];
/** Wykrywanie kafelków jednolitych czyta piksele jako słowa 32-bitowe; zakłada bajty w kolejności R, G, B, A (little endian). */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
/** Jednostki tekstur zarezerwowane poza atlasem: tablica stron + zapas. */
const RESERVED_UNITS = 3;

export interface PoolOptions {
  /** Test / diagnostyka: nadpisuje głębokości kolejnych kawałków. */
  depths?: number[];
  /** Test: nadpisuje limit liczby kawałków. */
  maxChunks?: number;
}

interface Chunk {
  tex: WebGLTexture | null;
  depth: number;
  used: number;
}

/**
 * Powierzchnia rzadka: warstwa (albo maska) jako siatka kafelków, z których tylko niektóre mają slot w puli.
 * Pola `ref` / `ver` / `has` są księgowością kompozytora (które kafelki i w jakiej wersji są już na GPU).
 */
export class SparseSurface {
  public readonly pool: TilePool;
  public readonly width: number;
  public readonly height: number;
  public readonly ts: number;
  public readonly cols: number;
  public readonly rows: number;
  /**
   * Zawartość tablicy stron na GPU, 4 liczby na kafelek: [adres slotu + 1 | 0 (pusty) | -1 (jednolity), r | g << 8,
   * b | a << 8, 0]. Dostęp przez `entry(idx)`.
   */
  public readonly table: Int32Array;
  /** numer slotu albo -1 */
  public readonly slot: Int32Array;
  public readonly ver: Int32Array;
  public readonly has: Uint8Array;
  public readonly ref: Array<object | null>;
  /** rośnie przy każdej faktycznej zmianie zawartości (wgranie / zwolnienie kafelka) */
  public rev = 0;
  public used = 0;
  /** liczba kafelków z treścią w ostatnio synchronizowanym oknie */
  public visible = 0;
  /** sloty tej powierzchni nie są wypierane (sesja edycji „na żywo”) */
  public readonly pinned: boolean;
  public ptTex: WebGLTexture | null = null;
  private rowMin = Infinity;
  private rowMax = -1;
  private alive = true;

  constructor(pool: TilePool, width: number, height: number, pinned = false) {
    this.pool = pool;
    this.width = width;
    this.height = height;
    this.ts = pool.ts;
    this.cols = Math.max(1, Math.ceil(width / this.ts));
    this.rows = Math.max(1, Math.ceil(height / this.ts));
    const n = this.cols * this.rows;
    this.table = new Int32Array(n * 4);
    this.slot = new Int32Array(n).fill(-1);
    this.ver = new Int32Array(n).fill(-1);
    this.has = new Uint8Array(n);
    this.ref = new Array<object | null>(n).fill(null);
    this.pinned = pinned;
  }

  /** Pierwsza liczba komórki tablicy stron kafelka: adres slotu + 1, 0 (pusty) albo -1 (jednolity). */
  public entry(idx: number): number {
    return this.table[idx * 4];
  }

  /** Kafelek ma coś do pokazania (slot albo kolor jednolity). */
  public filled(idx: number): boolean {
    return this.table[idx * 4] !== 0;
  }

  /** Pula wypiera kafelek: zapomnij o slocie i wymuś ponowne wgranie przy następnej potrzebie. */
  public onEvict(idx: number): void {
    this.slot[idx] = -1;
    this.table[idx * 4] = 0;
    this.ver[idx] = -1;
    this.dirtyRow(Math.floor(idx / this.cols));
    this.rev++;
  }

  public setSlot(idx: number, slot: number): void {
    this.slot[idx] = slot;
    const o = idx * 4;
    this.table[o] = slot + 1;
    this.table[o + 1] = 0;
    this.table[o + 2] = 0;
    this.dirtyRow(Math.floor(idx / this.cols));
  }

  /** Kafelek jednolitego koloru (proste, nieprzezroczyste dla a > 0 bajty RGBA): bez slotu, kolor w tablicy stron. */
  public setSolid(idx: number, r: number, g: number, b: number, a: number): void {
    this.slot[idx] = -1;
    const o = idx * 4;
    this.table[o] = -1;
    this.table[o + 1] = r | (g << 8);
    this.table[o + 2] = b | (a << 8);
    this.dirtyRow(Math.floor(idx / this.cols));
  }

  public clearSlot(idx: number): void {
    this.slot[idx] = -1;
    const o = idx * 4;
    this.table[o] = 0;
    this.table[o + 1] = 0;
    this.table[o + 2] = 0;
    this.dirtyRow(Math.floor(idx / this.cols));
  }

  private dirtyRow(r: number): void {
    if (r < this.rowMin) this.rowMin = r;
    if (r > this.rowMax) this.rowMax = r;
  }

  /** Wgrywa zmienione wiersze tablicy stron na GPU. */
  public flush(g: GL): void {
    if (!this.ptTex) {
      // storage jest zerowany (same „puste kafelki”), więc pierwsze wgranie dotyczy tylko zmienionych wierszy
      const t = g.createTexture()!;
      g.bindTexture(g.TEXTURE_2D, t);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
      g.texStorage2D(g.TEXTURE_2D, 1, g.RGBA32I, this.cols, this.rows);
      this.ptTex = t;
    }
    if (this.rowMax < 0) return;
    g.bindTexture(g.TEXTURE_2D, this.ptTex);
    g.pixelStorei(g.UNPACK_ALIGNMENT, 4);
    g.pixelStorei(g.UNPACK_ROW_LENGTH, 0);
    g.pixelStorei(g.UNPACK_SKIP_PIXELS, 0);
    g.pixelStorei(g.UNPACK_SKIP_ROWS, 0);
    const r0 = this.rowMin;
    const r1 = this.rowMax;
    g.texSubImage2D(g.TEXTURE_2D, 0, 0, r0, this.cols, r1 - r0 + 1, g.RGBA_INTEGER, g.INT, this.table, r0 * this.cols * 4);
    this.rowMin = Infinity;
    this.rowMax = -1;
  }

  /** Zwalnia wszystkie sloty i teksturę tablicy stron. */
  public dispose(g: GL | null): void {
    if (!this.alive) return;
    this.alive = false;
    for (let i = 0; i < this.slot.length; i++) if (this.slot[i] >= 0) this.pool.release(this, i);
    if (g && this.ptTex) g.deleteTexture(this.ptTex);
    this.ptTex = null;
  }
}

/**
 * Pula slotów. Adres slotu = (kawałek * MAX_PAGES + strona) * slotyNaStronę + numerWStronie; ten sam wzór dekoduje
 * shader, więc kawałki mogą mieć różną głębokość bez tabel pomocniczych.
 */
export class TilePool {
  public readonly ts: number;
  /** kafelków w boku strony */
  public readonly pageTiles: number;
  /** slotów na stronę */
  public readonly spp: number;
  public readonly maxChunks: number;
  private readonly depths: number[];
  private readonly g: GL;
  private readonly chunks: Chunk[] = [];
  /** stos wolnych slotów (pop = następny) */
  private free: number[] = [];
  private owner: Array<SparseSurface | null>;
  private ownerIdx: Int32Array;
  public readonly lastUsed: Int32Array;
  private readonly cap: number;
  private dummy: WebGLTexture | null = null;
  private limit: number;
  /** liczba zajętych slotów */
  public live = 0;
  public bytes = 0;

  constructor(g: GL, ts: number, opts: PoolOptions = {}) {
    this.g = g;
    this.ts = ts;
    this.pageTiles = Math.max(1, Math.floor(POOL_PAGE / ts));
    this.spp = this.pageTiles * this.pageTiles;
    const units = g.getParameter(g.MAX_TEXTURE_IMAGE_UNITS) as number;
    const byUnits = Math.max(0, units - RESERVED_UNITS);
    this.depths = opts.depths ?? CHUNK_DEPTHS;
    this.maxChunks = Math.min(opts.maxChunks ?? this.depths.length, this.depths.length, byUnits);
    this.limit = this.maxChunks;
    this.cap = MAX_PAGES * this.spp * Math.max(1, this.maxChunks);
    this.owner = new Array<SparseSurface | null>(this.cap).fill(null);
    this.ownerIdx = new Int32Array(this.cap);
    this.lastUsed = new Int32Array(this.cap);
  }

  /** Czy pula nadaje się do użycia (jest dość jednostek tekstur na choć jeden kawałek). */
  public get usable(): boolean {
    return this.maxChunks >= 1 && this.ts >= 1 && this.ts <= POOL_PAGE;
  }

  /** Liczba kawałków w shaderze (stała w czasie życia puli). */
  public get chunkCount(): number {
    return this.maxChunks;
  }

  /** Tekstury w pamięci GPU (atlas); tablice stron są pomijalnie małe. */
  public get atlasBytes(): number {
    return this.bytes;
  }

  public chunkOf(slot: number): number {
    return Math.floor(slot / (MAX_PAGES * this.spp));
  }

  /** Kod GLSL pobierania piksela powierzchni rzadkiej: `vec4 srcTexel(ivec2 q)` (q w pikselach powierzchni). */
  public glsl(): string {
    const n = this.maxChunks;
    let decl = '';
    let pick = '';
    for (let i = 0; i < n; i++) {
      decl += `uniform sampler2DArray uA${i};\n`;
      pick += `${i === 0 ? '' : 'else '}if (c == ${i}) return texelFetch(uA${i}, p, 0);\n`;
    }
    return `precision highp isampler2D;
precision highp sampler2DArray;
uniform isampler2D uPT;
uniform ivec2 uSrcDim;
${decl}const int TS = ${this.ts};
const int PGT = ${this.pageTiles};
const int SPP = ${this.spp};
const int MAXP = ${MAX_PAGES};
vec4 atlasAt(int c, ivec3 p) {
${pick}  return vec4(0.0);
}
vec4 srcTexel(ivec2 q) {
  if (q.x < 0 || q.y < 0 || q.x >= uSrcDim.x || q.y >= uSrcDim.y) return vec4(0.0);
  ivec2 t = q / TS;
  ivec4 e = texelFetch(uPT, t, 0);
  if (e.x == 0) return vec4(0.0);
  if (e.x < 0) {
    return vec4(float(e.y & 255), float(e.y >> 8), float(e.z & 255), float(e.z >> 8)) / 255.0;
  }
  int v = e.x - 1;
  int pc = v / SPP;
  int inPage = v - pc * SPP;
  int page = pc % MAXP;
  int ch = pc / MAXP;
  ivec2 sl = ivec2(inPage % PGT, inPage / PGT);
  return atlasAt(ch, ivec3(sl * TS + (q - t * TS), page));
}
`;
  }

  /** Podpina tablicę stron na jednostce 0 i kawałki atlasu na jednostkach 1..n; zwraca liczbę kawałków. */
  public bind(surf: SparseSurface): void {
    const g = this.g;
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, surf.ptTex);
    const dummy = this.dummyTex();
    for (let c = 0; c < this.maxChunks; c++) {
      g.activeTexture(g.TEXTURE1 + c);
      const ch = this.chunks[c];
      g.bindTexture(g.TEXTURE_2D_ARRAY, ch && ch.tex ? ch.tex : dummy);
    }
    g.activeTexture(g.TEXTURE0);
  }

  private dummyTex(): WebGLTexture {
    if (this.dummy) return this.dummy;
    const g = this.g;
    const t = g.createTexture()!;
    g.bindTexture(g.TEXTURE_2D_ARRAY, t);
    g.texParameteri(g.TEXTURE_2D_ARRAY, g.TEXTURE_MIN_FILTER, g.NEAREST);
    g.texParameteri(g.TEXTURE_2D_ARRAY, g.TEXTURE_MAG_FILTER, g.NEAREST);
    g.texStorage3D(g.TEXTURE_2D_ARRAY, 1, g.RGBA8, 1, 1, 1);
    this.dummy = t;
    return t;
  }

  // --- sloty -------------------------------------------------------------------------------------------------

  /**
   * Zwraca slot dla kafelka `idx` powierzchni (istniejący albo nowy); -1, gdy zabrakło miejsca nawet po wyparciu
   * kafelków nieużytych w klatce `frame`.
   */
  public acquire(surf: SparseSurface, idx: number, frame: number): number {
    const have = surf.slot[idx];
    if (have >= 0) {
      this.lastUsed[have] = frame;
      return have;
    }
    if (this.free.length === 0) this.grow();
    if (this.free.length === 0) this.evict(frame);
    if (this.free.length === 0) return -1;
    const s = this.free.pop()!;
    this.owner[s] = surf;
    this.ownerIdx[s] = idx;
    this.lastUsed[s] = frame;
    this.chunks[this.chunkOf(s)].used++;
    this.live++;
    surf.setSlot(idx, s);
    return s;
  }

  public release(surf: SparseSurface, idx: number): void {
    const s = surf.slot[idx];
    if (s < 0) {
      if (surf.entry(idx) !== 0) surf.clearSlot(idx); // kafelek jednolity
      return;
    }
    surf.clearSlot(idx);
    this.freeSlot(s);
  }

  /**
   * Zapisuje zawartość kafelka `idx` (RGBA8, proste kolory; `data` może być wycinkiem większego bufora): kafelek całkiem
   * przezroczysty nie zajmuje nic, jednolity trafia do tablicy stron, reszta dostaje slot i jest wgrywana.
   * Zwraca: 0 = pusty, 1 = wgrany do slotu, 2 = jednolity, -1 = brak miejsca w puli.
   */
  public put(surf: SparseSurface, idx: number, frame: number, w: number, h: number, data: ArrayBufferView, rowLength = 0, skipX = 0, skipY = 0): number {
    const stride = rowLength || w;
    const aligned = LITTLE_ENDIAN && data.byteOffset % 4 === 0;
    const px = aligned ? new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2) : null;
    const base = skipY * stride + skipX;
    const first = px ? px[base] : 0;
    let same = !!px;
    for (let y = 0; y < h && same; y++) {
      const o = base + y * stride;
      for (let x = 0; x < w; x++) {
        if (px![o + x] !== first) {
          same = false;
          break;
        }
      }
    }
    if (same) {
      this.release(surf, idx);
      // bajty w kolejności R, G, B, A (little endian: R to najmłodszy bajt słowa)
      const a = (first >>> 24) & 255;
      if (a === 0) return 0;
      surf.setSolid(idx, first & 255, (first >>> 8) & 255, (first >>> 16) & 255, a);
      return 2;
    }
    const slot = this.acquire(surf, idx, frame);
    if (slot < 0) return -1;
    this.upload(slot, w, h, data, rowLength, skipX, skipY);
    return 1;
  }

  private freeSlot(s: number): void {
    this.owner[s] = null;
    this.chunks[this.chunkOf(s)].used--;
    this.live--;
    this.free.push(s);
  }

  /** Dokłada kolejny kawałek atlasu (jeśli jest miejsce w limicie i GPU pozwala). */
  private grow(): void {
    let c = -1;
    for (let i = 0; i < this.limit; i++) {
      if (!this.chunks[i] || !this.chunks[i].tex) {
        c = i;
        break;
      }
    }
    if (c < 0) return;
    const g = this.g;
    const depth = Math.min(MAX_PAGES, this.depths[c]);
    const tex = g.createTexture()!;
    g.bindTexture(g.TEXTURE_2D_ARRAY, tex);
    g.texParameteri(g.TEXTURE_2D_ARRAY, g.TEXTURE_MIN_FILTER, g.NEAREST);
    g.texParameteri(g.TEXTURE_2D_ARRAY, g.TEXTURE_MAG_FILTER, g.NEAREST);
    g.texParameteri(g.TEXTURE_2D_ARRAY, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D_ARRAY, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    while (g.getError() !== g.NO_ERROR) {
      /* opróżnienie starych błędów, żeby błąd alokacji był rozpoznany */
    }
    g.texStorage3D(g.TEXTURE_2D_ARRAY, 1, g.RGBA8, POOL_PAGE, POOL_PAGE, depth);
    if (g.getError() !== g.NO_ERROR) {
      // brak pamięci GPU: nie próbuj więcej ponad to, co już mamy
      g.deleteTexture(tex);
      this.limit = Math.min(this.limit, c);
      return;
    }
    const ch: Chunk = this.chunks[c] ?? { tex: null, depth: 0, used: 0 };
    ch.tex = tex;
    ch.depth = depth;
    ch.used = 0;
    this.chunks[c] = ch;
    this.bytes += POOL_PAGE * POOL_PAGE * 4 * depth;
    const base = c * MAX_PAGES * this.spp;
    // od końca, żeby pop() oddawał najpierw sloty pierwszej strony
    for (let p = depth - 1; p >= 0; p--) for (let k = this.spp - 1; k >= 0; k--) this.free.push(base + p * this.spp + k);
  }

  /**
   * Wypiera najdawniej używane kafelki, które nie były dotknięte w klatce `frame` (ani przypięte). Wypiera partię,
   * żeby kolejne `acquire` nie szukały od nowa. Zwraca liczbę wypartych.
   */
  public evict(frame: number): number {
    const keys: number[] = [];
    for (let s = 0; s < this.cap; s++) {
      const o = this.owner[s];
      if (!o || o.pinned || this.lastUsed[s] >= frame) continue;
      keys.push(this.lastUsed[s] * this.cap + s);
    }
    if (keys.length === 0) return 0;
    keys.sort((a, b) => a - b);
    const total = this.chunks.reduce((n, c) => n + (c && c.tex ? c.depth * this.spp : 0), 0);
    const batch = Math.min(keys.length, Math.max(32, Math.ceil(total / 16)));
    for (let i = 0; i < batch; i++) {
      const s = keys[i] % this.cap;
      const o = this.owner[s]!;
      o.onEvict(this.ownerIdx[s]);
      this.freeSlot(s);
    }
    return batch;
  }

  /** Oddaje GPU kawałki, w których nie ma żadnego slotu (po zamknięciu dużej warstwy / dokumentu). */
  public trim(): void {
    const g = this.g;
    for (let c = 0; c < this.chunks.length; c++) {
      const ch = this.chunks[c];
      if (!ch || !ch.tex || ch.used !== 0) continue;
      g.deleteTexture(ch.tex);
      ch.tex = null;
      this.bytes -= POOL_PAGE * POOL_PAGE * 4 * ch.depth;
      const lo = c * MAX_PAGES * this.spp;
      const hi = lo + MAX_PAGES * this.spp;
      this.free = this.free.filter((s) => s < lo || s >= hi);
    }
    // chwilowy brak pamięci GPU nie jest trwały: przy następnej potrzebie wolno znów spróbować dorosnąć
    this.limit = this.maxChunks;
  }

  /** Wgrywa piksele kafelka (RGBA8, proste kolory) do slotu. `rowLength` / `skip*` pozwalają wgrać wycinek większego bufora. */
  public upload(slot: number, w: number, h: number, data: ArrayBufferView, rowLength = 0, skipX = 0, skipY = 0): void {
    const g = this.g;
    const c = this.chunkOf(slot);
    const inChunk = slot - c * MAX_PAGES * this.spp;
    const page = Math.floor(inChunk / this.spp);
    const inPage = inChunk - page * this.spp;
    const sx = (inPage % this.pageTiles) * this.ts;
    const sy = Math.floor(inPage / this.pageTiles) * this.ts;
    g.bindTexture(g.TEXTURE_2D_ARRAY, this.chunks[c].tex);
    g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, 0);
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    if (rowLength) {
      g.pixelStorei(g.UNPACK_ROW_LENGTH, rowLength);
      g.pixelStorei(g.UNPACK_SKIP_PIXELS, skipX);
      g.pixelStorei(g.UNPACK_SKIP_ROWS, skipY);
    }
    g.texSubImage3D(g.TEXTURE_2D_ARRAY, 0, sx, sy, page, w, h, 1, g.RGBA, g.UNSIGNED_BYTE, data);
    if (rowLength) {
      g.pixelStorei(g.UNPACK_ROW_LENGTH, 0);
      g.pixelStorei(g.UNPACK_SKIP_PIXELS, 0);
      g.pixelStorei(g.UNPACK_SKIP_ROWS, 0);
    }
  }

  /** Zwalnia wszystkie tekstury (kontekst nadal żywy) albo tylko zapomina o nich (kontekst utracony). */
  public dispose(): void {
    const g = this.g;
    const alive = !g.isContextLost();
    for (const ch of this.chunks) if (ch && ch.tex && alive) g.deleteTexture(ch.tex);
    if (this.dummy && alive) g.deleteTexture(this.dummy);
    this.chunks.length = 0;
    this.free = [];
    this.owner.fill(null);
    this.live = 0;
    this.bytes = 0;
    this.dummy = null;
  }

  /** Statystyki do diagnostyki (`__figuraGpuLast`). */
  public stats(): { slots: number; capacity: number; atlasMiB: number; chunks: number } {
    let capacity = 0;
    let chunks = 0;
    for (const c of this.chunks) if (c && c.tex) {
      capacity += c.depth * this.spp;
      chunks++;
    }
    return { slots: this.live, capacity, atlasMiB: Math.round(this.bytes / 1048576), chunks };
  }
}
