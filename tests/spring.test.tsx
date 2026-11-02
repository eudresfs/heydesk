import { strict as assert } from "node:assert";
import { test } from "node:test";
import { BodySpringDriver, SpringDriver, advanceSpring, advanceBodySpring, type FrameScheduler } from "../src/modules/motion/spring";

class Frames implements FrameScheduler {
  time = 0;
  sequence = 0;
  jobs = new Map<number, FrameRequestCallback>();
  now = () => this.time;
  request = (callback: FrameRequestCallback) => { this.jobs.set(++this.sequence, callback); return this.sequence; };
  cancel = (handle: number) => { this.jobs.delete(handle); };
  tick(milliseconds = 1000 / 60) {
    this.time += milliseconds;
    const jobs = [...this.jobs.values()]; this.jobs.clear();
    jobs.forEach(callback => callback(this.time));
  }
  settle(driver: { moving: boolean }) { for (let frame = 0; frame < 240 && driver.moving; frame++) this.tick(); assert.equal(driver.moving, false); }
}

test("spring percorre ida e volta, admite overshoot e termina sem RAF ocioso", async () => {
  const frames = new Frames(); const values: number[] = [];
  const driver = new SpringDriver(value => values.push(value), frames);
  const opening = driver.animateTo(1); frames.settle(driver);
  assert.equal(await opening, true); assert.equal(driver.position, 1); assert.equal(driver.velocity, 0);
  assert.ok(Math.max(...values) > 1.05 && Math.max(...values) < 1.12);
  const closing = driver.animateTo(0); frames.settle(driver);
  assert.equal(await closing, true); assert.equal(driver.position, 0); assert.equal(driver.velocity, 0);
  assert.ok(Math.min(...values) < -.05); assert.equal(frames.jobs.size, 0);
});

test("reversão resolve espera cancelada e conserva inércia em vez de reiniciar", async () => {
  const frames = new Frames(); const driver = new SpringDriver(() => {}, frames);
  const opening = driver.animateTo(1); for (let frame = 0; frame < 5; frame++) frames.tick();
  const position = driver.position; const velocity = driver.velocity;
  const closing = driver.animateTo(0);
  assert.equal(await opening, false); assert.equal(driver.position, position); assert.equal(driver.velocity, velocity);
  frames.tick(); assert.ok(driver.position > position, "inércia ainda avança por um frame antes da reversão");
  frames.settle(driver); assert.equal(await closing, true); assert.equal(driver.position, 0);
});

test("frame atrasado tem limite de dt e subdivisão estável, sem salto por atraso de segundos", () => {
  const delayed = advanceSpring({ x: 0, velocity: 0 }, 1, 10);
  const bounded = advanceSpring({ x: 0, velocity: 0 }, 1, .05);
  assert.deepEqual(delayed, bounded);
  assert.ok(delayed.x > .1 && delayed.x < .3);
  assert.ok(Number.isFinite(delayed.velocity) && delayed.velocity > 0);
  assert.deepEqual(advanceSpring({ x: 1.001, velocity: .01 }, 1, .004), { x: 1, velocity: 0 });
});

test("movimento imediato cancela RAF e conclui sem aguardar relógio", async () => {
  const frames = new Frames(); const driver = new SpringDriver(() => {}, frames);
  const opening = driver.animateTo(1); frames.tick();
  assert.equal(await driver.animateTo(0, true), true); assert.equal(await opening, false);
  assert.equal(driver.position, 0); assert.equal(driver.velocity, 0); assert.equal(frames.jobs.size, 0);
});

test("corpo usa snap conjunto em pixels depois do frame, não o limiar do helper genérico", () => {
  const oneAxisMoving = { width: { x: 580.001, velocity: .01 }, height: { x: 200, velocity: 8 } };
  const advanced = advanceBodySpring(oneAxisMoving, true, .004);
  assert.notEqual(advanced.width.x, 580, "largura não deve fixar enquanto altura ainda se move");
  const near = advanceBodySpring({ width: { x: 580.1, velocity: .4 }, height: { x: 200.1, velocity: .4 } }, true, .004);
  assert.deepEqual(near, { width: { x: 580, velocity: 0 }, height: { x: 200, velocity: 0 } });
  const delayed = advanceBodySpring({ width: { x: 220, velocity: 0 }, height: { x: 32, velocity: 0 } }, true, 5);
  assert.ok(delayed.width.x > 250 && delayed.width.x < 330, "dt limitado a 50 ms: um frame atrasado não salta");
  assert.ok(delayed.height.x > 45 && delayed.height.x < 90);
});

test("corpo retém frame e timestamp ao reverter e só termina no repouso real", async () => {
  const frames = new Frames(); const sizes: { width: number; height: number }[] = [];
  const driver = new BodySpringDriver((width, height) => sizes.push({ width, height }), frames);
  const first = driver.animateTo(true); for (let i = 0; i < 5; i++) frames.tick();
  const velocity = driver.widthVelocity; const pendingHandle = [...frames.jobs.keys()][0];
  frames.time += 5;
  const reverse = driver.animateTo(false);
  assert.equal(await first, false); assert.equal(driver.widthVelocity, velocity);
  assert.equal([...frames.jobs.keys()][0], pendingHandle, "retarget mantém o mesmo RAF pendente");
  frames.settle(driver); assert.equal(await reverse, true);
  assert.equal(driver.width, 220); assert.equal(driver.height, 32);
  const opening = driver.animateTo(true); frames.settle(driver); assert.equal(await opening, true);
  assert.ok(Math.max(...sizes.map(size => size.width)) > 590, "a mola ultrapassa o alvo");
  assert.ok(Math.max(...sizes.map(size => size.width + 2 * (10 + (size.height - 32) / 128 * 12))) < 680, "asas cabem na janela fixa");
  assert.ok(Math.max(...sizes.map(size => size.height)) < 230);
  assert.equal(driver.width, 580); assert.equal(driver.height, 200); assert.equal(frames.jobs.size, 0);
});

test("corpo ao encolher pousa no compacto e no peek sem ficar menor que o conteúdo", () => {
  for (const [from, to, min, collapsing] of [[{ width: 580, height: 200 }, false, { width: 220, height: 32 }, false], [{ width: 580, height: 200 }, "peek", { width: 232, height: 36 }, false], [{ width: 580, height: 200 }, false, { width: 220, height: 32 }, true]] as const) {
    let state = { width: { x: from.width, velocity: 0 }, height: { x: from.height, velocity: 0 } };
    let lowest = { width: Infinity, height: Infinity };
    for (let frame = 0; frame < 120; frame++) {
      state = advanceBodySpring(state, to, 1 / 60, collapsing);
      lowest = { width: Math.min(lowest.width, state.width.x), height: Math.min(lowest.height, state.height.x) };
    }
    assert.equal(lowest.width, min.width);
    assert.equal(lowest.height, min.height);
    assert.deepEqual([state.width.x, state.height.x], [min.width, min.height]);
  }
  let open = { width: { x: 220, velocity: 0 }, height: { x: 32, velocity: 0 } }, highest = 0;
  for (let frame = 0; frame < 60; frame++) { open = advanceBodySpring(open, true, 1 / 60); highest = Math.max(highest, open.height.x); }
  assert.ok(highest > 200, "abrir mantém o overshoot da mola");
});
