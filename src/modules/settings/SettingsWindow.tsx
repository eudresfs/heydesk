// Configurações numa janela própria (aberta pela engrenagem do notch): menu de seções à
// esquerda e a seção à direita. Reaproveita as mesmas telas de preferência do painel.
// O que é salvo aqui chega ao notch pelo evento "settings:changed".
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createShellBridge } from "../../lib/shellBridge";
import { useSettings } from "../../hooks/useSettings";
import { ContextPages, type ContextPage } from "../context/ContextPages";
import { useContextSnapshots } from "../context/useContext";
import { useCalendars } from "../context/useCalendars";
import { useSports } from "../sports/useSports";
import { useNotes } from "../context/useNotes";
import { AppearanceSection, MascotSection, ModulesSection, PagesSection, SoundSection, WaterSection } from "./sections";

export const settingsSections: { page: ContextPage; label: string; hint: string }[] = [
  { page: "appearance", label: "Aparência", hint: "Opacidade, cor de destaque e movimento." },
  { page: "mascotPrefs", label: "Mascote", hint: "Olhos, brilho e reações." },
  { page: "soundPrefs", label: "Sons", hint: "Volume, estilo e quando tocar." },
  { page: "modules", label: "Módulos", hint: "O que o notch acompanha." },
  { page: "pagesPrefs", label: "Páginas", hint: "Quais páginas aparecem e em que ordem." },
  { page: "waterPrefs", label: "Água", hint: "Meta, gole, garrafa e quando lembrar." },
  { page: "sportsPrefs", label: "Esportes", hint: "Times e campeonatos seguidos." },
  { page: "calendarPrefs", label: "Agendas", hint: "Calendários por link ICS." },
];
// Esportes e Agendas salvam sozinhos; o resto usa o botão Salvar.
const selfSaving: ContextPage[] = ["sportsPrefs", "calendarPrefs", "waterPrefs"];
const pick = (value: string | null): ContextPage => settingsSections.find(section => section.page === value)?.page ?? "appearance";

export function SettingsWindow() {
  const bridge = useMemo(createShellBridge, []);
  const settings = useSettings(bridge);
  const ready = settings.loadState === "ready";
  const sports = useSports(bridge, ready);
  const calendars = useCalendars(bridge);
  const notes = useNotes(bridge);
  const context = useContextSnapshots(bridge, false, settings.saved.modules);
  const [section, setSection] = useState<ContextPage>(() => pick(new URLSearchParams(location.search).get("section")));
  // A engrenagem do notch com a janela já aberta só troca de seção.
  useEffect(() => {
    if (!bridge.onDesktopEvent) return;
    let stop: (() => void) | undefined, alive = true;
    void bridge.onDesktopEvent("settings:section", payload => setSection(pick(String(payload)))).then(fn => { if (alive) stop = fn; else fn(); });
    return () => { alive = false; stop?.(); };
  }, [bridge]);
  const current = settingsSections.find(item => item.page === section)!;
  const saves = !selfSaving.includes(section);
  const status = settings.loadState === "error" ? "Não foi possível carregar as configurações."
    : settings.saveState === "saving" ? "Salvando…" : settings.saveState === "error" ? "Não foi possível salvar."
    : settings.saveState === "saved" && !settings.dirty ? "Salvo." : settings.dirty ? "Alterações não salvas." : "";
  const submit = (event: FormEvent) => { event.preventDefault(); if (settings.dirty) void settings.save(); };
  // Cor de destaque do rascunho também na própria janela (switches, Salvar).
  const accent = /^#[0-9a-f]{6}$/i.test(settings.draft.appearance.accentColor) && settings.draft.appearance.accentColor.toUpperCase() !== "#EB0028" ? settings.draft.appearance.accentColor : "#E5E5E5";
  const light = (([r, g, b]) => .2126 * r + .7152 * g + .0722 * b)([1, 3, 5].map(i => parseInt(accent.slice(i, i + 2), 16))) > 150;
  return <div className="settings-window" style={{ ["--primary" as string]: accent, ["--on-primary" as string]: light ? "#171717" : "#ffffff" }}>
    <nav className="settings-nav" aria-label="Seções das configurações">
      <span className="settings-brand">Heydesk</span>
      {settingsSections.map(item => <button key={item.page} type="button" aria-current={item.page === section ? "page" : undefined} onClick={() => setSection(item.page)}>{item.label}</button>)}
    </nav>
    <form className="settings-main" onSubmit={submit}>
      <header><h1>{current.label}</h1><p>{current.hint}</p></header>
      <div className="settings-body" key={section}>
        {settings.loadState === "loading" ? <p className="settings-status">Carregando…</p>
          : <fieldset className="set-fieldset" disabled={!ready && !selfSaving.includes(section)}>
            {section === "appearance" ? <AppearanceSection settings={settings} />
              : section === "mascotPrefs" ? <MascotSection settings={settings} />
              : section === "soundPrefs" ? <SoundSection settings={settings} />
              : section === "modules" ? <ModulesSection settings={settings} />
              : section === "pagesPrefs" ? <PagesSection settings={settings} />
              : section === "waterPrefs" ? <WaterSection notes={notes} />
              : <div className="set-legacy"><ContextPages page={section} bridge={bridge} settings={settings} context={context} editable={ready} setColorPickerActive={() => {}} sports={sports} calendars={calendars} /></div>}
          </fieldset>}
      </div>
      {saves && <footer className="settings-footer">
        <span role={settings.saveState === "error" || settings.loadState === "error" ? "alert" : "status"}>{status}</span>
        {settings.loadState === "error"
          ? <button type="button" className="text-button" onClick={() => void settings.load()}>Tentar novamente</button>
          : <>
            <button type="button" className="text-button" disabled={!settings.dirty} onClick={() => settings.edit(settings.saved)}>Descartar</button>
            <button type="submit" className="save-button" disabled={!ready || !settings.dirty || settings.saveState === "saving"}>Salvar</button>
          </>}
      </footer>}
    </form>
  </div>;
}

