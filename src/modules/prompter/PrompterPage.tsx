// Teleprompter (como no OmniNotch): o texto rola logo abaixo da câmera, centralizado.
// Editar, tocar/pausar, reiniciar, velocidade, tamanho e espelhar; espaço alterna,
// roda do mouse ajusta a posição. A rolagem é transform (a página não rola).
import { useEffect, useRef, useState } from "react";
import type { NotesControl } from "../context/useNotes";
import { clock, recordedMs, type RecorderControl } from "./useRecorder";

const glyph = {
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  play: "M8 5v14l11-7z",
  pause: "M7 5h3v14H7zM14 5h3v14h-3z",
  restart: "M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4",
  mirror: "M12 3v18M8 7L4 12l4 5M16 7l4 5-4 5",
  turtle: "M5 15a7 5 0 0 1 14 0zM4 15h16M7 15l-1 3M17 15l1 3M19 12l2-1",
  hare: "M13 4c2 0 3 2 2 4M9 4c2 0 3 2 2 4M5 18c0-4 3-8 8-8 3 0 6 2 6 5 0 2-1 3-3 3z",
  opacity: "M12 3a9 9 0 1 0 0 18zM12 3a9 9 0 0 1 0 18",
  pauseRec: "M8 6v12M16 6v12",
  stop: "M7 7h10v10H7z",
  camera: "M3 7h4l2-3h6l2 3h4v13H3zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-1-3-2 .2-1.3-1.3.2-2-3-1-1 2h-1.8l-1-2-3 1 .2 2L6.9 7.2 5 7l-1 3 2 1v2l-2 1 1 3 2-.2 1.3 1.3-.2 2 3 1 1-2h1.8l1 2 3-1-.2-2 1.3-1.3 2 .2 1-3-2-1z",
};
const sizes = { normal: 26, large: 38 } as const;
const Icon = ({ d, size = 14 }: { d: string; size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;

/** `ghost`: cópia que sai na troca de página; não pega foco nem teclado. */
export function PrompterPage({ notes, recorder, ghost = false }: { notes?: NotesControl; recorder?: RecorderControl; ghost?: boolean }) {
  const prompter = notes?.prompter;
  const [editing, setEditing] = useState(() => !prompter?.text.trim());
  const [playing, setPlaying] = useState(false);
  const [panel, setPanel] = useState<"none" | "opacity" | "record">("none");
  // A rolagem acompanha a gravação: começa com ela e pausa junto.
  const recState = recorder?.state.state;
  useEffect(() => { if (recState === "recording") { setEditing(false); setPlaying(true); } else if (recState === "paused") setPlaying(false); }, [recState]);
  const now = useClock(recorder?.busy ?? false);
  const offset = useRef(0);
  const view = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const speed = prompter?.speed ?? 4;
  // Rola em px/s proporcional à velocidade; para sozinho no fim do texto.
  useEffect(() => {
    if (!playing) return;
    let last = performance.now(), frame = 0, first = true;
    const tick = (now: number) => {
      const max = Math.max(0, (text.current?.scrollHeight ?? 0) - (view.current?.clientHeight ?? 0) / 2);
      // Tocar de novo no fim recomeça do início.
      if (first && offset.current >= max) offset.current = 0;
      first = false;
      offset.current = Math.min(max, offset.current + (now - last) / 1000 * speed * 9);
      last = now;
      if (text.current) text.current.style.transform = `translateY(${-offset.current}px)`;
      if (offset.current >= max) { setPlaying(false); return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed]);
  const restart = () => { offset.current = 0; if (text.current) text.current.style.transform = "translateY(0)"; };
  useEffect(() => {
    if (ghost) return;
    const key = (event: KeyboardEvent) => {
      if (editing || event.target instanceof Element && event.target.closest("input, textarea, select, button")) return;
      if (event.key === " ") { event.preventDefault(); setPlaying(value => !value); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [editing, ghost]);
  // Sem FFmpeg o Gravar abre as opções (com a instrução) em vez de contar.
  useEffect(() => { if (!ghost && recorder && !recorder.caps) recorder.loadCaps(); }, [ghost]); // eslint-disable-line react-hooks/exhaustive-deps
  // Erro some no ×; volta só se for outro. Novo início limpa.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const counting = recorder?.countdown != null;
  useEffect(() => { if (counting) setDismissed(null); }, [counting]);
  const error = recorder?.error && recorder.error !== dismissed ? recorder.error : null;
  // "Salvo em…" sai sozinho depois de 8 s.
  const lastFile = recorder?.state.lastFile ?? null;
  const [savedShown, setSavedShown] = useState<string | null>(null);
  useEffect(() => { if (!lastFile) return; setSavedShown(lastFile); const timer = window.setTimeout(() => setSavedShown(null), 8000); return () => window.clearTimeout(timer); }, [lastFile]);
  if (!notes || !prompter) return <div className="statement-page"><p className="context-note">Teleprompter indisponível.</p></div>;
  const wheel = (event: React.WheelEvent) => {
    event.stopPropagation(); // rola o texto, não troca de página
    offset.current = Math.max(0, offset.current + event.deltaY * .5);
    if (text.current) text.current.style.transform = `translateY(${-offset.current}px)`;
  };
  return <div className="prompter-page" data-editing={editing || undefined}>
    {editing
      ? <textarea className="prompter-editor hd-input" aria-label="Texto do teleprompter" placeholder="Cole ou escreva o roteiro aqui." autoFocus={!ghost} value={prompter.text} onChange={event => notes.setPrompter({ text: event.target.value })} />
      : <div className="prompter-view" ref={view} onWheel={wheel} onClick={() => setPlaying(value => !value)} data-mirror={prompter.mirror || undefined}>
          <div className="prompter-text" ref={text} style={{ fontSize: prompter.size }}>{prompter.text.trim() ? prompter.text : "Sem roteiro. Clique em editar."}</div>
        </div>}
    <div className="prompter-bar">
      <button type="button" className="prompter-button" aria-pressed={editing} aria-label={editing ? "Concluir edição" : "Editar texto"} title={editing ? "Concluir" : "Editar"} onClick={() => { setEditing(!editing); setPlaying(false); }}><Icon d={glyph.edit} /></button>
      <button type="button" className="prompter-button primary" aria-label={playing ? "Pausar" : "Rolar"} disabled={editing || !prompter.text.trim()} onClick={() => setPlaying(!playing)}><Icon d={playing ? glyph.pause : glyph.play} /></button>
      <button type="button" className="prompter-button" aria-label="Voltar ao início" title="Voltar ao início" disabled={editing} onClick={restart}><Icon d={glyph.restart} /></button>
      <label className="prompter-slider" title="Velocidade"><Icon d={glyph.turtle} size={13} /><input type="range" min="1" max="10" aria-label="Velocidade" style={{ ["--fill" as string]: `${(prompter.speed - 1) / 9 * 100}%` }} value={prompter.speed} onChange={event => notes.setPrompter({ speed: Number(event.target.value) })} /><Icon d={glyph.hare} size={13} /></label>
      <button type="button" className="prompter-button prompter-size" aria-pressed={prompter.size >= sizes.large} aria-label={prompter.size >= sizes.large ? "Fonte normal" : "Fonte grande"} title={prompter.size >= sizes.large ? "Fonte normal" : "Fonte grande"} onClick={() => notes.setPrompter({ size: prompter.size >= sizes.large ? sizes.normal : sizes.large })}>A<small>{prompter.size >= sizes.large ? "−" : "+"}</small></button>
      <button type="button" className="prompter-button" aria-pressed={prompter.mirror} aria-label="Espelhar" title="Espelhar (para vidro de teleprompter)" onClick={() => notes.setPrompter({ mirror: !prompter.mirror })}><Icon d={glyph.mirror} /></button>
      <button type="button" className="prompter-button" aria-pressed={panel === "opacity"} aria-label="Opacidade" title="Opacidade do painel" onClick={() => setPanel(panel === "opacity" ? "none" : "opacity")}><Icon d={glyph.opacity} /></button>
      {recorder && <span className="prompter-divider" />}
      {recorder && (recorder.busy
        ? <><span className="rec-time" data-paused={recorder.state.state === "paused" || undefined}><i />{clock(recordedMs(recorder.state, now))}</span>
            <button type="button" className="prompter-button" aria-label={recorder.state.state === "paused" ? "Continuar gravação" : "Pausar gravação"} onClick={recorder.pause}><Icon d={recorder.state.state === "paused" ? glyph.play : glyph.pauseRec} /></button>
            <button type="button" className="prompter-button rec-stop" aria-label="Parar gravação" onClick={recorder.stop}><Icon d={glyph.stop} /></button></>
        : <><button type="button" className="rec-button" data-counting={recorder.countdown != null || undefined} disabled={recorder.state.state === "saving"} aria-label={recorder.countdown != null ? "Cancelar contagem" : "Gravar tela"} onClick={() => { if (recorder.countdown == null && recorder.caps && !recorder.caps.ffmpeg) { setPanel("record"); return; } if (!recorder.caps) recorder.loadCaps(); recorder.start(); }}><i />{recorder.state.state === "saving" ? "Salvando…" : recorder.countdown != null ? `Cancelar · ${recorder.countdown}` : "Gravar"}</button>
            <button type="button" className="prompter-button" aria-pressed={recorder.camera} aria-label="Câmera em bolha" title="Câmera em bolha (entra na gravação)" onClick={recorder.toggleCamera}><Icon d={glyph.camera} /></button>
            <button type="button" className="prompter-button" aria-pressed={panel === "record"} aria-label="Opções de gravação" title="Opções de gravação" onClick={() => { recorder.loadCaps(); setPanel(panel === "record" ? "none" : "record"); }}><Icon d={glyph.gear} /></button></>)}
    </div>
    {panel === "opacity" && <div className="prompter-pop" role="dialog" aria-label="Opacidade"><span>Opacidade</span><input type="range" min="30" max="100" aria-label="Opacidade do painel" style={{ ["--fill" as string]: `${((prompter.opacity ?? 100) - 30) / 70 * 100}%` }} value={prompter.opacity ?? 100} onChange={event => notes.setPrompter({ opacity: Number(event.target.value) })} /><output>{prompter.opacity ?? 100}%</output></div>}
    {panel === "record" && recorder && <RecordOptions recorder={recorder} />}
    {error && <span className="rec-error" role="status" title={error}><span>{error}</span><button type="button" aria-label="Dispensar erro" title="Dispensar" onClick={() => setDismissed(error)}>×</button></span>}
    {!error && recorder && !recorder.busy && lastFile && savedShown === lastFile && panel === "none" && <span className="rec-last" title={lastFile}>Salvo em Vídeos\Heydesk · <button type="button" onClick={() => recorder.open(false)}>Abrir</button> · <button type="button" onClick={() => recorder.open(true)}>Mostrar na pasta</button></span>}
  </div>;
}

/** Alça na borda de baixo do notch: arrastar muda a altura do painel (200–420 px); grava ao soltar. */
export function PrompterGrip({ notes, onResize }: { notes: NotesControl; onResize(height: number | null): void }) {
  const prompter = notes.prompter;
  const grab = (event: React.PointerEvent) => {
    const startY = event.clientY, startHeight = prompter.height ?? 300;
    let height = startHeight;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    onResize(height); // já ao agarrar: a área do mouse se estende para baixo antes do primeiro movimento
    const move = (moveEvent: PointerEvent) => { height = Math.round(Math.min(420, Math.max(200, startHeight + moveEvent.clientY - startY))); onResize(height); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); onResize(null); notes.setPrompter({ height }); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  return <div className="prompter-grip" role="separator" aria-orientation="horizontal" aria-label="Arraste para aumentar ou reduzir" onPointerDown={grab}><i /></div>;
}

function useClock(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!active) return; const id = window.setInterval(() => setNow(Date.now()), 250); return () => window.clearInterval(id); }, [active]);
  return now;
}

function RecordOptions({ recorder }: { recorder: RecorderControl }) {
  const { caps, options } = recorder;
  if (caps && !caps.ffmpeg) return <div className="prompter-pop rec-pop" role="dialog" aria-label="Opções de gravação"><span>Instale o FFmpeg para gravar: <code>winget install Gyan.FFmpeg</code></span></div>;
  return <div className="prompter-pop rec-pop" role="dialog" aria-label="Opções de gravação">
    <label>Gravar<select value={options.source === "window" ? `w:${options.window ?? ""}` : options.monitor != null ? `m:${options.monitor}` : "m:"} onChange={event => { const [kind, value] = [event.target.value.slice(0, 1), event.target.value.slice(2)];
      recorder.setOptions(kind === "w" ? { source: "window", window: value } : { source: "screen", window: undefined, monitor: value === "" ? undefined : Number(value) }); }}>
      {/* Tela inteira: o principal por padrão; com mais de um monitor, cada um pelo nome. */}
      {(caps?.monitors?.length ?? 0) > 1 ? <><option value="m:">Tela principal</option>{caps!.monitors!.map((monitor, order) => <option key={monitor.index} value={`m:${monitor.index}`}>{`Tela ${order + 1}${monitor.primary ? " (principal)" : ""} · ${monitor.width}×${monitor.height}`}</option>)}</>
        : <option value="m:">Tela inteira</option>}
      {caps?.windows.map(title => <option key={title} value={`w:${title}`}>{title.length > 48 ? `${title.slice(0, 47)}…` : title}</option>)}</select></label>
    <label>Microfone<select value={options.microphone ?? ""} onChange={event => recorder.setOptions({ microphone: event.target.value })}><option value="">Sem microfone</option>{caps?.microphones.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
    <label>Fluidez<select value={options.fps ?? 30} onChange={event => recorder.setOptions({ fps: Number(event.target.value) })}><option value={30}>30 quadros/s</option><option value={60}>60 quadros/s (pede máquina forte)</option></select></label>
    {options.source !== "window" && <label>Resolução<select value={options.height ?? 0} onChange={event => recorder.setOptions({ height: Number(event.target.value) || undefined })}><option value={0}>Original da tela</option><option value={720}>720p (mais leve e fluido)</option></select></label>}
    <label className="rec-check"><input type="checkbox" checked={options.systemAudio} onChange={event => recorder.setOptions({ systemAudio: event.target.checked })} />Som do computador</label>
    <label className="rec-check"><input type="checkbox" checked={options.highlight !== false} onChange={event => recorder.setOptions({ highlight: event.target.checked })} />Realçar cursor e cliques</label>
    <label className="rec-check"><input type="checkbox" checked={options.showNotch === true} onChange={event => recorder.setOptions({ showNotch: event.target.checked })} />Mostrar o notch no vídeo</label>
    <span className="rec-hint">Atalhos: Ctrl+Alt+R grava/para · Ctrl+Alt+P pausa</span>
    <span className="rec-hint">{caps ? `Vídeo ${caps.encoder === "libx264" ? "por CPU" : "pela placa de vídeo"} · salva em Vídeos\\Heydesk` : "Carregando…"}</span>
  </div>;
}
