/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Kółko myszy nad listą rozwijaną (select) zmienia wybraną pozycję: do góry poprzednia, w dół następna.
 * Pozycje wyłączone są pomijane, a na końcach listy wybór się zatrzymuje. Zmiana wywołuje zwykłe zdarzenie `change`,
 * więc komponenty reagują tak samo jak na wybór z rozwiniętej listy. Działa globalnie, dla wszystkich list w programie.
 */
export function installSelectWheel(): () => void {
  let acc = 0;
  let lastSelect: HTMLSelectElement | null = null;

  const onWheel = (e: WheelEvent) => {
    const target = e.target as Element | null;
    const sel = target?.closest?.('select') as HTMLSelectElement | null;
    if (!sel || sel.disabled || sel.multiple) return;
    e.preventDefault();
    if (sel !== lastSelect) {
      lastSelect = sel;
      acc = 0;
    }
    // Zwykłe kółko daje duże przyrosty (jedno oczko = jedna pozycja), gładzik drobne, które sumuję do progu
    acc += e.deltaY || e.deltaX;
    if (Math.abs(acc) < 50) return;
    const dir = acc > 0 ? 1 : -1;
    acc = 0;
    let i = sel.selectedIndex + dir;
    while (i >= 0 && i < sel.options.length && (sel.options[i].disabled || sel.options[i].hidden)) i += dir;
    if (i < 0 || i >= sel.options.length) return;
    sel.selectedIndex = i;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  };

  document.addEventListener('wheel', onWheel, { passive: false });
  return () => document.removeEventListener('wheel', onWheel);
}
