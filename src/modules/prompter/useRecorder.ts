// Gravação de tela (FFmpeg no Rust): opções, contagem 3-2-1, pausar e parar.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ShellBridge } from "../../lib/shellBridge";

/** Monitor na ordem do Windows Graphics Capture (`index` = monitor_idx do FFmpeg). */
export interface RecorderMonitor { index: number; primary: boolean; width: number; height: number }
export interface RecorderCapabilities { ffmpeg: string | null; encoder: string | null; microphones: string[]; windows: string[]; monitors?: RecorderMonitor[] }
export interface RecorderState { state: "idle" | "recording" | "paused" | "saving" | "error"; elapsedMs: number; at: number; lastFile: string | null; error: string | null }
/** `monitor` ausente = o principal; `height` (ex.: 720) reduz a tela; `showNotch` deixa o notch aparecer no vídeo. */
export interface RecorderOptions { source: "screen" | "window"; window?: string; monitor?: number; height?: number; microphone?: string; systemAudio: boolean; fps?: number; highlight?: boolean; showNotch?: boolean }

const idle: RecorderState = { state: "idle", elapsedMs: 0, at: 0, lastFile: null, error: null };
const OPTIONS_KEY = "heydesk:recorder-options";
function loadOptions(): RecorderOptions {
  try { const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "null"); if (saved?.source) return saved; } catch { /* sem armazenamento */ }
  return { source: "screen", systemAudio: true };
}

export function useRecorder(bridge: ShellBridge) {
  const [state, setState] = useState<RecorderState>(idle);
  const [caps, setCaps] = useState<RecorderCapabilities | null>(null);
  const [options, setOptionsState] = useState<RecorderOptions>(loadOptions);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);
  const timer = useRef<number>();
  useEffect(() => {
    void bridge.recorderState?.().then(setState).catch(() => {});
    if (!bridge.onDesktopEvent) return;
    let stop: (() => void) | undefined, active = true;
    void bridge.onDesktopEvent("recorder:state", payload => setState(payload as RecorderState)).then(fn => { if (active) stop = fn; else fn(); });
    return () => { active = false; stop?.(); };
  }, [bridge]);
  // A bolha fechada por fora (× nela ou janela destruída) desliga o botão.
  useEffect(() => {
    if (!bridge.onDesktopEvent) return;
    let stop: (() => void) | undefined, active = true;
    void bridge.onDesktopEvent("camera:closed", () => setCamera(false)).then(fn => { if (active) stop = fn; else fn(); });
    return () => { active = false; stop?.(); };
  }, [bridge]);
  const loadCaps = useCallback(() => { void bridge.recorderCapabilities?.().then(value => {
    setCaps(value);
    // Primeira vez: usa o primeiro microfone encontrado.
    setOptionsState(current => current.microphone === undefined && value.microphones[0] ? { ...current, microphone: value.microphones[0] } : current);
  }).catch(() => {}); }, [bridge]);
  const setOptions = (patch: Partial<RecorderOptions>) => setOptionsState(current => {
    const next = { ...current, ...patch };
    try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(next)); } catch { /* ignora */ }
    return next;
  });
  const fail = (value: unknown) => setError(String((value as Error)?.message ?? value));
  /** Contagem 3-2-1 e então grava. Chamar de novo durante a contagem cancela. */
  const start = () => {
    if (countdown != null) { window.clearInterval(timer.current); setCountdown(null); void bridge.countdownOverlay?.(false).catch(() => {}); return; }
    // Novo início limpa o erro anterior (o local e o que veio do Rust).
    setError(null); setState(current => current.state === "error" ? { ...current, state: "idle", error: null } : current);
    // Durante a contagem: lista os microfones (e o Rust aquece a captura pela GPU).
    // Sem escolha salva, grava com o primeiro microfone, mesmo sem abrir as opções.
    const ready = (bridge.recorderCapabilities?.() ?? Promise.resolve(null)).catch(() => null);
    let left = 3;
    setCountdown(left);
    void bridge.countdownOverlay?.(true).catch(() => {});
    timer.current = window.setInterval(() => {
      left -= 1;
      if (left > 0) { setCountdown(left); return; }
      window.clearInterval(timer.current);
      setCountdown(null);
      void bridge.countdownOverlay?.(false).catch(() => {});
      void ready.then(found => {
        if (found) setCaps(found);
        const microphone = options.microphone ?? found?.microphones[0];
        if (microphone !== options.microphone) setOptions({ microphone });
        return bridge.recorderStart?.({ ...options, microphone });
      }).then(next => { if (next) setState(next); }).catch(fail);
    }, 1000);
  };
  const control = (action: "pause" | "resume" | "stop") => { bridge.recorderControl?.(action).then(setState).catch(fail); };
  useEffect(() => () => window.clearInterval(timer.current), []);
  const busy = state.state === "recording" || state.state === "paused";
  // Realce de cursor e cliques: liga com a gravação (se escolhido) e desliga ao parar.
  const highlight = busy && options.highlight !== false;
  useEffect(() => { void bridge.cursorOverlay?.(highlight).catch(() => {}); }, [bridge, highlight]);
  // Atalhos globais (Rust): Ctrl+Alt+R grava/para, Ctrl+Alt+P pausa/continua.
  const latest = useRef({ busy, start, control, paused: state.state === "paused" });
  latest.current = { busy, start, control, paused: state.state === "paused" };
  useEffect(() => {
    if (!bridge.onDesktopEvent) return;
    let stop: (() => void) | undefined, active = true;
    void bridge.onDesktopEvent("recorder:hotkey", payload => {
      const now = latest.current;
      if (payload === "toggle") { if (now.busy) now.control("stop"); else now.start(); }
      else if (payload === "pause" && now.busy) now.control(now.paused ? "resume" : "pause");
    }).then(fn => { if (active) stop = fn; else fn(); });
    return () => { active = false; stop?.(); };
  }, [bridge]);
  return {
    state, caps, options, countdown, error: error ?? (state.state === "error" ? state.error : null), busy,
    loadCaps, setOptions, start,
    toggle: () => busy ? control("stop") : start(),
    pause: () => control(state.state === "paused" ? "resume" : "pause"),
    stop: () => control("stop"),
    camera,
    toggleCamera: () => { bridge.cameraBubble?.(!camera).then(setCamera).catch(fail); },
    open: (reveal: boolean) => { if (state.lastFile) bridge.recorderOpen?.(state.lastFile, reveal).catch(fail); },
  };
}
export type RecorderControl = ReturnType<typeof useRecorder>;

/** Tempo gravado agora (o Rust manda o acumulado e o instante). */
export function recordedMs(state: RecorderState, now: number) {
  return state.state === "recording" ? state.elapsedMs + Math.max(0, now - state.at) : state.elapsedMs;
}
export const clock = (ms: number) => { const total = Math.floor(ms / 1000); const hours = Math.floor(total / 3600); const rest = `${String(Math.floor(total / 60) % 60).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`; return hours ? `${hours}:${rest}` : rest; };
