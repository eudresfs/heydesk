// Sons do Heydesk, sintetizados na hora (Web Audio): nada de arquivos de terceiros.
// Cada som é uma sequência curta de notas; o pacote muda timbre e envelope.
export type SoundPack = "soft" | "retro" | "minimal";
export type SoundKind = "notification" | "reminder" | "goal" | "kickoff" | "charger" | "unplug" | "warn" | "open" | "close" | "tap" | "giggle" | "track" | "confirm";
export type SoundCategory = "notifications" | "reminders" | "sports" | "interactions";

export const soundCategory: Record<SoundKind, SoundCategory> = {
  notification: "notifications", warn: "notifications", charger: "notifications", unplug: "notifications", track: "notifications",
  reminder: "reminders", confirm: "reminders",
  goal: "sports", kickoff: "sports",
  open: "interactions", close: "interactions", tap: "interactions", giggle: "interactions",
};

// Notas em semitons acima de A4 (440 Hz), duração em ms.
const melodies: Record<SoundKind, [number, number][]> = {
  notification: [[7, 90], [12, 140]],
  reminder: [[0, 110], [4, 110], [7, 200]],
  goal: [[0, 80], [4, 80], [7, 80], [12, 260]],
  kickoff: [[5, 120], [9, 180]],
  charger: [[0, 90], [7, 160]],
  unplug: [[7, 90], [0, 160]],
  warn: [[3, 140], [-2, 220]],
  open: [[12, 50]],
  close: [[7, 50]],
  tap: [[16, 40]],
  giggle: [[14, 50], [17, 50], [21, 70]],
  track: [[9, 70], [14, 120]],
  confirm: [[7, 70], [14, 140]],
};

const packs: Record<SoundPack, { wave: OscillatorType; attack: number; release: number; gap: number; level: number; octave: number }> = {
  soft: { wave: "sine", attack: .012, release: .16, gap: .02, level: .6, octave: 0 },
  retro: { wave: "square", attack: .002, release: .05, gap: .01, level: .22, octave: 0 },
  minimal: { wave: "triangle", attack: .004, release: .08, gap: .015, level: .45, octave: 12 },
};

let context: AudioContext | null = null;
function audio() {
  if (typeof window === "undefined" || typeof window.AudioContext === "undefined") return null;
  context ??= new AudioContext();
  if (context.state === "suspended") void context.resume().catch(() => {});
  return context;
}

/** Toca um som do pacote, no volume 0–100. Silencioso se o áudio não estiver disponível. */
export function playSound(kind: SoundKind, pack: SoundPack, volume: number) {
  const ctx = audio();
  if (!ctx || volume <= 0) return;
  const style = packs[pack] ?? packs.soft;
  const master = ctx.createGain();
  master.gain.value = Math.min(1, volume / 100) * style.level * .5;
  master.connect(ctx.destination);
  let at = ctx.currentTime + .01;
  for (const [semitone, ms] of melodies[kind]) {
    const oscillator = ctx.createOscillator(), gain = ctx.createGain(), length = ms / 1000;
    oscillator.type = style.wave;
    oscillator.frequency.value = 440 * Math.pow(2, (semitone + style.octave) / 12);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(1, at + style.attack);
    gain.gain.exponentialRampToValueAtTime(.0008, at + length + style.release);
    oscillator.connect(gain).connect(master);
    oscillator.start(at);
    oscillator.stop(at + length + style.release + .02);
    at += length + style.gap;
  }
  window.setTimeout(() => master.disconnect(), (at - ctx.currentTime + .5) * 1000);
}
