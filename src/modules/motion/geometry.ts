import { compactBody, openBody } from "./spring";
export interface NotchGeometry { center: number; width: number; height: number; radius: number; wing: number }

// Raio e asas acompanham a altura: compacto → raio 15/asa 10; aberto → raio 42/asa 22.
// Contínuo durante a mola, inclusive no overshoot.
export function notchGeometry(center: number, width: number, height: number): NotchGeometry {
  // Acima do painel padrão (Ask expandido) raio e asa param de crescer.
  const progress = Math.min(1.1, (height - compactBody.height) / (openBody.height - compactBody.height));
  return { center, width, height, radius: Math.max(0, Math.min(height / 2, 15 + 27 * progress)), wing: Math.max(0, 10 + 12 * progress) };
}

// Forma e hit-test compartilham medidas. A margem é somente histerese de saída.
export function containsNotchPoint(shape: NotchGeometry, x: number, y: number, margin = 0): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const left = shape.center - shape.width / 2, right = shape.center + shape.width / 2;
  const { height, radius, wing } = shape;
  if (y < -margin || y > height + margin || x < left - wing - margin || x > right + wing + margin) return false;
  if (x >= left - margin && x <= right + margin) {
    if (y <= height - radius || (x >= left + radius && x <= right - radius)) return true;
    const cornerX = x < shape.center ? left + radius : right - radius;
    return Math.hypot(x - cornerX, y - (height - radius)) <= radius + margin;
  }
  if (y > wing + margin) return false;
  const cornerX = x < left ? left - wing : right + wing;
  return Math.hypot(x - cornerX, y - wing) >= Math.max(0, wing - margin);
}

export function notchPath(shape: NotchGeometry): string {
  const left = shape.center - shape.width / 2, right = shape.center + shape.width / 2;
  const { height: h, radius: r, wing: e } = shape;
  return `M${left - e} 0H${right + e}A${e} ${e} 0 0 0 ${right} ${e}V${h - r}A${r} ${r} 0 0 1 ${right - r} ${h}H${left + r}A${r} ${r} 0 0 1 ${left} ${h - r}V${e}A${e} ${e} 0 0 0 ${left - e} 0Z`;
}
