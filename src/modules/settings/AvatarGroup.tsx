// Corpo do mascote (open-bot-avatar): galeria da lib, corpos do usuário, importar JSON, gerar com o
// Claude e o editor online. Os olhos continuam os do Heydesk, por cima do corpo escolhido.
import { useState } from "react";
import { examples, validateAvatar, type AvatarDefinition } from "open-bot-avatar";
import type { MascotSettings, ShellBridge } from "../../lib/shellBridge";
import { Mascot } from "../context/Mascot";
import { Group, Row } from "./sections";

const bodyColors = ["#FF6A1A", "#FFD60A", "#30D158", "#0A84FF", "#BF5AF2", "#FF375F", "#E5E5E5", "#8E8E93"];
const MAX_SAVED = 24;

/** JSON de fora (arquivo, colagem ou Claude) → definição aceita pela lib, ou a lista de erros. */
export function parseAvatar(text: string): { ok: true; value: AvatarDefinition } | { ok: false; error: string } {
  let json: unknown;
  try { json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { return { ok: false, error: "Não é um JSON válido." }; }
  const result = validateAvatar(json);
  return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.errors.slice(0, 2).join(" ") || "Corpo inválido." };
}

export function AvatarGroup({ bridge, mascot, onPick }: { bridge?: ShellBridge; mascot: MascotSettings; onPick(patch: Partial<MascotSettings>): void }) {
  const [status, setStatus] = useState<{ busy?: boolean; error?: string; note?: string }>({});
  const [description, setDescription] = useState("");
  const [paste, setPaste] = useState<string | null>(null);
  const saved = mascot.avatars ?? [];
  const color = mascot.avatarColor ?? "#FF6A1A";
  const active = mascot.avatar ?? null;
  const usable = (mascot.theme ?? "eyes") === "eyes";
  // Novo corpo entra na lista do usuário (mesmo id substitui) e já fica escolhido.
  const adopt = (avatar: AvatarDefinition, note: string) => {
    const list = [avatar, ...saved.filter(item => item.id !== avatar.id)].slice(0, MAX_SAVED);
    onPick({ avatar, avatars: list });
    setStatus({ note: `${note} Salve para aplicar no notch.` });
  };
  const take = (text: string, note: string) => {
    const parsed = parseAvatar(text);
    if (!parsed.ok) { setStatus({ error: parsed.error }); return false; }
    adopt(parsed.value, note);
    return true;
  };
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 64 * 1024) { setStatus({ error: "Arquivo grande demais para um mascote." }); return; }
    take(await file.text(), `“${file.name}” importado.`);
  };
  const generate = async () => {
    if (!bridge?.generateAvatar || !description.trim()) return;
    setStatus({ busy: true, note: "O Claude está desenhando… (até 2 min)" });
    try {
      const avatar = await bridge.generateAvatar(description);
      const parsed = parseAvatar(JSON.stringify(avatar));
      if (!parsed.ok) { setStatus({ error: `O Claude errou o formato: ${parsed.error}` }); return; }
      adopt(parsed.value, `“${parsed.value.name}” criado.`);
      setDescription("");
    } catch (reason) { setStatus({ error: typeof reason === "string" ? reason : "Não foi possível gerar o mascote." }); }
  };
  const remove = (id: string) => {
    onPick({ avatars: saved.filter(item => item.id !== id), ...(active?.id === id ? { avatar: null } : {}) });
    setStatus({ note: "Corpo removido. Salve para aplicar." });
  };
  const card = (avatar: AvatarDefinition | null, label: string, own = false) => {
    const pressed = avatar ? active?.id === avatar.id && active.body.path === avatar.body.path : !active;
    return <span key={`${own ? "u" : "g"}-${avatar?.id ?? "none"}`} className="set-avatar">
      <button type="button" className="set-option set-theme" aria-pressed={pressed} disabled={!usable} title={label} onClick={() => onPick({ avatar })}>
        <Mascot size="large" expression="normal" active={false} reducedMotion shape={mascot.eyeShape} avatar={avatar ? { definition: avatar, color } : null} />
        <span>{label}</span>
      </button>
      {own && <button type="button" className="set-avatar-remove" aria-label={`Remover ${label}`} onClick={() => remove(avatar!.id)}>×</button>}
    </span>;
  };
  return <Group title="Corpo do mascote">
    <Row title="Corpo" desc={usable ? <>Silhuetas do <b>open-bot-avatar</b> com os olhos do Heydesk por cima: expressões, piscadas e acessórios continuam valendo.</> : "Escolha o mascote “Olhos” em Tema para usar um corpo."} wide>
      <span className="set-options">
        {card(null, "Só olhos")}
        {examples.map(avatar => card(avatar, avatar.name))}
        {saved.map(avatar => card(avatar, avatar.name, true))}
      </span>
    </Row>
    <Row title="Cor do corpo">
      <span className="set-swatches">
        {bodyColors.map(swatch => <button key={swatch} type="button" className="set-swatch" disabled={!usable} style={{ ["--swatch" as string]: swatch }} aria-label={`Corpo ${swatch}`} aria-pressed={color.toUpperCase() === swatch} onClick={() => onPick({ avatarColor: swatch })} />)}
        <label className="set-swatch set-swatch-custom" title="Outra cor" data-active={!bodyColors.includes(color.toUpperCase()) || undefined}><input type="color" aria-label="Outra cor do corpo" disabled={!usable} value={color} onChange={event => onPick({ avatarColor: event.target.value.toUpperCase() })} /></label>
      </span>
    </Row>
    <Row title="Criar com o Claude" desc="Descreva um objeto, hobby ou profissão. Usa o Claude Code instalado e o seu login." wide>
      <span className="set-actions set-avatar-generate">
        <input type="text" className="set-input" maxLength={400} placeholder="ex.: um fone de ouvido, um gamer, uma xícara de café" value={description} disabled={status.busy}
          onChange={event => setDescription(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void generate(); }} />
        <button type="button" className="set-button" disabled={status.busy || !description.trim() || !bridge?.generateAvatar} onClick={() => void generate()}>{status.busy ? "Gerando…" : "Gerar"}</button>
      </span>
    </Row>
    <Row title="Importar ou desenhar" desc={status.error ? <span role="alert">{status.error}</span> : status.note ?? "JSON no formato do open-bot-avatar, de um arquivo ou colado. No editor online dá para desenhar e copiar o JSON."} wide>
      <span className="set-actions">
        <label className="set-button set-file">Abrir .json
          <input type="file" className="sr-only" accept=".json,application/json" aria-label="Importar corpo em JSON" onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ""; }} /></label>
        <button type="button" className="set-button" aria-expanded={paste !== null} onClick={() => setPaste(paste === null ? "" : null)}>Colar JSON</button>
        {bridge?.openAvatarEditor && <button type="button" className="set-button" onClick={() => void bridge.openAvatarEditor?.().catch(() => setStatus({ error: "Não foi possível abrir o navegador." }))}>Abrir editor online</button>}
      </span>
      {paste !== null && <span className="set-avatar-paste">
        <textarea className="set-input" rows={3} aria-label="JSON do corpo" placeholder='{"version":1,"id":"…","name":"…","body":{"path":"M…Z"},"eyes":{…}}' value={paste} onChange={event => setPaste(event.target.value)} />
        <button type="button" className="set-button" disabled={!paste.trim()} onClick={() => { if (take(paste, "Corpo colado.")) setPaste(null); }}>Usar</button>
      </span>}
    </Row>
  </Group>;
}
