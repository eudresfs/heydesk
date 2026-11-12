import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { getExample } from "open-bot-avatar";
import { Mascot } from "../src/modules/context/Mascot";
import { parseAvatar } from "../src/modules/settings/AvatarGroup";

const dom = new Window({ url: "http://localhost" });
Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); });
async function render(element: React.ReactElement) {
  host = document.createElement("div") as unknown as HTMLDivElement;
  document.body.appendChild(host as unknown as Node);
  root = createRoot(host);
  await act(async () => root!.render(element));
  return host;
}

test("corpo do open-bot-avatar fica sob os olhos do Heydesk, na cor escolhida", async () => {
  const mug = getExample("mug")!;
  const node = await render(<Mascot expression="angry" active={false} reducedMotion avatar={{ definition: mug, color: "#30D158" }} />);
  const mascot = node.querySelector(".mascot")!;
  assert.equal(mascot.getAttribute("data-avatar"), "");
  assert.equal(mascot.getAttribute("data-expression"), "angry");
  const bodies = [...node.querySelectorAll("svg > g > path")];
  assert.ok(bodies.length > 0);
  assert.ok(bodies.every(path => path.getAttribute("fill")?.toLowerCase() === "#30d158"));
  // Olhos bravos do Heydesk (não as pílulas da lib) dentro do plano do rosto.
  assert.equal(node.querySelectorAll(".mascot-look .mascot-eye").length, 2);
});

test("imagem de tema vence o corpo; sem corpo, os olhos de sempre", async () => {
  const mug = getExample("mug")!;
  const node = await render(<Mascot expression="normal" active={false} reducedMotion image="data:image/png;base64,AA==" avatar={{ definition: mug, color: "#FF6A1A" }} />);
  assert.equal(node.querySelector(".mascot")!.hasAttribute("data-avatar"), false);
  assert.ok(node.querySelector("image.mascot-image"));
});

test("JSON importado passa pela validação da lib", () => {
  const mug = getExample("mug")!;
  const ok = parseAvatar("```json\n" + JSON.stringify(mug) + "\n```");
  assert.equal(ok.ok, true);
  assert.equal(parseAvatar("isso não é json").ok, false);
  const broken = parseAvatar(JSON.stringify({ ...mug, eyes: { ...mug.eyes, scale: 9 } }));
  assert.equal(broken.ok, false);
});
