// Bolha de câmera (estilo Loom): janela própria, redonda, sempre por cima e arrastável.
// Fica fora do notch, então aparece na gravação de tela.
import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const sizes = [160, 220, 300];

export function CameraBubble() {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState(1);
  useEffect(() => {
    let stream: MediaStream | null = null;
    navigator.mediaDevices?.getUserMedia({ video: { width: 640, height: 640, facingMode: "user" }, audio: false })
      .then(media => { stream = media; if (video.current) video.current.srcObject = media; })
      .catch(() => setError("Câmera indisponível ou sem permissão."));
    return () => stream?.getTracks().forEach(track => track.stop());
  }, []);
  // A janela acompanha o tamanho escolhido (pequena, média, grande).
  useEffect(() => {
    void import("@tauri-apps/api/dpi").then(({ LogicalSize }) => getCurrentWindow().setSize(new LogicalSize(sizes[size], sizes[size]))).catch(() => {});
  }, [size]);
  const drag = (event: React.PointerEvent) => { if (event.button === 0 && !(event.target as HTMLElement).closest("button")) void getCurrentWindow().startDragging(); };
  return <div className="camera-bubble" onPointerDown={drag} onDoubleClick={() => setSize((size + 1) % sizes.length)}>
    {error ? <p>{error}</p> : <video ref={video} autoPlay muted playsInline />}
    <div className="camera-tools">
      <button type="button" aria-label="Mudar tamanho" title="Tamanho (ou duplo clique)" onClick={() => setSize((size + 1) % sizes.length)}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg></button>
      <button type="button" aria-label="Fechar câmera" title="Fechar" onClick={() => void getCurrentWindow().close()}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
    </div>
  </div>;
}
