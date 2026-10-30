import { useCallback, useEffect, useRef, useState } from "react";
import { defaultSettings, type AppSettings, type ShellBridge } from "../lib/shellBridge";

export function useSettings(bridge: ShellBridge) {
  const [saved, setSaved] = useState(defaultSettings);
  const [draft, setDraft] = useState(defaultSettings);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(bridge.desktop ? "loading" : "ready");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const active = useRef(false);
  const revision = useRef(0);
  const loadRequest = useRef(0);
  const saving = useRef(false);

  const load = useCallback(async () => {
    if (!bridge.desktop) return;
    const request = ++loadRequest.current;
    setLoadState("loading");
    try {
      const settings = await bridge.loadSettings();
      if (!active.current || request !== loadRequest.current) return;
      revision.current++;
      setSaved(settings);
      setDraft(settings);
      setLoadState("ready");
      setSaveState("idle");
    } catch {
      if (active.current && request === loadRequest.current) setLoadState("error");
    }
  }, [bridge]);

  useEffect(() => {
    active.current = true;
    void load();
    return () => { active.current = false; loadRequest.current++; };
  }, [load]);
  // Salvo em outra janela (configurações ↔ notch): adota o novo; edição em curso aqui fica.
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (!bridge.onDesktopEvent) return;
    let stop: (() => void) | undefined, alive = true;
    void bridge.onDesktopEvent("settings:changed", payload => {
      const settings = payload as AppSettings;
      setSaved(settings);
      if (!dirtyRef.current) { revision.current++; setDraft(settings); }
    }).then(fn => { if (alive) stop = fn; else fn(); });
    return () => { alive = false; stop?.(); };
  }, [bridge]);

  function edit(settings: AppSettings) {
    revision.current++;
    setDraft(settings);
    setSaveState(previous => previous === "saving" ? previous : "idle");
  }

  async function save() {
    if (!bridge.desktop || loadState !== "ready" || saving.current) return;
    const submittedRevision = revision.current;
    saving.current = true;
    setSaveState("saving");
    try {
      const settings = await bridge.saveSettings(draft);
      if (!active.current) return;
      setSaved(settings);
      if (submittedRevision === revision.current) {
        setDraft(settings);
        setSaveState("saved");
      } else setSaveState("idle");
    } catch {
      if (active.current) setSaveState("error");
    } finally { saving.current = false; }
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  dirtyRef.current = dirty;
  return { saved, draft, edit, dirty, loadState, saveState, load, save };
}
