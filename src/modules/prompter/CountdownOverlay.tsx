// Contagem 3-2-1 no centro da tela antes de gravar (janela própria, fora do vídeo).
// Conta sozinha a partir de quando abre; o notch fecha a janela ao começar ou cancelar.
import { useEffect, useState } from "react";

export function CountdownOverlay() {
  const [left, setLeft] = useState(3);
  useEffect(() => {
    const id = window.setInterval(() => setLeft(value => Math.max(1, value - 1)), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <div className="countdown-overlay" role="timer" aria-live="assertive">
    <svg className="countdown-ring" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="46" key={left} /></svg>
    <span key={left}>{left}</span>
  </div>;
}
