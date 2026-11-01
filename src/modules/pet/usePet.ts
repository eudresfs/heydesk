// Liga o bichinho ao notch: barras atuais (calculadas, sem gravar), humor, nível e as
// ações da página. Só a janela principal usa; configurações e PiP não simulam nada.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MascotExpression } from "../context/Mascot";
import type { NotesControl } from "../context/useNotes";
import type { MascotReaction } from "../context/useMascotTouch";
import type { SoundKind } from "../sound/sounds";
import { dayKey, levelFloor, levelOf, petMood, project, stageOf, windowOf, type PetEvent, type PetGain } from "./petSim";

export function usePet(notes: NotesControl, { enabled, now, react, play }: {
  enabled: boolean; now: number;
  react(expression: MascotExpression, kind: MascotReaction["kind"] | null, ms: number): void;
  play(kind: SoundKind): void;
}) {
  const window = windowOf(notes.water);
  const view = useMemo(() => project(notes.pet, window, now), [notes.pet, now, window.startMin, window.endMin, window.days.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const mood = petMood(view);
  const level = levelOf(view.xp);
  const [lastGain, setLastGain] = useState<{ gain: PetGain; key: number } | null>(null);
  // Virada do dia: grava uma vez (zera os contadores e fecha a sequência de ontem).
  const savedDay = useRef("");
  const today = dayKey(now);
  useEffect(() => {
    if (!enabled || notes.state !== "ready" || notes.pet.daily.date === today || savedDay.current === today) return;
    savedDay.current = today;
    notes.setPet(project(notes.pet, windowOf(notes.water), Date.now()));
  }, [enabled, notes.state, today]); // eslint-disable-line react-hooks/exhaustive-deps
  const event = useCallback((input: PetEvent) => {
    if (!enabled || notes.state === "loading") return null;
    const gain = notes.petEvent(input);
    if (gain.xp || gain.coins || gain.capped) setLastGain({ gain, key: Date.now() });
    if (gain.levelUp) { play("goal"); react("laugh", "giggle", 1400); }
    return gain;
  }, [enabled, notes, play, react]);
  return {
    enabled, view, mood, level, stage: stageOf(level),
    /** Progresso até o próximo nível (0–1). */
    progress: Math.min(1, (view.xp - levelFloor(level)) / Math.max(1, levelFloor(level + 1) - levelFloor(level))),
    lastGain, event,
    /** Alimentar = registrar um gole (a água já credita o bichinho). */
    feed: () => { if (!enabled) return; notes.drink(); react("happy", "giggle", 900); setLastGain({ gain: { xp: 5, coins: 2, levelUp: false }, key: Date.now() }); },
    pet: () => { react("happy", "giggle", 1100); event({ kind: "petting" }); },
  };
}
export type PetControl = ReturnType<typeof usePet>;
