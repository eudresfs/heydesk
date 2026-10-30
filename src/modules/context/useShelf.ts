// Prateleira: arquivos enviados do celular pela rede local (QR code). O Rust guarda e serve.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ShellBridge } from "../../lib/shellBridge";

export interface ShelfItem { id: string; name: string; size: number; addedAt: number }
export interface ReceiveInfo { url: string; qrSize: number; qr: string; expiresAt: number }

export function useShelf(bridge: ShellBridge, onReceived?: (item: ShelfItem) => void) {
  const [dragging, setDragging] = useState(false);
  const [items, setItems] = useState<ShelfItem[]>([]);
  const [receive, setReceive] = useState<ReceiveInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const received = useRef(onReceived);
  received.current = onReceived;
  const refresh = useCallback(() => {
    void bridge.shelfList?.().then(setItems).catch(() => {});
    void bridge.shelfReceiveStatus?.().then(setReceive).catch(() => {});
  }, [bridge]);
  useEffect(() => {
    refresh();
    if (!bridge.onDesktopEvent) return;
    let unlisten: (() => void) | undefined, active = true;
    // O evento traz o item novo, ou nada quando a sessão de recebimento termina.
    void bridge.onDesktopEvent("shelf:changed", payload => {
      refresh();
      if (payload && typeof payload === "object" && "id" in payload) received.current?.(payload as ShelfItem);
    }).then(stop => { if (active) unlisten = stop; else stop(); });
    return () => { active = false; unlisten?.(); };
  }, [bridge, refresh]);
  const fail = (value: unknown) => setError(String((value as Error)?.message ?? value));
  return {
    items, receive, error, dragging, setDragging, bridge,
    start: () => { setError(null); bridge.shelfReceiveStart?.().then(setReceive).catch(fail); },
    stop: () => { setReceive(null); void bridge.shelfReceiveStop?.(); },
    open: (id: string) => { bridge.shelfOpen?.(id).catch(fail); },
    reveal: (id: string) => { bridge.shelfReveal?.(id).catch(fail); },
    remove: (id: string) => { bridge.shelfRemove?.(id).then(setItems).catch(fail); },
    /** Do seletor de arquivos (passa pela memória) ou arrastados (copiados do disco). */
    addFiles: (files: File[]) => { setError(null); files.reduce((chain, file) => chain.then(() => bridge.shelfAdd?.(file).then(() => {})), Promise.resolve()).catch(fail); },
    drag: (id: string) => { bridge.shelfDrag?.(id).catch(fail); },
    addPaths: (paths: string[]) => { setError(null); bridge.shelfAddPaths?.(paths).catch(fail); },
  };
}
export type ShelfControl = ReturnType<typeof useShelf>;

/** Miniatura do Windows por item, buscada uma vez. */
const thumbCache = new Map<string, Promise<string | null>>();
export function useThumbnail(bridge: ShellBridge | undefined, id: string) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!bridge?.shelfThumbnail) return;
    let active = true;
    if (!thumbCache.has(id)) thumbCache.set(id, bridge.shelfThumbnail(id).catch(() => null));
    void thumbCache.get(id)!.then(value => { if (active) setSrc(value); });
    return () => { active = false; };
  }, [bridge, id]);
  return src;
}
export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
  return `${(bytes / 1024 ** 3).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} GB`;
}
export const extension = (name: string) => (name.includes(".") ? name.split(".").pop()! : "").slice(0, 4).toUpperCase() || "ARQ";
