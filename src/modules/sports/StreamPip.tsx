// Transmissão em PiP: janela pequena logo abaixo do notch com o player do canal
// (YouTube, Twitch ou Kick, links vindos do HLTV). Arrastável, três tamanhos, troca de
// canal e fechar; começa sem som.
import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createShellBridge } from "../../lib/shellBridge";
import { embedUrl, type CsStream } from "./useSports";

const sizes = [[320, 180], [384, 216], [512, 288]] as const;

export function StreamPip() {
  const bridge = useMemo(createShellBridge, []);
  const start = new URLSearchParams(location.search).get("src") ?? "";
  const [src, setSrc] = useState(start);
  const [streams, setStreams] = useState<CsStream[]>([]);
  const [size, setSize] = useState(1);
  const [menu, setMenu] = useState(false);
  // Lista de canais do jogo acompanhado (atualizada pelo HLTV).
  useEffect(() => {
    const read = () => void bridge.getCsLive?.().then(live => setStreams(live?.streams ?? [])).catch(() => {});
    read();
    const timer = window.setInterval(read, 15_000);
    return () => window.clearInterval(timer);
  }, [bridge]);
  useEffect(() => {
    const [width, height] = sizes[size];
    void import("@tauri-apps/api/dpi").then(({ LogicalSize }) => getCurrentWindow().setSize(new LogicalSize(width, height))).catch(() => {});
  }, [size]);
  const drag = (event: React.PointerEvent) => { if (event.button === 0 && !(event.target as HTMLElement).closest("button, .pip-menu")) void getCurrentWindow().startDragging(); };
  const current = streams.find(stream => stream.embed === src);
  return <div className="pip" onPointerDown={drag}>
    {src ? <iframe className="pip-player" src={embedUrl(src)} title={current?.name ?? "Transmissão"} allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowFullScreen />
      : <p className="pip-empty">Transmissão indisponível.</p>}
    <div className="pip-bar">
      <span className="pip-grip" aria-hidden="true" />
      {streams.length > 1 && <button type="button" className="pip-button pip-channel" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>{current ? `${current.name}` : "Canais"} ▾</button>}
      <button type="button" className="pip-button" aria-label="Mudar tamanho" onClick={() => setSize((size + 1) % sizes.length)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg></button>
      <button type="button" className="pip-button" aria-label="Fechar transmissão" onClick={() => void bridge.streamPip?.(null)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
    </div>
    {menu && <div className="pip-menu" role="menu">{streams.map(stream => <button key={stream.embed} type="button" role="menuitem" aria-current={stream.embed === src || undefined} onClick={() => { setSrc(stream.embed); setMenu(false); }}>
      <span>{stream.country === "Brazil" ? "🇧🇷" : stream.country === "Portugal" ? "🇵🇹" : "🌐"}</span><b>{stream.name}</b><small>{stream.provider} · {stream.viewers}</small></button>)}</div>}
  </div>;
}
