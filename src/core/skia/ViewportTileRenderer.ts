/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GraphicEngine } from './GraphicEngine.ts';
import { SKBlendMode, SKRectI, getCanvasCompositeOperation } from './types.ts';
import { markWindowedContext } from './VectorRenderer.ts';
import { grayToAlpha, finishPassThrough } from './Layer.ts';
import type { FxContext } from './Filters.ts';
import { GpuComposer, type GpuPreviewSource, type GpuWindow } from './GpuCompose.ts';

/**
 * Szybki, przerywalny renderer podglądu edycji (figury, linie, krzywe, tekst, gradient) dla płótna dowolnej wielkości.
 *
 * Zasady działania:
 *  - Jednostka podziału ma VIEW_TILE_SIZE (128) px:
 *      * zoom < 100%  -> w pikselach EKRANU (render w rozdzielczości ekranu, koszt kafelka ograniczony do ~128x128 px),
 *      * zoom >= 100% -> w pikselach PŁÓTNA (render w rozdzielczości dokumentu i powiększenie; mały widok nie jest
 *                        dzielony na setki kafelków, a wynik jest dokładnie tym, co powstanie po zatwierdzeniu).
 *  - Odświeżany jest tylko prostokątny blok jednostek przecinający: obszar figury ∩ widoczny dokument ∩ bbox zaznaczenia.
 *    Wszystko poza blokiem jest natychmiast czyszczone (odsłania płótno dokumentu), więc po pan/zoom nie zostają
 *    resztki starego podglądu.
 *  - Praca jest dzielona na zadania (prostokątne grupy jednostek). Rozmiar zadania dobierany jest do budżetu klatki
 *    z zmierzonej szybkości renderowania: mały obraz to jedno zadanie w jednej klatce (zmiana pojawia się od razu,
 *    bez migotania kafelków), duży to wiele zadań sortowanych promieniowo od kursora.
 *  - Renderowanie odbywa się w callbackach requestAnimationFrame: w jednej klatce wykonuje się tyle zadań, ile mieści się
 *    w budżecie czasu, a efekt jest malowany razem (atomowo). Każda nowa prośba (ruch myszy) unieważnia kolejkę,
 *    a pętla przerywa się też, gdy isInputPending zgłasza zdarzenie wejścia.
 *  - Brak buforów pośrednich odbudowywanych przy zmianie: zadanie składa się bezpośrednio z kafelków warstw.
 *
 * Płótno kafelków leży nad płótnem dokumentu. Obszary bez podglądu pozostają przezroczyste i odsłaniają płótno dokumentu.
 */

/** Największy bufor (w pikselach) podglądu rasteryzowanego raz w rozdzielczości dokumentu; większe figury rysujemy w oknach */
const DOC_SPRITE_MAX_PX = 24 * 1024 * 1024;
/** Do tego rozmiaru bufor podglądu powstaje także w trakcie przeciągania (koszt rzędu kilkudziesięciu ms) */
const DOC_SPRITE_LIVE_PX = 3 * 1024 * 1024;
export const VIEW_TILE_SIZE = 128;

/**
 * Minimalne przesunięcie (piksele urządzenia) siatki próbkowania. Przy zoomie ułamkowym (np. 250%) środki pikseli
 * wypadają dokładnie na granicach pikseli dokumentu, a o wyniku (który piksel "wygra") decydował szum zmiennoprzecinkowy
 * - różny dla całego płótna i dla okna rastra zadania. Stałe przesunięcie sprawia, że obie ścieżki wybierają ten sam piksel.
 */
const TIE_EPS = 0.002;

/**
 * Po zmianie widoku (zoom, przesunięcie) dotychczasowy podgląd jest natychmiast przeskalowany/przesunięty, a ponowny
 * render (wyostrzenie) startuje dopiero, gdy widok przestanie się zmieniać na tyle ms. Zoomowanie nie "regeneruje" więc
 * kafelków na oczach użytkownika.
 */
const REFINE_DELAY_MS = 100;

/**
 * Jeśli szacowany koszt odświeżenia całego bloku jest nie większy niż tyle (ms), idzie on jako JEDNO zadanie
 * i pojawia się na ekranie naraz (jak przed kafelkowaniem). Dopiero większe obszary są dzielone na zadania
 * mieszczące się w budżecie klatki.
 */
const ATOMIC_MAX_MS = 10;

/** Przy zoomie >= 100% (render w rozdzielczości dokumentu) blok do tylu ms też idzie jako jedno zadanie. */
const ATOMIC_MAX_MS_DOC = 16;
/** Przy zoomie >= 100% zadanie ma na ekranie co najmniej tyle pikseli w każdym wymiarze (o ile blok jest tak duży). */
const MIN_JOB_SCREEN_PX = 256;

/** Górny limit rastra jednego zadania (piksele) - chroni przed ogromnymi buforami. */
const MAX_JOB_RASTER_PX = 2 * 1024 * 1024;

/**
 * Pamięć podręczna podglądu (skala 1:1, układ dokumentu). Budowana w tle po zakończeniu modyfikacji, kawałkami po
 * CACHE_GROUP x CACHE_GROUP jednostek (VIEW_TILE_SIZE px), tak by zoom i przesunięcie nie wymagały renderowania.
 * Powyżej CACHE_MAX_PX pikseli (4 bajty każdy) pamięć nie jest budowana i działa dotychczasowe renderowanie po zoomie.
 */
const CACHE_GROUP = 4;
const CACHE_MAX_PX = 32 * 1000 * 1000;
/** Czas (ms) bez nowej prośby, po którym zaczyna się budowa pamięci podręcznej. */
const CACHE_MARGIN = 32;
const CACHE_START_DELAY_MS = 60;
/** Budżet czasu (ms) jednego kroku budowy pamięci podręcznej. */
const CACHE_STEP_BUDGET_MS = 8;

/**
 * Bufory grup warstw (pod i nad aktywną) w kawałkach LAYER_CHUNK x LAYER_CHUNK px dokumentu. Zadania podglądu w trybie
 * pełnej kompozycji nie składają wtedy każdej warstwy z kafelków 64 px od nowa, tylko rysują 1-2 gotowe bufory.
 * Kawałki budowane są leniwie (tylko tam, gdzie jest podgląd) i zrzucane przy zmianie sygnatury podkładu.
 * Włączane od LAYER_GROUP_MIN_LAYERS widocznych warstw poza aktywną.
 */
const LAYER_CHUNK = 512;
const LAYER_GROUP_MIN_LAYERS = 3;
/** Od tylu pikseli rastra bloku bufory warstw opłacają się także przy mniejszej liczbie warstw (budowa kawałka kosztuje raz). */
const LAYER_GROUP_MIN_BLOCK_PX = 150 * 1000;

/**
 * Niska rozdzielczość podczas interakcji (przeciąganie uchwytu): gdy pełny render bloku nie mieści się w kilku
 * milisekundach, kolejne prośby napływające szybciej niż INTERACTION_GAP_MS renderują blok w 1/2 albo 1/4 rozdzielczości
 * i powiększają wynik. Po ustaniu ruchu (REFINE_EXACT_DELAY_MS bez nowej prośby) blok jest wyostrzany pełnym renderem.
 */
const INTERACTION_GAP_MS = 150;
/** false = podgląd zawsze w pełnej rozdzielczości (bez rozmycia podczas przeciągania, ale wolniejsze klatki przy dużych figurach). */
const LOD_ENABLED = true;
/** Niska rozdzielczość tylko, gdy pełny render bloku miałby trwać dłużej niż tyle ms (kilka klatek); poniżej zawsze ostro. */
const LOD_MIN_EST_MS = 45;
/** Najniższa rozdzielczość: połowa (ćwiartka była zbyt widocznie rozmyta). */
const LOD_LEVEL = 0.5;
const REFINE_EXACT_DELAY_MS = 70;
/** Sprite przesuwanego podglądu: górny limit rozmiaru (piksele ekranu). */
const SPRITE_MAX_PX = 16 * 1000 * 1000;

/**
 * Bufory grup warstw w PIKSELACH EKRANU (tryb pełnej kompozycji przy zoomie < 100%): warstwy poniżej aktywnej, sama aktywna
 * warstwa i warstwy powyżej są raz (leniwie, po jednostkach 128 px) rysowane w skali widoku do trzech płócien wielkości
 * widoku. Zadanie nie skaluje wtedy warstw z rozdzielczości dokumentu, tylko kopiuje gotowe fragmenty 1:1 i miesza je
 * z podglądem. Bufory są ważne dla jednego widoku i jednej sygnatury podkładu (zoom / przesunięcie zrzuca je).
 */
const VIEW_GROUPS_ENABLED = true;

interface ViewGroups {
  key: string;
  w: number;
  h: number;
  below: HTMLCanvasElement | null;
  active: HTMLCanvasElement | null;
  above: HTMLCanvasElement | null;
  /** warstwy nad aktywną wszystkie Normalne (można je spłaszczyć do jednego bufora) */
  aboveOk: boolean;
  /** które jednostki (VIEW_TILE_SIZE) są już narysowane */
  built: Uint8Array;
  nx: number;
}

/** Gotowy (wyrenderowany do końca) podgląd w trybie nakładki, który można przesuwać o całkowitą liczbę pikseli ekranu. */
interface MoveSprite {
  /** klucz zawartości bez położenia + podkład + tryb + zaznaczenie */
  key: string;
  /** punkt odniesienia (układ dokumentu), w którym sprite został wyrenderowany */
  x: number;
  y: number;
  /** widok, dla którego sprite jest ważny */
  zoom: number;
  left: number;
  top: number;
  width: number;
  height: number;
  /** prostokąt ekranowy sprite'a w chwili renderu (przesunięcie 0) */
  rect: Rect;
  canvas: HTMLCanvasElement;
}

interface LayerChunk {
  below: HTMLCanvasElement | null;
  above: HTMLCanvasElement | null;
  /** sama aktywna warstwa (bez krycia i trybu mieszania) - nie zmienia się w trakcie sesji podglądu */
  active: HTMLCanvasElement | null;
}

interface CacheChunk {
  ux0: number;
  uy0: number;
  ux1: number;
  uy1: number;
  /** okno rastra w układzie dokumentu (z marginesem 1 px) */
  ox: number;
  oy: number;
  rw: number;
  rh: number;
  canvas: HTMLCanvasElement | null;
}

interface PreviewCache {
  /** pełny klucz: klucz podglądu + podkład + zaznaczenie + tryb nakładki */
  key: string;
  baseSig: string;
  chunks: CacheChunk[];
  /** liczba już wyrenderowanych kawałków; kawałki są ułożone w kolejności renderowania */
  done: number;
  complete: boolean;
}

export interface TileViewState {
  zoom: number;
  /** Położenie lewego górnego rogu dokumentu na ekranie (piksele całkowite) */
  left: number;
  top: number;
  /** Rozmiar widoku (płótna kafelków) */
  width: number;
  height: number;
}

export interface TilePreview {
  /** Rysuje podgląd w układzie dokumentu; kontekst ma ustawioną transformację dokument -> raster */
  render: (ctx: CanvasRenderingContext2D) => void;
  blendMode: SKBlendMode;
  /** Obszar zajmowany przez podgląd (układ dokumentu, razem z marginesami) */
  bounds: SKRectI | null;
  /**
   * Klucz zawartości podglądu: musi się zmieniać przy KAŻDEJ zmianie wyglądu podglądu w układzie dokumentu
   * (geometria, ustawienia, tryb mieszania), a nie zmieniać przy samym zoomie / przesunięciu / zmianie rozmiaru okna.
   * Gdy klucz jest ustawiony, renderer po zakończeniu modyfikacji buduje w tle pamięć podręczną podglądu w skali 1:1
   * i przy zmianie samego widoku nie renderuje niczego ponownie, tylko rysuje z tej pamięci.
   * Brak klucza = zachowanie dotychczasowe (render po każdej zmianie widoku).
   */
  key?: string;
  /**
   * Rasteryzuj podgląd w rozdzielczości dokumentu JEDEN raz (poza oknami kafelków), tak samo jak robi to zatwierdzanie
   * figury, i kopiuj z gotowego bufora. Rasteryzacja krawędzi ścieżek w Canvas 2D zależy od rozmiaru i położenia
   * płótna, na którym rysujemy, więc rysowanie w przyciętych oknach daje inne piksele krawędzi niż zatwierdzenie.
   * Wymaga ustawionego `key`; dotyczy okien w rozdzielczości dokumentu (zoom >= 100% i pełna jakość).
   */
  docSprite?: boolean;
  /**
   * Opis czystego przesunięcia (opcjonalny). `key` identyfikuje zawartość podglądu BEZ położenia (rozmiar, obrót, ustawienia,
   * tryb mieszania; punkty względem punktu odniesienia), a (x, y) to punkt odniesienia w układzie dokumentu. Dwie prośby
   * z równym `key` różnią się tylko przesunięciem o (Δx, Δy) - w trybie nakładki renderer nie renderuje wtedy niczego,
   * tylko kopiuje gotowy sprite o zaokrągloną liczbę pikseli ekranu, a dokładny render robi po chwili bez ruchu.
   */
  move?: { key: string; x: number; y: number };
}

export interface TileRequest {
  view: TileViewState;
  preview: TilePreview;
  /** Punkt, od którego zadania są renderowane promieniowo (współrzędne ekranu) */
  focus: { x: number; y: number } | null;
  /** Trwa przeciąganie (kolejne prośby co kilka ms): pozwala użyć niskiej rozdzielczości. Brak = decyduje odstęp czasu. */
  interactive?: boolean;
  /** Wymusza dokładny render w pełnej rozdzielczości (bez sprite'a i bez niskiej rozdzielczości). */
  exact?: boolean;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Zadanie: prostokątna grupa jednostek [ux0..ux1] x [uy0..uy1] (włącznie). */
interface Job {
  ux0: number;
  uy0: number;
  ux1: number;
  uy1: number;
  d: number;
}

const makeCanvas = (): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: false })!;
  return { canvas, ctx };
};

export class ViewportTileRenderer {
  private readonly engine: GraphicEngine;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  // Bufory robocze jednego zadania (zmieniają rozmiar tylko gdy zmieni się rozmiar zadania)
  private readonly raster = makeCanvas();
  private readonly layerBuf = makeCanvas();
  private readonly maskBuf = makeCanvas();
  /** Bufor dzieci grupy rysowanej izolowanie (grupa z krytem / trybem / maską, w której leży aktywna warstwa). */
  private readonly groupBuf = makeCanvas();
  private readonly previewBuf = makeCanvas();
  private readonly snap = makeCanvas();
  private readonly lodBuf = makeCanvas();
  private readonly cropBuf = makeCanvas();

  private generation = 0;
  private queue: Job[] = [];
  private rafId = 0;
  private timerId = 0;
  private idleWaiters: Array<() => void> = [];

  private view: TileViewState | null = null;
  private preview: TilePreview | null = null;
  private docMode = false;
  /** Ten render użył przybliżenia (okna zamiast bufora w rozdzielczości dokumentu) - po pauzie trzeba go wyostrzyć */
  private windowApprox = false;
  /** Podgląd zrasteryzowany raz w rozdzielczości dokumentu (patrz TilePreview.docSprite) */
  private docSpriteBuf: { key: string; x: number; y: number; canvas: HTMLCanvasElement } | null = null;

  // Zmierzone parametry wydajności (adaptacja do maszyny i obciążenia)
  private msPerKpx = 0.03; // ms na 1000 pikseli rastra (z narzutem); korygowane pomiarami
  /** To samo dla zadań w niskiej rozdzielczości podglądu (warstwy składane są nadal w pełnej); 0 = jeszcze nie zmierzone. */
  private msPerKpxLod = 0;
  private frameInterval = 16.7; // ms między klatkami (rAF)
  private lastRafTs = 0;
  private jobsThisFrame = 0;

  // Płótno dokumentu (bez podglądu). Gdy ustawione, kafelki rysują je same TYM SAMYM drawImage co zadania,
  // więc obszar bloku i reszta widoku przechodzą przez identyczny resampler (brak "przeskoków" o 1 px na granicy).
  private base: HTMLCanvasElement | null = null;
  private prevBlk: Rect | null = null;
  /**
   * Tryb nakładki: kafelki zawierają TYLKO podgląd (z maską zaznaczenia) na przezroczystym tle, a dokument pokazuje
   * zwykłe płótno pod spodem. Tło jest wtedy zawsze identyczne w całym widoku, a zadania nie składają warstw.
   * Możliwy, gdy wynik = podgląd "source-over" nałożony na spłaszczony dokument (aktywna warstwa na wierzchu, normalna,
   * pełna nieprzezroczystość, narzędzie w trybie normalnym). W innych przypadkach działa pełna kompozycja.
   */
  private overlay = false;
  private deferUntil = 0;
  /** Kompozytor GPU (podgląd składany na karcie graficznej) i informacja, że płótno kafelków pokazuje jego wynik. */
  private gpu: GpuComposer | null = null;
  private gpuShown = false;

  private selCacheRef: unknown = null;
  private selCacheRect: Rect | null = null;

  // --- pamięć podręczna podglądu (zoom / przesunięcie bez renderowania) ---
  /** Pełny klucz zawartości aktualnie wyświetlanego (lub właśnie renderowanego) podglądu; null = brak kluczowania. */
  private shownKey: string | null = null;
  /** Czy podgląd o kluczu shownKey jest w pełni narysowany na płótnie kafelków. */
  private shownComplete = false;
  private cache: PreviewCache | null = null;
  private cacheTimer = 0;
  private selTokenRef: unknown = null;
  private selToken = 0;

  // --- niska rozdzielczość podczas interakcji, wyostrzanie po pauzie, przesuwanie sprite'a ---
  /** Współczynnik rozdzielczości rastra bieżącej kolejki (1 = pełna, 0.5 / 0.25 = niska). */
  private lod = 1;
  private lastRequestTs = 0;
  private lastReq: TileRequest | null = null;
  private refineTimer = 0;
  private sprite: MoveSprite | null = null;
  /** Kandydat na sprite: ustawiany przy renderze podglądu z opisem przesunięcia, zamieniany w sprite po jego zakończeniu. */
  private spriteCandidate: { key: string; x: number; y: number } | null = null;

  // --- bufory grup warstw (patrz LAYER_CHUNK) ---
  private layerChunks = new Map<number, LayerChunk>();
  private layerChunksSig: string | null = null;
  private layerAboveOk = false;
  private bigBlock = false;
  private vg: ViewGroups | null = null;

  public tilesRendered = 0;
  public jobsRendered = 0;

  constructor(canvas: HTMLCanvasElement, engine: GraphicEngine) {
    this.canvas = canvas;
    this.engine = engine;
    this.ctx = canvas.getContext('2d')!;
  }


  // ------------------------------------------------------------------------------------------------
  // Składanie na GPU (patrz GpuCompose)
  // ------------------------------------------------------------------------------------------------

  /**
   * Podgląd składany w całości na karcie graficznej: wszystkie warstwy z efektami, maskami i trybami mieszania + podgląd
   * narzędzia w jednym przebiegu, bez kafelków i bez odczytu z GPU. false = nie dotyczy / nie obsługujemy (działa ścieżka CPU).
   * Tryb nakładki (podgląd na wierzchu bez efektów) zostaje na CPU: jest tani i nie rusza reszty dokumentu.
   */
  private tryGpu(req: TileRequest, exact: boolean): boolean {
    if (!GpuComposer.available()) return false;
    const v = req.view;
    const pv = req.preview;
    if (this.computeOverlay(pv, v.zoom)) return false;
    if (!this.computeEffective(pv.bounds, v)) return false;
    if (!this.gpu) this.gpu = new GpuComposer(this.engine);
    this.windowApprox = false;
    const source: GpuPreviewSource = {
      blendMode: pv.blendMode,
      bounds: pv.bounds,
      rasterize: (win, rect) => this.rasterizeForGpu(pv, win, rect),
    };
    const glc = this.gpu.compose(v, source);
    if (!glc) return false;
    if (this.canvas.width !== v.width || this.canvas.height !== v.height) {
      this.canvas.width = v.width;
      this.canvas.height = v.height;
    }
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'copy';
    c.drawImage(glc, 0, 0);
    c.globalCompositeOperation = 'source-over';
    this.queue = [];
    this.overlay = false;
    this.view = v;
    this.preview = pv;
    this.docMode = v.zoom >= 1;
    this.shownView = null;
    this.shownKey = null;
    this.shownComplete = false;
    this.prevBlk = null;
    this.gpuShown = true;
    (globalThis as { __figuraGpuLast?: unknown }).__figuraGpuLast = { ...this.gpu.lastStats, t: performance.now() };
    if (this.windowApprox && !exact) this.scheduleRefine();
    this.flushIdle();
    return true;
  }

  /** Wyjście z trybu GPU: płótno kafelków zawiera cały dokument, więc ścieżka CPU zaczyna od pełnego odtworzenia. */
  private leaveGpu(): void {
    this.gpuShown = false;
    this.view = null;
    this.prevBlk = null;
    this.shownView = null;
    this.shownKey = null;
    this.shownComplete = false;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Podgląd narzędzia w oknie rastra GPU (obszar `rect` okna, z maską zaznaczenia): ta sama rasteryzacja co w ścieżce CPU. */
  private rasterizeForGpu(
    pv: TilePreview,
    win: GpuWindow,
    rect: { x0: number; y0: number; x1: number; y1: number } | null
  ): { canvas: HTMLCanvasElement; x: number; y: number } | null {
    const eng = this.engine;
    const s = win.s;
    const x0 = rect ? rect.x0 : 0;
    const y0 = rect ? rect.y0 : 0;
    const w = rect ? rect.x1 - rect.x0 : win.W;
    const h = rect ? rect.y1 - rect.y0 : win.H;
    if (w <= 0 || h <= 0) return null;
    const pb = this.previewBuf;
    this.sizeBuf(pb, w, h);
    // początek bufora w układzie dokumentu
    const ox = win.ox + x0 / s;
    const oy = win.oy + y0 / s;
    const sprite = s === 1 ? this.getDocSprite(pv) : null;
    if (sprite) {
      pb.ctx.drawImage(sprite.canvas, sprite.x - ox, sprite.y - oy);
    } else {
      markWindowedContext(pb.ctx);
      pb.ctx.setTransform(s, 0, 0, s, -ox * s, -oy * s);
      pv.render(pb.ctx);
      pb.ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    if (eng.selectionAffectsActiveLayer) {
      const maskCanvas = eng.selectionManager.maskCanvas;
      pb.ctx.save();
      pb.ctx.globalCompositeOperation = 'destination-in';
      pb.ctx.imageSmoothingEnabled = s < 1;
      const srcW = Math.min(w / s, maskCanvas.width - ox);
      const srcH = Math.min(h / s, maskCanvas.height - oy);
      if (srcW > 0 && srcH > 0) pb.ctx.drawImage(maskCanvas, ox, oy, srcW, srcH, 0, 0, srcW * s, srcH * s);
      else pb.ctx.clearRect(0, 0, w, h);
      pb.ctx.restore();
    }
    return { canvas: pb.canvas, x: x0, y: y0 };
  }

  /** Płótno dokumentu rysowane pod podglądem (null = odsłaniamy płótno dokumentu przezroczystością). */
  public setBase(base: HTMLCanvasElement | null): void {
    this.base = base;
  }

  private shownView: TileViewState | null = null;

  /**
   * Tryb bez podglądu: płótno kafelków jest jedyną powierzchnią wyświetlającą dokument (to samo drawImage co w sesji
   * podglądu), więc wygląd nie zmienia się przy wejściu w sesję i po jej zatwierdzeniu.
   * dirty = fragment dokumentu do odświeżenia (null = całe płótno).
   */
  /** Świeżo złożone okno dokumentu: częściowe odświeżenie czyta z niego zamiast z ogromnego płótna dokumentu (patrz present). */
  private srcWin: { canvas: HTMLCanvasElement; left: number; top: number } | null = null;

  public present(view: TileViewState, base: HTMLCanvasElement, dirty: SKRectI | null, win?: { canvas: HTMLCanvasElement; left: number; top: number } | null): void {
    this.base = base;
    this.overlay = false;
    this.gpuShown = false;
    const prev = this.shownView;
    let full = dirty === null;
    if (this.canvas.width !== view.width || this.canvas.height !== view.height) {
      this.canvas.width = view.width;
      this.canvas.height = view.height;
      full = true;
    }
    if (!prev || prev.left !== view.left || prev.top !== view.top || prev.zoom !== view.zoom) full = true;
    this.shownView = view;
    const saved = this.view;
    this.view = view;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (full) {
      this.drawBaseRect({ x0: 0, y0: 0, x1: view.width, y1: view.height });
    } else {
      const z = view.zoom;
      // Źródłem jest małe okno, jeśli zawiera potrzebny fragment: czytanie z całego płótna dokumentu (np. 12 Mpx) wymusza
      // jego migawkę, a przy następnym rysowaniu kosztowną kopię całego płótna - za każdym ruchem pędzla
      this.srcWin = win ?? null;
      // margines 2 px: filtr dwuliniowy sięga sąsiednich pikseli dokumentu
      this.drawBaseRect({
        x0: Math.max(0, Math.floor(view.left + (dirty!.left - 2) * z)),
        y0: Math.max(0, Math.floor(view.top + (dirty!.top - 2) * z)),
        x1: Math.min(view.width, Math.ceil(view.left + (dirty!.right + 2) * z)),
        y1: Math.min(view.height, Math.ceil(view.top + (dirty!.bottom + 2) * z)),
      });
      this.srcWin = null;
    }
    this.view = saved;
  }

  /** Czy płótno kafelków pokazuje już dokument w tym widoku (tryb bez podglądu) - pełne odświeżenie jest wtedy zbędne. */
  public isShowing(view: TileViewState): boolean {
    const p = this.shownView;
    return !!p && !this.overlay && p.left === view.left && p.top === view.top && p.zoom === view.zoom && p.width === view.width && p.height === view.height && this.canvas.width === view.width && this.canvas.height === view.height;
  }

  /** Płótno dokumentu zmieniło się (np. cofnięcie w trakcie sesji): przy następnej prośbie narysuj je od nowa. */
  public invalidateBase(): void {
    this.prevBlk = null;
    this.view = null;
    this.shownView = null;
    this.shownKey = null;
    this.shownComplete = false;
    this.dropCache();
    this.dropLayerChunks();
    this.dropViewGroups();
    this.dropSprite();
    this.dropDocSprite();
  }

  /** Rysuje fragment dokumentu (płótno bazowe) w prostokącie ekranowym, dokładnie jak zadanie w trybie dokumentu. */
  private drawBaseRect(r: Rect, under = false): void {
    const w = r.x1 - r.x0;
    const h = r.y1 - r.y0;
    if (w <= 0 || h <= 0) return;
    const c = this.ctx;
    const v = this.view;
    if (!this.base || this.overlay || !v) {
      if (!under) c.clearRect(r.x0, r.y0, w, h);
      return;
    }
    const z = v.zoom;
    const bw = this.base.width;
    const bh = this.base.height;
    // Tylko potrzebny fragment źródła (+2 px na filtr): rysowanie całego, ogromnego płótna na każdy pas kosztowało
    const sx0 = Math.max(0, Math.floor((r.x0 - v.left) / z) - 2);
    const sy0 = Math.max(0, Math.floor((r.y0 - v.top) / z) - 2);
    const sx1 = Math.min(bw, Math.ceil((r.x1 - v.left) / z) + 2);
    const sy1 = Math.min(bh, Math.ceil((r.y1 - v.top) / z) + 2);
    c.save();
    c.beginPath();
    c.rect(r.x0, r.y0, w, h);
    c.clip();
    if (under) c.globalCompositeOperation = 'destination-over';
    else c.clearRect(r.x0, r.y0, w, h);
    if (sx1 > sx0 && sy1 > sy0) {
      c.imageSmoothingEnabled = z < 2;
      c.imageSmoothingQuality = 'low';
      let src: HTMLCanvasElement = this.base;
      let ox = 0;
      let oy = 0;
      const sw = this.srcWin;
      if (sw && sx0 >= sw.left && sy0 >= sw.top && sx1 <= sw.left + sw.canvas.width && sy1 <= sw.top + sw.canvas.height) {
        src = sw.canvas;
        ox = sw.left;
        oy = sw.top;
      }
      c.drawImage(
        src,
        sx0 - ox,
        sy0 - oy,
        sx1 - sx0,
        sy1 - sy0,
        v.left + TIE_EPS + sx0 * z,
        v.top + TIE_EPS + sy0 * z,
        (sx1 - sx0) * z,
        (sy1 - sy0) * z
      );
    }
    c.restore();
  }

  /** Przywraca dokument w obszarze `region` poza blokiem `blk` (cztery pasy). */
  private restoreOutside(region: Rect, blk: Rect | null): void {
    if (!blk) {
      this.drawBaseRect(region);
      return;
    }
    const b: Rect = {
      x0: Math.min(region.x1, Math.max(region.x0, blk.x0)),
      y0: Math.min(region.y1, Math.max(region.y0, blk.y0)),
      x1: Math.min(region.x1, Math.max(region.x0, blk.x1)),
      y1: Math.min(region.y1, Math.max(region.y0, blk.y1)),
    };
    this.drawBaseRect({ x0: region.x0, y0: region.y0, x1: region.x1, y1: b.y0 });
    this.drawBaseRect({ x0: region.x0, y0: b.y1, x1: region.x1, y1: region.y1 });
    this.drawBaseRect({ x0: region.x0, y0: b.y0, x1: b.x0, y1: b.y1 });
    this.drawBaseRect({ x0: b.x1, y0: b.y0, x1: region.x1, y1: b.y1 });
  }

  /** Czy ostatnia prośba działa w trybie nakładki (zwykłe płótno dokumentu ma pozostać widoczne). */
  public isOverlay(): boolean {
    return this.overlay;
  }

  private computeOverlay(pv: TilePreview, zoom: number): boolean {
    if (pv.blendMode !== 'SrcOver') return false;
    // Duże powiększenie: piksele są wielkimi blokami, więc podgląd i dokument muszą być rysowane tym samym rasterem
    // (zwykłe płótno pod spodem zaokrągla krawędzie pikseli inaczej niż płótno kafelków - 1 px przesunięcia i szczeliny)
    if (zoom >= 2) return false;
    const eng = this.engine;
    const act = eng.renderLayers[eng.renderActiveIndex];
    if (!act || !act.visible || act.opacity < 1 || getCanvasCompositeOperation(act.blendMode) !== 'source-over') return false;
    // aktywna warstwa w grupie z krytem / trybem / maską: podgląd musi przejść przez izolowaną kompozycję grupy
    if (eng.renderIsolation || eng.renderHasPass || eng.renderHasAdjustments) return false;
    // warstwa z maską: podgląd musi przejść przez pełną kompozycję (maskowanie), więc bez trybu nakładki
    if (act.maskGrid && act.maskEnabled) return false;
    // warstwa z korekcjami: podgląd musi przejść przez korekcje razem z pikselami warstwy, więc bez trybu nakładki
    if (act.hasActiveCorrections) return false;
    for (let i = eng.renderActiveIndex + 1; i < eng.renderLayers.length; i++) {
      const l = eng.renderLayers[i];
      if (l.visible && l.opacity > 0) return false;
    }
    return true;
  }

  public isIdle(): boolean {
    return this.queue.length === 0;
  }

  /** Promise rozwiązywana, gdy kolejka jest pusta (używane w testach). */
  public whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  public dispose(): void {
    this.gpu?.dispose();
    this.gpu = null;
    this.gpuShown = false;
    this.generation++;
    this.queue = [];
    this.cancelScheduled();
    if (this.sliceChannel) {
      this.sliceChannel.port1.close();
      this.sliceChannel = null;
    }
    this.shownKey = null;
    this.shownComplete = false;
    this.lastReq = null;
    this.dropCache();
    this.dropLayerChunks();
    this.dropViewGroups();
    this.dropSprite();
    this.dropDocSprite();
  }

  /** Usuwa podgląd (cały obszar staje się przezroczysty) i przerywa renderowanie. */
  public clear(): void {
    this.gpuShown = false;
    this.overlay = false;
    this.generation++;
    this.queue = [];
    this.preview = null;
    this.view = null;
    this.prevBlk = null;
    this.shownView = null;
    this.shownKey = null;
    this.shownComplete = false;
    this.lastReq = null;
    this.dropCache();
    this.dropLayerChunks();
    this.dropViewGroups();
    this.dropSprite();
    this.cancelScheduled();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.flushIdle();
  }

  /** Budżet czasu na jedną klatkę: ok. połowy odstępu między klatkami (ms). */
  private frameBudget(): number {
    return Math.min(9, Math.max(4, this.frameInterval * 0.5));
  }

  /**
   * Nowa prośba o odświeżenie podglądu. Natychmiast unieważnia poprzednią kolejkę.
   */
  public request(req: TileRequest): void {
    this.generation++;
    this.cancelScheduled();
    const nowTs = performance.now();
    const interacting = req.interactive ?? nowTs - this.lastRequestTs < INTERACTION_GAP_MS;
    this.lastRequestTs = nowTs;
    this.lastReq = req;
    const exact = !!req.exact;
    this.sliceAllowed = exact || !interacting;
    const v = req.view;
    const T = VIEW_TILE_SIZE;
    const z = v.zoom;
    if (this.tryGpu(req, exact)) return;
    if (this.gpuShown) this.leaveGpu();
    const prev = this.view;

    const overlay = this.computeOverlay(req.preview, z);
    const modeChanged = overlay !== this.overlay;
    this.overlay = overlay;
    let viewChanged = false;

    // --- ta sama zawartość podglądu: samo przesunięcie / zoom / zmiana rozmiaru okna nie wymaga renderowania ---
    const fullKey = req.preview.key !== undefined ? this.makeFullKey(req.preview.key, overlay) : null;
    if (this.cache && this.cache.key !== fullKey) this.dropCache();
    if (fullKey !== null) {
      const sameView =
        !!prev &&
        prev.left === v.left &&
        prev.top === v.top &&
        prev.zoom === v.zoom &&
        this.canvas.width === v.width &&
        this.canvas.height === v.height;
      if (!modeChanged && sameView && this.shownKey === fullKey && this.shownComplete) {
        // identyczna prośba (np. ponowne uruchomienie efektu Reacta): nic się nie zmieniło
        this.preview = req.preview;
        this.view = v;
        this.queue = [];
        this.flushIdle();
        this.maybeStartCacheFill();
        return;
      }
      const cache = this.cache;
      if (cache && cache.complete && cache.key === fullKey) {
        this.showFromCache(v, req.preview, overlay);
        this.shownKey = fullKey;
        this.shownComplete = true;
        this.flushIdle();
        return;
      }
      // --- czyste przesunięcie: gotowy sprite kopiowany o całkowitą liczbę pikseli, bez renderowania ---
      if (!exact && !modeChanged && this.tryMoveSprite(req, v, overlay)) {
        this.shownKey = fullKey;
        this.shownComplete = false; // przybliżenie (≤ 0,5 px ekranu): dokładny render po chwili bez ruchu
        this.flushIdle();
        this.scheduleRefine();
        return;
      }
    }

    // --- dopasowanie płótna do widoku, zachowanie zawartości na czas renderu (brak migotania) ---
    this.shownView = null;
    let fullRestore = !prev;
    if (this.canvas.width !== v.width || this.canvas.height !== v.height) {
      this.canvas.width = v.width;
      this.canvas.height = v.height;
      fullRestore = true;
    } else if (prev && (prev.left !== v.left || prev.top !== v.top || prev.zoom !== v.zoom)) {
      this.transformExistingContent(prev, v);
      fullRestore = true;
      viewChanged = true;
    }
    if (modeChanged) {
      // zmiana trybu: stara zawartość (z dokumentem albo sama nakładka) nie pasuje do nowego trybu
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      fullRestore = true;
      viewChanged = false;
    }
    this.deferUntil = viewChanged ? performance.now() + REFINE_DELAY_MS : 0;
    const whole: Rect = { x0: 0, y0: 0, x1: v.width, y1: v.height };
    const prevBlk = this.prevBlk;
    this.prevBlk = null;

    this.view = v;
    this.preview = req.preview;
    this.docMode = z >= 1;
    this.queue = [];
    this.shownKey = fullKey;
    this.shownComplete = false;
    const prevLod = this.lod;
    this.lod = 1;
    this.windowApprox = false;
    // po zakończeniu dokładnego renderu z tego podglądu powstanie sprite do przesuwania (tylko tryb nakładki, bez zaznaczenia)
    const mv = req.preview.move;
    this.spriteCandidate =
      mv && overlay && fullKey !== null && !this.engine.selectionManager.hasActiveSelection
        ? { key: this.makeFullKey(mv.key, overlay), x: mv.x, y: mv.y }
        : null;

    const eff = this.computeEffective(req.preview.bounds, v);
    if (!eff) {
      this.shownKey = null;
      this.drawBaseRect(whole);
      this.flushIdle();
      return;
    }

    // --- zakres jednostek (blok) przecinający obszar podglądu ---
    // Jednostka podziału: >= 100% w pikselach PŁÓTNA (VIEW_TILE_SIZE px dokumentu, render w rozdzielczości dokumentu),
    // < 100% w pikselach EKRANU (render w rozdzielczości ekranu).
    let ux0: number, uy0: number, ux1: number, uy1: number;
    if (this.docMode) {
      ux0 = Math.floor(eff.x0 / T);
      uy0 = Math.floor(eff.y0 / T);
      ux1 = Math.floor((eff.x1 - 1) / T);
      uy1 = Math.floor((eff.y1 - 1) / T);
    } else {
      const sx0 = Math.max(0, Math.floor(v.left + eff.x0 * z) - 1);
      const sy0 = Math.max(0, Math.floor(v.top + eff.y0 * z) - 1);
      const sx1 = Math.min(v.width, Math.ceil(v.left + eff.x1 * z) + 1);
      const sy1 = Math.min(v.height, Math.ceil(v.top + eff.y1 * z) + 1);
      if (sx1 <= sx0 || sy1 <= sy0) {
        this.shownKey = null;
        this.drawBaseRect(whole);
        this.flushIdle();
        return;
      }
      ux0 = Math.floor(sx0 / T);
      uy0 = Math.floor(sy0 / T);
      ux1 = Math.floor((sx1 - 1) / T);
      uy1 = Math.floor((sy1 - 1) / T);
    }

    // --- wszystko poza blokiem czyścimy od razu (odsłania płótno dokumentu, usuwa resztki starego podglądu) ---
    const blk = this.unitRectToScreen(ux0, uy0, ux1, uy1);
    if (this.base) {
      if (fullRestore || !prevBlk) this.restoreOutside(whole, blk);
      else this.restoreOutside(prevBlk, blk);
    } else {
      this.clearOutside(blk);
    }
    this.prevBlk = blk;
    // Brak "dziur" (szachownicy) w bloku do czasu wyrenderowania zadań: po zmianie widoku, trybu, rozmiaru i na początku sesji
    // (płótno kafelków było puste, a zwykłe płótno dokumentu jest w trybie pełnej kompozycji ukryte) blok dostaje dokument
    // bez podglądu pod spód; dotychczasowa zawartość zostaje i jest zastępowana dopiero gotowym zadaniem.
    if ((viewChanged || fullRestore) && !this.overlay && this.base) this.drawBaseRect(blk, true);

    // --- grupowanie jednostek w zadania o rozmiarze dopasowanym do budżetu klatki ---
    const nx = ux1 - ux0 + 1;
    const ny = uy1 - uy0 + 1;
    // Rzeczywista liczba pikseli rastra bloku (przy zoomie >= 100%: okno dokumentu przycięte do widoku, a nie pełne
    // jednostki) - przy dużym zoomie widać mały fragment dokumentu, więc cały blok idzie jako jedno zadanie
    let blockPx = nx * ny * T * T;
    if (this.docMode) {
      const vis = this.visibleDocRect(v);
      const w = Math.min((ux1 + 1) * T, vis.x1) - Math.max(ux0 * T, vis.x0);
      const h = Math.min((uy1 + 1) * T, vis.y1) - Math.max(uy0 * T, vis.y0);
      blockPx = Math.max(1, w) * Math.max(1, h);
    }
    // Niska rozdzielczość: tylko podczas interakcji, dla podglądów z kluczem (wszystko poza tekstem) i bez zmiany widoku.
    // Histereza (prevLod): raz wybrana niska rozdzielczość trzyma się do wyraźnego spadku szacowanego kosztu.
    if (LOD_ENABLED && !exact && interacting && fullKey !== null && !viewChanged) {
      const estFull = (this.msPerKpx * blockPx) / 1000;
      const thr = prevLod < 1 ? LOD_MIN_EST_MS * 0.7 : LOD_MIN_EST_MS;
      if (estFull > thr) this.lod = LOD_LEVEL;
    }
    // Nowe bufory warstw buduje się tylko poza przeciąganiem (budowa kawałka to jednorazowy skok kosztu); istniejące działają zawsze
    this.bigBlock = this.sliceAllowed && blockPx >= LAYER_GROUP_MIN_BLOCK_PX;
    const lod = this.lod;
    // koszt na 1000 px rastra: w niskiej rozdzielczości tylko podgląd jest tańszy (warstwy składamy w pełnej), więc mierzymy osobno
    const costKpx = lod < 1 ? (this.msPerKpxLod > 0 ? this.msPerKpxLod : this.msPerKpx * (0.3 + 0.7 * lod * lod)) : this.msPerKpx;
    const unitPx = Math.max(1, blockPx / (nx * ny));
    const budget = this.frameBudget();
    const estAll = (costKpx * blockPx) / 1000;
    // Tani blok (jedno zadanie) odświeżamy od razu, także po zoomie - bez opóźnienia i bez kafelków
    const atomicMax = this.docMode ? ATOMIC_MAX_MS_DOC : ATOMIC_MAX_MS;
    if (estAll <= atomicMax) this.deferUntil = 0;
    let gx = nx;
    let gy = ny;
    if (estAll > atomicMax) {
      const perUnit = (costKpx * unitPx) / 1000;
      // jedno zadanie ~ 80% budżetu klatki: duże zadania amortyzują narzut (alokacje buforów, getImageData)
      const k = Math.max(1, Math.floor((budget * 0.7) / Math.max(1e-6, perUnit)));
      gx = Math.max(1, Math.min(nx, Math.round(Math.sqrt(k))));
      gy = Math.max(1, Math.min(ny, Math.floor(k / gx)));
    }
    if (this.docMode) {
      // zoom >= 100%: nie dziel na kafelki mniejsze niż MIN_JOB_SCREEN_PX na ekranie
      const minU = Math.max(1, Math.ceil(MIN_JOB_SCREEN_PX / (T * z)));
      gx = Math.max(gx, Math.min(nx, minU));
      gy = Math.max(gy, Math.min(ny, minU));
    }
    const maxUnits = Math.max(1, Math.floor(MAX_JOB_RASTER_PX / unitPx));
    while (gx * gy > maxUnits) {
      if (gx >= gy) gx = Math.max(1, gx - 1);
      else gy = Math.max(1, gy - 1);
    }

    const cx = req.focus ? req.focus.x : (blk.x0 + blk.x1) / 2;
    const cy = req.focus ? req.focus.y : (blk.y0 + blk.y1) / 2;
    const jobs: Job[] = [];
    // zoom >= 100%: wąski pas resztkowy na końcu dołączamy do poprzedniego zadania zamiast robić z niego osobne
    const minUnits = this.docMode ? Math.max(1, Math.ceil(MIN_JOB_SCREEN_PX / (T * z))) : 1;
    const endOf = (start: number, size: number, last: number) => {
      const e = Math.min(start + size - 1, last);
      return this.docMode && last - e > 0 && last - e <= minUnits ? last : e;
    };
    for (let jy = uy0; jy <= uy1; ) {
      const ey = endOf(jy, gy, uy1);
      for (let jx = ux0; jx <= ux1; ) {
        const ex = endOf(jx, gx, ux1);
        const job: Job = { ux0: jx, uy0: jy, ux1: ex, uy1: ey, d: 0 };
        const r = this.unitRectToScreen(job.ux0, job.uy0, job.ux1, job.uy1);
        const dx = (r.x0 + r.x1) / 2 - cx;
        const dy = (r.y0 + r.y1) / 2 - cy;
        job.d = dx * dx + dy * dy;
        jobs.push(job);
        jx = ex + 1;
      }
      jy = ey + 1;
    }
    jobs.sort((a, b) => a.d - b.d);
    this.queue = jobs;

    if (this.queue.length > 0) this.schedule();
    else {
      this.onRenderFinished();
      this.flushIdle();
    }
  }

  // ------------------------------------------------------------------------------------------------
  // Planowanie (rytm klatek)
  // ------------------------------------------------------------------------------------------------

  private schedule(): void {
    if (this.rafId || this.timerId) return;
    const wait = this.deferUntil - performance.now();
    if (wait > 0) {
      this.timerId = window.setTimeout(() => {
        this.timerId = 0;
        this.schedule();
      }, wait);
      return;
    }
    this.rafId = requestAnimationFrame((ts) => {
      this.rafId = 0;
      if (this.timerId) {
        clearTimeout(this.timerId);
        this.timerId = 0;
      }
      this.run(ts);
    });
    // Zapasowo, gdy karta jest w tle i rAF nie jest wywoływane
    this.timerId = window.setTimeout(() => {
      this.timerId = 0;
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = 0;
      }
      this.run(performance.now(), false);
    }, 100);
  }

  private sliceChannel: MessageChannel | null = null;
  private slicePending = false;
  /** Czy kolejne porcje mogą iść jedna po drugiej (bez czekania na klatkę): nie podczas przeciągania - wtedy rAF i budżet klatki. */
  private sliceAllowed = false;

  /** Następna porcja pracy zaraz po bieżącej (makrozadanie z MessageChannel, bez 4-ms opóźnienia setTimeout). */
  private scheduleSlice(): void {
    if (this.slicePending || this.rafId || this.timerId) return;
    if (!this.sliceAllowed || this.deferUntil > performance.now()) {
      this.schedule();
      return;
    }
    if (typeof MessageChannel === 'undefined') {
      this.schedule();
      return;
    }
    if (!this.sliceChannel) {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        if (!this.slicePending) return;
        this.slicePending = false;
        if (this.queue.length > 0) this.run(performance.now(), false);
      };
      this.sliceChannel = ch;
    }
    this.slicePending = true;
    this.sliceChannel.port2.postMessage(0);
  }

  private cancelScheduled(): void {
    this.slicePending = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.timerId) clearTimeout(this.timerId);
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    if (this.refineTimer) clearTimeout(this.refineTimer);
    this.rafId = 0;
    this.timerId = 0;
    this.cacheTimer = 0;
    this.refineTimer = 0;
  }

  private flushIdle(): void {
    if (this.queue.length > 0 || this.idleWaiters.length === 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  /**
   * Jedna klatka pracy: wykonuje tyle zadań, ile mieści się w budżecie czasu. Wszystkie zmiany trafiają na ekran razem
   * (malowanie następuje po zakończeniu callbacku), więc mały obraz odświeża się od razu, a nie kafelek po kafelku.
   */
  private run(ts: number, fromRaf = true): void {
    if (fromRaf) {
      if (this.lastRafTs > 0) {
        const dt = ts - this.lastRafTs;
        if (dt > 4 && dt < 100) this.frameInterval = Math.min(34, Math.max(6, this.frameInterval * 0.8 + dt * 0.2));
      }
      this.lastRafTs = ts;
    }

    const gen = this.generation;
    const t0 = performance.now();
    const budget = this.frameBudget();
    this.jobsThisFrame = 0;
    const sched = (navigator as unknown as { scheduling?: { isInputPending?: () => boolean } }).scheduling;

    while (this.queue.length > 0) {
      // Pierwsze zadanie w klatce zawsze; kolejne tylko jeśli według pomiarów zmieści się w budżecie
      if (this.jobsThisFrame > 0) {
        const next = this.queue[0];
        const units = (next.ux1 - next.ux0 + 1) * (next.uy1 - next.uy0 + 1);
        const predicted =
          ((this.lod < 1 && this.msPerKpxLod > 0 ? this.msPerKpxLod : this.msPerKpx) * units * VIEW_TILE_SIZE * VIEW_TILE_SIZE) / 1000;
        if (performance.now() - t0 + predicted > budget) break;
      }
      const job = this.queue.shift()!;
      this.jobsThisFrame++;
      try {
        this.renderJob(job);
      } catch (err) {
        console.error('ViewportTileRenderer: błąd renderowania zadania', err);
      }
      if (gen !== this.generation) break;
      // Zdarzenie wejścia (mysz/klawiatura) czeka: oddaj sterowanie, resztę dokończymy w następnej klatce
      if (sched?.isInputPending?.()) break;
    }

    // Poza przeciąganiem kolejne porcje pracy NIE czekają na następną klatkę (czekanie na rAF po każdej porcji dawało
    // jedno zadanie na klatkę mimo kilku ms kosztu zadania). Podczas przeciągania zostaje rytm klatek i budżet,
    // żeby uchwyty i ramki reagowały płynnie i FPS nie spadał.
    if (this.queue.length > 0) {
      if (this.sliceAllowed) this.scheduleSlice();
      else this.schedule();
    } else {
      this.onRenderFinished();
      this.flushIdle();
    }
  }

  // ------------------------------------------------------------------------------------------------
  // Geometria
  // ------------------------------------------------------------------------------------------------

  /** Widoczny fragment dokumentu (piksele całkowite, przycięty do dokumentu). */
  private visibleDocRect(v: TileViewState): Rect {
    const z = v.zoom;
    return {
      x0: Math.max(0, Math.floor((0 - v.left) / z)),
      y0: Math.max(0, Math.floor((0 - v.top) / z)),
      x1: Math.min(this.engine.width, Math.ceil((v.width - v.left) / z)),
      y1: Math.min(this.engine.height, Math.ceil((v.height - v.top) / z)),
    };
  }

  /** Obszar podglądu przycięty do dokumentu, widocznego okna i prostokąta opisanego na zaznaczeniu. */
  private computeEffective(bounds: SKRectI | null, v: TileViewState, clipToView = true): Rect | null {
    if (!bounds) return null;
    const e = this.engine;
    let r: Rect = {
      x0: Math.max(0, bounds.left),
      y0: Math.max(0, bounds.top),
      x1: Math.min(e.width, bounds.right),
      y1: Math.min(e.height, bounds.bottom),
    };
    if (clipToView) {
      const vis = this.visibleDocRect(v);
      r = this.intersect(r, { x0: vis.x0 - 2, y0: vis.y0 - 2, x1: vis.x1 + 2, y1: vis.y1 + 2 });
    }

    const sel = this.getSelectionRect();
    if (sel !== undefined) {
      if (sel === null) return null; // zaznaczenie puste: podgląd i tak byłby w pełni zamaskowany
      r = this.intersect(r, sel);
    }
    return r.x1 > r.x0 && r.y1 > r.y0 ? r : null;
  }

  private intersect(a: Rect, b: Rect): Rect {
    return {
      x0: Math.max(a.x0, b.x0),
      y0: Math.max(a.y0, b.y0),
      x1: Math.min(a.x1, b.x1),
      y1: Math.min(a.y1, b.y1),
    };
  }

  /**
   * Prostokąt opisany na zaznaczeniu. undefined = brak zaznaczenia (bez ograniczenia), null = puste.
   * Liczony z wielokątów konturu (tanio), a nie ze skanu milionów pikseli maski.
   */
  private getSelectionRect(): Rect | null | undefined {
    const sm = this.engine.selectionManager;
    if (!sm.hasActiveSelection) return undefined;
    const ref = sm.contourPath;
    if (this.selCacheRef === ref) return this.selCacheRect;

    let rect: Rect | null = null;
    const cb = sm.getContourBounds();
    if (cb) {
      rect = { x0: Math.floor(cb.x0) - 2, y0: Math.floor(cb.y0) - 2, x1: Math.ceil(cb.x1) + 2, y1: Math.ceil(cb.y1) + 2 };
    } else {
      const b = sm.getSelectionBounds();
      if (b) rect = { x0: b.left - 1, y0: b.top - 1, x1: b.right + 1, y1: b.bottom + 1 };
    }
    this.selCacheRef = ref;
    this.selCacheRect = rect;
    return rect;
  }

  /**
   * Prostokąt ekranowy (liczby całkowite) pokrywany przez grupę jednostek. Sąsiednie grupy mają wspólne krawędzie,
   * więc przy zoomie ułamkowym nie powstają szwy.
   */
  private unitRectToScreen(ux0: number, uy0: number, ux1: number, uy1: number): Rect {
    const v = this.view!;
    const T = VIEW_TILE_SIZE;
    const z = v.zoom;
    const eng = this.engine;
    if (this.docMode) {
      const vis = this.visibleDocRect(v);
      const dx0 = Math.max(ux0 * T, vis.x0);
      const dy0 = Math.max(uy0 * T, vis.y0);
      const dx1 = Math.min((ux1 + 1) * T, vis.x1);
      const dy1 = Math.min((uy1 + 1) * T, vis.y1);
      // Wspólne krawędzie sąsiednich zadań zaokrąglane tak samo (brak szwów); skraje dokumentu obejmują częściowe piksele
      const ex0 = dx0 <= 0 ? Math.floor(v.left) : Math.round(v.left + dx0 * z);
      const ey0 = dy0 <= 0 ? Math.floor(v.top) : Math.round(v.top + dy0 * z);
      const ex1 = dx1 >= eng.width ? Math.ceil(v.left + eng.width * z) : Math.round(v.left + dx1 * z);
      const ey1 = dy1 >= eng.height ? Math.ceil(v.top + eng.height * z) : Math.round(v.top + dy1 * z);
      return {
        x0: Math.max(0, ex0),
        y0: Math.max(0, ey0),
        x1: Math.min(v.width, ex1),
        y1: Math.min(v.height, ey1),
      };
    }
    return {
      x0: Math.max(ux0 * T, Math.floor(v.left), 0),
      y0: Math.max(uy0 * T, Math.floor(v.top), 0),
      x1: Math.min((ux1 + 1) * T, v.width, Math.ceil(v.left + eng.width * z)),
      y1: Math.min((uy1 + 1) * T, v.height, Math.ceil(v.top + eng.height * z)),
    };
  }

  /** Czyści płótno poza prostokątem bloku (cztery pasy). */
  private clearOutside(b: Rect): void {
    const c = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const x0 = Math.min(W, Math.max(0, b.x0));
    const x1 = Math.min(W, Math.max(x0, b.x1));
    const y0 = Math.min(H, Math.max(0, b.y0));
    const y1 = Math.min(H, Math.max(y0, b.y1));
    c.clearRect(0, 0, W, y0);
    c.clearRect(0, y1, W, H - y1);
    c.clearRect(0, y0, x0, y1 - y0);
    c.clearRect(x1, y0, W - x1, y1 - y0);
  }

  /** Przesunięcie / skalowanie dotychczasowej zawartości przy pan i zoom, żeby podgląd nie znikał na czas renderu. */
  private transformExistingContent(prev: TileViewState, next: TileViewState): void {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const sn = this.snap;
    if (sn.canvas.width !== W || sn.canvas.height !== H) {
      sn.canvas.width = W;
      sn.canvas.height = H;
    } else {
      sn.ctx.clearRect(0, 0, W, H);
    }
    sn.ctx.drawImage(this.canvas, 0, 0);
    this.ctx.clearRect(0, 0, W, H);
    this.ctx.imageSmoothingEnabled = false;
    if (prev.zoom === next.zoom) {
      this.ctx.drawImage(sn.canvas, next.left - prev.left, next.top - prev.top);
    } else {
      const zr = next.zoom / prev.zoom;
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.drawImage(sn.canvas, next.left - prev.left * zr, next.top - prev.top * zr, W * zr, H * zr);
    }
  }

  // ------------------------------------------------------------------------------------------------
  // Render jednego zadania
  // ------------------------------------------------------------------------------------------------

  private sizeBuf(buf: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }, w: number, h: number): void {
    if (buf.canvas.width !== w || buf.canvas.height !== h) {
      buf.canvas.width = w;
      buf.canvas.height = h;
    } else {
      buf.ctx.setTransform(1, 0, 0, 1, 0, 0);
      buf.ctx.globalAlpha = 1;
      buf.ctx.globalCompositeOperation = 'source-over';
      buf.ctx.clearRect(0, 0, w, h);
    }
  }

  private drawLayerTiles(
    c: CanvasRenderingContext2D,
    layer: GraphicEngine['layers'][number],
    ox: number,
    oy: number,
    s: number,
    rw: number,
    rh: number,
    cl?: Rect,
    /**
     * 'raw' = piksele bez maski; 'mask' = surowa siatka maski (do podglądu edycji maski);
     * 'base' = piksele z maską, ale BEZ korekcji (aktywna warstwa: podgląd narzędzia jest dokładany na piksele,
     * a korekcje nakłada dopiero na całość `composeWindow`, żeby działały także na podgląd)
     */
    source?: 'raw' | 'mask' | 'base'
  ): void {
    // cl: tylko kafelki, których prostokąt docelowy (piksele rastra) przecina cl
    const grid = source === 'mask' && layer.maskGrid ? layer.maskGrid : layer.pixelGrid;
    const canvasOf = (t: import('./Tile.ts').Tile): HTMLCanvasElement | null =>
      source === 'base' ? layer.renderCanvas(t, false) : source ? t.canvas : layer.renderCanvas(t);
    const needsContent = !layer.grayView || !!source;
    const left = cl ? Math.floor(ox + cl.x0 / s) - 1 : Math.floor(ox) - 1;
    const top = cl ? Math.floor(oy + cl.y0 / s) - 1 : Math.floor(oy) - 1;
    const right = cl ? Math.ceil(ox + cl.x1 / s) + 1 : Math.ceil(ox + rw / s) + 1;
    const bottom = cl ? Math.ceil(oy + cl.y1 / s) + 1 : Math.ceil(oy + rh / s) + 1;
    const tiles = grid.getTilesIntersectingRect({
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    });
    c.imageSmoothingEnabled = s !== 1;
    c.imageSmoothingQuality = 'low';
    if (s === 1) {
      for (const tile of tiles) {
        if (!(source ? tile.hasContent : layer.tileShown(tile)) && needsContent) continue;
        const cv = canvasOf(tile);
        if (cv) c.drawImage(cv, tile.pixelX - ox, tile.pixelY - oy);
      }
      return;
    }
    // Docelowe prostokąty zaokrąglane do pikseli rastra: sąsiednie kafelki warstwy mają wspólne całkowite krawędzie,
    // więc nie ma szwów (częściowe krycie na ułamkowych krawędziach dawało widoczną siatkę przy niektórych zoomach).
    for (const tile of tiles) {
      if (!(source ? tile.hasContent : layer.tileShown(tile)) && needsContent) continue;
      const x0 = Math.round((tile.pixelX - ox) * s);
      const y0 = Math.round((tile.pixelY - oy) * s);
      const x1 = Math.round((tile.pixelX + tile.width - ox) * s);
      const y1 = Math.round((tile.pixelY + tile.height - oy) * s);
      if (x1 <= x0 || y1 <= y0) continue;
      if (cl && (x0 >= cl.x1 || y0 >= cl.y1 || x1 <= cl.x0 || y1 <= cl.y0)) continue;
      const cv = canvasOf(tile);
      if (cv) c.drawImage(cv, 0, 0, tile.width, tile.height, x0, y0, x1 - x0, y1 - y0);
    }
  }

  // ------------------------------------------------------------------------------------------------
  // Pamięć podręczna podglądu (zoom / przesunięcie bez renderowania)
  // ------------------------------------------------------------------------------------------------

  /** Token zaznaczenia: zmienia się, gdy zaznaczenie zostanie zbudowane od nowa (każda zmiana tworzy nowy contourPath). */
  private selectionToken(): number {
    const sm = this.engine.selectionManager;
    if (!sm.hasActiveSelection) return 0;
    const ref = sm.contourPath;
    if (this.selTokenRef !== ref) {
      this.selTokenRef = ref;
      this.selToken++;
    }
    return this.selToken;
  }

  /** Klucz podglądu + wszystko inne, co wpływa na jego wygląd, a czego nie zna wywołujący (podkład, zaznaczenie, tryb). */
  private makeFullKey(key: string, overlay: boolean): string {
    return `${key}|${this.engine.getBaseSignature()}|${this.engine.correctionSessionSignature}|${overlay ? 1 : 0}|${this.selectionToken()}`;
  }

  private dropViewGroups(): void {
    const g = this.vg;
    if (g) {
      if (g.below) g.below.width = 0;
      if (g.active) g.active.width = 0;
      if (g.above) g.above.width = 0;
    }
    this.vg = null;
  }

  /**
   * Bufory grup warstw w skali widoku dla okna rastra (ox, oy, s, rw, rh) zadania w rozdzielczości ekranu. Dorysowuje
   * brakujące jednostki 128 px. null = nie dotyczy (zoom >= 100%, nakładka, okno poza widokiem).
   */
  private viewGroupsFor(ox: number, oy: number, s: number, rw: number, rh: number): (ViewGroups & { sx: number; sy: number }) | null {
    const v = this.view;
    if (!VIEW_GROUPS_ENABLED || !v || this.docMode || this.overlay || s >= 1 || Math.abs(s - v.zoom) > 1e-9) return null;
    const sx = Math.round(ox * s + v.left);
    const sy = Math.round(oy * s + v.top);
    if (sx < 0 || sy < 0 || sx + rw > v.width || sy + rh > v.height) return null;
    const eng = this.engine;
    const act = eng.renderActiveIndex;
    const T = VIEW_TILE_SIZE;
    const key = `${eng.getBaseSignature()}|${act}|${v.zoom}|${v.left}|${v.top}|${v.width}|${v.height}`;
    if (!this.vg || this.vg.key !== key) {
      this.dropViewGroups();
      let aboveOk = true;
      for (let i = act + 1; i < eng.renderLayers.length; i++) {
        const l = eng.renderLayers[i];
        if (l.visible && l.opacity > 0 && getCanvasCompositeOperation(l.blendMode) !== 'source-over') aboveOk = false;
      }
      const nx = Math.ceil(v.width / T);
      const ny = Math.ceil(v.height / T);
      this.vg = { key, w: v.width, h: v.height, below: null, active: null, above: null, aboveOk, built: new Uint8Array(nx * ny), nx };
    }
    const g = this.vg;
    const z = v.zoom;
    const o0x = -v.left / z;
    const o0y = -v.top / z;
    const mk = (): HTMLCanvasElement => {
      const c = document.createElement('canvas');
      c.width = v.width;
      c.height = v.height;
      return c;
    };
    // jednostki pokrywane przez okno
    for (let uy = Math.floor(sy / T); uy <= Math.floor((sy + rh - 1) / T); uy++) {
      for (let ux = Math.floor(sx / T); ux <= Math.floor((sx + rw - 1) / T); ux++) {
        const bi = uy * g.nx + ux;
        if (g.built[bi]) continue;
        g.built[bi] = 1;
        const cl: Rect = { x0: ux * T, y0: uy * T, x1: Math.min((ux + 1) * T, v.width), y1: Math.min((uy + 1) * T, v.height) };
        const paint = (which: 'below' | 'active' | 'above', from: number, to: number, plain: boolean): void => {
          for (let i = from; i < to; i++) {
            const layer = eng.renderLayers[i];
            if (!layer.visible || layer.opacity <= 0) continue;
            let cv = g[which];
            if (!cv) cv = g[which] = mk();
            const c = cv.getContext('2d')!;
            c.save();
            c.beginPath();
            c.rect(cl.x0, cl.y0, cl.x1 - cl.x0, cl.y1 - cl.y0);
            c.clip();
            c.globalAlpha = plain ? 1 : layer.opacity;
            c.globalCompositeOperation = plain ? 'source-over' : getCanvasCompositeOperation(layer.blendMode);
            this.drawLayerTiles(c, layer, o0x, o0y, z, v.width, v.height, cl, plain ? 'base' : undefined);
            c.restore();
          }
        };
        paint('below', 0, act, false);
        paint('active', act, act + 1, true);
        if (g.aboveOk) paint('above', act + 1, eng.renderLayers.length, false);
      }
    }
    return Object.assign(g, { sx, sy });
  }

  private dropLayerChunks(): void {
    for (const ch of this.layerChunks.values()) {
      if (ch.below) ch.below.width = 0;
      if (ch.above) ch.above.width = 0;
      if (ch.active) ch.active.width = 0;
    }
    this.layerChunks.clear();
    this.layerChunksSig = null;
  }

  private dropCache(): void {
    const c = this.cache;
    if (c) {
      for (const ch of c.chunks) {
        if (ch.canvas) {
          ch.canvas.width = 0; // zwalnia pamięć bufora od razu, bez czekania na GC
          ch.canvas = null;
        }
      }
    }
    this.cache = null;
  }

  /** Wywoływane, gdy podgląd o kluczu shownKey jest w całości narysowany. */
  private onRenderFinished(): void {
    if (this.shownKey === null) return;
    if (this.lod < 1 || this.windowApprox) {
      // blok narysowany w niskiej rozdzielczości (lub z przybliżeniem okien): po pauzie wyostrzamy go pełnym renderem
      this.scheduleRefine();
      return;
    }
    this.shownComplete = true;
    this.buildSprite();
    this.maybeStartCacheFill();
  }

  // ------------------------------------------------------------------------------------------------
  // Przesuwanie gotowego podglądu (sprite) i wyostrzanie po pauzie
  // ------------------------------------------------------------------------------------------------

  /** Po REFINE_EXACT_DELAY_MS bez nowej prośby renderuje ostatni podgląd dokładnie (pełna rozdzielczość, bez sprite'a). */
  private scheduleRefine(): void {
    if (this.refineTimer) clearTimeout(this.refineTimer);
    this.refineTimer = window.setTimeout(() => {
      this.refineTimer = 0;
      const r = this.lastReq;
      if (r && this.view) this.request({ view: r.view, preview: r.preview, focus: r.focus, exact: true });
    }, REFINE_EXACT_DELAY_MS);
  }

  private dropDocSprite(): void {
    if (this.docSpriteBuf) this.docSpriteBuf.canvas.width = 0;
    this.docSpriteBuf = null;
  }

  private dropSprite(): void {
    if (this.sprite) this.sprite.canvas.width = 0;
    this.sprite = null;
    this.spriteCandidate = null;
  }

  /**
   * Zamienia właśnie dokończony, dokładny render w sprite: kopię prostokąta bloku z płótna kafelków (tryb nakładki:
   * same piksele podglądu). Sprite jest ważny tylko, gdy cała figura mieści się w widoku i w dokumencie (nic nie jest
   * przycięte), bo tylko wtedy przesunięcie nie odsłoni brakującej zawartości.
   */
  private buildSprite(): void {
    const cand = this.spriteCandidate;
    const v = this.view;
    const pv = this.preview;
    const blk = this.prevBlk;
    // przesuwanie sprite'a działa tylko poniżej 100% (powyżej render idzie w rozdzielczości dokumentu)
    if (!cand || !v || !pv || !blk || !pv.bounds || !this.overlay || v.zoom >= 1) return;
    if (this.engine.selectionManager.hasActiveSelection) return;
    const b = pv.bounds;
    const eng = this.engine;
    if (b.left < 0 || b.top < 0 || b.right > eng.width || b.bottom > eng.height) return;
    const z = v.zoom;
    const x0 = Math.floor(v.left + b.left * z) - 1;
    const y0 = Math.floor(v.top + b.top * z) - 1;
    const x1 = Math.ceil(v.left + b.right * z) + 1;
    const y1 = Math.ceil(v.top + b.bottom * z) + 1;
    if (x0 < 0 || y0 < 0 || x1 > v.width || y1 > v.height) return;
    const rect: Rect = {
      x0: Math.max(0, Math.floor(blk.x0)),
      y0: Math.max(0, Math.floor(blk.y0)),
      x1: Math.min(v.width, Math.ceil(blk.x1)),
      y1: Math.min(v.height, Math.ceil(blk.y1)),
    };
    const w = rect.x1 - rect.x0;
    const h = rect.y1 - rect.y0;
    if (w <= 0 || h <= 0 || w * h > SPRITE_MAX_PX) return;
    let cv = this.sprite?.canvas;
    if (!cv) cv = document.createElement('canvas');
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    const sctx = cv.getContext('2d')!;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = 'copy';
    sctx.drawImage(this.canvas, rect.x0, rect.y0, w, h, 0, 0, w, h);
    sctx.globalCompositeOperation = 'source-over';
    this.sprite = {
      key: cand.key,
      x: cand.x,
      y: cand.y,
      zoom: v.zoom,
      left: v.left,
      top: v.top,
      width: v.width,
      height: v.height,
      rect,
      canvas: cv,
    };
  }

  /**
   * Czyste przesunięcie: zamiast renderować podgląd od nowa, rysuje gotowy sprite przesunięty o zaokrągloną liczbę pikseli
   * ekranu. Zwraca false, gdy sprite się nie nadaje (inna zawartość, widok, zaznaczenie, tryb) - wtedy działa zwykły render.
   */
  private tryMoveSprite(req: TileRequest, v: TileViewState, overlay: boolean): boolean {
    const mv = req.preview.move;
    const sp = this.sprite;
    if (!mv || !sp || !overlay || !this.overlay) return false;
    if (this.engine.selectionManager.hasActiveSelection) return false;
    if (sp.key !== this.makeFullKey(mv.key, overlay)) return false;
    if (sp.zoom !== v.zoom || sp.left !== v.left || sp.top !== v.top || sp.width !== v.width || sp.height !== v.height) return false;
    // płótno kafelków musi być w stanie sesji podglądu (po present() zawiera cały dokument)
    if (this.shownView !== null || !this.view || this.canvas.width !== v.width || this.canvas.height !== v.height) return false;
    if (this.docMode || v.zoom >= 1) return false;
    const b = req.preview.bounds;
    if (!b) return false;

    const z = v.zoom;
    const eng = this.engine;
    const dx = Math.round((mv.x - sp.x) * z);
    const dy = Math.round((mv.y - sp.y) * z);

    // obszar, w którym podgląd może być widoczny: dokument ∩ widok
    const C: Rect = {
      x0: Math.max(0, Math.floor(v.left)),
      y0: Math.max(0, Math.floor(v.top)),
      x1: Math.min(v.width, Math.ceil(v.left + eng.width * z)),
      y1: Math.min(v.height, Math.ceil(v.top + eng.height * z)),
    };
    const dst: Rect = {
      x0: Math.max(C.x0, sp.rect.x0 + dx),
      y0: Math.max(C.y0, sp.rect.y0 + dy),
      x1: Math.min(C.x1, sp.rect.x1 + dx),
      y1: Math.min(C.y1, sp.rect.y1 + dy),
    };

    this.queue = [];
    this.view = v;
    this.preview = req.preview;
    this.overlay = true;
    this.docMode = false;
    this.deferUntil = 0;
    this.shownView = null;
    this.spriteCandidate = null;

    const d = this.ctx;
    d.setTransform(1, 0, 0, 1, 0, 0);
    const old = this.prevBlk;
    if (old) d.clearRect(old.x0, old.y0, old.x1 - old.x0, old.y1 - old.y0);
    else d.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (dst.x1 > dst.x0 && dst.y1 > dst.y0) {
      d.imageSmoothingEnabled = false;
      d.drawImage(
        sp.canvas,
        dst.x0 - (sp.rect.x0 + dx),
        dst.y0 - (sp.rect.y0 + dy),
        dst.x1 - dst.x0,
        dst.y1 - dst.y0,
        dst.x0,
        dst.y0,
        dst.x1 - dst.x0,
        dst.y1 - dst.y0
      );
      this.prevBlk = dst;
    } else {
      this.prevBlk = null;
    }
    return true;
  }

  private maybeStartCacheFill(): void {
    const key = this.shownKey;
    const v = this.view;
    const pv = this.preview;
    if (key === null || !this.shownComplete || !v || !pv || this.cacheTimer) return;
    if (this.cache && this.cache.complete && this.cache.key === key) return;
    if (!this.cache && !this.buildCachePlan(key, v, pv)) return;
    this.scheduleCacheStep(CACHE_START_DELAY_MS);
  }

  /** Dzieli obszar podglądu (bez ograniczenia do widoku) na kawałki w kolejności od środka widoku. */
  private buildCachePlan(key: string, v: TileViewState, pv: TilePreview): boolean {
    const eng = this.engine;
    const T = VIEW_TILE_SIZE;
    const eff = this.computeEffective(pv.bounds, v, false);
    if (!eff) return false;
    const ux0 = Math.floor(eff.x0 / T);
    const uy0 = Math.floor(eff.y0 / T);
    const ux1 = Math.floor((eff.x1 - 1) / T);
    const uy1 = Math.floor((eff.y1 - 1) / T);
    const px = (Math.min(eng.width, (ux1 + 1) * T) - ux0 * T) * (Math.min(eng.height, (uy1 + 1) * T) - uy0 * T);
    if (px <= 0 || px > CACHE_MAX_PX) return false;

    const chunks: CacheChunk[] = [];
    for (let gy = uy0; gy <= uy1; gy += CACHE_GROUP) {
      for (let gx = ux0; gx <= ux1; gx += CACHE_GROUP) {
        const cx1 = Math.min(gx + CACHE_GROUP - 1, ux1);
        const cy1 = Math.min(gy + CACHE_GROUP - 1, uy1);
        // Margines CACHE_MARGIN px (wielokrotność 32): przy zmniejszaniu filtr (zwłaszcza 'high' z mipmapami) sięga
        // daleko poza kawałek, a początek kawałka na wielokrotności 32 trzyma fazę mipmap zgodną z całym dokumentem.
        // Przy marginesie 1 px na styku kawałków powstawały widoczne linie.
        const ox = Math.max(0, gx * T - CACHE_MARGIN);
        const oy = Math.max(0, gy * T - CACHE_MARGIN);
        const rw = Math.min(eng.width, (cx1 + 1) * T + CACHE_MARGIN) - ox;
        const rh = Math.min(eng.height, (cy1 + 1) * T + CACHE_MARGIN) - oy;
        if (rw <= 0 || rh <= 0) continue;
        chunks.push({ ux0: gx, uy0: gy, ux1: cx1, uy1: cy1, ox, oy, rw, rh, canvas: null });
      }
    }
    if (chunks.length === 0) return false;

    // najpierw to, co jest najbliżej środka aktualnie widocznego fragmentu dokumentu
    const mx = (v.width / 2 - v.left) / v.zoom;
    const my = (v.height / 2 - v.top) / v.zoom;
    const dist = (c: CacheChunk) => {
      const dx = c.ox + c.rw / 2 - mx;
      const dy = c.oy + c.rh / 2 - my;
      return dx * dx + dy * dy;
    };
    chunks.sort((a, b) => dist(a) - dist(b));

    this.cache = { key, baseSig: eng.getBaseSignature(), chunks, done: 0, complete: false };
    return true;
  }

  private scheduleCacheStep(delay: number): void {
    const gen = this.generation;
    this.cacheTimer = window.setTimeout(() => {
      this.cacheTimer = 0;
      if (gen !== this.generation) return;
      this.cacheStep();
    }, delay);
  }

  /** Jeden krok budowy pamięci podręcznej: kilka kawałków w budżecie czasu, z oddaniem sterowania przy zdarzeniu wejścia. */
  private cacheStep(): void {
    const cache = this.cache;
    if (!cache || cache.complete) return;
    if (this.engine.getBaseSignature() !== cache.baseSig || !this.preview) {
      this.dropCache();
      return;
    }
    const sched = (navigator as unknown as { scheduling?: { isInputPending?: () => boolean } }).scheduling;
    if (sched?.isInputPending?.()) {
      this.scheduleCacheStep(40);
      return;
    }
    const t0 = performance.now();
    while (cache.done < cache.chunks.length) {
      const ch = cache.chunks[cache.done];
      try {
        const out = this.composeWindow(ch.ox, ch.oy, 1, ch.rw, ch.rh);
        const cv = document.createElement('canvas');
        cv.width = ch.rw;
        cv.height = ch.rh;
        cv.getContext('2d')!.drawImage(out, 0, 0);
        ch.canvas = cv;
      } catch (err) {
        console.error('ViewportTileRenderer: błąd budowy pamięci podręcznej podglądu', err);
        this.dropCache();
        return;
      }
      cache.done++;
      if (performance.now() - t0 > CACHE_STEP_BUDGET_MS) break;
      if (sched?.isInputPending?.()) break;
    }
    if (cache.done >= cache.chunks.length) cache.complete = true;
    else this.scheduleCacheStep(2);
  }

  /** Prostokąt ekranowy (liczby całkowite) pełnej grupy jednostek, bez przycinania do widoku (jak w trybie dokumentu). */
  private groupScreenRect(ux0: number, uy0: number, ux1: number, uy1: number, v: TileViewState): Rect {
    const T = VIEW_TILE_SIZE;
    const z = v.zoom;
    const eng = this.engine;
    const dx0 = ux0 * T;
    const dy0 = uy0 * T;
    const dx1 = Math.min((ux1 + 1) * T, eng.width);
    const dy1 = Math.min((uy1 + 1) * T, eng.height);
    const ex0 = dx0 <= 0 ? Math.floor(v.left) : Math.round(v.left + dx0 * z);
    const ey0 = dy0 <= 0 ? Math.floor(v.top) : Math.round(v.top + dy0 * z);
    const ex1 = dx1 >= eng.width ? Math.ceil(v.left + eng.width * z) : Math.round(v.left + dx1 * z);
    const ey1 = dy1 >= eng.height ? Math.ceil(v.top + eng.height * z) : Math.round(v.top + dy1 * z);
    return {
      x0: Math.max(0, ex0),
      y0: Math.max(0, ey0),
      x1: Math.min(v.width, ex1),
      y1: Math.min(v.height, ey1),
    };
  }

  /** Rysuje cały widok (dokument + podgląd) z pamięci podręcznej, bez renderowania czegokolwiek. */
  private showFromCache(v: TileViewState, preview: TilePreview, overlay: boolean): void {
    const cache = this.cache!;
    if (this.canvas.width !== v.width || this.canvas.height !== v.height) {
      this.canvas.width = v.width;
      this.canvas.height = v.height;
    }
    this.view = v;
    this.preview = preview;
    this.overlay = overlay;
    this.docMode = v.zoom >= 1;
    this.queue = [];
    this.shownView = null;
    this.prevBlk = null;
    this.deferUntil = 0;

    const d = this.ctx;
    d.setTransform(1, 0, 0, 1, 0, 0);
    this.drawBaseRect({ x0: 0, y0: 0, x1: v.width, y1: v.height });

    const z = v.zoom;
    for (const ch of cache.chunks) {
      if (!ch.canvas) continue;
      const clip = this.groupScreenRect(ch.ux0, ch.uy0, ch.ux1, ch.uy1, v);
      if (clip.x1 <= clip.x0 || clip.y1 <= clip.y0) continue;
      d.clearRect(clip.x0, clip.y0, clip.x1 - clip.x0, clip.y1 - clip.y0);
      d.save();
      d.beginPath();
      d.rect(clip.x0, clip.y0, clip.x1 - clip.x0, clip.y1 - clip.y0);
      d.clip();
      d.imageSmoothingEnabled = z < 2;
      d.imageSmoothingQuality = z < 1 ? 'high' : 'low';
      d.drawImage(ch.canvas, 0, 0, ch.rw, ch.rh, v.left + TIE_EPS + ch.ox * z, v.top + TIE_EPS + ch.oy * z, ch.rw * z, ch.rh * z);
      d.restore();
    }
  }

  // ------------------------------------------------------------------------------------------------
  // Bufory grup warstw
  // ------------------------------------------------------------------------------------------------

  private firstVisibleAbove(act: number): number {
    const layers = this.engine.renderLayers;
    for (let i = act + 1; i < layers.length; i++) if (layers[i].visible && layers[i].opacity > 0) return i;
    return -1;
  }

  /**
   * Czy w tej kompozycji używać buforów grup. Przy zmianie sygnatury podkładu stare bufory są zrzucane.
   * Grupa "nad aktywną" jest buforowana tylko, gdy wszystkie jej warstwy mają tryb Normalny (inaczej kolejność mieszania
   * z podłożem ma znaczenie i trzeba rysować warstwy po kolei).
   */
  private prepareLayerGroups(): boolean {
    const eng = this.engine;
    let others = 0;
    for (let i = 0; i < eng.renderLayers.length; i++) {
      const l = eng.renderLayers[i];
      if (i !== eng.renderActiveIndex && l.visible && l.opacity > 0) others++;
    }
    // indeks aktywnej warstwy wpływa na podział na grupy "pod" i "nad"
    const sig = eng.getBaseSignature() + '|' + eng.renderActiveIndex;
    const haveChunks = this.layerChunksSig === sig && this.layerChunks.size > 0;
    if (others < LAYER_GROUP_MIN_LAYERS && !this.bigBlock && !haveChunks) return false;
    if (this.layerChunksSig !== sig) {
      this.dropLayerChunks();
      this.layerChunksSig = sig;
    }
    let aboveOk = true;
    for (let i = eng.renderActiveIndex + 1; i < eng.renderLayers.length; i++) {
      const l = eng.renderLayers[i];
      if (l.visible && l.opacity > 0 && getCanvasCompositeOperation(l.blendMode) !== 'source-over') aboveOk = false;
    }
    this.layerAboveOk = aboveOk;
    return true;
  }

  private buildLayerGroup(from: number, to: number, ox: number, oy: number, rw: number, rh: number, plain = false): HTMLCanvasElement | null {
    const layers = this.engine.renderLayers;
    let cv: HTMLCanvasElement | null = null;
    let r: CanvasRenderingContext2D | null = null;
    for (let i = from; i < to; i++) {
      const layer = layers[i];
      if (!layer.visible || layer.opacity <= 0) continue;
      if (!cv) {
        cv = document.createElement('canvas');
        cv.width = rw;
        cv.height = rh;
        r = cv.getContext('2d')!;
      }
      r!.save();
      // plain: sama zawartość warstwy (krycie i tryb mieszania stosuje składanie okna)
      r!.globalAlpha = plain ? 1 : layer.opacity;
      r!.globalCompositeOperation = plain ? 'source-over' : getCanvasCompositeOperation(layer.blendMode);
      this.drawLayerTiles(r!, layer, ox, oy, 1, rw, rh, undefined, plain ? 'base' : undefined);
      r!.restore();
    }
    return cv;
  }

  private getLayerChunk(cx: number, cy: number): LayerChunk {
    const key = cy * 65536 + cx;
    let ch = this.layerChunks.get(key);
    if (ch) return ch;
    const eng = this.engine;
    const ox = cx * LAYER_CHUNK;
    const oy = cy * LAYER_CHUNK;
    const rw = Math.min(LAYER_CHUNK, eng.width - ox);
    const rh = Math.min(LAYER_CHUNK, eng.height - oy);
    const act = eng.renderActiveIndex;
    ch = {
      active: this.buildLayerGroup(act, act + 1, ox, oy, rw, rh, true),
      below: this.buildLayerGroup(0, act, ox, oy, rw, rh),
      above: this.layerAboveOk ? this.buildLayerGroup(act + 1, eng.renderLayers.length, ox, oy, rw, rh) : null,
    };
    this.layerChunks.set(key, ch);
    return ch;
  }

  /** Rysuje grupę warstw (gotowe kawałki) w oknie rastra; krawędzie kawałków zaokrąglane jak w drawLayerTiles (bez szwów). */
  private drawLayerGroup(
    c: CanvasRenderingContext2D,
    which: 'below' | 'above' | 'active',
    ox: number,
    oy: number,
    s: number,
    rw: number,
    rh: number
  ): void {
    const eng = this.engine;
    const left = Math.max(0, Math.floor(ox) - 1);
    const top = Math.max(0, Math.floor(oy) - 1);
    const right = Math.min(eng.width, Math.ceil(ox + rw / s) + 1);
    const bottom = Math.min(eng.height, Math.ceil(oy + rh / s) + 1);
    if (right <= left || bottom <= top) return;
    c.save();
    c.imageSmoothingEnabled = s !== 1;
    c.imageSmoothingQuality = 'low';
    for (let cy = Math.floor(top / LAYER_CHUNK); cy <= Math.floor((bottom - 1) / LAYER_CHUNK); cy++) {
      for (let cx = Math.floor(left / LAYER_CHUNK); cx <= Math.floor((right - 1) / LAYER_CHUNK); cx++) {
        const src = this.getLayerChunk(cx, cy)[which];
        if (!src) continue;
        const px = cx * LAYER_CHUNK;
        const py = cy * LAYER_CHUNK;
        if (s === 1) {
          c.drawImage(src, px - ox, py - oy);
        } else {
          const x0 = Math.round((px - ox) * s);
          const y0 = Math.round((py - oy) * s);
          const x1 = Math.round((px + src.width - ox) * s);
          const y1 = Math.round((py + src.height - oy) * s);
          if (x1 > x0 && y1 > y0) c.drawImage(src, 0, 0, src.width, src.height, x0, y0, x1 - x0, y1 - y0);
        }
      }
    }
    c.restore();
  }

  /**
   * Składa zawartość okna rastra [ox, ox + rw/s] x [oy, oy + rh/s] (układ dokumentu, skala s): w trybie nakładki samo
   * podgląd (z maską zaznaczenia), w pozostałych przypadkach wszystkie warstwy z podglądem na aktywnej.
   * Zwraca bufor roboczy (rw x rh), który jest nadpisywany przy następnym wywołaniu.
   */
  /**
   * Bufor podglądu w rozdzielczości dokumentu: figura rysowana na zwykłym (niepodzielonym na okna) płótnie, czyli tą samą
   * drogą co przy zatwierdzaniu, więc piksele są identyczne z tymi, które trafią do warstwy. Bufor żyje, dopóki ten sam klucz.
   * Zwraca null, gdy podgląd go nie wymaga albo figura jest tak duża, że bufor byłby zbyt kosztowny (wtedy rysujemy w oknach).
   */
  private getDocSprite(preview: TilePreview): { x: number; y: number; canvas: HTMLCanvasElement } | null {
    if (!preview.docSprite || preview.key === undefined || !preview.bounds) return null;
    const key = preview.key;
    const cur = this.docSpriteBuf;
    if (cur && cur.key === key) return cur;
    const b = preview.bounds;
    const x0 = Math.max(0, Math.floor(b.left));
    const y0 = Math.max(0, Math.floor(b.top));
    const x1 = Math.min(this.engine.width, Math.ceil(b.right));
    const y1 = Math.min(this.engine.height, Math.ceil(b.bottom));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0 || w * h > DOC_SPRITE_MAX_PX) return null;
    // Duża figura: rasteryzacja całości kosztuje setki ms, więc w trakcie przeciągania zostają okna (szybkie, z drobnymi
    // różnicami na krawędziach), a dokładny bufor powstaje po chwili bez ruchu (prośba exact) - przed zatwierdzeniem
    if (w * h > DOC_SPRITE_LIVE_PX && !this.sliceAllowed) {
      this.windowApprox = true;
      return null;
    }
    let canvas = cur ? cur.canvas : document.createElement('canvas');
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const c = canvas.getContext('2d')!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, w, h);
    c.translate(-x0, -y0);
    preview.render(c);
    c.setTransform(1, 0, 0, 1, 0, 0);
    this.docSpriteBuf = { key, x: x0, y: y0, canvas };
    return this.docSpriteBuf;
  }

  /**
   * Składa okno rastra. Gdy w bieżącej kompozycji są filtry działające na całość okna (aktywna warstwa, korekcje stosu,
   * kryt grupy), okno jest powiększane o ich zasięg (w pikselach rastra) i po złożeniu przycinane z powrotem, więc wynik
   * nie ma szwów na styku zadań, a filtr widzi sąsiednie piksele jak na całym dokumencie.
   */
  private composeWindow(ox: number, oy: number, s: number, rw: number, rh: number, plod = 1): HTMLCanvasElement {
    const mDoc = this.engine.renderFilterMargin;
    if (mDoc <= 0 || this.overlay) return this.composeWindowRaw(ox, oy, s, rw, rh, plod);
    const m = Math.min(1500, Math.ceil(mDoc * s));
    const out = this.composeWindowRaw(ox - m / s, oy - m / s, s, rw + 2 * m, rh + 2 * m, plod);
    const cb = this.cropBuf;
    this.sizeBuf(cb, rw, rh);
    cb.ctx.drawImage(out, m, m, rw, rh, 0, 0, rw, rh);
    return cb.canvas;
  }

  private composeWindowRaw(ox: number, oy: number, s: number, rw: number, rh: number, plod = 1): HTMLCanvasElement {
    const eng = this.engine;
    // kontekst filtrów dla tego okna: skala, położenie okna w dokumencie i obszar zajmowany przez dokument
    const fxw: FxContext = {
      scale: s,
      docX0: ox,
      docY0: oy,
      docW: eng.width,
      docH: eng.height,
      bounds: { x0: -ox * s, y0: -oy * s, x1: (eng.width - ox) * s, y1: (eng.height - oy) * s },
    };
    const preview = this.preview!;
    const hasSel = eng.selectionAffectsActiveLayer;
    // Maska jest odczytywana dopiero, gdy faktycznie jest potrzebna (jej rastrowanie bywa odroczone)
    const overlay = this.overlay;

    // Rysuje podgląd do bufora pb (z maską zaznaczenia)
    const fillPreview = (): HTMLCanvasElement => {
      const pb = this.previewBuf;
      this.sizeBuf(pb, rw, rh);
      if (plod < 1) {
        // Niska rozdzielczość: podgląd rasteryzowany w plod-krotnie mniejszym buforze i powiększany do okna.
        // Warstwy dokumentu (poniżej) nadal składane są w pełnej rozdzielczości, więc nie tracą ostrości.
        const lw = Math.max(1, Math.ceil(rw * plod));
        const lh = Math.max(1, Math.ceil(rh * plod));
        const lb = this.lodBuf;
        this.sizeBuf(lb, lw, lh);
        markWindowedContext(lb.ctx);
        const ls = s * plod;
        lb.ctx.setTransform(ls, 0, 0, ls, -ox * ls, -oy * ls);
        preview.render(lb.ctx);
        lb.ctx.setTransform(1, 0, 0, 1, 0, 0);
        pb.ctx.save();
        pb.ctx.imageSmoothingEnabled = true;
        pb.ctx.imageSmoothingQuality = 'low';
        pb.ctx.drawImage(lb.canvas, 0, 0, rw * plod, rh * plod, 0, 0, rw, rh);
        pb.ctx.restore();
      } else {
        const sprite = s === 1 ? this.getDocSprite(preview) : null;
        if (sprite) {
          pb.ctx.drawImage(sprite.canvas, sprite.x - ox, sprite.y - oy);
        } else {
          markWindowedContext(pb.ctx);
          pb.ctx.setTransform(s, 0, 0, s, -ox * s, -oy * s);
          preview.render(pb.ctx);
          pb.ctx.setTransform(1, 0, 0, 1, 0, 0);
        }
      }

      if (hasSel) {
        const maskCanvas = eng.selectionManager.maskCanvas;
        pb.ctx.save();
        pb.ctx.globalCompositeOperation = 'destination-in';
        pb.ctx.imageSmoothingEnabled = s < 1;
        const srcW = Math.min(rw / s, maskCanvas.width - ox);
        const srcH = Math.min(rh / s, maskCanvas.height - oy);
        if (srcW > 0 && srcH > 0) {
          pb.ctx.drawImage(maskCanvas, ox, oy, srcW, srcH, 0, 0, srcW * s, srcH * s);
        }
        pb.ctx.restore();
      }
      return pb.canvas;
    };

    let out: HTMLCanvasElement;
    if (overlay) {
      // Nakładka: tylko podgląd na przezroczystym tle (dokument pod spodem rysuje zwykłe płótno)
      out = fillPreview();
    } else {
      const rc = this.raster;
      this.sizeBuf(rc, rw, rh);
      const r = rc.ctx;
      const act = eng.renderActiveIndex;
      // Zoom < 100%: gotowe bufory warstw w skali widoku (kopiowanie 1:1); w pozostałych przypadkach bufory kawałków dokumentu
      // Aktywna warstwa w izolowanej grupie: wszystkie warstwy rysowane po kolei (bez buforów grup i widoków),
      // a dzieci grupy trafiają do osobnego bufora nakładanego potem z ustawieniami grupy.
      const iso = eng.renderIsolation;
      // Grupy „Przepuszczanie” z krytem / maską: warstwy muszą być rysowane po kolei na tle (bez buforów grup)
      const hasPass = eng.renderHasPass;
      // Korekcje samodzielne w stosie: warstwy rysowane po kolei (bufory grup nie znają ich położenia względem warstw)
      const hasAdj = eng.renderHasAdjustments;
      const vgp = iso || hasPass || hasAdj ? null : this.viewGroupsFor(ox, oy, s, rw, rh);
      const grouped = vgp || iso || hasPass || hasAdj ? false : this.prepareLayerGroups();
      let R: CanvasRenderingContext2D = r;
      const passSnaps = new Map<string, HTMLCanvasElement>();

      if (vgp) {
        if (vgp.below) r.drawImage(vgp.below, vgp.sx, vgp.sy, rw, rh, 0, 0, rw, rh);
      } else if (grouped) {
        // Warstwy pod aktywną: gotowy bufor grupy (identyczny wynik jak kolejne rysowanie warstw na pustym rastrze)
        this.drawLayerGroup(r, 'below', ox, oy, s, rw, rh);
      }

      for (let i = 0; i < eng.renderLayers.length; i++) {
        const layer = eng.renderLayers[i];
        const psG = hasPass ? eng.renderPassStartAt(i) : undefined;
        if (psG) {
          const sc = document.createElement('canvas');
          sc.width = rw;
          sc.height = rh;
          sc.getContext('2d')!.drawImage(r.canvas, 0, 0);
          passSnaps.set(psG.id, sc);
        }
        const peG = hasPass ? eng.renderPassEndAt(i) : undefined;
        if (peG) {
          const sn = passSnaps.get(peG.id);
          if (sn && peG.ownVisible) {
            const al = document.createElement('canvas');
            al.width = rw;
            al.height = rh;
            const actx = al.getContext('2d')!;
            if (peG.maskGrid && peG.maskEnabled) {
              const gm = this.maskBuf;
              this.sizeBuf(gm, rw, rh);
              this.drawLayerTiles(gm.ctx, peG, ox, oy, s, rw, rh, undefined, 'mask');
              const gimg = gm.ctx.getImageData(0, 0, rw, rh);
              grayToAlpha(gimg.data);
              gm.ctx.putImageData(gimg, 0, 0);
              actx.globalAlpha = peG.opacity;
              actx.drawImage(gm.canvas, 0, 0);
            } else {
              actx.globalAlpha = peG.opacity;
              actx.fillStyle = '#000';
              actx.fillRect(0, 0, rw, rh);
            }
            finishPassThrough(r, sn, al, 0, 0, rw, rh);
          }
          continue;
        }
        if (iso && i === iso.start) {
          this.sizeBuf(this.groupBuf, rw, rh);
          R = this.groupBuf.ctx;
        }
        if (iso && i === iso.header) {
          R = r;
          const g = iso.group;
          if (g.ownVisible && g.opacity > 0) {
            const gb = this.groupBuf;
            // maska grupy działa przed jej korekcjami i stylizacjami (cień nie jest przycinany maską), potem kryt grupy
            if (g.maskGrid && g.maskEnabled) {
              const gm = this.maskBuf;
              this.sizeBuf(gm, rw, rh);
              this.drawLayerTiles(gm.ctx, g, ox, oy, s, rw, rh, undefined, 'mask');
              const gimg = gm.ctx.getImageData(0, 0, rw, rh);
              grayToAlpha(gimg.data);
              gm.ctx.putImageData(gimg, 0, 0);
              gb.ctx.save();
              gb.ctx.globalCompositeOperation = 'destination-in';
              gb.ctx.drawImage(gm.canvas, 0, 0);
              gb.ctx.restore();
            }
            if (g.hasActiveCorrections) g.applyCorrectionsToCanvas(gb.canvas, rw, rh, 0, 0, fxw);
            r.save();
            r.globalAlpha = g.opacity;
            r.globalCompositeOperation = getCanvasCompositeOperation(g.blendMode === 'PassThrough' ? 'SrcOver' : g.blendMode);
            r.drawImage(gb.canvas, 0, 0);
            r.restore();
          }
          continue;
        }
        if (layer.isAdjustment) {
          // korekcja samodzielna działa na wszystko, co pod nią w tym kontenerze (raster okna albo bufor grupy)
          if (layer.adjustmentActive) layer.applyCorrectionsToCanvas(R.canvas, rw, rh, 0, 0, fxw);
          continue;
        }
        if (!layer.visible || layer.opacity <= 0) continue;

        if (i !== act) {
          if (vgp) {
            if (i < act) continue;
            if (vgp.aboveOk) {
              if (i === this.firstVisibleAbove(act) && vgp.above) R.drawImage(vgp.above, vgp.sx, vgp.sy, rw, rh, 0, 0, rw, rh);
              continue;
            }
          } else {
            if (grouped && i < act) continue;
            if (grouped && this.layerAboveOk && i > act) {
              // wszystkie warstwy nad aktywną są "Normalne": rysujemy je raz, jako grupę, po aktywnej
              if (i === this.firstVisibleAbove(act)) this.drawLayerGroup(r, 'above', ox, oy, s, rw, rh);
              continue;
            }
          }
          R.save();
          R.globalAlpha = layer.opacity;
          R.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
          this.drawLayerTiles(R, layer, ox, oy, s, rw, rh);
          R.restore();
          continue;
        }

        // Aktywna warstwa + podgląd (z maską zaznaczenia i trybem mieszania narzędzia)
        const lb = this.layerBuf;
        this.sizeBuf(lb, rw, rh);
        const editingMask = layer.editMask && !!layer.maskGrid && layer.maskEnabled && !layer.grayView;
        // przy połączonej masce pływające piksele mają już nałożoną poruszaną maskę (podgląd sesji), więc nie maskujemy ich drugi raz
        let corrDone = false;
        const maskedPixels =
          !editingMask && !!layer.maskGrid && layer.maskEnabled && !layer.grayView && !eng.transformContentSession?.other;
        if (editingMask) {
          // Edycja maski: podgląd narzędzia nanoszony na MASKĘ, a dopiero ona (jako alfa) na piksele warstwy
          const mb = this.maskBuf;
          this.sizeBuf(mb, rw, rh);
          this.drawLayerTiles(mb.ctx, layer, ox, oy, s, rw, rh, undefined, 'mask');
          const pcanvasM = fillPreview();
          mb.ctx.save();
          mb.ctx.globalCompositeOperation = getCanvasCompositeOperation(preview.blendMode);
          mb.ctx.drawImage(pcanvasM, 0, 0);
          mb.ctx.restore();
          const mimg = mb.ctx.getImageData(0, 0, rw, rh);
          grayToAlpha(mimg.data);
          mb.ctx.putImageData(mimg, 0, 0);
          this.drawLayerTiles(lb.ctx, layer, ox, oy, s, rw, rh, undefined, 'raw');
          // maska działa przed korekcjami i filtrami (cień i zniekształcenie dotyczą już zamaskowanego obrazu)
          lb.ctx.save();
          lb.ctx.globalCompositeOperation = 'destination-in';
          lb.ctx.drawImage(mb.canvas, 0, 0);
          lb.ctx.restore();
          if (layer.hasActiveCorrections) layer.applyCorrectionsToCanvas(lb.canvas, rw, rh, 0, 0, fxw);
          corrDone = true;
        } else if (maskedPixels) {
          // Edycja pikseli warstwy z maską: podgląd nanoszony na surowe piksele, a dopiero całość maskowana (jak po zatwierdzeniu)
          this.drawLayerTiles(lb.ctx, layer, ox, oy, s, rw, rh, undefined, 'raw');
          const pcanvasP = fillPreview();
          lb.ctx.save();
          lb.ctx.globalCompositeOperation = getCanvasCompositeOperation(preview.blendMode);
          lb.ctx.drawImage(pcanvasP, 0, 0);
          lb.ctx.restore();
          const mb2 = this.maskBuf;
          this.sizeBuf(mb2, rw, rh);
          this.drawLayerTiles(mb2.ctx, layer, ox, oy, s, rw, rh, undefined, 'mask');
          const mimg2 = mb2.ctx.getImageData(0, 0, rw, rh);
          grayToAlpha(mimg2.data);
          mb2.ctx.putImageData(mimg2, 0, 0);
          lb.ctx.save();
          lb.ctx.globalCompositeOperation = 'destination-in';
          lb.ctx.drawImage(mb2.canvas, 0, 0);
          lb.ctx.restore();
          // maska przed korekcjami i filtrami
          if (layer.hasActiveCorrections) layer.applyCorrectionsToCanvas(lb.canvas, rw, rh, 0, 0, fxw);
          corrDone = true;
        } else {
          if (vgp) {
            if (vgp.active) lb.ctx.drawImage(vgp.active, vgp.sx, vgp.sy, rw, rh, 0, 0, rw, rh);
          } else if (grouped) this.drawLayerGroup(lb.ctx, 'active', ox, oy, s, rw, rh);
          else this.drawLayerTiles(lb.ctx, layer, ox, oy, s, rw, rh, undefined, 'base');

          const pcanvas = fillPreview();

          lb.ctx.save();
          lb.ctx.globalCompositeOperation = getCanvasCompositeOperation(preview.blendMode);
          lb.ctx.drawImage(pcanvas, 0, 0);
          lb.ctx.restore();
        }

        // Korekcje warstwy działają na całości (piksele + podgląd narzędzia), jak tryb mieszania i krycie warstwy
        if (!corrDone && layer.hasActiveCorrections) layer.applyCorrectionsToCanvas(lb.canvas, rw, rh, 0, 0, fxw);

        R.save();
        R.globalAlpha = layer.opacity;
        R.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
        R.drawImage(lb.canvas, 0, 0);
        R.restore();
      }
      out = rc.canvas;
    }
    return out;
  }

  private renderJob(job: Job): void {
    const v = this.view;
    const preview = this.preview;
    if (!v || !preview) return;
    const eng = this.engine;
    const T = VIEW_TILE_SIZE;
    const z = v.zoom;

    // Prostokąt ekranowy zadania (całkowity) - obszar, który zostanie zastąpiony
    const clip = this.unitRectToScreen(job.ux0, job.uy0, job.ux1, job.uy1);
    if (clip.x1 <= clip.x0 || clip.y1 <= clip.y0) return;

    // Parametry rastra: dokument -> raster to x_r = (x - ox) * s
    // lod < 1 dotyczy TYLKO rasteryzacji podglądu (patrz composeWindow): warstwy dokumentu są zawsze składane w pełnej jakości
    const lod = this.lod;
    let ox: number, oy: number, s: number, rw: number, rh: number;
    if (this.docMode) {
      const vis = this.visibleDocRect(v);
      const dx0 = Math.max(job.ux0 * T, vis.x0);
      const dy0 = Math.max(job.uy0 * T, vis.y0);
      const dx1 = Math.min((job.ux1 + 1) * T, vis.x1);
      const dy1 = Math.min((job.uy1 + 1) * T, vis.y1);
      if (dx1 <= dx0 || dy1 <= dy0) return;
      // margines 1 px, żeby filtrowanie przy powiększeniu 1-2x było poprawne na styku zadań
      ox = Math.max(0, dx0 - 1);
      oy = Math.max(0, dy0 - 1);
      s = 1;
      rw = Math.min(eng.width, dx1 + 1) - ox;
      rh = Math.min(eng.height, dy1 + 1) - oy;
    } else {
      s = z;
      ox = (clip.x0 - v.left) / z;
      oy = (clip.y0 - v.top) / z;
      rw = clip.x1 - clip.x0;
      rh = clip.y1 - clip.y0;
    }
    if (rw <= 0 || rh <= 0) return;

    const tStart = performance.now();

    const out = this.composeWindow(ox, oy, s, rw, rh, lod);
    const tCompose = performance.now();

    // --- wyświetlenie (zadanie zastępuje swój prostokąt w całości) ---
    const d = this.ctx;
    d.clearRect(clip.x0, clip.y0, clip.x1 - clip.x0, clip.y1 - clip.y0);
    if (this.docMode) {
      d.save();
      d.beginPath();
      d.rect(clip.x0, clip.y0, clip.x1 - clip.x0, clip.y1 - clip.y0);
      d.clip();
      d.imageSmoothingEnabled = z < 2;
      d.imageSmoothingQuality = 'low';
      d.drawImage(out, 0, 0, rw, rh, v.left + TIE_EPS + ox * z, v.top + TIE_EPS + oy * z, rw * z, rh * z);
      d.restore();
    } else {
      d.drawImage(out, 0, 0, rw, rh, clip.x0, clip.y0, rw, rh);
    }

    // Opcjonalny profiler (konsola przeglądarki: window.__figuraTileProf = {}; po testach odczytaj window.__figuraTileProf)
    const prof = (globalThis as any).__figuraTileProf as Record<string, number> | undefined;
    if (prof) {
      const tEnd = performance.now();
      prof.jobs = (prof.jobs || 0) + 1;
      prof.composeMs = (prof.composeMs || 0) + (tCompose - tStart);
      prof.displayMs = (prof.displayMs || 0) + (tEnd - tCompose);
      prof.kpx = (prof.kpx || 0) + (rw * rh) / 1000;
      prof.overlayJobs = (prof.overlayJobs || 0) + (this.overlay ? 1 : 0);
    }

    // Adaptacja szacunku kosztu (do doboru rozmiaru zadań w kolejnych prośbach)
    const elapsed = performance.now() - tStart;
    const kpx = (rw * rh) / 1000;
    if (kpx > 0.5) {
      if (lod < 1) this.msPerKpxLod = this.msPerKpxLod > 0 ? this.msPerKpxLod * 0.7 + (elapsed / kpx) * 0.3 : elapsed / kpx;
      else this.msPerKpx = this.msPerKpx * 0.7 + (elapsed / kpx) * 0.3;
    }
    this.jobsRendered++;
    this.tilesRendered++;
  }
}

// ------------------------------------------------------------------------------------------------
// Obszary zajmowane przez podgląd (układ dokumentu) - do wyznaczania dirty rect
// ------------------------------------------------------------------------------------------------

const toRectI = (x0: number, y0: number, x1: number, y1: number): SKRectI => {
  const left = Math.floor(x0);
  const top = Math.floor(y0);
  const right = Math.ceil(x1);
  const bottom = Math.ceil(y1);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
};

/** Linia i krzywa: prostokąt opisany na punktach + ten sam margines, którego używa renderer (grubość, markery). */
export function boundsForPoints(
  pts: Array<{ x: number; y: number }>,
  strokeWidth: number,
  markerSize: number | undefined
): SKRectI {
  const sw = Math.max(1, Math.round(strokeWidth));
  const pad = Math.max(30, sw * (markerSize || 1.0) * 4 + 30);
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return toRectI(x0 - pad, y0 - pad, x1 + pad, y1 + pad);
}

/** Obrócony prostokąt w x h wokół środka + margines `ext` (obrys, ostre naroża, wygładzanie). */
export function boundsForRotatedBox(
  center: { x: number; y: number },
  width: number,
  height: number,
  angle: number,
  ext: number
): SKRectI {
  const c = Math.abs(Math.cos(angle));
  const s = Math.abs(Math.sin(angle));
  const hx = (width * c + height * s) / 2 + ext;
  const hy = (width * s + height * c) / 2 + ext;
  return toRectI(center.x - hx, center.y - hy, center.x + hx, center.y + hy);
}

/** Figura: obrys może wystawać poza ramkę (wyrównanie na zewnątrz, miter przy ostrych narożach gwiazdy). */
export function boundsForShape(
  center: { x: number; y: number },
  width: number,
  height: number,
  angle: number,
  strokeWidth: number
): SKRectI {
  return boundsForRotatedBox(center, width, height, angle, Math.max(0, strokeWidth) * 5 + 4);
}
