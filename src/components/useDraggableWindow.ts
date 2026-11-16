import { useRef, useState } from 'react';

/**
 * Przesuwanie okna dialogowego za pasek tytułu. Okno startuje wyśrodkowane (układem CSS rodzica); przy pierwszym
 * złapaniu paska jego położenie jest zamieniane na współrzędne ekranu i od tej pory podąża za myszą (z zachowaniem w oknie przeglądarki).
 * `boxStyle` ustawia się na oknie, `titleProps` na pasku tytułu (przyciski na pasku nie przeciągają).
 */
export function useDraggableWindow() {
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  const titleProps = {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const r = boxRef.current?.getBoundingClientRect();
      if (!r) return;
      drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      setPos({ x: r.left, y: r.top });
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d) return;
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - 80, e.clientX - d.dx)),
        y: Math.max(0, Math.min(window.innerHeight - 40, e.clientY - d.dy)),
      });
    },
    onPointerUp: () => {
      drag.current = null;
    },
    onPointerCancel: () => {
      drag.current = null;
    },
  };
  const boxStyle: React.CSSProperties | undefined = pos ? { position: 'fixed', left: pos.x, top: pos.y, margin: 0 } : undefined;
  return { boxRef, boxStyle, titleProps, reset: () => setPos(null) };
}
