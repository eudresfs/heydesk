import { strict as assert } from "node:assert";
import { test } from "node:test";
import { WheelPaging } from "../src/modules/navigation/wheelPaging";

test("touchpad acumula movimento sem transformar ruído em troca de página", () => {
  const wheel = new WheelPaging();
  for (let n = 0; n < 8; n++) assert.equal(wheel.accept(10, 0, n * 10), 0);
  assert.equal(wheel.accept(10, 0, 80), 1);
  assert.equal(wheel.accept(120, 0, 95), 0);
  assert.equal(wheel.accept(120, 0, 120), 0);
  assert.equal(wheel.accept(120, 0, 301), 1);
});

test("roda normaliza linhas e páginas e permite intenção oposta sem atraso artificial", () => {
  const wheel = new WheelPaging();
  assert.equal(wheel.accept(3, 1, 0), 1);
  assert.equal(wheel.accept(-3, 1, 20), -1);
  assert.equal(wheel.accept(-3, 1, 30), 0);
  wheel.reset(); assert.equal(wheel.accept(-1, 2, 35), -1);
  wheel.reset(); assert.equal(wheel.accept(.01, 0, 40), 0);
  assert.equal(wheel.accept(Number.NaN, 0, 45), 0);
  assert.equal(wheel.accept(0, 0, 50), 0);
});
