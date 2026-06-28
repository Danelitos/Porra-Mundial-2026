/**
 * app.js — SPA de la Porra Mundial 2026.
 *
 * Carga los JSON de /data, construye el contexto con js/engine.js y
 * renderiza todas las vistas. Todo se recalcula en el cliente: basta con
 * actualizar data/matches.json (npm run result) y recargar.
 */

import {
  buildContext, computeRanking, computeGroupTable,
  isGroupComplete, isGroupStageComplete, computeEvolution, computeGlobalStats,
  normName, levenshtein, signOf, KO_QUALIFY_ROUNDS,
} from "./js/engine.js";
import { startLive, liveStatus } from "./js/live.js";
import { viewStatus, liveMinute } from "./js/livesource.js";

let CTX = null;

/* Memoización de los cálculos pesados (ranking, evolución, estadísticas).
   Se cachean por "versión" de CTX.matches: live.js sustituye ese array al
   sincronizar, así que el WeakMap invalida la caché solo cuando hay datos
   nuevos. Resultado: navegar entre pestañas no recalcula nada. */
const _memo = new WeakMap();
function memo(key, fn) {
  let cache = _memo.get(CTX.matches);
  if (!cache) { cache = {}; _memo.set(CTX.matches, cache); }
  return key in cache ? cache[key] : (cache[key] = fn());
}
/** Firma del estado visible de todos los partidos (para detectar cuándo un
 *  partido pasa a "en juego"/"finalizado" por hora y conviene repintar). */
const statusSignature = () => CTX.matches.map((m) => viewStatus(m)).join("");

const rankingOf = () => memo("ranking", () => computeRanking(CTX));
const evolutionOf = () => memo("evolution", () => computeEvolution(CTX));
const globalStatsOf = () => memo("stats", () => computeGlobalStats(CTX));

const $view = document.getElementById("view");
const PALETTE = ["#21c469", "#f5c343", "#4da3ff", "#ff5d6c", "#b07cff", "#3fd6c5", "#ff9f43", "#e84393", "#74b9ff", "#a3cb38", "#fd79a8", "#81ecec", "#ffeaa7", "#55efc4", "#fab1a0", "#00cec9", "#6c5ce7", "#fdcb6e", "#e17055", "#00b894"];

/* ============================ Utilidades UI ============================ */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Icono Lucide inline; lucide.createIcons() lo convierte en SVG tras cada render. */
const icon = (name, cls = "") => `<i data-lucide="${name}" class="ic${cls ? " " + cls : ""}" aria-hidden="true"></i>`;

function refreshIcons() {
  window.lucide?.createIcons();
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function avatarHTML(name, { size = "", demo = false } = {}) {
  const initials = name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const hue = hashCode(name) % 360;
  const style = `background:linear-gradient(135deg,hsl(${hue},60%,42%),hsl(${(hue + 50) % 360},65%,30%))`;
  return `<div class="avatar ${size}" style="${style}" title="${esc(name)}${demo ? " (demo)" : ""}">${esc(initials)}</div>`;
}

function team(id) {
  const t = CTX.teamsById[id];
  if (!t) return `<span class="team-chip muted">${esc(id || "—")}</span>`;
  return `<span class="team-chip"><span class="flag">${t.flag}</span><span>${esc(t.name)}</span></span>`;
}
function teamShort(id) {
  const t = CTX.teamsById[id];
  return t ? `${t.flag} ${esc(t.name)}` : esc(id || "—");
}

function fmtDate(iso, withTime = true) {
  if (!iso) return "—";
  const d = new Date(iso);
  const date = d.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
  if (!withTime) return date;
  const time = d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  return `${date} · ${time}`;
}

function fmtUpdated(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("es-ES", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
}

const STATUS_LABEL = { pending: "Pendiente", live: "En juego", finished: "Finalizado" };

function demoBadge(p) {
  return p.demo ? ` <span class="demo-badge">DEMO</span>` : "";
}

function medalClass(pos) {
  return pos === 1 ? "gold" : pos === 2 ? "silver" : pos === 3 ? "bronze" : "";
}

function sectionTitle(iconName, label) {
  return `<div class="section-title">${icon(iconName)}<span>${label}</span></div>`;
}

/* ============================== Componentes ============================== */

function matchCard(m, { showVenue = true } = {}) {
  const st = viewStatus(m);
  const score = m.score && st !== "pending"
    ? `${m.score.home} – ${m.score.away}`
    : `<span class="muted">VS</span>`;
  const min = st === "live" ? liveMinute(m) : null;
  const minute = min ? ` <span class="minute-badge">${esc(/^\d/.test(min) ? min + "′" : min)}</span>` : "";
  return `
  <div class="match-card ${st === "live" ? "is-live" : ""}">
    <div class="mc-top">Grupo ${m.group} · J${m.matchday} · ${fmtDate(m.date)}</div>
    <div class="team"><span class="flag">${CTX.teamsById[m.home]?.flag || "🏳️"}</span><span class="nm">${esc(CTX.teamsById[m.home]?.name || m.home)}</span></div>
    <div class="score ${st === "pending" ? "pending" : ""}">${score}</div>
    <div class="team right"><span class="nm">${esc(CTX.teamsById[m.away]?.name || m.away)}</span><span class="flag">${CTX.teamsById[m.away]?.flag || "🏳️"}</span></div>
    <div class="meta">
      <span class="venue">${showVenue && m.venue ? `${icon("map-pin")}${esc(m.venue)}` : ""}</span>
      <span class="status-dot ${st}">${STATUS_LABEL[st]}${minute}</span>
    </div>
  </div>`;
}

/** Cómo mostrar una casilla del cuadro: equipo concreto (con bandera) o etiqueta
 *  (1º A, 3º C/E/F…, Por definir) cuando aún no se conoce. */
function koSlotDisplay(slot, matchId) {
  const r = resolveBracketSlot(slot, matchId);
  const id = r.teamId || r.provisional;
  if (id) {
    const t = CTX.teamsById[id];
    return { flag: t?.flag || "🏳️", name: t?.name || id, set: !!r.teamId };
  }
  return { flag: "🏳️", name: r.label, set: false };
}

/** Tarjeta de un partido de la fase eliminatoria, con el mismo aspecto que las de
 *  grupos. Si ya hay resultado en data/knockout.json se muestra el marcador y se
 *  resalta al ganador (que avanza); si no, queda pendiente (VS). */
function koMatchCard(n) {
  const m = CTX.bracket?.matches[String(n)];
  if (!m) return "";
  const h = koSlotDisplay(m.home, n), a = koSlotDisplay(m.away, n);
  const roundName = CTX.bracket.rounds[m.round] || "Eliminatoria";
  const res = CTX.knockout?.results?.[String(n)];
  const st = res?.status === "finished" ? "finished" : res?.status === "live" ? "live" : "pending";
  const hasScore = res && res.score && st !== "pending";
  const min = st === "live" && res?.minute ? ` <span class="minute-badge">${esc(/^\d/.test(res.minute) ? res.minute + "′" : res.minute)}</span>` : "";
  const winHome = res?.winner && res.winner === res.home;
  const winAway = res?.winner && res.winner === res.away;
  const scoreHTML = hasScore
    ? `${res.score.home} – ${res.score.away}${res.winner && res.score.home === res.score.away ? ` <small class="muted">(pen)</small>` : ""}`
    : `<span class="muted">VS</span>`;
  return `
  <div class="match-card ${st === "live" ? "is-live" : ""}">
    <div class="mc-top">${esc(roundName)} · ${fmtDate(m.date)}</div>
    <div class="team ${winHome ? "ko-win" : res?.winner ? "ko-out" : ""}"><span class="flag">${h.flag}</span><span class="nm ${h.set ? "" : "muted"}">${esc(h.name)}</span>${winHome ? icon("check", "ko-check") : ""}</div>
    <div class="score ${st === "pending" ? "pending" : ""}">${scoreHTML}</div>
    <div class="team right ${winAway ? "ko-win" : res?.winner ? "ko-out" : ""}">${winAway ? icon("check", "ko-check") : ""}<span class="nm ${a.set ? "" : "muted"}">${esc(a.name)}</span><span class="flag">${a.flag}</span></div>
    <div class="meta">
      <span class="venue">${m.venue ? `${icon("map-pin")}${esc(m.venue)}` : ""}</span>
      <span class="status-dot ${st}">${STATUS_LABEL[st]}${min}</span>
    </div>
  </div>`;
}

/** Orden de las rondas eliminatorias para listarlas (incluye 3.er puesto). */
const KO_RESULT_ROUNDS = ["r32", "r16", "qf", "sf", "tp", "final"];

/** Nº de partido del cuadro agrupados por ronda y ordenados por fecha. */
function koMatchesByRound() {
  const out = {};
  for (const [n, m] of Object.entries(CTX.bracket?.matches || {})) (out[m.round] ||= []).push(n);
  for (const r of Object.keys(out)) {
    out[r].sort((a, b) => {
      const da = CTX.bracket.matches[a].date || "", db = CTX.bracket.matches[b].date || "";
      return da < db ? -1 : da > db ? 1 : Number(a) - Number(b);
    });
  }
  return out;
}

/** Variación de posición respecto al día anterior. */
function positionDeltas() {
  const evo = evolutionOf();
  if (evo.length < 2) return {};
  const prev = evo[evo.length - 2].standings;
  const cur = evo[evo.length - 1].standings;
  const out = {};
  for (const s of cur) {
    const p = prev.find((x) => x.id === s.id);
    out[s.id] = p ? p.position - s.position : 0;
  }
  return out;
}

function rankRow(r, delta = null) {
  const medal = medalClass(r.position);
  const crown = r.position === 1 ? icon("crown", "crown") : "";
  const deltaHTML = delta == null || delta === 0
    ? `<span class="delta same">${icon("minus")}</span>`
    : delta > 0
      ? `<span class="delta up">${icon("chevron-up")}${delta}</span>`
      : `<span class="delta down">${icon("chevron-down")}${-delta}</span>`;
  return `
  <a class="rank-row ${medal}" href="#/perfil/${esc(r.id)}" style="--i:${r.position}">
    <div class="pos"><b>${r.position}</b>${deltaHTML}</div>
    ${avatarHTML(r.name, { demo: r.demo })}
    <div class="who">
      <div class="nm">${crown}${esc(r.name)}${demoBadge(r)}</div>
      <div class="sub">${r.stats.exactHits} exactos · ${r.stats.signHits} signos · ${r.stats.accuracy}% acierto</div>
    </div>
    <div class="pts"><b>${r.breakdown.total}</b><small>puntos</small></div>
  </a>`;
}

/** Gráfico SVG de líneas: evolución de puntos. Destaca el Top y atenúa el resto
 *  para que sea legible aunque haya muchos participantes ("líneas con foco"). */
function evolutionChart(checkpoints, { height = 300, top = 6 } = {}) {
  if (!checkpoints.length) {
    return `<div class="card empty-card">${icon("chart-line", "big")}
      <p>La evolución aparecerá aquí en cuanto haya partidos finalizados.</p></div>`;
  }
  const standings = checkpoints[checkpoints.length - 1].standings; // ya ordenado por posición
  const ids = standings.map((s) => s.id);
  const TOP = Math.min(top, ids.length);
  const W = 720, H = height, padL = 34, padR = 104, padT = 16, padB = 28;
  const maxPts = Math.max(4, ...checkpoints.flatMap((c) => c.standings.map((s) => s.total)));
  const x = (i) => padL + (i * (W - padL - padR)) / Math.max(1, checkpoints.length - 1);
  const y = (v) => padT + (H - padT - padB) * (1 - v / maxPts);
  const seriesFor = (id) => checkpoints.map((c, i) => {
    const s = c.standings.find((st) => st.id === id);
    return { x: x(i), y: y(s ? s.total : 0), v: s ? s.total : 0 };
  });

  // Rejilla horizontal con escala de puntos.
  let grid = "";
  for (let g = 0; g <= 4; g++) {
    const v = Math.round((maxPts * g) / 4);
    grid += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(255,255,255,0.06)"/>
             <text x="${padL - 6}" y="${y(v) + 3}" text-anchor="end" font-size="10" fill="#5d6c86">${v}</text>`;
  }

  // Resto de la peña: líneas grises tenues de fondo (contexto, sin saturar).
  let muted = "";
  ids.slice(TOP).forEach((id) => {
    const pts = seriesFor(id).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    muted += `<polyline points="${pts.join(" ")}" fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="1.5" stroke-linejoin="round"/>`;
  });

  // Top destacado: líneas de color, grueso, con punto y etiqueta al final.
  let lines = "";
  const tags = [];
  ids.slice(0, TOP).forEach((id, idx) => {
    const color = PALETTE[idx % PALETTE.length];
    const series = seriesFor(id);
    const pts = series.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    const last = series[series.length - 1];
    lines += `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2.75" stroke-linejoin="round" stroke-linecap="round"/>`;
    lines += `<circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="3.5" fill="${color}"/>`;
    const name = standings.find((s) => s.id === id)?.name || id;
    tags.push({ origY: last.y, ty: last.y, x: last.x, color, name, v: last.v });
  });

  // Anti-solapamiento vertical de las etiquetas finales (empuje hacia abajo).
  tags.sort((a, b) => a.origY - b.origY);
  const gapPx = 15;
  for (let i = 1; i < tags.length; i++) {
    if (tags[i].ty - tags[i - 1].ty < gapPx) tags[i].ty = tags[i - 1].ty + gapPx;
  }
  let endLabels = "";
  for (const t of tags) {
    const lx = W - padR + 9;
    endLabels += `<path d="M ${(W - padR).toFixed(1)},${t.origY.toFixed(1)} C ${(W - padR + 5).toFixed(1)},${t.origY.toFixed(1)} ${(W - padR + 3).toFixed(1)},${t.ty.toFixed(1)} ${lx.toFixed(1)},${t.ty.toFixed(1)}" fill="none" stroke="${t.color}" stroke-width="1" opacity="0.45"/>`;
    endLabels += `<text x="${(lx + 2).toFixed(1)}" y="${(t.ty + 3.5).toFixed(1)}" font-size="11" font-weight="600" fill="${t.color}">${esc(t.name)} <tspan fill="#9aa7bd" font-weight="400">${t.v}</tspan></text>`;
  }

  // Etiquetas del eje X (fechas).
  let xlabels = "";
  checkpoints.forEach((c, i) => {
    if (checkpoints.length <= 10 || i % Math.ceil(checkpoints.length / 10) === 0 || i === checkpoints.length - 1) {
      xlabels += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#5d6c86">${esc(c.label)}</text>`;
    }
  });

  return `<div class="card chart-card">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolución de puntos">${grid}${muted}${lines}${endLabels}${xlabels}</svg>
    <p class="muted table-note">Top ${TOP} destacado · el resto de la peña en gris. Ranking completo en la pestaña Ranking.</p>
  </div>`;
}

/** Badges de los partidos ya jugados por un equipo en su grupo (V/E/D, en orden). */
function teamFormHTML(teamId, groupId) {
  const ms = CTX.matches
    .filter((m) => m.group === groupId && m.status === "finished" && m.score && (m.home === teamId || m.away === teamId))
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  if (!ms.length) return `<span class="form-empty">—</span>`;
  const dots = ms.map((m) => {
    const isHome = m.home === teamId;
    const gf = isHome ? m.score.home : m.score.away;
    const ga = isHome ? m.score.away : m.score.home;
    const opp = CTX.teamsById[isHome ? m.away : m.home];
    const res = gf > ga ? "w" : gf < ga ? "l" : "d";
    const ic = res === "w" ? "check" : res === "l" ? "x" : "minus";
    const label = res === "w" ? "Victoria" : res === "l" ? "Derrota" : "Empate";
    const title = `${label} ${gf}-${ga} vs ${opp ? opp.name : "?"}`;
    return `<span class="fdot ${res}" title="${esc(title)}">${icon(ic)}</span>`;
  }).join("");
  return `<span class="form-cell">${dots}</span>`;
}

function groupTableHTML(g, { compact = false } = {}) {
  const table = computeGroupTable(g, CTX.matches);
  const played = table.some((r) => r.pj > 0);
  const rows = table.map((r, i) => `
    <tr class="${i === 0 ? "q1" : i === 1 ? "q2" : i === 2 ? "q3" : ""}">
      <td>${i + 1}. ${team(r.teamId)}</td>
      <td class="num">${r.pj}</td><td class="num">${r.pg}</td><td class="num">${r.pe}</td><td class="num">${r.pp}</td>
      ${compact ? "" : `<td class="num">${r.gf}</td><td class="num">${r.gc}</td>`}
      <td class="num">${r.dg > 0 ? "+" : ""}${r.dg}</td>
      <td class="num"><b>${r.pts}</b></td>
      ${compact ? "" : `<td class="form-td">${teamFormHTML(r.teamId, g.id)}</td>`}
    </tr>`).join("");
  return `
  <div class="table-wrap">
    <table class="std">
      <thead><tr><th>Equipo</th><th class="num">PJ</th><th class="num">PG</th><th class="num">PE</th><th class="num">PP</th>
      ${compact ? "" : `<th class="num">GF</th><th class="num">GC</th>`}<th class="num">DG</th><th class="num">Pts</th>
      ${compact ? "" : `<th class="form-td">Últimos</th>`}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  ${played ? "" : `<p class="muted table-note">Orden alfabético hasta que se jueguen partidos. <span style="color:var(--green)">▎1º</span> y <span style="color:var(--blue)">▎2º</span> clasifican directo, <span style="color:var(--gold)">▎3º</span> puntúa 1 pt si se acierta el equipo.</p>`}`;
}

/* ================================ Vistas ================================ */

function viewHome() {
  const ranking = rankingOf();
  const stats = globalStatsOf();
  const top3 = ranking.slice(0, 3);
  const leader = ranking[0];
  // Próximos: partidos de grupos pendientes y, cuando los grupos cierran, también
  // los de la fase eliminatoria. Se mezclan y ordenan por fecha.
  const upcomingItems = CTX.matches
    .filter((m) => viewStatus(m) === "pending")
    .map((m) => ({ date: m.date, html: matchCard(m) }));
  if (CTX.bracket && isGroupStageComplete(CTX.matches)) {
    for (const [n, m] of Object.entries(CTX.bracket.matches)) {
      upcomingItems.push({ date: m.date, html: koMatchCard(n) });
    }
  }
  upcomingItems.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const upcoming = upcomingItems.slice(0, 6);
  const live = CTX.matches.filter((m) => viewStatus(m) === "live");
  const anyPoints = leader && leader.breakdown.total > 0;

  const podium = top3.length === 3 ? `
    <div class="podium">
      ${[1, 0, 2].map((i) => {
        const r = top3[i];
        return `<a class="podium-slot podium-${i + 1}" href="#/perfil/${esc(r.id)}">
          ${avatarHTML(r.name, { demo: r.demo })}
          <div class="p-name">${esc(r.name)}</div>
          <div class="p-pts">${r.breakdown.total} pts</div>
          <div class="podium-base">${i + 1}º</div>
        </a>`;
      }).join("")}
    </div>` : "";

  return `
  <div class="hero">
    <div class="hero-main">
      <div class="hero-flex">
        <div class="hero-copy">
          <span class="hero-kicker">FIFA World Cup 26 · Canadá · México · USA</span>
          <h1>Porra <span>Mundial 2026</span></h1>
          <p class="hero-sub">Del 11 de junio al 19 de julio. ${stats.participants} porristas, ${stats.matchesTotal} partidos (72 de grupos + fase eliminatoria) y un solo trono.</p>
        </div>
        <img class="hero-logo" src="assets/logo.svg" alt="Emblema oficial del Mundial 2026" />
      </div>
      <div class="hero-meta">
        <span class="pill green">${icon("calendar-check")}${stats.matchesPlayed}/${stats.matchesTotal} jugados</span>
        ${live.length ? `<span class="pill red">${icon("radio")}${live.length} en juego</span>` : ""}
        <span class="pill gold">${icon("crown")}${anyPoints ? `Líder: ${esc(leader.name)} (${leader.breakdown.total} pts)` : "Todo por decidir"}</span>
        <span class="pill blue">${icon("wifi")}Resultados en directo</span>
        <span class="pill">${icon("clock")}${fmtUpdated(CTX.tournament.lastUpdated)}</span>
      </div>
    </div>
    <div class="card top3-card">
      <h3>${icon("trophy")}Top 3</h3>
      ${podium || `<p class="muted">Aún no hay suficientes participantes.</p>`}
      <p class="top3-link"><a class="chip" href="#/ranking">Ver ranking completo ${icon("arrow-right")}</a></p>
    </div>
  </div>

  ${sectionTitle("chart-column", "La porra en números")}
  <div class="grid grid-4">
    <div class="card stat-tile"><div class="v green">${stats.participants}</div><div class="l">Participantes</div></div>
    <div class="card stat-tile"><div class="v blue">${stats.matchesPlayed}</div><div class="l">Partidos jugados</div><div class="st-sub">de ${stats.matchesTotal}</div></div>
    <div class="card stat-tile"><div class="v">${stats.totalGoals}</div><div class="l">Goles totales</div><div class="st-sub">${stats.avgGoals} por partido</div></div>
    <div class="card stat-tile"><div class="v blue">${stats.koMatchesPlayed}</div><div class="l">Eliminatoria</div><div class="st-sub">de ${stats.koMatchesTotal} jugados</div></div>
    <div class="card stat-tile"><div class="v gold">${stats.totalExactHits}</div><div class="l">Exactos de los participantes</div></div>
    <div class="card stat-tile"><div class="v">${stats.totalSignHits}</div><div class="l">Signos de los participantes</div></div>
    <div class="card stat-tile"><div class="v green">${stats.avgPoints}</div><div class="l">Media de puntos</div></div>
    <div class="card stat-tile"><div class="v gold">${stats.leader ? stats.leader.total : 0}</div><div class="l">Puntos del líder</div></div>
  </div>

  ${live.length ? `${sectionTitle("radio", "En juego")}<div class="grid grid-2">${live.map((m) => matchCard(m)).join("")}</div>` : ""}

  ${sectionTitle("calendar-days", "Próximos partidos")}
  <div class="grid grid-2">
    ${upcoming.length ? upcoming.map((u) => u.html).join("") : `<p class="muted">No quedan partidos por jugar.</p>`}
  </div>

  ${sectionTitle("chart-line", "Evolución de la porra")}
  ${evolutionChart(evolutionOf())}
  `;
}

function viewRanking() {
  const ranking = rankingOf();
  const deltas = positionDeltas();
  return `
  <div class="page-head">
    <h1>${icon("trophy")}Ranking general</h1>
    <p>Se recalcula automáticamente con cada resultado oficial. Desempates: exactos → signos → grupos.</p>
  </div>
  <div class="chips">
    <button class="chip" onclick="window.print()">${icon("printer")}Exportar PDF</button>
  </div>
  <div class="rank-table">
    ${ranking.map((r) => rankRow(r, deltas[r.id] ?? null)).join("")}
  </div>`;
}

function viewParticipantes() {
  const ranking = rankingOf();
  const cards = ranking.map((r) => `
    <a class="card hover participant-card" href="#/perfil/${esc(r.id)}" data-name="${esc(r.name.toLowerCase())}">
      ${avatarHTML(r.name, { size: "lg", demo: r.demo })}
      <div class="p-info">
        <h3>${esc(r.name)}${demoBadge(r)}</h3>
        <div class="muted">Posición ${r.position}ª</div>
        <div class="p-pts">${r.breakdown.total} pts</div>
      </div>
    </a>`).join("");

  return `
  <div class="page-head"><h1>${icon("users")}Participantes</h1><p>${ranking.length} porristas en liza. Los marcados como DEMO se sustituirán por porras reales.</p></div>
  <div class="searchbox">${icon("search")}<input id="psearch" type="search" placeholder="Buscar participante…" autocomplete="off" /></div>
  <div class="grid grid-3" id="plist">${cards}</div>`;
}

/** Equipo de una casilla del cuadro SEGÚN EL PRONÓSTICO de un participante.
 *  Las casillas de grupo (1º/2º/3º) usan el equipo real; las de ganador/perdedor
 *  de cruce usan lo que el participante hizo pasar (mapa teamOf ya calculado). */
function pkSlotTeam(slot, matchId, teamOf) {
  if (!slot) return null;
  if (slot.type === "m") return teamOf[String(slot.n)]?.winner || null;
  if (slot.type === "l") {
    const x = teamOf[String(slot.n)];
    return x && x.winner ? (x.winner === x.home ? x.away : x.home) : null;
  }
  const r = resolveBracketSlot(slot, matchId);
  return r.teamId || r.provisional || null;
}

/** Reconstruye el cuadro completo de un participante a partir de su pronóstico:
 *  { <idPartido>: { home, away, winner } } con los equipos que ÉL coloca. */
function buildParticipantBracket(p) {
  const ko = p.predictions?.knockout;
  if (!ko || !CTX.bracket) return {};
  const adv = {
    r32: new Set((ko.r32 || []).map((x) => x.home).filter(Boolean)),
    r16: new Set((ko.r16 || []).map((x) => x.home).filter(Boolean)),
    qf: new Set((ko.qf || []).map((x) => x.home).filter(Boolean)),
    sf: new Set((ko.sf || []).map((x) => x.home).filter(Boolean)),
  };
  const champion = ko.final?.[0]?.home || null;
  const third = ko.thirdPlace?.[0]?.home || null;

  const idsByRound = {};
  for (const [id, m] of Object.entries(CTX.bracket.matches)) (idsByRound[m.round] ||= []).push(id);

  const teamOf = {};
  for (const round of ["r32", "r16", "qf", "sf", "final", "tp"]) {
    for (const id of idsByRound[round] || []) {
      const m = CTX.bracket.matches[id];
      const home = pkSlotTeam(m.home, id, teamOf);
      const away = pkSlotTeam(m.away, id, teamOf);
      let winner = null;
      if (adv[round]) winner = adv[round].has(home) ? home : adv[round].has(away) ? away : null;
      else if (round === "final") winner = champion === home || champion === away ? champion : null;
      else if (round === "tp") winner = third === home || third === away ? third : null;
      teamOf[id] = { home, away, winner };
    }
  }
  return teamOf;
}

/** Línea de equipo dentro de la tarjeta del cuadro de un participante. `win` =
 *  es el equipo que él hace pasar; `real` = ganador real del cruce (si lo hay),
 *  para marcar acierto/fallo. */
function pkBracketTeam(teamId, { win, real }) {
  if (!teamId) return `<div class="bk-team is-tbd"><span class="bk-pos">Por definir</span></div>`;
  const t = CTX.teamsById[teamId];
  let cls = win ? "pk-win" : "pk-lose";
  let mark = "";
  if (win && real) {
    const ok = real === teamId;
    cls += ok ? " ok" : " no";
    mark = ok ? icon("check", "ko-check") : icon("x", "ko-x");
  }
  return `<div class="bk-team ${cls}"><span class="flag">${t?.flag || "🏳️"}</span><span class="nm">${esc(t?.name || teamId)}</span>${mark}</div>`;
}

/** Tarjeta de un partido del cuadro, con el pronóstico de un participante. */
function pkBracketCard(p, pb, n, { mirror = false } = {}) {
  const m = CTX.bracket.matches[String(n)];
  if (!m) return "";
  const node = pb[String(n)] || {};
  const real = CTX.knockout?.results?.[String(n)]?.winner || null;
  const d = fmtDate(m.date);
  return `
    <div class="bk-card${mirror ? " mirror" : ""}">
      <div class="bk-head"><span class="bk-no">#${n}</span><span class="bk-date">${d}${m.venue ? " · " + esc(m.venue) : ""}</span></div>
      ${pkBracketTeam(node.home, { win: !!node.home && node.winner === node.home, real })}
      <div class="bk-vs"><span>VS</span></div>
      ${pkBracketTeam(node.away, { win: !!node.away && node.winner === node.away, real })}
    </div>`;
}

/** Sección "Cuadro eliminatorio" del perfil: el pronóstico del participante
 *  dibujado igual que la página de Eliminatorias (con acierto/fallo cuando ya
 *  hay resultado real). */
function koPerfilSection(p, r, params) {
  if (!CTX.bracket) return "";
  const ko = p.predictions.knockout;
  if (!ko || !ko.r32 || !ko.r32.length) {
    return `${sectionTitle("git-merge", "Cuadro eliminatorio")}
    <p class="muted">Aún no ha enviado su cuadro de la fase eliminatoria.</p>`;
  }
  const pb = buildParticipantBracket(p);
  const card = (n, opts) => pkBracketCard(p, pb, n, opts);
  return `
  ${sectionTitle("git-merge", "Cuadro eliminatorio")}
  <p class="muted">Su pronóstico del cuadro · ${r.stats.koHits || 0} aciertos · <b>${r.breakdown.koPts || 0} pts</b> en la eliminatoria.</p>
  <div class="bk-legend">
    <span class="key"><b>Negrita</b> = a quién hace pasar</span>
    <span class="key"><span class="sw ok"></span>Acierto (ya jugado)</span>
    <span class="key"><span class="sw no"></span>Fallo</span>
  </div>
  ${bracketBody(params, { card, baseHref: `#/perfil/${p.id}` })}`;
}

/** Tira con el podio del Mundial que pronostica el participante (campeón,
 *  subcampeón y 3.er puesto), con acierto/fallo si el torneo ya lo decidió. */
function wcPodiumStrip(r) {
  const pod = r.koDetail?.podium;
  if (!pod || !pod.champion?.team) return "";
  const slot = (medal, label, sl) => {
    const t = CTX.teamsById[sl.team];
    const cls = sl.status === "hit" ? "ok" : sl.status === "miss" ? "no" : "";
    const mark = sl.status === "hit" ? icon("check", "ko-check") : sl.status === "miss" ? icon("x", "ko-x") : "";
    return `<div class="wc-pod ${cls}">
      <span class="wc-pod-medal">${medal}</span>
      <span class="flag">${t?.flag || "🏳️"}</span>
      <span class="wc-pod-name">${esc(t?.name || sl.team)}${mark}</span>
      <span class="wc-pod-lbl">${label}</span>
    </div>`;
  };
  return `
  <div class="card wc-podium mt">
    <div class="wc-podium-title">${icon("trophy")}Su podio del Mundial</div>
    <div class="wc-podium-slots">
      ${slot("🥈", "Subcampeón", pod.runnerUp)}
      ${slot("🏆", "Campeón", pod.champion)}
      ${slot("🥉", "3.er puesto", pod.third)}
    </div>
  </div>`;
}

function viewPerfil(id, params) {
  const p = CTX.participants.find((x) => x.id === id);
  if (!p) return `<div class="card">No existe ese participante. <a href="#/participantes">Volver</a></div>`;
  const ranking = rankingOf();
  const r = ranking.find((x) => x.id === id);
  const b = r.breakdown, s = r.stats;

  // Evolución individual de la posición.
  const evo = evolutionOf();
  const myEvo = evo.map((c) => ({ label: c.label, ...c.standings.find((st) => st.id === id) }));

  // Pronósticos agrupados por grupo.
  const groupBlocks = CTX.groupsData.groups.map((g) => {
    const ms = CTX.matches.filter((m) => m.group === g.id);
    const rows = ms.map((m) => {
      const pm = r.perMatch.find((x) => x.matchId === m.id);
      const pred = pm.pred;
      const predTxt = pred && pred.home != null ? `${pred.home}-${pred.away} <small class="muted">(${esc(pred.sign || "")})</small>` : `<span class="muted">—</span>`;
      const realTxt = pm.score ? `${pm.score.home}-${pm.score.away}` : `<span class="muted">—</span>`;
      const ptsTxt = pm.score
        ? (pm.pts.total > 0 ? `<span class="hit">+${pm.pts.total}</span>` : `<span class="miss">0</span>`)
        : `<span class="muted">·</span>`;
      return `<tr>
        <td>${teamShort(m.home)} <span class="muted">vs</span> ${teamShort(m.away)}</td>
        <td class="num">${predTxt}</td><td class="num">${realTxt}</td><td class="num">${ptsTxt}</td>
      </tr>`;
    }).join("");

    const pick = p.predictions.groups[g.id] || {};
    const gr = r.groupResults[g.id] || {};
    const pickCell = (label, teamId, ok) => {
      const cls = ok === true ? "hit" : ok === false ? "miss" : "";
      return `<span class="pill ${ok === true ? "green" : ok === false ? "red" : ""}">${label} <b class="${cls}">${teamShort(teamId)}</b></span>`;
    };
    return `
    <div class="card group-block">
      <h3>${g.name} ${gr.complete ? `<span class="pill green">cerrado · +${gr.pts || 0} pts</span>` : ""}</h3>
      <div class="table-wrap"><table class="std">
        <thead><tr><th>Partido</th><th class="num">Su pred.</th><th class="num">Real</th><th class="num">Pts</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="pick-row">
        ${pick.first ? pickCell("1º", pick.first, gr.first) : ""}
        ${pick.second ? pickCell("2º", pick.second, gr.second) : ""}
        ${pick.third ? pickCell("3º", pick.third, gr.third === true ? true : null) : ""}
      </div>
    </div>`;
  }).join("");

  const maxBar = Math.max(1, b.total);
  const bar = (label, val, cls = "", note = "") => `
    <div class="bar-row"><span>${label}${note ? ` <small class="muted">${note}</small>` : ""}</span>
      <div class="track"><div class="fill ${cls}" style="width:${Math.min(100, (val / maxBar) * 100)}%"></div></div>
      <span class="val">${val}</span>
    </div>`;
  const kb = r.koBreakdown || {};
  const koHit = (round) => (r.koDetail?.rounds?.[round]?.picks || []).filter((x) => x.status === "hit").length;
  const groupTotal = b.signPts + b.exactPts + b.groupPickPts + b.thirdsPts;
  const n = (v, sing, plur) => `${v} ${v === 1 ? sing : plur}`;
  // Desglose de signos acertados por tipo (firmados): suman exactamente signHits.
  let sW = 0, sD = 0, sL = 0;
  for (const pm of r.perMatch) {
    if (!pm.score || !pm.pred || pm.pred.sign == null) continue;
    const real = signOf(pm.score.home, pm.score.away);
    if (pm.pred.sign !== real) continue;
    if (real === "1") sW++; else if (real === "X") sD++; else sL++;
  }
  // Goles que lleva el pichichi elegido (de la tabla oficial de goleadores).
  const pichScorer = p.pichichi ? (CTX.scorers || []).find((sc) => samePlayer(sc.name, p.pichichi)) : null;
  const pichGoals = pichScorer ? pichScorer.goals : 0;

  return `
  <a class="backlink" href="#/ranking">${icon("arrow-left")}Ranking</a>
  <div class="card profile-head">
    ${avatarHTML(p.name, { size: "lg", demo: p.demo })}
    <div class="who">
      <h1>${esc(p.name)}${demoBadge(p)}</h1>
      <div class="tagline">Posición ${r.position}ª de ${ranking.length}</div>
    </div>
    <div class="bigpts"><b>${b.total}</b><span>puntos</span></div>
  </div>

  ${wcPodiumStrip(r)}

  ${sectionTitle("chart-column", "Estadísticas")}
  <div class="grid grid-4">
    <div class="card stat-tile"><div class="v green">${s.accuracy}%</div><div class="l">Acierto de signo</div><div class="st-sub">${s.signHits}/${s.playedWithPred} partidos</div></div>
    <div class="card stat-tile"><div class="v blue">${s.signHits}</div><div class="l">Signos acertados</div><div class="st-sub">= ${sW} + ${sD} + ${sL}</div></div>
    <div class="card stat-tile"><div class="v gold">${s.exactHits}</div><div class="l">Marcadores exactos</div><div class="st-sub">${s.exactRate}% de los partidos</div></div>
    <div class="card stat-tile"><div class="v">${s.groupPickHits + s.thirdsHits}</div><div class="l">Aciertos de grupo</div><div class="st-sub">1.º/2.º/3.º</div></div>
    <div class="card stat-tile"><div class="v green">${sW}</div><div class="l">Victorias firmadas</div><div class="st-sub">signo 1 acertado</div></div>
    <div class="card stat-tile"><div class="v">${sD}</div><div class="l">Empates firmados</div><div class="st-sub">signo X acertado</div></div>
    <div class="card stat-tile"><div class="v red">${sL}</div><div class="l">Derrotas firmadas</div><div class="st-sub">signo 2 acertado</div></div>
    <div class="card stat-tile"><div class="v ${p.pichichi ? "gold" : ""}">${p.pichichi ? pichGoals : "—"}</div><div class="l">Goles de su pichichi</div><div class="st-sub">${esc(p.pichichi || "sin elegir")}${s.pichichiHit ? " ✓" : ""}</div></div>
  </div>

  ${sectionTitle("layers", "Desglose de puntos")}
  <p class="muted breakdown-help">El <b>signo</b> (1·X·2) y el <b>marcador</b> son apuestas independientes: acertar el signo da <b>1 pt</b> y acertar el marcador exacto da <b>3 pts</b>. Si aciertas los dos, 4 pts (puedes "cubrirte" firmando un signo distinto a tu marcador).</p>
  <div class="grid grid-2 align-start">
    <div class="card">
      <h3>${icon("layout-grid")}Fase de grupos <span class="pill">${groupTotal} pts</span></h3>
      <div class="bars">
        ${bar("Signos acertados (1·X·2)", b.signPts, "", `${s.signHits}/${s.playedWithPred} · 1 pt c/u`)}
        ${bar("Bonus por marcador exacto", b.exactPts, "gold", `${n(s.exactHits, "exacto", "exactos")} · +3 c/u`)}
        ${bar("1.º / 2.º de grupo", b.groupPickPts, "blue", `${n(s.groupPickHits, "acierto", "aciertos")} · 4/2 pts`)}
        ${bar("3.os de grupo", b.thirdsPts, "blue", `${n(s.thirdsHits, "acierto", "aciertos")} · 1 pt c/u`)}
      </div>
      <div class="breakdown-total"><span>Subtotal grupos</span><b>${groupTotal} pts</b></div>
    </div>
    <div class="card">
      <h3>${icon("git-merge")}Eliminatoria <span class="pill ${(b.koPts || 0) > 0 ? "green" : ""}">${b.koPts || 0} pts</span></h3>
      <div class="bars">
        ${bar("Ronda de 32", kb.r32 || 0, "green", n(koHit("r32"), "acierto", "aciertos"))}
        ${bar("Octavos", kb.r16 || 0, "green", n(koHit("r16"), "acierto", "aciertos"))}
        ${bar("Cuartos", kb.qf || 0, "green", n(koHit("qf"), "acierto", "aciertos"))}
        ${bar("Semifinales (finalistas)", kb.sf || 0, "green", n(koHit("sf"), "acierto", "aciertos"))}
        ${bar("3.er puesto", kb.thirdPlace || 0, "blue")}
        ${bar("Subcampeón", kb.runnerUp || 0, "gold")}
        ${bar("Campeón 🏆", kb.champion || 0, "gold")}
      </div>
    </div>
  </div>

  <div class="grid grid-2 align-start mt">
    <div class="card">
      <h3>${icon("star")}Bonus y total</h3>
      <div class="bars">
        ${bar("Pichichi", b.pichichiPts, "gold", s.pichichiHit ? "acertado" : "")}
      </div>
      <div class="breakdown-total"><span>Total</span><b>${b.total} pts</b></div>
    </div>
    <div class="card">
      <h3>${icon("chart-line")}Evolución</h3>
      ${myEvo.length ? (() => {
        const EVO_SHOWN = 5;
        const extra = myEvo.length - EVO_SHOWN;
        const rows = myEvo.map((e, i) =>
          `<tr class="${i >= EVO_SHOWN ? "evo-extra" : ""}"><td>${esc(e.label)}</td><td class="num"><b>${e.total}</b></td><td class="num">${e.position}ª</td></tr>`).join("");
        return `
        <div class="evo-table${extra > 0 ? " collapsed" : ""}">
          <div class="table-wrap"><table class="std">
            <thead><tr><th>Día</th><th class="num">Puntos</th><th class="num">Posición</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
          ${extra > 0 ? `<p class="evo-toggle-row"><button class="chip evo-more-btn" data-more="${extra}">${icon("chevron-down")}Ver más (${extra})</button></p>` : ""}
        </div>`;
      })() : `<p class="muted">Aún no hay partidos finalizados.</p>`}
      <p class="mt-sm"><button class="chip" onclick="window.print()">${icon("printer")}Exportar PDF</button></p>
    </div>
  </div>

  ${koPerfilSection(p, r, params)}

  ${sectionTitle("target", "Pronósticos por grupo")}
  ${groupBlocks}`;
}

function viewGrupos(params) {
  const sel = (params.get("g") || "A").toUpperCase();
  const g = CTX.groupsData.groups.find((x) => x.id === sel) || CTX.groupsData.groups[0];
  const complete = isGroupComplete(g.id, CTX.matches);
  const ranking = rankingOf();

  const chips = CTX.groupsData.groups.map((x) =>
    `<a class="chip ${x.id === g.id ? "active" : ""}" href="#/grupos?g=${x.id}">${x.id === "H" ? "H 🇪🇸" : x.id}</a>`).join("");

  const ms = CTX.matches.filter((m) => m.group === g.id);

  const predRows = ranking.map((r) => {
    const p = CTX.participants.find((x) => x.id === r.id);
    const pick = p.predictions.groups[g.id] || {};
    const gr = r.groupResults[g.id] || {};
    const cell = (teamId, ok) => teamId
      ? `<span class="${ok === true ? "hit" : ok === false ? "miss" : ""}">${teamShort(teamId)}${ok === true ? ` ${icon("check")}` : ok === false ? ` ${icon("x")}` : ""}</span>`
      : `<span class="muted">—</span>`;
    return `<tr>
      <td><a class="t-person" href="#/perfil/${esc(r.id)}">${avatarHTML(r.name, { size: "sm", demo: r.demo })} <span class="t-name">${esc(r.name)}</span></a></td>
      <td>${cell(pick.first, complete ? gr.first : null)}</td>
      <td>${cell(pick.second, complete ? gr.second : null)}</td>
      <td>${cell(pick.third, gr.third === true ? true : null)}</td>
      <td class="num">${complete ? `<b class="${(gr.pts || 0) > 0 ? "hit" : "muted"}">+${gr.pts || 0}</b>` : `<span class="muted">·</span>`}</td>
    </tr>`;
  }).join("");

  return `
  <div class="page-head"><h1>${icon("layout-grid")}Grupos</h1><p>Clasificación oficial calculada con los resultados reales + lo que pronosticó cada uno.</p></div>
  <div class="chips">${chips}</div>

  <h2 class="group-title">${g.name} ${complete ? `<span class="pill green">grupo cerrado</span>` : `<span class="pill">${ms.filter((m) => m.status === "finished").length}/6 jugados</span>`}</h2>
  <div class="grid grid-2 align-start">
    <div class="min0">
      ${sectionTitle("list-ordered", "Clasificación oficial")}
      ${groupTableHTML(g)}
      ${sectionTitle("calendar-days", "Partidos")}
      <div class="grid gap-sm">${ms.map((m) => matchCard(m, { showVenue: false })).join("")}</div>
    </div>
    <div class="min0">
      ${sectionTitle("target", "Predicciones de la peña")}
      <div class="table-wrap">
        <table class="std">
          <thead><tr><th>Participante</th><th>1º (4 pts)</th><th>2º (2 pts)</th><th>3º (1 pt*)</th><th class="num">Pts</th></tr></thead>
          <tbody>${predRows}</tbody>
        </table>
      </div>
      <p class="muted table-note">* El 3º puntúa si queda realmente 3º en su grupo cuando este cierra.</p>
    </div>
  </div>`;
}

function viewResultados(params) {
  const koAvailable = !!(CTX.bracket && isGroupStageComplete(CTX.matches));
  // Selector de fase: por defecto la eliminatoria si ya está disponible.
  let fase = params.get("fase");
  if (fase !== "grupos" && fase !== "elim") fase = koAvailable ? "elim" : "grupos";
  if (fase === "elim" && !koAvailable) fase = "grupos";

  const head = `
  <div class="page-head"><h1>${icon("calendar-days")}Resultados y calendario</h1><p>${CTX.matches.filter((m) => m.status === "finished").length} de ${CTX.matches.length} partidos finalizados.</p></div>
  ${koAvailable ? `<div class="chips fase-toggle">
    <a class="chip ${fase === "grupos" ? "active" : ""}" href="#/resultados?fase=grupos">${icon("layout-grid")}Fase de grupos</a>
    <a class="chip ${fase === "elim" ? "active" : ""}" href="#/resultados?fase=elim">${icon("git-merge")}Eliminatoria</a>
  </div>` : ""}`;

  // ----- Vista eliminatoria -----
  if (fase === "elim") {
    const byRound = koMatchesByRound();
    const koSections = KO_RESULT_ROUNDS.filter((r) => byRound[r]).map((r) => `
      ${sectionTitle("git-merge", CTX.bracket.rounds[r] || r)}
      <div class="grid grid-2">${byRound[r].map((n) => koMatchCard(n)).join("")}</div>`).join("");
    return `${head}${koSections || `<p class="muted">Aún no hay cuadro de eliminatoria.</p>`}`;
  }

  // ----- Vista fase de grupos -----
  const fStatus = params.get("estado") || "todos";
  const fGroup = (params.get("g") || "").toUpperCase();

  let ms = [...CTX.matches];
  if (fStatus !== "todos") ms = ms.filter((m) => viewStatus(m) === fStatus);
  if (fGroup) ms = ms.filter((m) => m.group === fGroup);

  const mkChip = (label, val) =>
    `<a class="chip ${fStatus === val ? "active" : ""}" href="#/resultados?fase=grupos&estado=${val}${fGroup ? "&g=" + fGroup : ""}">${label}</a>`;

  const groupOpts = ["", ...CTX.groupsData.groups.map((g) => g.id)]
    .map((id) => `<option value="${id}" ${id === fGroup ? "selected" : ""}>${id ? "Grupo " + id : "Todos los grupos"}</option>`).join("");

  // Agrupar por jornada.
  const byDay = {};
  for (const m of ms) (byDay[m.matchday] ||= []).push(m);

  const sections = Object.keys(byDay).sort().map((j) => `
    ${sectionTitle("calendar", `Jornada ${j}`)}
    <div class="grid grid-2">${byDay[j].map((m) => matchCard(m)).join("")}</div>`).join("");

  return `
  ${head}
  <div class="chips filters">
    ${mkChip("Todos", "todos")}${mkChip("Pendientes", "pending")}${mkChip("En juego", "live")}${mkChip("Finalizados", "finished")}
    <select class="ctl" id="groupfilter">${groupOpts}</select>
  </div>
  ${sections || `<p class="muted">No hay partidos con ese filtro.</p>`}`;
}

const RULE_ICONS = { "Fase de Grupos": "layout-grid", "Fase Eliminatoria": "git-merge", "Bonus": "star", "Desempates": "scale" };

function viewReglas() {
  const sections = CTX.rules.rulesDisplay.map((sec) => `
    <div class="card">
      <h3>${icon(RULE_ICONS[sec.section] || "badge-check")}${esc(sec.section)}</h3>
      ${sec.items.map((it) => `<div class="rule-item"><span class="lbl">${esc(it.label)}</span><span class="val">${esc(it.value)}</span></div>`).join("")}
    </div>`).join("");
  return `
  <div class="page-head"><h1>${icon("scroll-text")}Reglas de la porra</h1>
  <p>${esc(CTX.rules.porraName)} · ${esc(CTX.rules.edition)}</p></div>
  <div class="grid grid-2 align-start">${sections}</div>`;
}

/** ¿Dos nombres de jugador se refieren al mismo? (tolera "Mbappé" vs "Kylian Mbappé"). */
function samePlayer(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 4 && (nb.includes(na) || na.includes(nb))) return true;
  return levenshtein(na, nb, 2) <= 2;
}

function scorerRow(s, pos) {
  const flag = (s.teamId && CTX.teamsById[s.teamId]?.flag) || "🏳️";
  const teamName = (s.teamId && CTX.teamsById[s.teamId]?.name) || s.teamName || "";
  // Porristas que apostaron por este goleador como pichichi.
  const backers = CTX.participants.filter((p) => p.pichichi && samePlayer(p.pichichi, s.name));
  const backersBadge = backers.length
    ? `<span class="pill gold" title="${esc(backers.map((b) => b.name).join(", "))}">${icon("ticket")}${backers.length}</span>`
    : "";
  const extra = [
    s.penalties ? `${s.penalties} de penalti` : "",
    s.assists ? `${s.assists} asist.` : "",
  ].filter(Boolean).join(" · ");
  return `
  <div class="scorer-row ${medalClass(pos)}" style="--i:${pos}">
    <div class="pos"><b>${pos}</b></div>
    <div class="who">
      <div class="nm">${pos === 1 ? icon("crown", "crown") : ""}${esc(s.name)} ${backersBadge}</div>
      <div class="sub"><span class="flag">${flag}</span>${esc(teamName)}${extra ? ` · ${esc(extra)}` : ""}</div>
    </div>
    <div class="goals"><b>${s.goals}</b><small>${s.goals === 1 ? "gol" : "goles"}</small></div>
  </div>`;
}

function viewGoleadores() {
  const scorers = CTX.scorers || [];
  const top = scorers[0] || null;

  // Apuestas de la peña: agrupa los pichichis elegidos y cruza con los goles reales.
  const picks = {};
  for (const p of CTX.participants) {
    if (!p.pichichi) continue;
    const key = normName(p.pichichi);
    if (!picks[key]) picks[key] = { label: p.pichichi, backers: [] };
    picks[key].backers.push(p.name);
  }
  const bets = Object.values(picks).map((b) => {
    const sc = scorers.find((s) => samePlayer(s.name, b.label));
    return { ...b, goals: sc ? sc.goals : 0, scoring: !!sc };
  }).sort((a, b) => b.goals - a.goals || b.backers.length - a.backers.length || a.label.localeCompare(b.label, "es"));

  const TOP_SCORERS = 30;
  const list = scorers.length
    ? `<div class="scorer-table">${scorers.slice(0, TOP_SCORERS).map((s, i) => scorerRow(s, i + 1)).join("")}</div>
       ${scorers.length > TOP_SCORERS ? `<p class="muted table-note">Mostrando el top ${TOP_SCORERS} de ${scorers.length} goleadores.</p>` : ""}`
    : `<div class="card empty-card">${icon("goal", "big")}
        <p>La tabla de máximos goleadores aparecerá en cuanto se marquen los primeros goles del torneo.</p></div>`;

  const betRows = bets.map((b) => `
    <tr>
      <td>${b.scoring && samePlayer(b.label, top?.name || "") ? icon("crown", "crown") : ""}${esc(b.label)}</td>
      <td class="num"><b class="${b.goals > 0 ? "hit" : "muted"}">${b.goals}</b></td>
      <td>${b.backers.map((n) => `<span class="chip mini">${esc(n)}</span>`).join(" ")}</td>
    </tr>`).join("");

  return `
  <div class="page-head">
    <h1>${icon("goal")}Máximos goleadores</h1>
    <p>Bota de oro del Mundial en directo${top ? ` · va de pichichi <b>${esc(top.name)}</b> con ${top.goals} ${top.goals === 1 ? "gol" : "goles"}` : ""}. El pichichi de la porra se concede a quien acierte el máximo goleador del torneo.</p>
  </div>

  ${sectionTitle("trophy", "Clasificación de goleadores")}
  ${list}

  ${sectionTitle("ticket", "Las apuestas de la peña")}
  <div class="table-wrap">
    <table class="std">
      <thead><tr><th>Pichichi apostado</th><th class="num">Goles</th><th>Porristas</th></tr></thead>
      <tbody>${betRows || `<tr><td colspan="3" class="muted">Nadie ha elegido pichichi todavía.</td></tr>`}</tbody>
    </table>
  </div>
  <p class="muted table-note">Los goles se actualizan automáticamente con la tabla oficial de la FIFA.</p>`;
}

/* ============================ Fase eliminatoria ============================ */

/** Resuelve una casilla del cuadro a un equipo concreto o, si aún no se sabe,
 *  a la etiqueta de posición (1º A, 2º B, 3º C/E/F…, Ganador 73). */
function resolveBracketSlot(slot, matchId) {
  if (!slot) return { label: "—" };
  if (slot.type === "w" || slot.type === "r") {
    const idx = slot.type === "w" ? 0 : 1;
    const label = (slot.type === "w" ? "1º " : "2º ") + slot.g;
    const g = CTX.groupsData.groups.find((x) => x.id === slot.g);
    if (!g) return { label };
    const table = computeGroupTable(g, CTX.matches);
    const teamId = table[idx]?.teamId;
    if (isGroupComplete(g.id, CTX.matches)) return { label, teamId, confirmed: true };
    const played = table.some((r) => r.pj > 0);
    return { label, provisional: played ? teamId : null };
  }
  if (slot.type === "t") {
    // El cruce del 3º lo fija la FIFA al cerrar la fase de grupos: lo cargamos en
    // tournament.bestThirds como { "<idPartido>": "<grupo>" }. Si ya está, mostramos
    // el equipo concreto; si no, la etiqueta con los grupos candidatos.
    const bt = CTX.tournament.bestThirds;
    const gId = bt && !Array.isArray(bt) ? bt[String(matchId)] : null;
    if (gId) {
      const g = CTX.groupsData.groups.find((x) => x.id === gId);
      if (g && isGroupComplete(g.id, CTX.matches)) {
        const teamId = computeGroupTable(g, CTX.matches)[2]?.teamId;
        if (teamId) return { label: "3º " + gId, teamId, confirmed: true };
      }
    }
    return { label: "3º " + slot.g.join("/"), third: true };
  }
  // El ganador / perdedor de un cruce: si ya se jugó, mostramos el equipo real;
  // si no, "Por definir" (como en los cuadros oficiales, sin el nº interno).
  const res = CTX.knockout?.results?.[String(slot.n)];
  if (slot.type === "m") {
    if (res?.winner) return { label: "Ganador #" + slot.n, teamId: res.winner, confirmed: true };
    return { label: "Por definir", tbd: true, fromMatch: slot.n };
  }
  if (slot.type === "l") {
    const loser = res?.loser || (res?.winner && res.home && res.away ? (res.winner === res.home ? res.away : res.home) : null);
    if (loser) return { label: "Perdedor #" + slot.n, teamId: loser, confirmed: true };
    return { label: "Perdedor semifinal", tbd: true, fromMatch: slot.n };
  }
  return { label: "—" };
}

/** Una línea de equipo dentro de un partido del cuadro. */
function bracketTeam(slot, matchId) {
  const r = resolveBracketSlot(slot, matchId);
  if (r.confirmed && r.teamId) {
    const t = CTX.teamsById[r.teamId];
    return `<div class="bk-team is-set"><span class="flag">${t?.flag || "🏳️"}</span><span class="nm">${esc(t?.name || r.teamId)}</span><span class="bk-tag">${esc(r.label)}</span></div>`;
  }
  if (r.provisional) {
    const t = CTX.teamsById[r.provisional];
    return `<div class="bk-team is-prov" title="Provisional · grupo sin cerrar"><span class="flag">${t?.flag || "🏳️"}</span><span class="nm">${esc(t?.name || r.provisional)}</span><span class="bk-tag prov">${esc(r.label)}</span></div>`;
  }
  const cls = r.third ? "is-third" : r.tbd ? "is-tbd" : "";
  return `<div class="bk-team ${cls}"><span class="bk-pos">${esc(r.label)}</span></div>`;
}

function bracketCard(n, { mirror = false } = {}) {
  const m = CTX.bracket.matches[String(n)];
  if (!m) return "";
  const d = fmtDate(m.date);
  return `
    <div class="bk-card${mirror ? " mirror" : ""}">
      <div class="bk-head"><span class="bk-no">#${n}</span><span class="bk-date">${d}${m.venue ? " · " + esc(m.venue) : ""}</span></div>
      ${bracketTeam(m.home, n)}
      <div class="bk-vs"><span>VS</span></div>
      ${bracketTeam(m.away, n)}
    </div>`;
}

function bracketMatch(n, { mirror = false, card = bracketCard } = {}) {
  return `<div class="bk-match">${card(n, { mirror })}</div>`;
}

function bracketColumn(title, nums, { side, round, mirror = false, card = bracketCard } = {}) {
  return `
  <div class="bk-col ${side} r-${round}">
    <div class="bk-col-head">${esc(title)}</div>
    <div class="bk-round">${nums.map((n) => bracketMatch(n, { mirror, card })).join("")}</div>
  </div>`;
}

const BK_ROUND_ORDER = ["r32", "r16", "qf", "sf", "final"];

/** ¿Están finalizados todos los partidos de una ronda del cuadro? */
function koRoundComplete(round) {
  if (!CTX.bracket) return false;
  const ids = Object.entries(CTX.bracket.matches).filter(([, m]) => m.round === round).map(([id]) => id);
  if (!ids.length) return false;
  return ids.every((id) => CTX.knockout?.results?.[id]?.status === "finished");
}

/** Ronda que conviene mostrar por defecto: la primera que aún no ha terminado
 *  (al acabar la Ronda de 32 entera, pasa a Octavos sola, y así sucesivamente). */
function defaultBracketRound() {
  for (const r of BK_ROUND_ORDER) if (!koRoundComplete(r)) return r;
  return "final";
}

/**
 * Cuerpo del cuadro (móvil + escritorio), reutilizable. `card(n, {mirror})` pinta
 * cada partido: el cuadro oficial usa bracketCard; el perfil de un participante
 * usa una versión con su pronóstico. `baseHref` dirige los chips de ronda (para
 * que en el perfil naveguen dentro del propio perfil, no a Eliminatorias).
 */
function bracketBody(params, { card = bracketCard, baseHref = "#/eliminatorias" } = {}) {
  const bk = CTX.bracket;
  const L = bk.layout.left, R = bk.layout.right, T = bk.rounds;
  // ----- Vista móvil: mini-cuadro de dos rondas conectadas (estilo Google) -----
  const sel = BK_ROUND_ORDER.includes(params?.get("ronda")) ? params.get("ronda") : defaultBracketRound();
  const ADJ = { r32: "r16", r16: "qf", qf: "sf", sf: "final", final: null };
  const linRound = (r) => (r === "final" ? bk.layout.final : [...(L[r] || []), ...(R[r] || [])]);
  const sep = baseHref.includes("?") ? "&" : "?";
  const roundChips = BK_ROUND_ORDER.map((r) =>
    `<a class="chip ${r === sel ? "active" : ""}" href="${baseHref}${sep}ronda=${r}">${esc(T[r])}</a>`).join("");

  const leftNums = linRound(sel);
  const nextR = ADJ[sel];
  const rightNums = nextR ? linRound(nextR) : [];
  const miniH = Math.max(1, leftNums.length) * 122;
  const mobileBracket = sel === "final"
    ? `<div class="bk-final-wrap">
         <div class="bk-champ inline">${icon("crown", "crown")}<span>Final · Campeón del Mundo</span></div>
         ${card(bk.layout.final[0])}
         <div class="bk-third">
           <div class="bk-third-head">${icon("medal")}${esc(T.tp)}</div>
           ${card(103)}
         </div>
       </div>`
    : `<div class="bk-mini-scroll">
         <div class="bk-mini" style="height:${miniH}px">
           <div class="bk-mini-col send">${leftNums.map((n) => `<div class="bk-match">${card(n)}</div>`).join("")}</div>
           <div class="bk-mini-col recv">${rightNums.map((n) => `<div class="bk-match">${card(n)}</div>`).join("")}</div>
         </div>
       </div>
       <p class="muted bk-mini-hint">${esc(T[sel])} → ${esc(T[nextR])}. Desliza para ver el resto.</p>`;

  const mobileList = `
    <div class="chips bk-rounds">${roundChips}</div>
    ${mobileBracket}`;

  // ----- Vista escritorio: cuadro completo conectado -----
  const fullBracket = `
    <div class="bracket-scroll">
      <div class="bracket">
        ${bracketColumn(T.r32, L.r32, { side: "left", round: "r32", card })}
        ${bracketColumn(T.r16, L.r16, { side: "left", round: "r16", card })}
        ${bracketColumn(T.qf, L.qf, { side: "left", round: "qf", card })}
        ${bracketColumn(T.sf, L.sf, { side: "left", round: "sf", card })}
        <div class="bk-col final r-final">
          <div class="bk-col-head">${icon("trophy")}${esc(T.final)}</div>
          <div class="bk-round">${bracketMatch(bk.layout.final[0], { card })}
            <div class="bk-champ">${icon("crown", "crown")}<span>Campeón del Mundo</span></div>
            <div class="bk-third">
              <div class="bk-third-head">${icon("medal")}${esc(T.tp)}</div>
              ${card(103)}
            </div>
          </div>
        </div>
        ${bracketColumn(T.sf, R.sf, { side: "right", round: "sf", mirror: true, card })}
        ${bracketColumn(T.qf, R.qf, { side: "right", round: "qf", mirror: true, card })}
        ${bracketColumn(T.r16, R.r16, { side: "right", round: "r16", mirror: true, card })}
        ${bracketColumn(T.r32, R.r32, { side: "right", round: "r32", mirror: true, card })}
      </div>
    </div>`;

  return `
  <div class="bk-mobile">${mobileList}</div>
  <div class="bk-desktop">${fullBracket}</div>`;
}

function viewEliminatorias(params) {
  const bk = CTX.bracket;
  if (!bk) return `<div class="card error-card">${icon("triangle-alert", "big")}<h2>No hay datos del cuadro</h2><p class="muted">Falta data/bracket.json.</p></div>`;
  return `
  <div class="page-head bk-page-head">
    <h1>${icon("git-merge")}Fase eliminatoria</h1>
    <p>Cuadro oficial del Mundial 2026. El <b>1º</b> y <b>2º</b> de cada grupo se rellenan solos al cerrarse; los <b>terceros</b> los asigna la FIFA al final.</p>
  </div>

  <div class="bk-legend">
    <span class="key"><span class="sw set"></span>Clasificado</span>
    <span class="key"><span class="sw prov"></span>Provisional</span>
    <span class="key"><span class="sw third"></span>Tercero por determinar</span>
  </div>

  ${bracketBody(params, { card: bracketCard, baseHref: "#/eliminatorias" })}
  <p class="muted table-note bk-desktop">Desliza el cuadro en horizontal para verlo entero. Cruces oficiales según el reglamento FIFA del Mundial 2026.</p>`;
}

/* ===================== Mi Quiniela (constructor de cuadro) =====================
   Sección interactiva: cada porrista rellena su propio cuadro eliminatorio
   (quién pasa en cada ronda hasta el campeón) y lo exporta para mandármelo.
   Se desbloquea cuando termina la fase de grupos. Las picks se guardan en el
   propio navegador (localStorage); nada viaja a ningún servidor. */

const Q_KEY = "porra2026:quiniela";
const KO_ROUND_ORDER = ["r32", "r16", "qf", "sf", "final"];

/* Vista previa (solo admin, vía #/quiniela?preview=1): desbloquea el constructor
   antes de tiempo y rellena las casillas con la clasificación PROVISIONAL de cada
   grupo, para poder probar el flujo aunque la fase de grupos no haya cerrado. */
let Q_PREVIEW = false;

function loadQuiniela() {
  try {
    const s = JSON.parse(localStorage.getItem(Q_KEY));
    if (s && typeof s === "object") return { name: s.name || "", picks: s.picks || {} };
  } catch { /* corrupto o sin acceso */ }
  return { name: "", picks: {} };
}
function saveQuiniela(st) {
  try { localStorage.setItem(Q_KEY, JSON.stringify({ name: st.name || "", picks: st.picks || {} })); }
  catch { /* modo incógnito / sin espacio */ }
}

/** Ids de partido de una ronda, ordenados cronológicamente (por fecha). */
function roundMatchIds(r) {
  const bk = CTX.bracket;
  const ids = (r === "final" ? bk.layout.final : [...(bk.layout.left[r] || []), ...(bk.layout.right[r] || [])]).map(String);
  return ids.sort((a, b) => {
    const da = bk.matches[a]?.date || "", db = bk.matches[b]?.date || "";
    return da < db ? -1 : da > db ? 1 : Number(a) - Number(b);
  });
}

/** Ids de partido del cuadro en orden cronológico (R32 → … → Final, y dentro de
 *  cada ronda por fecha). */
function orderedMatchIds() {
  const ids = [];
  for (const r of KO_ROUND_ORDER) ids.push(...roundMatchIds(r));
  return ids;
}

/** Equipo concreto que ocupa una casilla del cuadro, dado el estado de picks.
 *  Devuelve un teamId o null si aún no se conoce (grupo sin cerrar, tercero sin
 *  asignar por la FIFA, o partido previo sin resolver por el usuario). */
function qSlotTeam(slot, matchId, picks) {
  if (!slot) return null;
  if (slot.type === "w" || slot.type === "r") {
    const g = CTX.groupsData.groups.find((x) => x.id === slot.g);
    if (!g || (!Q_PREVIEW && !isGroupComplete(g.id, CTX.matches))) return null;
    return computeGroupTable(g, CTX.matches)[slot.type === "w" ? 0 : 1]?.teamId ?? null;
  }
  if (slot.type === "t") {
    // El cruce del 3º lo fija la FIFA al acabar la fase de grupos. Lo cargamos en
    // tournament.bestThirds como { "<idPartidoR32>": "<grupo>" }. Hasta entonces, null.
    const bt = CTX.tournament.bestThirds;
    let gId = bt && !Array.isArray(bt) ? bt[String(matchId)] : null;
    if (!gId && Q_PREVIEW) gId = Array.isArray(slot.g) ? slot.g[0] : slot.g; // siembra provisional para la demo
    if (!gId) return null;
    const g = CTX.groupsData.groups.find((x) => x.id === gId);
    if (!g || (!Q_PREVIEW && !isGroupComplete(g.id, CTX.matches))) return null;
    return computeGroupTable(g, CTX.matches)[2]?.teamId ?? null;
  }
  if (slot.type === "m") {
    const side = picks[String(slot.n)];
    if (!side) return null;
    const m = CTX.bracket.matches[String(slot.n)];
    return m ? qSlotTeam(m[side], slot.n, picks) : null;
  }
  return null;
}

/** Etiqueta de la casilla cuando aún no hay equipo (1º A, 2º B, 3º, Ganador #X). */
function qSlotLabel(slot) {
  if (!slot) return "—";
  if (slot.type === "w") return "1º " + slot.g;
  if (slot.type === "r") return "2º " + slot.g;
  if (slot.type === "t") return "3º (por asignar)";
  if (slot.type === "m") return "Ganador #" + slot.n;
  return "—";
}

/** Equipo que el usuario hace pasar de un partido (el del lado elegido). */
function qWinner(matchId, picks) {
  const m = CTX.bracket.matches[String(matchId)];
  const side = picks[String(matchId)];
  return m && side ? qSlotTeam(m[side], matchId, picks) : null;
}
/** El finalista que pierde la final (subcampeón) según la pick de la final. */
function qOtherFinalist(matchId, picks) {
  const m = CTX.bracket.matches[String(matchId)];
  const side = picks[String(matchId)];
  if (!m || !side) return null;
  return qSlotTeam(m[side === "home" ? "away" : "home"], matchId, picks);
}

/* ---- 3.er y 4.º puesto: lo disputan los dos perdedores de semifinales ----
   No es un partido del cuadro (no está en bracket.matches): lo derivamos de
   las picks de las semis. La elección se guarda en picks[Q_THIRD_KEY] como el
   id de la SEMIFINAL cuyo perdedor queda 3º (referenciar la semi, y no al
   equipo, mantiene la pick estable aunque se cambie quién pasa la semi). */
const Q_THIRD_KEY = "3p";
function qSemifinalIds() {
  const L = CTX.bracket.layout.left, R = CTX.bracket.layout.right;
  return [...(L.sf || []), ...(R.sf || [])].map(String);
}
/** [{ sf, team }] con el perdedor de cada semifinal (team = null si sin decidir). */
function qSemifinalLosers(picks) {
  return qSemifinalIds().map((id) => ({ sf: id, team: qOtherFinalist(id, picks) }));
}
/** Equipo que el usuario coloca 3º (el perdedor de la semi elegida). */
function qThird(picks) {
  const sel = picks[Q_THIRD_KEY];
  const losers = qSemifinalLosers(picks);
  if (!sel || losers.some((l) => !l.team)) return null;
  return losers.find((l) => l.sf === sel)?.team ?? null;
}
/** Equipo que queda 4º (el otro perdedor de semifinales). */
function qFourth(picks) {
  const sel = picks[Q_THIRD_KEY];
  const losers = qSemifinalLosers(picks);
  if (!sel || losers.some((l) => !l.team)) return null;
  return losers.find((l) => l.sf !== sel)?.team ?? null;
}

/** Elimina picks que han dejado de ser válidas (p. ej. al deshacer un ganador
 *  previo, la casilla "Ganador #X" vuelve a quedar vacía y arrastra a las
 *  siguientes). Itera en orden de ronda hasta estabilizar. Muta picks. */
function pruneQuiniela(picks) {
  const order = orderedMatchIds();
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of order) {
      if (!picks[id]) continue;
      const m = CTX.bracket.matches[id];
      if (!m || qSlotTeam(m[picks[id]], id, picks) == null) { delete picks[id]; changed = true; }
    }
  }
}

function qTeamRow(matchId, side, picks, ready) {
  const m = CTX.bracket.matches[matchId];
  const teamId = qSlotTeam(m[side], matchId, picks);
  if (!teamId) return `<div class="q-team is-pending"><span class="q-pos">${esc(qSlotLabel(m[side]))}</span></div>`;
  const t = CTX.teamsById[teamId];
  const selected = picks[matchId] === side;
  return `<button type="button" class="q-team ${selected ? "is-pick" : ""}" data-match="${matchId}" data-side="${side}"${ready ? "" : " disabled"} aria-pressed="${selected}">
    <span class="flag">${t?.flag || "🏳️"}</span><span class="nm">${esc(t?.name || teamId)}</span>
    ${selected ? icon("check", "q-check") : ""}
  </button>`;
}

function qMatchCard(matchId, picks) {
  const m = CTX.bracket.matches[matchId];
  const ready = qSlotTeam(m.home, matchId, picks) && qSlotTeam(m.away, matchId, picks);
  const d = fmtDate(m.date);
  return `<div class="q-card ${ready ? "" : "is-locked"}">
    <div class="q-card-head"><span class="q-no">#${matchId}</span><span class="q-date">${esc(d)}${m.venue ? " · " + esc(m.venue) : ""}</span></div>
    ${qTeamRow(matchId, "home", picks, ready)}
    <div class="q-vs">vs</div>
    ${qTeamRow(matchId, "away", picks, ready)}
  </div>`;
}

function qRoundSection(r, picks) {
  const bk = CTX.bracket;
  const ids = roundMatchIds(r);
  const picked = ids.filter((id) => picks[id]).length;
  const done = picked === ids.length;
  return `<div class="q-round">
    <div class="q-round-head"><span>${esc(bk.rounds[r])}</span><span class="q-progress ${done ? "done" : ""}">${picked}/${ids.length}</span></div>
    <div class="q-grid">${ids.map((id) => qMatchCard(id, picks)).join("")}</div>
  </div>`;
}

/** Tarjeta del 3.er y 4.º puesto: se activa al decidir las dos semifinales. */
function qThirdPlaceSection(picks) {
  const losers = qSemifinalLosers(picks);
  const ready = losers.every((l) => l.team);
  const sel = picks[Q_THIRD_KEY];
  const done = ready && !!sel;
  const row = (l) => {
    if (!l.team) return `<div class="q-team is-pending"><span class="q-pos">Perdedor SF #${l.sf}</span></div>`;
    const t = CTX.teamsById[l.team];
    const selected = sel === l.sf;
    return `<button type="button" class="q-team ${selected ? "is-pick" : ""}" data-third="${l.sf}"${ready ? "" : " disabled"} aria-pressed="${selected}">
      <span class="flag">${t?.flag || "🏳️"}</span><span class="nm">${esc(t?.name || l.team)}</span>
      ${selected ? icon("medal", "q-check") : ""}
    </button>`;
  };
  return `<div class="q-round">
    <div class="q-round-head"><span>3.er y 4.º puesto</span><span class="q-progress ${done ? "done" : ""}">${done ? 1 : 0}/1</span></div>
    <div class="q-grid"><div class="q-card q-card-third ${ready ? "" : "is-locked"}">
      <div class="q-card-head"><span class="q-no">🥉</span><span class="q-date">Quién gana el bronce</span></div>
      ${row(losers[0])}
      <div class="q-vs">vs</div>
      ${row(losers[1])}
    </div></div>
  </div>`;
}

/** Contenido recalculable: banner de campeón, progreso, rondas y exportación.
 *  Se re-renderiza solo (sin tocar el hash) cada vez que se elige un equipo. */
function quinielaInner(picks) {
  const bk = CTX.bracket;
  const finalId = String(bk.layout.final[0]);
  const champ = qWinner(finalId, picks);
  const runner = qOtherFinalist(finalId, picks);
  const third = qThird(picks);
  const total = orderedMatchIds().length + 1; // +1: el 3.er/4.º puesto
  const picked = orderedMatchIds().filter((id) => picks[id]).length + (third ? 1 : 0);
  const t = champ ? CTX.teamsById[champ] : null;

  const champBanner = `
    <div class="card q-champ-banner ${champ ? "is-set" : ""}">
      ${icon("crown", "crown q-crown")}
      <div class="q-champ-txt">
        <small>Tu campeón del mundo</small>
        <b>${champ ? `<span class="flag">${t?.flag || "🏳️"}</span> ${esc(t?.name || champ)}` : "Por decidir"}</b>
        ${runner ? `<span class="q-runner">Subcampeón: ${teamShort(runner)}</span>` : ""}
        ${third ? `<span class="q-runner">🥉 3.er puesto: ${teamShort(third)}</span>` : ""}
      </div>
      <div class="q-progress-big"><b>${picked}</b><span>/ ${total} cruces</span></div>
    </div>`;

  // ¿Hay casillas de tercero sin resolver? Avisamos (dependen de la FIFA).
  const pendingThirds = orderedMatchIds().some((id) => {
    const m = bk.matches[id];
    return (m.home?.type === "t" && !qSlotTeam(m.home, id, picks)) ||
           (m.away?.type === "t" && !qSlotTeam(m.away, id, picks));
  });
  const thirdsNote = pendingThirds
    ? `<p class="q-note">${icon("info")}Algunos cruces esperan al <b>mejor tercero</b>: se activarán en cuanto se confirme la asignación oficial de la FIFA.</p>`
    : "";

  // El 3.er/4.º puesto va justo antes de la Final (se juega antes en la realidad).
  const rounds = KO_ROUND_ORDER.map((r) =>
    (r === "final" ? qThirdPlaceSection(picks) : "") + qRoundSection(r, picks)
  ).join("");

  const actions = `
    <div class="q-actions">
      <button type="button" class="chip primary" data-action="wa">${icon("send")}Enviar por WhatsApp (PDF)</button>
    </div>
    <p class="muted table-note">Cuando lo tengas, mándamelo por WhatsApp en PDF y yo lo meto en la porra. Tus elecciones se guardan en este dispositivo automáticamente.</p>`;

  return champBanner + thirdsNote + rounds + actions;
}

function viewQuiniela(params) {
  Q_PREVIEW = params?.get("preview") === "1";
  if (!CTX.bracket) {
    return `<div class="card error-card">${icon("triangle-alert", "big")}<h2>No hay datos del cuadro</h2><p class="muted">Falta data/bracket.json.</p></div>`;
  }

  // ----- Bloqueada hasta que acabe la fase de grupos (salvo vista previa admin) -----
  if (!isGroupStageComplete(CTX.matches) && !Q_PREVIEW) {
    const pending = CTX.matches.filter((m) => m.status !== "finished");
    const lastDate = CTX.matches.reduce((mx, m) => (m.date > mx ? m.date : mx), "");
    return `
    <div class="page-head"><h1>${icon("list-checks")}Mi Quiniela</h1>
      <p>Tu cuadro de la fase eliminatoria: elige quién pasa en cada ronda hasta el campeón y expórtalo.</p></div>
    <div class="card q-locked">
      ${icon("lock", "big")}
      <h2>Disponible al terminar la fase de grupos</h2>
      <p class="muted">Esta sección se abre cuando se juegue el <b>último partido de la fase de grupos</b>. Entonces conoceremos los 1º y 2º de cada grupo y podrás montar tu cuadro.</p>
      <div class="q-lock-meta">
        <span class="pill">${icon("calendar-days")}Último partido: ${fmtDate(lastDate, false)}</span>
        <span class="pill gold">${icon("hourglass")}Quedan ${pending.length} ${pending.length === 1 ? "partido" : "partidos"}</span>
      </div>
      <p class="mt"><a class="chip" href="#/eliminatorias">${icon("git-merge")}Ver el cuadro oficial mientras tanto</a></p>
    </div>`;
  }

  // ----- Desbloqueada: constructor interactivo -----
  const st = loadQuiniela();
  pruneQuiniela(st.picks);
  saveQuiniela(st);
  const previewBanner = (Q_PREVIEW && !isGroupStageComplete(CTX.matches))
    ? `<div class="card q-preview-banner">${icon("flask-conical")}<div><b>Vista previa (solo tú)</b><span>La fase de grupos no ha terminado: el cuadro está sembrado con la <b>clasificación provisional</b> de ahora mismo, solo para que pruebes. Cuando cierren los grupos se rellenará con los puestos definitivos.</span></div></div>`
    : "";
  return `
  <div class="page-head"><h1>${icon("list-checks")}Mi Quiniela</h1>
    <p>Elige quién pasa en cada cruce y se irá rellenando hasta el campeón. Cuando acabes, expórtalo y mándamelo.</p></div>
  ${previewBanner}
  <div class="q-name-wrap">
    <label for="q-name">¿Quién eres? (para identificar el cuadro)</label>
    <select id="q-name" class="q-name">
      <option value="" ${st.name ? "" : "selected"} disabled>Elige tu nombre…</option>
      ${[...CTX.participants]
        .sort((a, b) => a.name.localeCompare(b.name, "es"))
        .map((p) => `<option value="${esc(p.name)}" ${p.name === st.name ? "selected" : ""}>${esc(p.name)}</option>`)
        .join("")}
    </select>
  </div>
  <div id="q-app">${quinielaInner(st.picks)}</div>`;
}

/** Texto bonito del cuadro para exportar (.txt / WhatsApp / PDF). */
function quinielaText(name, picks) {
  const bk = CTX.bracket;
  const finalId = String(bk.layout.final[0]);
  const tl = (id) => { const t = CTX.teamsById[id]; return t ? `${t.flag} ${t.name}` : "—"; };
  const winnersOf = (r) => roundMatchIds(r).map((id) => qWinner(id, picks)).filter(Boolean).map(tl);
  const champ = qWinner(finalId, picks);
  const runner = qOtherFinalist(finalId, picks);
  const third = qThird(picks);
  const fourth = qFourth(picks);

  const L = [];
  L.push("🏆 PORRA MUNDIAL 2026 · CUADRO ELIMINATORIO");
  L.push("👤 " + (name && name.trim() ? name.trim() : "(sin nombre)"));
  L.push("🗓 " + new Date().toLocaleDateString("es-ES", { day: "2-digit", month: "long", year: "numeric" }));
  L.push("");
  const sec = (title, arr) => { L.push(title); L.push(arr.length ? arr.join("\n") : "— (sin completar)"); L.push(""); };
  sec("🔵 PASAN A OCTAVOS", winnersOf("r32"));
  sec("🟣 PASAN A CUARTOS", winnersOf("r16"));
  sec("🟢 SEMIFINALISTAS", winnersOf("qf"));
  sec("🟠 FINALISTAS", winnersOf("sf"));
  L.push("🏆 CAMPEÓN DEL MUNDO: " + (champ ? tl(champ) : "—"));
  L.push("🥈 SUBCAMPEÓN: " + (runner ? tl(runner) : "—"));
  L.push("🥉 TERCER PUESTO: " + (third ? tl(third) : "—"));
  L.push("4️⃣ CUARTO PUESTO: " + (fourth ? tl(fourth) : "—"));
  L.push("");
  L.push("──────────");
  L.push("Detalle partido a partido:");
  for (const r of KO_ROUND_ORDER) {
    const ids = roundMatchIds(r);
    L.push("");
    L.push("· " + bk.rounds[r] + " ·");
    for (const id of ids) {
      const m = bk.matches[id];
      const h = qSlotTeam(m.home, id, picks), a = qSlotTeam(m.away, id, picks);
      const w = qWinner(id, picks);
      L.push(`#${id}: ${h ? tl(h) : qSlotLabel(m.home)} vs ${a ? tl(a) : qSlotLabel(m.away)}  → ${w ? tl(w) : "—"}`);
    }
  }
  const losers = qSemifinalLosers(picks);
  L.push("");
  L.push("· 3.er y 4.º puesto ·");
  L.push(`${losers[0].team ? tl(losers[0].team) : "Perdedor SF #" + losers[0].sf} vs ${losers[1].team ? tl(losers[1].team) : "Perdedor SF #" + losers[1].sf}  → ${third ? tl(third) : "—"}`);
  return L.join("\n");
}

/** Descarga un Blob ya generado (PDF) como fichero. */
function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Genera un PDF maquetado del cuadro (cabecera, podio y partido a partido con
 *  el ganador resaltado). Dibujado con primitivas de jsPDF y solo fuente
 *  Helvetica (los acentos del español sí se renderizan; nada de emojis ni
 *  flechas, que las fuentes estándar no soportan). Devuelve un Blob o null. */
function quinielaPdfBlob(name, picks) {
  const JsPDF = window.jspdf?.jsPDF;
  if (!JsPDF) return null;
  const bk = CTX.bracket;
  const doc = new JsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 40, contentW = W - M * 2;
  const C = {
    navy: [15, 23, 42], slate: [51, 65, 85], grey: [120, 130, 145],
    line: [228, 233, 240], soft: [243, 246, 250], white: [255, 255, 255],
    gold: [180, 134, 11], silver: [110, 122, 140], bronze: [176, 110, 46],
    green: [21, 128, 61], greenBg: [220, 248, 230], navyTxt: [203, 213, 225],
  };
  const fill = (c) => doc.setFillColor(c[0], c[1], c[2]);
  const txt = (c) => doc.setTextColor(c[0], c[1], c[2]);
  const draw = (c) => doc.setDrawColor(c[0], c[1], c[2]);
  const tname = (id) => CTX.teamsById[id]?.name || id || "—";
  let y = 0;

  // ---------- Cabecera ----------
  fill(C.navy); doc.rect(0, 0, W, 88, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(18); txt(C.white);
  doc.text("PORRA MUNDIAL 2026", M, 38);
  doc.setFont("helvetica", "normal"); doc.setFontSize(10); txt(C.navyTxt);
  doc.text("Cuadro de la fase eliminatoria", M, 56);
  doc.setFont("helvetica", "bold"); doc.setFontSize(13); txt(C.white);
  doc.text(name && name.trim() ? name.trim() : "(sin nombre)", W - M, 38, { align: "right" });
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); txt([148, 163, 184]);
  doc.text(new Date().toLocaleDateString("es-ES", { day: "2-digit", month: "long", year: "numeric" }), W - M, 56, { align: "right" });
  y = 88 + 22;

  // ---------- Podio (Campeón / Subcampeón / 3º / 4º) ----------
  const finalId = String(bk.layout.final[0]);
  const podium = [
    { lbl: "CAMPEÓN", team: qWinner(finalId, picks), col: C.gold },
    { lbl: "SUBCAMPEÓN", team: qOtherFinalist(finalId, picks), col: C.silver },
    { lbl: "3.er PUESTO", team: qThird(picks), col: C.bronze },
    { lbl: "4.º PUESTO", team: qFourth(picks), col: C.slate },
  ];
  const gap = 9, bw = (contentW - gap * 3) / 4, bh = 56;
  podium.forEach((p, i) => {
    const x = M + i * (bw + gap);
    fill(C.soft); doc.roundedRect(x, y, bw, bh, 6, 6, "F");
    fill(p.col); doc.roundedRect(x, y, 4, bh, 2, 2, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(7); txt(p.col);
    doc.text(p.lbl, x + 11, y + 17);
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); txt(C.navy);
    const nm = p.team ? tname(p.team) : "Por decidir";
    doc.text(doc.splitTextToSize(nm, bw - 16)[0], x + 11, y + 38);
  });
  y += bh + 24;

  // ---------- Detalle partido a partido ----------
  const ensure = (need) => { if (y + need > H - M) { doc.addPage(); y = M; } };
  const cellW = contentW * 0.42;
  const midX = M + contentW * 0.52;

  const roundHeader = (title) => {
    ensure(50);
    fill(C.navy); doc.roundedRect(M, y, contentW, 21, 4, 4, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); txt(C.white);
    doc.text(title.toUpperCase(), M + 10, y + 14.5);
    y += 21 + 7;
  };

  // Dibuja una casilla de equipo anclada en x (align left/right); resalta al ganador.
  const teamCell = (x, align, label, isWinner) => {
    doc.setFont("helvetica", isWinner ? "bold" : "normal"); doc.setFontSize(9.5);
    const t = doc.splitTextToSize(label, cellW)[0];
    if (isWinner) {
      const tw = doc.getTextWidth(t), padX = 5, chipH = 15, cx = align === "right" ? x - tw : x;
      fill(C.greenBg); doc.roundedRect(cx - padX, y + 1.5, tw + padX * 2, chipH, 4, 4, "F");
      txt(C.green);
    } else txt(C.slate);
    doc.text(t, x, y + 12, { align });
  };

  const matchRow = (numTxt, homeLbl, awayLbl, homeWin, awayWin) => {
    ensure(24);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); txt(C.grey);
    doc.text(numTxt, M + 2, y + 12);
    teamCell(midX - 16, "right", homeLbl, homeWin);
    doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); txt(C.grey);
    doc.text("vs", midX, y + 12, { align: "center" });
    teamCell(midX + 16, "left", awayLbl, awayWin);
    y += 19;
    draw(C.line); doc.line(M, y, M + contentW, y);
    y += 4;
  };

  // 3.er y 4.º puesto: no es un partido del cuadro (lo derivamos de las semis) y
  // va justo antes de la Final, como en la web.
  const thirdPlaceRow = () => {
    roundHeader(bk.rounds.tp || "Tercer puesto");
    const losers = qSemifinalLosers(picks);
    const third = qThird(picks);
    matchRow(
      "3-4",
      losers[0].team ? tname(losers[0].team) : "Perdedor semifinal",
      losers[1].team ? tname(losers[1].team) : "Perdedor semifinal",
      !!third && third === losers[0].team, !!third && third === losers[1].team,
    );
  };

  for (const r of KO_ROUND_ORDER) {
    if (r === "final") thirdPlaceRow();
    roundHeader(bk.rounds[r]);
    for (const id of roundMatchIds(r)) {
      const m = bk.matches[id];
      const hTeam = qSlotTeam(m.home, id, picks), aTeam = qSlotTeam(m.away, id, picks);
      const w = qWinner(id, picks);
      matchRow(
        "#" + id,
        hTeam ? tname(hTeam) : qSlotLabel(m.home),
        aTeam ? tname(aTeam) : qSlotLabel(m.away),
        !!w && w === hTeam, !!w && w === aTeam,
      );
    }
  }

  // ---------- Pie ----------
  ensure(20);
  doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); txt(C.grey);
  doc.text("Generado desde la web · Porra Mundial 2026", M, y + 10);

  doc.setProperties({ title: "Fase Eliminatoria" + (name ? " - " + name : "") });
  return doc.output("blob");
}

/** Comparte el PDF del cuadro por WhatsApp (hoja de compartir del sistema, que
 *  permite adjuntar el fichero). Si el dispositivo no admite compartir ficheros,
 *  descarga el PDF y abre WhatsApp con una nota para que lo adjunten a mano. */
async function shareQuinielaPdf(name, picks) {
  const blob = quinielaPdfBlob(name, picks);
  const cleanName = (name || "").replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim() || "sin nombre";
  const filename = `Fase Eliminatoria - ${cleanName}.pdf`;
  if (!blob) { // jsPDF no cargó (sin red): ventana imprimible como último recurso
    const text = quinielaText(name, picks);
    const w = window.open("", "_blank");
    if (w) {
      w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Cuadro Mundial 2026${name ? " - " + esc(name) : ""}</title></head>
        <body style="margin:0;background:#fff;color:#111"><pre style="font:14px/1.6 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;padding:28px">${esc(text)}</pre></body></html>`);
      w.document.close(); w.focus();
      setTimeout(() => w.print(), 250);
    }
    return;
  }
  const file = new File([blob], filename, { type: "application/pdf" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Cuadro Mundial 2026", text: `Cuadro de ${name || "la porra"} · Mundial 2026` });
      return;
    } catch (err) {
      if (err?.name === "AbortError") return; // el usuario canceló la hoja de compartir
    }
  }
  // Sin Web Share de ficheros (típico en escritorio): descargar + abrir WhatsApp.
  downloadBlob(filename, blob);
  window.open("https://wa.me/?text=" + encodeURIComponent(`Te paso mi cuadro del Mundial 2026 (${name || "sin nombre"}). Adjunto el PDF que acabo de descargar: ${filename}`), "_blank");
}

/* ================================ Router ================================ */

const routes = {
  home: viewHome,
  ranking: viewRanking,
  participantes: viewParticipantes,
  grupos: viewGrupos,
  resultados: viewResultados,
  goleadores: viewGoleadores,
  eliminatorias: viewEliminatorias,
  quiniela: viewQuiniela,
  reglas: viewReglas,
};

function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = h.split("?");
  const segs = pathPart.split("/").filter(Boolean);
  return { route: segs[0] || "home", arg: segs[1] || null, params: new URLSearchParams(queryPart || "") };
}

function render() {
  if (!CTX) return;
  const { route, arg, params } = parseHash();
  let html;
  if (route === "perfil" && arg) html = viewPerfil(decodeURIComponent(arg), params);
  else html = (routes[route] || viewHome)(params);

  $view.innerHTML = html;
  refreshIcons();
  $view.style.animation = "none";
  void $view.offsetWidth; // reinicia la animación de entrada
  $view.style.animation = "";
  window.scrollTo({ top: 0 });

  // Navegación activa
  const active = route === "perfil" ? "participantes" : route;
  document.querySelectorAll("[data-route]").forEach((a) => {
    a.classList.toggle("active", a.dataset.route === active);
  });
  document.getElementById("morebtn")?.classList.toggle(
    "active",
    ["participantes", "grupos", "quiniela", "goleadores", "reglas"].includes(active)
  );

  // Centra el chip activo en los carruseles de filtros (móvil).
  document.querySelector(".chips .chip.active")
    ?.scrollIntoView({ block: "nearest", inline: "center" });

  wireEvents(route, params);
}

/* --------------------------- Hoja "Más" (móvil) --------------------------- */

const $sheet = document.getElementById("more-sheet");
const $backdrop = document.getElementById("sheet-backdrop");

function openSheet() {
  $sheet.hidden = false;
  $backdrop.hidden = false;
  $sheet.classList.remove("closing");
  $backdrop.classList.remove("closing");
}

function closeSheet() {
  if ($sheet.hidden) return;
  $sheet.classList.add("closing");
  $backdrop.classList.add("closing");
  setTimeout(() => {
    $sheet.hidden = true;
    $backdrop.hidden = true;
    $sheet.classList.remove("closing");
    $backdrop.classList.remove("closing");
  }, 220);
}

document.getElementById("morebtn").addEventListener("click", () => {
  $sheet.hidden ? openSheet() : closeSheet();
});
$backdrop.addEventListener("click", closeSheet);
$sheet.addEventListener("click", (e) => { if (e.target.closest("a")) closeSheet(); });
window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

function wireEvents(route) {
  if (route === "perfil") {
    // "Ver más / Ver menos" de la tabla de evolución día a día.
    document.querySelector(".evo-table")?.addEventListener("click", (e) => {
      const btn = e.target.closest(".evo-more-btn");
      if (!btn) return;
      const wrap = btn.closest(".evo-table");
      const collapsed = wrap.classList.toggle("collapsed");
      btn.innerHTML = collapsed
        ? `${icon("chevron-down")}Ver más (${btn.dataset.more})`
        : `${icon("chevron-up")}Ver menos`;
      refreshIcons();
    });
  }
  if (route === "participantes") {
    const input = document.getElementById("psearch");
    input?.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      document.querySelectorAll(".participant-card").forEach((c) => {
        c.style.display = !q || c.dataset.name.includes(q) ? "" : "none";
      });
    });
  }
  if (route === "resultados") {
    document.getElementById("groupfilter")?.addEventListener("change", (e) => {
      const { params } = parseHash();
      const estado = params.get("estado") || "todos";
      location.hash = `#/resultados?fase=grupos&estado=${estado}${e.target.value ? "&g=" + e.target.value : ""}`;
    });
  }
  if (route === "quiniela") {
    const nameIn = document.getElementById("q-name");
    nameIn?.addEventListener("change", () => {
      const st = loadQuiniela(); st.name = nameIn.value; saveQuiniela(st);
    });
    const app = document.getElementById("q-app");
    app?.addEventListener("click", (e) => {
      // Elegir quién pasa en un cruce.
      const pick = e.target.closest("button[data-match]");
      if (pick && !pick.disabled) {
        const id = pick.dataset.match, side = pick.dataset.side;
        const st = loadQuiniela();
        if (st.picks[id] === side) delete st.picks[id]; // re-toque = deshacer
        else st.picks[id] = side;
        pruneQuiniela(st.picks);
        saveQuiniela(st);
        app.innerHTML = quinielaInner(st.picks);
        refreshIcons();
        return;
      }
      // Elegir quién gana el 3.er puesto (perdedor de una de las dos semis).
      const third = e.target.closest("button[data-third]");
      if (third && !third.disabled) {
        const sf = third.dataset.third;
        const st = loadQuiniela();
        if (st.picks[Q_THIRD_KEY] === sf) delete st.picks[Q_THIRD_KEY]; // re-toque = deshacer
        else st.picks[Q_THIRD_KEY] = sf;
        saveQuiniela(st);
        app.innerHTML = quinielaInner(st.picks);
        refreshIcons();
        return;
      }
      // Exportar: único botón → compartir el PDF por WhatsApp.
      const act = e.target.closest("button[data-action='wa']");
      if (!act) return;
      const st = loadQuiniela();
      act.disabled = true;
      shareQuinielaPdf(st.name, st.picks).finally(() => { act.disabled = false; });
    });
  }
  if (route === "eliminatorias") {
    // Cambiar de fase deslizando el dedo en horizontal (además de tocar las pestañas).
    const area = document.querySelector(".bk-mobile");
    if (area) {
      let x0 = null, y0 = null;
      area.addEventListener("touchstart", (e) => {
        const t = e.changedTouches[0]; x0 = t.clientX; y0 = t.clientY;
      }, { passive: true });
      area.addEventListener("touchend", (e) => {
        if (x0 == null) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - x0, dy = t.clientY - y0;
        x0 = null;
        // Solo un swipe horizontal claro (evita confundir con scroll vertical).
        if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        const cur = new URLSearchParams(location.hash.split("?")[1] || "").get("ronda") || defaultBracketRound();
        let i = BK_ROUND_ORDER.indexOf(cur); if (i < 0) i = 0;
        const ni = dx < 0 ? Math.min(BK_ROUND_ORDER.length - 1, i + 1) : Math.max(0, i - 1);
        if (ni !== i) location.hash = `#/eliminatorias?ronda=${BK_ROUND_ORDER[ni]}`;
      }, { passive: true });
    }
  }
}

/* ============================= Arranque ============================= */

async function loadJSON(file) {
  const res = await fetch(`data/${file}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`No se pudo cargar data/${file}`);
  return res.json();
}

async function boot() {
  refreshIcons(); // iconos estáticos de cabecera y navegación
  try {
    const [rules, groupsData, matchesFile, participantsFile, tournament, scorersFile, bracketFile, knockoutFile] = await Promise.all([
      loadJSON("scoring_rules.json"),
      loadJSON("groups.json"),
      loadJSON("matches.json"),
      loadJSON("participants.json"),
      loadJSON("tournament.json"),
      loadJSON("scorers.json").catch(() => ({ lastUpdated: null, scorers: [] })),
      loadJSON("bracket.json").catch(() => null),
      loadJSON("knockout.json").catch(() => ({ results: {} })),
    ]);
    CTX = buildContext({
      rules, groupsData,
      matches: matchesFile.matches,
      participants: participantsFile.participants,
      tournament,
      bracket: bracketFile,
      knockout: knockoutFile,
    });
    CTX.scorers = scorersFile.scorers || [];
    CTX.scorersUpdated = scorersFile.lastUpdated || null;
    CTX.bracket = bracketFile;
    document.getElementById("footer-updated").textContent =
      "última actualización: " + fmtUpdated(tournament.lastUpdated);
    render();

    // Resultados en tiempo real: fusiona la API en memoria y re-renderiza.
    startLive(CTX, () => {
      render();
      flashSyncIndicator();
    });
    setInterval(updateSyncIndicator, 30_000);
    updateSyncIndicator();

    // El estado "en juego" se infiere por la hora de inicio (no depende de la
    // API), así que repintamos solo cuando algún partido cruza ese umbral.
    let lastStatusSig = statusSignature();
    setInterval(() => {
      const sig = statusSignature();
      if (sig !== lastStatusSig) { lastStatusSig = sig; render(); }
    }, 30_000);
  } catch (err) {
    $view.innerHTML = `<div class="card error-card">
      ${icon("triangle-alert", "big")}
      <h2>No se pudieron cargar los datos</h2>
      <p class="muted">${esc(err.message)}</p>
      <p class="muted">Si abres el archivo en local, sirve la carpeta con <code>npm run serve</code> (fetch no funciona con file://).</p>
    </div>`;
    refreshIcons();
  }
}

/** Indicador de sincronización en vivo (punto verde de la cabecera). */
function updateSyncIndicator() {
  const el = document.getElementById("livesync");
  if (!el) return;
  const { lastSync, lastError } = liveStatus();
  if (lastError) {
    el.className = "livesync error";
    el.title = "Sin conexión con la API de resultados — mostrando datos guardados";
  } else if (lastSync) {
    el.className = "livesync ok";
    el.title = "Resultados en directo · sincronizado " +
      lastSync.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  }
}

function flashSyncIndicator() {
  updateSyncIndicator();
  const el = document.getElementById("livesync");
  el?.classList.add("flash");
  setTimeout(() => el?.classList.remove("flash"), 2000);
}

window.addEventListener("hashchange", render);

document.getElementById("sharebtn").addEventListener("click", async () => {
  const data = { title: "Porra Mundial 2026", text: "Sigue nuestra porra del Mundial 2026", url: location.href };
  if (navigator.share) {
    try { await navigator.share(data); } catch { /* cancelado */ }
  } else {
    await navigator.clipboard.writeText(location.href);
    const btn = document.getElementById("sharebtn");
    btn.innerHTML = icon("check");
    refreshIcons();
    setTimeout(() => { btn.innerHTML = icon("share-2"); refreshIcons(); }, 1500);
  }
});

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  // Auto-actualización: cuando un service worker nuevo toma el control (tras subir
  // CACHE_VERSION), recargamos una vez para servir el shell nuevo sin que el
  // usuario tenga que vaciar la caché a mano.
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").then((reg) => {
      // Busca actualizaciones al arrancar y cada vez que la pestaña vuelve a primer plano.
      reg.update().catch(() => {});
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update().catch(() => {});
      });
    }).catch(() => {});
  });
}

boot();
