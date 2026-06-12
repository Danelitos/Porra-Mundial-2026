/**
 * live.js — Sincronización de resultados en vivo en el navegador.
 *
 * Al cargar la web y periódicamente, consulta TheSportsDB y fusiona los
 * marcadores reales con data/matches.json (en memoria, sin tocar el repo).
 * Si la API falla, la web sigue funcionando con los datos del repositorio.
 *
 * Frecuencia: 60 s si hay partidos en juego, 5 min si no.
 */

import { roundURL, GROUP_ROUNDS, mapEventsToUpdates, applyUpdates } from "./livesource.js";

const POLL_LIVE = 60_000;
const POLL_IDLE = 300_000;

let timer = null;
let lastSync = null;
let lastError = null;

export function liveStatus() {
  return { lastSync, lastError };
}

async function fetchRound(round) {
  const res = await fetch(roundURL(round), { cache: "no-store" });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const json = await res.json();
  return json.events || [];
}

/**
 * Una pasada de sincronización. onChange(matches) se llama solo si algo cambió.
 * Devuelve true si hubo cambios.
 */
export async function syncOnce(ctx, onChange) {
  try {
    const eventsArrays = await Promise.all(GROUP_ROUNDS.map(fetchRound));
    const { updates } = mapEventsToUpdates(eventsArrays, ctx.matches, ctx.groupsData);
    const { matches, changed } = applyUpdates(ctx.matches, updates);
    lastSync = new Date();
    lastError = null;
    if (changed > 0) {
      ctx.matches = matches;
      onChange?.(matches, changed);
      return true;
    }
    return false;
  } catch (err) {
    lastError = err.message;
    return false;
  }
}

/** Arranca el sondeo periódico (idempotente). */
export function startLive(ctx, onChange) {
  if (timer) return;
  const tick = async () => {
    await syncOnce(ctx, onChange);
    const anyLive = ctx.matches.some((m) => m.status === "live");
    timer = setTimeout(tick, anyLive ? POLL_LIVE : POLL_IDLE);
  };
  tick();
}
