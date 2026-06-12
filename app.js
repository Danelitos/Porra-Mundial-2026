/**
 * app.js — SPA de la Porra Mundial 2026.
 *
 * Carga los JSON de /data, construye el contexto con js/engine.js y
 * renderiza todas las vistas. Todo se recalcula en el cliente: basta con
 * actualizar data/matches.json (npm run result) y recargar.
 */

import {
  buildContext, computeRanking, computeParticipant, computeGroupTable,
  isGroupComplete, computeEvolution, computeScenarios, computeGlobalStats,
  signOf,
} from "./js/engine.js";
import { startLive, liveStatus } from "./js/live.js";

let CTX = null;

const $view = document.getElementById("view");
const PALETTE = ["#21c469", "#f5c343", "#4da3ff", "#ff5d6c", "#b07cff", "#3fd6c5", "#ff9f43", "#e84393", "#74b9ff", "#a3cb38", "#fd79a8", "#81ecec", "#ffeaa7", "#55efc4", "#fab1a0", "#00cec9", "#6c5ce7", "#fdcb6e", "#e17055", "#00b894"];

/* ============================ Utilidades UI ============================ */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function avatarHTML(name, { size = "", demo = false } = {}) {
  const initials = name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const hue = hashCode(name) % 360;
  const style = `background:linear-gradient(135deg,hsl(${hue},65%,45%),hsl(${(hue + 50) % 360},70%,32%))`;
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

/* ============================== Componentes ============================== */

function matchCard(m, { showVenue = true } = {}) {
  const score = m.score && m.status !== "pending"
    ? `${m.score.home} – ${m.score.away}`
    : `<span class="muted">VS</span>`;
  const minute = m.status === "live" && m.minute ? ` <span class="minute-badge">${esc(m.minute)}′</span>` : "";
  return `
  <div class="match-card ${m.status === "live" ? "is-live" : ""}">
    <div class="team"><span class="flag">${CTX.teamsById[m.home]?.flag || "🏳️"}</span><span class="nm">${esc(CTX.teamsById[m.home]?.name || m.home)}</span></div>
    <div class="score ${m.status === "pending" ? "pending" : ""}">${score}</div>
    <div class="team right"><span class="nm">${esc(CTX.teamsById[m.away]?.name || m.away)}</span><span class="flag">${CTX.teamsById[m.away]?.flag || "🏳️"}</span></div>
    <div class="meta">
      <span>Grupo ${m.group} · J${m.matchday} · ${fmtDate(m.date)}</span>
      ${showVenue && m.venue ? `<span>📍 ${esc(m.venue)}</span>` : ""}
      <span class="status-dot ${m.status}">${STATUS_LABEL[m.status]}${minute}</span>
    </div>
  </div>`;
}

/** Variación de posición respecto al día anterior (▲/▼/—). */
function positionDeltas() {
  const evo = computeEvolution(CTX);
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
  const icon = r.position === 1 ? "👑 " : "";
  const deltaHTML = delta == null || delta === 0
    ? `<span class="delta same">—</span>`
    : delta > 0
      ? `<span class="delta up">▲ ${delta}</span>`
      : `<span class="delta down">▼ ${-delta}</span>`;
  return `
  <a class="rank-row ${medal}" href="#/perfil/${esc(r.id)}" style="--i:${r.position}">
    <div class="pos"><b>${r.position}</b>${deltaHTML}</div>
    ${avatarHTML(r.name, { demo: r.demo })}
    <div class="who">
      <div class="nm">${icon}${esc(r.name)}${demoBadge(r)}</div>
      <div class="sub">${r.stats.exactHits} exactos · ${r.stats.signHits} signos · ${r.stats.accuracy}% acierto</div>
    </div>
    <div class="pts"><b>${r.breakdown.total}</b><small>puntos</small></div>
  </a>`;
}

/** Gráfico SVG de líneas: evolución de puntos por participante. */
function evolutionChart(checkpoints, { height = 260 } = {}) {
  if (!checkpoints.length) {
    return `<div class="card" style="text-align:center;color:var(--text-dim);padding:40px">
      📈 La evolución aparecerá aquí en cuanto haya partidos finalizados.</div>`;
  }
  const ids = checkpoints[checkpoints.length - 1].standings.map((s) => s.id);
  const W = 720, H = height, padL = 34, padR = 14, padT = 14, padB = 28;
  const maxPts = Math.max(4, ...checkpoints.flatMap((c) => c.standings.map((s) => s.total)));
  const x = (i) => padL + (i * (W - padL - padR)) / Math.max(1, checkpoints.length - 1);
  const y = (v) => padT + (H - padT - padB) * (1 - v / maxPts);

  let lines = "", labels = "", legend = "";
  ids.forEach((id, idx) => {
    const color = PALETTE[idx % PALETTE.length];
    const pts = checkpoints.map((c, i) => {
      const s = c.standings.find((st) => st.id === id);
      return `${x(i).toFixed(1)},${y(s ? s.total : 0).toFixed(1)}`;
    });
    const name = checkpoints[checkpoints.length - 1].standings.find((s) => s.id === id)?.name || id;
    lines += `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" opacity="0.9"/>`;
    const lastPt = pts[pts.length - 1].split(",");
    lines += `<circle cx="${lastPt[0]}" cy="${lastPt[1]}" r="3.5" fill="${color}"/>`;
    legend += `<span class="key"><span class="swatch" style="background:${color}"></span>${esc(name)}</span>`;
  });
  checkpoints.forEach((c, i) => {
    if (checkpoints.length <= 10 || i % Math.ceil(checkpoints.length / 10) === 0 || i === checkpoints.length - 1) {
      labels += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#5d6c86">${esc(c.label)}</text>`;
    }
  });
  let grid = "";
  for (let g = 0; g <= 4; g++) {
    const v = Math.round((maxPts * g) / 4);
    grid += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(255,255,255,0.06)"/>
             <text x="${padL - 6}" y="${y(v) + 3}" text-anchor="end" font-size="10" fill="#5d6c86">${v}</text>`;
  }
  return `<div class="card chart-card">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolución de puntos">${grid}${lines}${labels}</svg>
    <div class="legend">${legend}</div>
  </div>`;
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
    </tr>`).join("");
  return `
  <div class="table-wrap">
    <table class="std">
      <thead><tr><th>Equipo</th><th class="num">PJ</th><th class="num">PG</th><th class="num">PE</th><th class="num">PP</th>
      ${compact ? "" : `<th class="num">GF</th><th class="num">GC</th>`}<th class="num">DG</th><th class="num">Pts</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  ${played ? "" : `<p class="muted" style="font-size:0.78rem;margin:8px 2px 0">Orden alfabético hasta que se jueguen partidos. <span style="color:var(--green)">▎1º</span> y <span style="color:var(--blue)">▎2º</span> clasifican directo, <span style="color:var(--gold)">▎3º</span> puede entrar entre los 8 mejores terceros.</p>`}`;
}

/* ================================ Vistas ================================ */

function viewHome() {
  const ranking = computeRanking(CTX);
  const stats = computeGlobalStats(CTX);
  const top3 = ranking.slice(0, 3);
  const leader = ranking[0];
  const now = new Date().toISOString();
  const upcoming = CTX.matches.filter((m) => m.status !== "finished").slice(0, 5);
  const live = CTX.matches.filter((m) => m.status === "live");
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
          <p class="hero-sub">Del 11 de junio al 19 de julio. ${stats.participants} porristas, 72 partidos de fase de grupos y un solo trono. 🏆</p>
        </div>
        <img class="hero-logo" src="assets/logo.svg" alt="Emblema oficial del Mundial 2026" />
      </div>
      <div class="hero-meta">
        <span class="pill green">⚽ ${stats.matchesPlayed}/${stats.matchesTotal} partidos jugados</span>
        ${live.length ? `<span class="pill red">🔴 ${live.length} en juego</span>` : ""}
        <span class="pill gold">${anyPoints ? `👑 Líder: ${esc(leader.name)} (${leader.breakdown.total} pts)` : "👑 Todo por decidir"}</span>
        <span class="pill blue">📡 Resultados en directo</span>
        <span class="pill">🕑 ${fmtUpdated(CTX.tournament.lastUpdated)}</span>
      </div>
    </div>
    <div class="card">
      <h3 style="margin-bottom:14px">🏅 Top 3</h3>
      ${podium || `<p class="muted">Aún no hay suficientes participantes.</p>`}
      <p style="text-align:center;margin:14px 0 0"><a class="chip" href="#/ranking">Ver ranking completo →</a></p>
    </div>
  </div>

  <div class="section-title">📊 La porra en números</div>
  <div class="grid grid-4">
    <div class="card stat-tile"><div class="v green">${stats.participants}</div><div class="l">Participantes</div></div>
    <div class="card stat-tile"><div class="v blue">${stats.matchesPlayed}</div><div class="l">Partidos jugados</div></div>
    <div class="card stat-tile"><div class="v gold">${stats.totalExactHits}</div><div class="l">Exactos acertados</div></div>
    <div class="card stat-tile"><div class="v">${stats.totalGoals}</div><div class="l">Goles (${stats.avgGoals}/partido)</div></div>
  </div>

  ${live.length ? `<div class="section-title">🔴 En juego</div><div class="grid grid-2">${live.map((m) => matchCard(m)).join("")}</div>` : ""}

  <div class="section-title">📅 Próximos partidos</div>
  <div class="grid grid-2">
    ${upcoming.length ? upcoming.map((m) => matchCard(m)).join("") : `<p class="muted">No quedan partidos pendientes de la fase de grupos.</p>`}
  </div>

  <div class="section-title">📈 Evolución de la porra</div>
  ${evolutionChart(computeEvolution(CTX))}
  `;
}

function viewRanking() {
  const ranking = computeRanking(CTX);
  const deltas = positionDeltas();
  return `
  <div class="page-head">
    <h1>🏅 Ranking general</h1>
    <p>Se recalcula automáticamente con cada resultado oficial. Desempates: exactos → signos → grupos.</p>
  </div>
  <div class="chips">
    <button class="chip" onclick="window.print()">🖨 Exportar PDF</button>
  </div>
  <div class="rank-table">
    ${ranking.map((r) => rankRow(r, deltas[r.id] ?? null)).join("")}
  </div>`;
}

function viewParticipantes() {
  const ranking = computeRanking(CTX);
  const cards = ranking.map((r) => `
    <a class="card hover participant-card" href="#/perfil/${esc(r.id)}" data-name="${esc(r.name.toLowerCase())}">
      <div style="display:flex;align-items:center;gap:14px">
        ${avatarHTML(r.name, { size: "lg", demo: r.demo })}
        <div style="min-width:0">
          <h3 style="margin:0;font-size:1.05rem">${esc(r.name)}${demoBadge(r)}</h3>
          <div class="muted" style="font-size:0.8rem">Posición ${r.position}ª</div>
          <div style="font-family:var(--font-display);font-weight:800;font-size:1.2rem;color:var(--gold)">${r.breakdown.total} pts</div>
        </div>
      </div>
    </a>`).join("");

  return `
  <div class="page-head"><h1>👥 Participantes</h1><p>${ranking.length} porristas en liza. Los marcados como DEMO se sustituirán por porras reales.</p></div>
  <div class="searchbox">🔍 <input id="psearch" type="search" placeholder="Buscar participante…" autocomplete="off" /></div>
  <div class="grid grid-3" id="plist">${cards}</div>`;
}

function viewPerfil(id) {
  const p = CTX.participants.find((x) => x.id === id);
  if (!p) return `<div class="card">No existe ese participante. <a href="#/participantes">Volver</a></div>`;
  const ranking = computeRanking(CTX);
  const r = ranking.find((x) => x.id === id);
  const b = r.breakdown, s = r.stats;

  // Evolución individual de la posición.
  const evo = computeEvolution(CTX);
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
      return `<span class="pill ${ok === true ? "green" : ok === false ? "red" : ""}" style="margin:2px">${label} <b class="${cls}">${teamShort(teamId)}</b></span>`;
    };
    return `
    <div class="card" style="margin-bottom:14px">
      <h3 style="font-size:0.98rem">${g.name} ${gr.complete ? `<span class="pill green" style="margin-left:6px">cerrado · +${gr.pts || 0} pts</span>` : ""}</h3>
      <div class="table-wrap"><table class="std">
        <thead><tr><th>Partido</th><th class="num">Su pred.</th><th class="num">Real</th><th class="num">Pts</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div style="margin-top:10px">
        ${pick.first ? pickCell("1º", pick.first, gr.first) : ""}
        ${pick.second ? pickCell("2º", pick.second, gr.second) : ""}
        ${pick.third ? pickCell("3º", pick.third, gr.third === true ? true : null) : ""}
      </div>
    </div>`;
  }).join("");

  const maxBar = Math.max(1, b.total);
  const bar = (label, val, cls = "") => `
    <div class="bar-row"><span>${label}</span>
      <div class="track"><div class="fill ${cls}" style="width:${Math.min(100, (val / maxBar) * 100)}%"></div></div>
      <span class="val">${val}</span>
    </div>`;

  return `
  <a class="backlink" href="#/ranking">← Ranking</a>
  <div class="card profile-head">
    ${avatarHTML(p.name, { size: "lg", demo: p.demo })}
    <div class="who">
      <h1>${esc(p.name)}${demoBadge(p)}</h1>
      <div class="tagline">Posición ${r.position}ª de ${ranking.length} · ⚽ Pichichi: <b>${esc(p.pichichi || "sin elegir")}</b>${s.pichichiHit ? " ✅" : ""}</div>
    </div>
    <div class="bigpts"><b>${b.total}</b><span>puntos</span></div>
  </div>

  <div class="section-title">📊 Estadísticas</div>
  <div class="grid grid-4">
    <div class="card stat-tile"><div class="v green">${s.accuracy}%</div><div class="l">Acierto de signo</div></div>
    <div class="card stat-tile"><div class="v gold">${s.exactHits}</div><div class="l">Resultados exactos</div></div>
    <div class="card stat-tile"><div class="v blue">${s.winsHit + s.lossesHit}</div><div class="l">Victorias acertadas</div></div>
    <div class="card stat-tile"><div class="v">${s.drawsHit}</div><div class="l">Empates acertados</div></div>
  </div>

  <div class="grid grid-2" style="margin-top:14px">
    <div class="card">
      <h3 style="font-size:0.98rem">🧮 Desglose de puntos</h3>
      <div class="bars">
        ${bar("Signos (1·X·2)", b.signPts)}
        ${bar("Exactos", b.exactPts, "gold")}
        ${bar("Grupos (1º/2º)", b.groupPickPts, "blue")}
        ${bar("Terceros", b.thirdsPts, "blue")}
        ${bar("Pichichi", b.pichichiPts, "gold")}
      </div>
    </div>
    <div class="card">
      <h3 style="font-size:0.98rem">📈 Evolución</h3>
      ${myEvo.length ? `
        <div class="table-wrap"><table class="std">
          <thead><tr><th>Día</th><th class="num">Puntos</th><th class="num">Posición</th></tr></thead>
          <tbody>${myEvo.map((e) => `<tr><td>${esc(e.label)}</td><td class="num"><b>${e.total}</b></td><td class="num">${e.position}ª</td></tr>`).join("")}</tbody>
        </table></div>`
      : `<p class="muted">Aún no hay partidos finalizados.</p>`}
      <p style="margin:12px 0 0"><a class="chip" href="#/comparador?a=${esc(id)}">⚔️ Comparar con otro participante</a>
      <button class="chip" onclick="window.print()">🖨 Exportar PDF</button></p>
    </div>
  </div>

  <div class="section-title">🔮 Pronósticos por grupo</div>
  ${groupBlocks}`;
}

function viewGrupos(params) {
  const sel = (params.get("g") || "A").toUpperCase();
  const g = CTX.groupsData.groups.find((x) => x.id === sel) || CTX.groupsData.groups[0];
  const complete = isGroupComplete(g.id, CTX.matches);
  const table = computeGroupTable(g, CTX.matches);
  const ranking = computeRanking(CTX);

  const chips = CTX.groupsData.groups.map((x) =>
    `<a class="chip ${x.id === g.id ? "active" : ""}" href="#/grupos?g=${x.id}">${x.id === "H" ? "H 🇪🇸" : x.id}</a>`).join("");

  const ms = CTX.matches.filter((m) => m.group === g.id);

  const predRows = ranking.map((r) => {
    const p = CTX.participants.find((x) => x.id === r.id);
    const pick = p.predictions.groups[g.id] || {};
    const gr = r.groupResults[g.id] || {};
    const cell = (teamId, ok) => teamId
      ? `<span class="${ok === true ? "hit" : ok === false ? "miss" : ""}">${teamShort(teamId)}${ok === true ? " ✓" : ok === false ? " ✗" : ""}</span>`
      : `<span class="muted">—</span>`;
    return `<tr>
      <td><a href="#/perfil/${esc(r.id)}" style="display:flex;align-items:center;gap:8px">${avatarHTML(r.name, { size: "sm", demo: r.demo })} ${esc(r.name)}</a></td>
      <td>${cell(pick.first, complete ? gr.first : null)}</td>
      <td>${cell(pick.second, complete ? gr.second : null)}</td>
      <td>${cell(pick.third, gr.third === true ? true : null)}</td>
      <td class="num">${complete ? `<b class="${(gr.pts || 0) > 0 ? "hit" : "muted"}">+${gr.pts || 0}</b>` : `<span class="muted">·</span>`}</td>
    </tr>`;
  }).join("");

  return `
  <div class="page-head"><h1>⚽ Grupos</h1><p>Clasificación oficial calculada con los resultados reales + lo que pronosticó cada uno.</p></div>
  <div class="chips">${chips}</div>

  <h2 style="font-size:1.2rem">${g.name} ${complete ? `<span class="pill green">grupo cerrado</span>` : `<span class="pill">${ms.filter((m) => m.status === "finished").length}/6 jugados</span>`}</h2>
  <div class="grid grid-2" style="align-items:start">
    <div>
      <div class="section-title" style="margin-top:8px">📋 Clasificación oficial</div>
      ${groupTableHTML(g)}
      <div class="section-title">📅 Partidos</div>
      <div class="grid" style="gap:10px">${ms.map((m) => matchCard(m, { showVenue: false })).join("")}</div>
    </div>
    <div>
      <div class="section-title" style="margin-top:8px">🔮 Predicciones de la peña</div>
      <div class="table-wrap">
        <table class="std">
          <thead><tr><th>Participante</th><th>1º (4 pts)</th><th>2º (2 pts)</th><th>3º (1 pt*)</th><th class="num">Pts</th></tr></thead>
          <tbody>${predRows}</tbody>
        </table>
      </div>
      <p class="muted" style="font-size:0.76rem">* El 3º solo puntúa si queda 3º y entra entre los 8 mejores terceros del Mundial.</p>
    </div>
  </div>`;
}

function viewResultados(params) {
  const fStatus = params.get("estado") || "todos";
  const fGroup = (params.get("g") || "").toUpperCase();

  let ms = [...CTX.matches];
  if (fStatus !== "todos") ms = ms.filter((m) => m.status === fStatus);
  if (fGroup) ms = ms.filter((m) => m.group === fGroup);

  const mkChip = (label, val) =>
    `<a class="chip ${fStatus === val ? "active" : ""}" href="#/resultados?estado=${val}${fGroup ? "&g=" + fGroup : ""}">${label}</a>`;

  const groupOpts = ["", ...CTX.groupsData.groups.map((g) => g.id)]
    .map((id) => `<option value="${id}" ${id === fGroup ? "selected" : ""}>${id ? "Grupo " + id : "Todos los grupos"}</option>`).join("");

  // Agrupar por jornada.
  const byDay = {};
  for (const m of ms) (byDay[m.matchday] ||= []).push(m);

  const sections = Object.keys(byDay).sort().map((j) => `
    <div class="section-title">🗓 Jornada ${j}</div>
    <div class="grid grid-2">${byDay[j].map((m) => matchCard(m)).join("")}</div>`).join("");

  return `
  <div class="page-head"><h1>📅 Resultados y calendario</h1><p>${CTX.matches.filter((m) => m.status === "finished").length} de ${CTX.matches.length} partidos finalizados.</p></div>
  <div class="chips" style="align-items:center">
    ${mkChip("Todos", "todos")}${mkChip("Pendientes", "pending")}${mkChip("En juego", "live")}${mkChip("Finalizados", "finished")}
    <select class="ctl" id="groupfilter">${groupOpts}</select>
  </div>
  ${sections || `<p class="muted">No hay partidos con ese filtro.</p>`}`;
}

function viewEscenarios() {
  const sc = computeScenarios(CTX);
  const cards = sc.map((s) => {
    const isLeader = s.gapToLeader === 0;
    const pend = s.pendingMatches.slice(0, 4).map((x) => `
      <div class="it">
        <span>${teamShort(x.match.home)} <span class="muted">vs</span> ${teamShort(x.match.away)}</span>
        <span class="muted">su pred: <b style="color:var(--text)">${x.pred.home != null ? `${x.pred.home}-${x.pred.away}` : x.pred.sign}</b></span>
      </div>`).join("");
    return `
    <div class="card hover scenario-card">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
        ${avatarHTML(s.name, { demo: s.demo })}
        <div style="min-width:0">
          <h3 style="margin:0;font-size:1rem"><a href="#/perfil/${esc(s.id)}">${esc(s.name)}</a>${s.demo ? ` <span class="demo-badge">DEMO</span>` : ""}</h3>
          <div class="muted" style="font-size:0.78rem">${s.position}ª posición · ${s.total} pts</div>
        </div>
      </div>
      <div class="gap ${isLeader ? "leader" : ""}">${isLeader ? "👑 Es el líder" : `A ${s.gapToLeader} pts del líder`}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">
        <span class="pill blue">⏳ ${s.pendingWithPred} partidos por puntuar</span>
        <span class="pill gold">📈 Máx. alcanzable: ${s.maxReachable} pts</span>
        ${isLeader ? "" : s.canCatchLeader ? `<span class="pill green">✅ Aún puede alcanzar al líder</span>` : `<span class="pill red">❌ Ya no puede alcanzar al líder (solo grupos)</span>`}
      </div>
      ${pend ? `<div class="scenario-list"><div class="muted" style="font-size:0.74rem;text-transform:uppercase;letter-spacing:0.06em">Próximos partidos que le pueden dar puntos</div>${pend}</div>` : ""}
    </div>`;
  }).join("");

  return `
  <div class="page-head"><h1>🎯 ¿Qué necesita cada participante?</h1>
  <p>Distancia al líder, puntos aún en juego y escenarios favorables (solo fase de grupos: signo + exacto por partido, 1º/2º/3º de grupo y pichichi).</p></div>
  <div class="grid grid-2">${cards}</div>`;
}

function viewComparador(params) {
  const ranking = computeRanking(CTX);
  const aId = params.get("a") || ranking[0]?.id;
  const bId = params.get("b") || ranking[1]?.id;
  const opts = (sel) => ranking.map((r) => `<option value="${esc(r.id)}" ${r.id === sel ? "selected" : ""}>${esc(r.name)}${r.demo ? " (demo)" : ""}</option>`).join("");

  const A = ranking.find((r) => r.id === aId), B = ranking.find((r) => r.id === bId);
  let body = "";
  if (A && B) {
    const pa = CTX.participants.find((p) => p.id === A.id);
    const pb = CTX.participants.find((p) => p.id === B.id);
    // Coincidencias de pronóstico entre ambos.
    let sameExact = 0, sameSign = 0, total = 0;
    for (const m of CTX.matches) {
      const x = pa.predictions.matches[m.id], y = pb.predictions.matches[m.id];
      if (!x || !y) continue;
      total++;
      if (x.home === y.home && x.away === y.away) sameExact++;
      if (x.sign === y.sign) sameSign++;
    }
    const row = (label, va, vb, fmt = (v) => v) => `
      <div class="compare-row">
        <div class="c-val ${va > vb ? "win" : ""}">${fmt(va)}</div>
        <div class="c-lbl">${label}</div>
        <div class="c-val ${vb > va ? "win" : ""}">${fmt(vb)}</div>
      </div>`;
    body = `
    <div class="card">
      ${row("Puntos totales", A.breakdown.total, B.breakdown.total)}
      ${row("Posición", A.position, B.position, (v) => v + "ª")}
      ${row("Exactos", A.stats.exactHits, B.stats.exactHits)}
      ${row("Signos", A.stats.signHits, B.stats.signHits)}
      ${row("% acierto", A.stats.accuracy, B.stats.accuracy, (v) => v + "%")}
      ${row("Pts grupos", A.breakdown.groupPickPts, B.breakdown.groupPickPts)}
      ${row("Empates acertados", A.stats.drawsHit, B.stats.drawsHit)}
    </div>
    <div class="grid grid-3" style="margin-top:14px">
      <div class="card stat-tile"><div class="v blue">${total}</div><div class="l">Partidos comparables</div></div>
      <div class="card stat-tile"><div class="v gold">${sameExact}</div><div class="l">Mismo marcador exacto</div></div>
      <div class="card stat-tile"><div class="v green">${sameSign}</div><div class="l">Mismo signo</div></div>
    </div>
    <div class="grid grid-2" style="margin-top:14px">
      <div class="card"><h3 style="font-size:0.95rem">⚽ Pichichi de ${esc(A.name)}</h3><p style="margin:0;font-weight:700">${esc(pa.pichichi || "—")}</p></div>
      <div class="card"><h3 style="font-size:0.95rem">⚽ Pichichi de ${esc(B.name)}</h3><p style="margin:0;font-weight:700">${esc(pb.pichichi || "—")}</p></div>
    </div>`;
  }

  return `
  <div class="page-head"><h1>⚔️ Comparador</h1><p>Cara a cara entre dos participantes.</p></div>
  <div class="vs-head">
    <select class="ctl" id="cmpA">${opts(aId)}</select>
    <div class="vs">VS</div>
    <select class="ctl" id="cmpB">${opts(bId)}</select>
  </div>
  ${body}`;
}

function viewReglas() {
  const sections = CTX.rules.rulesDisplay.map((sec) => `
    <div class="card">
      <h3>${sec.icon} ${esc(sec.section)}</h3>
      ${sec.items.map((it) => `<div class="rule-item"><span class="lbl">${esc(it.label)}</span><span class="val">${esc(it.value)}</span></div>`).join("")}
    </div>`).join("");
  return `
  <div class="page-head"><h1>📜 Reglas de la porra</h1>
  <p>${esc(CTX.rules.porraName)} · ${esc(CTX.rules.edition)} — cargadas desde <code>data/scoring_rules.json</code>.</p></div>
  <div class="grid grid-2">${sections}</div>`;
}

/* ================================ Router ================================ */

const routes = {
  home: viewHome,
  ranking: viewRanking,
  participantes: viewParticipantes,
  grupos: viewGrupos,
  resultados: viewResultados,
  escenarios: viewEscenarios,
  comparador: viewComparador,
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
  if (route === "perfil" && arg) html = viewPerfil(decodeURIComponent(arg));
  else html = (routes[route] || viewHome)(params);

  $view.innerHTML = html;
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
    ["participantes", "escenarios", "comparador", "reglas"].includes(active)
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
      location.hash = `#/resultados?estado=${estado}${e.target.value ? "&g=" + e.target.value : ""}`;
    });
  }
  if (route === "comparador") {
    const upd = () => {
      const a = document.getElementById("cmpA").value;
      const b = document.getElementById("cmpB").value;
      location.hash = `#/comparador?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`;
    };
    document.getElementById("cmpA")?.addEventListener("change", upd);
    document.getElementById("cmpB")?.addEventListener("change", upd);
  }
}

/* ============================= Arranque ============================= */

async function loadJSON(file) {
  const res = await fetch(`data/${file}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`No se pudo cargar data/${file}`);
  return res.json();
}

async function boot() {
  try {
    const [rules, groupsData, matchesFile, participantsFile, tournament] = await Promise.all([
      loadJSON("scoring_rules.json"),
      loadJSON("groups.json"),
      loadJSON("matches.json"),
      loadJSON("participants.json"),
      loadJSON("tournament.json"),
    ]);
    CTX = buildContext({
      rules, groupsData,
      matches: matchesFile.matches,
      participants: participantsFile.participants,
      tournament,
    });
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
  } catch (err) {
    $view.innerHTML = `<div class="card" style="text-align:center;padding:40px">
      <h2>⚠️ No se pudieron cargar los datos</h2>
      <p class="muted">${esc(err.message)}</p>
      <p class="muted">Si abres el archivo en local, sirve la carpeta con <code>npm run serve</code> (fetch no funciona con file://).</p>
    </div>`;
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
  const data = { title: "Porra Mundial 2026", text: "Sigue nuestra porra del Mundial 2026 ⚽", url: location.href };
  if (navigator.share) {
    try { await navigator.share(data); } catch { /* cancelado */ }
  } else {
    await navigator.clipboard.writeText(location.href);
    const btn = document.getElementById("sharebtn");
    btn.textContent = "✓";
    setTimeout(() => (btn.textContent = "⤴"), 1500);
  }
});

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("service-worker.js").catch(() => {}));
}

boot();
