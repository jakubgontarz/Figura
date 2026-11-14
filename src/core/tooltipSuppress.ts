/**
 * Podpowiedzi (atrybut title) mają się pokazywać tylko wtedy, gdy kursor wisi nad elementem. Gdy użytkownik wciska przycisk myszy
 * (przeciąga suwak, klika), przeglądarka nie powinna wyskakiwać z podpowiedzią pod kursorem, więc na czas wciśnięcia
 * atrybut title jest tymczasowo zdejmowany z elementu i jego przodków, a po puszczeniu przywracany.
 */
export function installTooltipSuppress(): void {
  let held: { el: Element; title: string }[] = [];

  const restore = () => {
    for (const { el, title } of held) {
      if (el.isConnected && !el.hasAttribute('title')) el.setAttribute('title', title);
    }
    held = [];
  };

  window.addEventListener(
    'pointerdown',
    (e) => {
      restore();
      let el = e.target instanceof Element ? e.target : null;
      while (el) {
        const t = el.getAttribute('title');
        if (t) {
          held.push({ el, title: t });
          el.removeAttribute('title');
        }
        el = el.parentElement;
      }
    },
    true
  );
  // puszczenie przycisku (także przy zablokowanym wskaźniku, gdy zdarzenie trafia do innego elementu) i utrata okna
  window.addEventListener('pointerup', restore, true);
  window.addEventListener('pointercancel', restore, true);
  window.addEventListener('blur', restore);
  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement) restore();
  });
}
