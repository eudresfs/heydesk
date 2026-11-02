// Liga o bichinho ao notch: barras atuais (calculadas, sem gravar), humor, nível e as
// ações da página. Só a janela principal usa; configurações e PiP não simulam nada.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MascotExpression } from "../context/Mascot";
import type { NotesControl } from "../context/useNotes";
import type { MascotReaction } from "../context/useMascotTouch";
import type { SoundKind } from "../sound/sounds";
import { dayKey, levelFloor, levelOf, periodAt, petMood, project, stageOf, windowOf, type PetEvent, type PetGain } from "./petSim";
export type { PetGain };

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
  // Só com as notas lidas (com erro de leitura, gravar apagaria nota, tarefas e água).
  const ready = notes.state === "ready" || notes.state === "saving";
  const celebrate = useCallback((gain: PetGain) => {
    if (gain.xp || gain.coins || gain.capped) setLastGain({ gain, key: Date.now() });
    // Reação sem "giggle": o efeito que transforma giggle em carinho não deve contar isto.
    if (gain.levelUp) { play("goal"); react("laugh", null, 1400); }
  }, [play, react]);
  const event = useCallback((input: PetEvent) => {
    if (!enabled || !ready) return null;
    const gain = notes.petEvent(input);
    celebrate(gain);
    return gain;
  }, [enabled, ready, notes, celebrate]);
  return {
    enabled, view, mood, level, stage: stageOf(level),
    /** Dentro do horário de trabalho (o rosto de "crítico" só aparece nele). */
    working: periodAt(now, window) === "work",
    /** Progresso até o próximo nível (0–1). */
    progress: Math.min(1, (view.xp - levelFloor(level)) / Math.max(1, levelFloor(level + 1) - levelFloor(level))),
    lastGain, event,
    /** "Bebi um copo": registra um gole de verdade na água; o ganho mostrado é o real. */
    feed: () => { if (!enabled || !ready) return; const gain = notes.drink(); react("happy", null, 900); celebrate(gain); },
    /** O carinho em si vem do efeito que observa a reação "giggle" (o mesmo do toque no mascote). */
    pet: () => { react("happy", "giggle", 1100); },
  };
}
export type PetControl = ReturnType<typeof usePet>;
