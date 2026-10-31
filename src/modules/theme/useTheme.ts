// Tema ativo do mascote: imagens por humor, fonte, sons, cores e textos de um pacote
// (embutido ou importado). "eyes" é o padrão e não carrega nada: ficam os olhos vetoriais.
import { useEffect, useState } from "react";
import type { ShellBridge, ThemeBundle, ThemeMood } from "../../lib/shellBridge";
import type { MascotExpression } from "../context/Mascot";
import { audioContext, type SoundKind } from "../sound/sounds";

export interface ActiveTheme {
  id: string;
  images: Partial<Record<ThemeMood, string>> | null;
  pixelated: boolean;
  fontFamily?: string;
  colors?: { ground?: string; accent?: string; text?: string };
  /** Brilho do próprio tema; em tema com HUD substitui o brilho escolhido em Aparência. */
  glow?: [string, string, string];
  copy?: { water?: string[]; mapFor?: string };
  sounds: Map<SoundKind, AudioBuffer>;
  /** Visual do notch; imagens já como data: URL. */
  hud?: {
    surface?: string; text?: string; muted?: string; accent?: string; border?: string; frame?: string; frameSlice: number; panel?: string;
    texture?: string; textureOpacity: number; corner?: string; crest?: string; bevel: boolean; shimmer: boolean; panelOpacity: number;
    /** Filetes que seguem o formato do notch, de fora para dentro. */
    lines: { color: string; inset: number; width: number; glow: boolean }[];
  };
}

/** Variáveis CSS do HUD do tema (vazio: visual padrão). Superfícies derivam da cor do notch. */
export function hudStyle(hud: ActiveTheme["hud"]): Record<string, string> {
  if (!hud) return {};
  const vars: Record<string, string> = {};
  if (hud.surface) {
    // Superfícies internas ficam no mesmo tom do notch, só um pouco mais claras; os cartões
    // ganham um degradê da cor do tema em vez do cinza padrão.
    vars["--island-fill"] = hud.surface;
    vars["--surface-1"] = `color-mix(in srgb, ${hud.surface} 94%, white)`;
    vars["--surface-2"] = `color-mix(in srgb, ${hud.surface} 89%, white)`;
    vars["--surface-3"] = `color-mix(in srgb, ${hud.surface} 82%, white)`;
    vars["--card-a"] = `color-mix(in srgb, ${hud.surface} 86%, ${hud.accent ?? "white"})`;
    vars["--card-b"] = `color-mix(in srgb, ${hud.surface} 80%, black)`;
    // Capa vazia do player: tom do tema com um anel discreto da cor de destaque.
    vars["--art-bg"] = `color-mix(in srgb, ${hud.surface} 76%, ${hud.accent ?? "white"})`;
    if (hud.accent) vars["--art-ring"] = `inset 0 0 0 1px color-mix(in srgb, ${hud.accent} 35%, transparent)`;
  }
  // Textos secundários mais fortes que no tema padrão: a textura atrás pede contraste.
  if (hud.text) { vars["--text"] = hud.text; vars["--text-muted"] = hud.muted ?? `color-mix(in srgb, ${hud.text} 72%, transparent)`; vars["--text-faint"] = `color-mix(in srgb, ${hud.muted ?? hud.text} 62%, transparent)`; }
  else if (hud.muted) vars["--text-muted"] = hud.muted;
  if (hud.accent) vars["--primary"] = hud.accent;
  if (hud.border) { vars["--island-stroke"] = hud.border; vars["--ring"] = `0 0 0 1px color-mix(in srgb, ${hud.border} 55%, transparent)`; }
  if (hud.frame) { vars["--hud-frame"] = `url("${hud.frame}")`; vars["--hud-slice"] = String(hud.frameSlice); }
  if (hud.corner) vars["--hud-corner"] = `url("${hud.corner}")`;
  if (hud.crest) vars["--hud-crest"] = `url("${hud.crest}")`;
  if (hud.texture) vars["--hud-texture-opacity"] = String(hud.textureOpacity);
  if (hud.panel) vars["--hud-panel-opacity"] = String(hud.panelOpacity);
  return vars;
}

export const emptyTheme: ActiveTheme = { id: "eyes", images: null, pixelated: false, sounds: new Map() };

// Qual imagem cada expressão usa; a primeira que o tema tiver vence.
const fallbacks: Record<MascotExpression, ThemeMood[]> = {
  normal: ["calm"], wide: ["wide", "calm"], happy: ["happy"], sleep: ["sleep", "sleepy"], worried: ["worried", "calm"],
  sleepy: ["sleepy"], yawn: ["sleepy"], wink: ["wink", "happy"], laugh: ["laugh", "happy"], angry: ["angry"],
};
/** Imagem do tema para a expressão (undefined: tema sem imagens, usa os olhos). */
export function moodImage(expression: MascotExpression, images: ActiveTheme["images"]) {
  if (!images) return undefined;
  for (const mood of fallbacks[expression] ?? ["calm"]) { const image = images[mood]; if (image) return image; }
  return images.calm;
}

const bytes = (base64: string) => Uint8Array.from(atob(base64), c => c.charCodeAt(0));
const fontStack = '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';

const cache = new Map<string, Promise<ActiveTheme>>();
const fonts = new Map<string, FontFace>();

async function resolve(bundle: ThemeBundle): Promise<ActiveTheme> {
  const { manifest } = bundle;
  let fontFamily: string | undefined;
  if (bundle.font && typeof FontFace !== "undefined" && typeof document !== "undefined") {
    const name = `heydesk-theme-${bundle.id}`;
    try {
      const face = fonts.get(name) ?? new FontFace(name, bytes(bundle.font.base64));
      if (!fonts.has(name)) { await face.load(); document.fonts.add(face); fonts.set(name, face); }
      fontFamily = `"${name}", ${fontStack}`;
    } catch { /* fonte quebrada: fica a do sistema */ }
  }
  const sounds = new Map<SoundKind, AudioBuffer>();
  const ctx = Object.keys(bundle.sounds).length ? audioContext() : null;
  if (ctx) await Promise.all(Object.entries(bundle.sounds).map(async ([kind, blob]) => {
    try { sounds.set(kind as SoundKind, await ctx.decodeAudioData(bytes(blob.base64).buffer)); } catch { /* fica o som sintetizado */ }
  }));
  const colors = manifest.colors ? { ground: manifest.colors.ground ?? undefined, accent: manifest.colors.accent ?? undefined, text: manifest.colors.text ?? undefined } : undefined;
  const copy = manifest.copy ? { water: manifest.copy.water ?? undefined, mapFor: manifest.copy.mapFor ?? undefined } : undefined;
  const images = Object.keys(bundle.images).length ? bundle.images : null;
  const source = manifest.hud;
  const hud = source ? {
    surface: source.surface ?? undefined, text: source.text ?? undefined, muted: source.muted ?? undefined, accent: source.accent ?? undefined, border: source.border ?? undefined,
    frame: bundle.hud?.frame, frameSlice: source.frameSlice ?? 16, panel: bundle.hud?.panel,
    texture: bundle.hud?.texture, textureOpacity: source.textureOpacity ?? .5, corner: bundle.hud?.corner, crest: bundle.hud?.crest,
    bevel: source.bevel === true, shimmer: source.shimmer === true, panelOpacity: source.panelOpacity ?? .38,
    lines: (source.lines ?? []).slice(0, 3).map(line => ({ color: line.color, inset: line.inset, width: line.width, glow: line.glow === true })),
  } : undefined;
  return { id: bundle.id, images, pixelated: manifest.images?.pixelated !== false, fontFamily, colors, glow: manifest.colors?.glow ?? undefined, copy, sounds, hud };
}

/** Carrega o tema `id`; enquanto carrega (ou se falhar) devolve o tema vazio. */
export function useTheme(bridge: ShellBridge, id: string | undefined) {
  const [theme, setTheme] = useState<ActiveTheme>(emptyTheme);
  useEffect(() => {
    if (!id || id === "eyes" || !bridge.themeRead) { setTheme(emptyTheme); return; }
    let active = true;
    let pending = cache.get(id);
    if (!pending) {
      pending = bridge.themeRead(id).then(resolve);
      cache.set(id, pending);
      pending.catch(() => cache.delete(id));
    }
    pending.then(next => { if (active) setTheme(next); }).catch(() => { if (active) setTheme(emptyTheme); });
    return () => { active = false; };
  }, [bridge, id]);
  return theme;
}

/** Título do lembrete de água pelo tema: uma linha por nível (0–2; o 3 usa a última). */
export function themeWater<T extends { title: string }>(copy: T, level: number, lines?: string[]): T {
  const line = lines?.length ? lines[Math.min(level, lines.length - 1)] : undefined;
  return line ? { ...copy, title: line } : copy;
}

/** Tema importado de novo (mesmo id): esquece o que estava em memória. */
export function forgetTheme(id: string) { cache.delete(id); }
