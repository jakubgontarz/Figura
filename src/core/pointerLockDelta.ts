/**
 * Przesunięcie myszy podczas przeciągania z zablokowanym wskaźnikiem (Pointer Lock).
 *
 * Przy włączaniu blokady przeglądarki potrafią podać pojedyncze fałszywe zdarzenia: ruch równy współrzędnej, na której kursor
 * był przed blokadą, a po nim ruch o przeciwnym znaku (kursor „skacze” do środka i wraca). Ruch zależałby wtedy od miejsca na
 * ekranie, w którym zaczęto przeciąganie. Ten licznik:
 *  - do czasu przejęcia blokady (maks. 300 ms, potem uznaje, że blokada się nie udała) nie liczy żadnego ruchu,
 *  - po przejęciu blokady odrzuca pary dużych, wzajemnie znoszących się zdarzeń.
 * Bez blokady przesunięcie liczy zwykle ze współrzędnych kursora.
 */
export class PointerLockDelta {
  private lastX = 0;
  private lastY = 0;
  private requestedAt = 0;
  private failed = false;
  private pend: [number, number] | null = null;
  private wasLocked = false;

  constructor(x: number, y: number) {
    this.lastX = x;
    this.lastY = y;
  }

  /** Prosi o zablokowanie wskaźnika na elemencie; od tej chwili czeka na jego przejęcie. */
  request(el: Element): void {
    this.requestedAt = performance.now();
    try {
      const p = (el as HTMLElement).requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {
        this.failed = true;
      });
    } catch {
      this.failed = true;
    }
  }

  /** Przesunięcie [dx, dy] w pikselach ekranu, jakie wnosi to zdarzenie. */
  next(e: { clientX: number; clientY: number; movementX: number; movementY: number }, el: Element): [number, number] {
    const locked = document.pointerLockElement === el;
    if (!locked) {
      if (this.requestedAt && !this.failed && performance.now() - this.requestedAt < 300) {
        // blokada jeszcze się nie włączyła: współrzędne bywają w tym czasie nieprawdziwe
        return [0, 0];
      }
      let d: [number, number] = [e.clientX - this.lastX, e.clientY - this.lastY];
      // po próbie włączenia blokady nagły skok współrzędnych o ponad 150 px w jednym zdarzeniu to nie ruch myszy
      if (this.requestedAt && (Math.abs(d[0]) > 150 || Math.abs(d[1]) > 150)) d = [0, 0];
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      return d;
    }
    const mx = e.movementX;
    const my = e.movementY;
    const big = (v: number) => Math.abs(v) > 100;
    // pierwsze zdarzenie po przejęciu blokady: duży skok to przeskok kursora do środka, a nie ruch myszy
    if (!this.wasLocked) {
      this.wasLocked = true;
      if (big(mx) || big(my)) return [0, 0];
    }
    if (this.pend) {
      const [px, py] = this.pend;
      this.pend = null;
      if (Math.abs(px + mx) <= 3 && Math.abs(py + my) <= 3) return [0, 0]; // fałszywa para: odrzucona
      if (big(mx) || big(my)) {
        this.pend = [mx, my];
        return [px, py];
      }
      return [px + mx, py + my];
    }
    if (big(mx) || big(my)) {
      this.pend = [mx, my];
      return [0, 0];
    }
    return [mx, my];
  }
}
