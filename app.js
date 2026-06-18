/**
 * app.js — SPA de la Porra Mundial 2026.
 *
 * Carga los JSON de /data, construye el contexto con js/engine.js y
 * renderiza todas las vistas. Todo se recalcula en el cliente: basta con
 * actualizar data/matches.json (npm run result) y recargar.
 */

import {
  buildContext, computeRanking, computeGroupTable,
  isGroupComplete, computeEvolution, computeGlobalStats,
  normName, levenshtein,
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
    <div class="team"><span class="flag">${CTX.teamsById[m.home]?.flag || "🏳️"}</span><span class="nm">${esc(CTX.teamsById[m.home]?.name || m.home)}</span></div>
    <div class="score ${st === "pending" ? "pending" : ""}">${score}</div>
    <div class="team right"><span class="nm">${esc(CTX.teamsById[m.away]?.name || m.away)}</span><span class="flag">${CTX.teamsById[m.away]?.flag || "🏳️"}</span></div>
    <div class="meta">
      <span>Grupo ${m.group} · J${m.matchday} · ${fmtDate(m.date)}</span>
      ${showVenue && m.venue ? `<span class="venue">${icon("map-pin")}${esc(m.venue)}</span>` : ""}
      <span class="status-dot ${st}">${STATUS_LABEL[st]}${minute}</span>
    </div>
  </div>`;
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

/** Gráfico SVG de líneas: evolución de puntos por participante. */
function evolutionChart(checkpoints, { height = 260 } = {}) {
  if (!checkpoints.length) {
    return `<div class="card empty-card">${icon("chart-line", "big")}
      <p>La evolución aparecerá aquí en cuanto haya partidos finalizados.</p></div>`;
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
  ${played ? "" : `<p class="muted table-note">Orden alfabético hasta que se jueguen partidos. <span style="color:var(--green)">▎1º</span> y <span style="color:var(--blue)">▎2º</span> clasifican directo, <span style="color:var(--gold)">▎3º</span> puntúa 1 pt si se acierta el equipo.</p>`}`;
}

/* ================================ Vistas ================================ */

function viewHome() {
  const ranking = rankingOf();
  const stats = globalStatsOf();
  const top3 = ranking.slice(0, 3);
  const leader = ranking[0];
  const upcoming = CTX.matches.filter((m) => viewStatus(m) === "pending").slice(0, 5);
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
          <p class="hero-sub">Del 11 de junio al 19 de julio. ${stats.participants} porristas, 72 partidos de fase de grupos y un solo trono.</p>
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
    <div class="card stat-tile"><div class="v blue">${stats.matchesPlayed}</div><div class="l">Partidos jugados</div></div>
    <div class="card stat-tile"><div class="v gold">${stats.totalExactHits}</div><div class="l">Exactos acertados</div></div>
    <div class="card stat-tile"><div class="v">${stats.totalGoals}</div><div class="l">Goles (${stats.avgGoals}/partido)</div></div>
  </div>

  ${live.length ? `${sectionTitle("radio", "En juego")}<div class="grid grid-2">${live.map((m) => matchCard(m)).join("")}</div>` : ""}

  ${sectionTitle("calendar-days", "Próximos partidos")}
  <div class="grid grid-2">
    ${upcoming.length ? upcoming.map((m) => matchCard(m)).join("") : `<p class="muted">No quedan partidos pendientes de la fase de grupos.</p>`}
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

function viewPerfil(id) {
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
  const bar = (label, val, cls = "") => `
    <div class="bar-row"><span>${label}</span>
      <div class="track"><div class="fill ${cls}" style="width:${Math.min(100, (val / maxBar) * 100)}%"></div></div>
      <span class="val">${val}</span>
    </div>`;

  return `
  <a class="backlink" href="#/ranking">${icon("arrow-left")}Ranking</a>
  <div class="card profile-head">
    ${avatarHTML(p.name, { size: "lg", demo: p.demo })}
    <div class="who">
      <h1>${esc(p.name)}${demoBadge(p)}</h1>
      <div class="tagline">Posición ${r.position}ª de ${ranking.length} · Pichichi: <b>${esc(p.pichichi || "sin elegir")}</b>${s.pichichiHit ? ` <span class="hit">${icon("check")}</span>` : ""}</div>
    </div>
    <div class="bigpts"><b>${b.total}</b><span>puntos</span></div>
  </div>

  ${sectionTitle("chart-column", "Estadísticas")}
  <div class="grid grid-4">
    <div class="card stat-tile"><div class="v green">${s.accuracy}%</div><div class="l">Acierto de signo</div></div>
    <div class="card stat-tile"><div class="v gold">${s.exactHits}</div><div class="l">Resultados exactos</div></div>
    <div class="card stat-tile"><div class="v blue">${s.winsHit + s.lossesHit}</div><div class="l">Victorias acertadas</div></div>
    <div class="card stat-tile"><div class="v">${s.drawsHit}</div><div class="l">Empates acertados</div></div>
  </div>

  <div class="grid grid-2 mt">
    <div class="card">
      <h3>${icon("layers")}Desglose de puntos</h3>
      <div class="bars">
        ${bar("Signos (1·X·2)", b.signPts)}
        ${bar("Exactos", b.exactPts, "gold")}
        ${bar("Grupos (1º/2º)", b.groupPickPts, "blue")}
        ${bar("Terceros", b.thirdsPts, "blue")}
        ${bar("Pichichi", b.pichichiPts, "gold")}
      </div>
    </div>
    <div class="card">
      <h3>${icon("chart-line")}Evolución</h3>
      ${myEvo.length ? `
        <div class="table-wrap"><table class="std">
          <thead><tr><th>Día</th><th class="num">Puntos</th><th class="num">Posición</th></tr></thead>
          <tbody>${myEvo.map((e) => `<tr><td>${esc(e.label)}</td><td class="num"><b>${e.total}</b></td><td class="num">${e.position}ª</td></tr>`).join("")}</tbody>
        </table></div>`
      : `<p class="muted">Aún no hay partidos finalizados.</p>`}
      <p class="mt-sm"><button class="chip" onclick="window.print()">${icon("printer")}Exportar PDF</button></p>
    </div>
  </div>

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
  const fStatus = params.get("estado") || "todos";
  const fGroup = (params.get("g") || "").toUpperCase();

  let ms = [...CTX.matches];
  if (fStatus !== "todos") ms = ms.filter((m) => viewStatus(m) === fStatus);
  if (fGroup) ms = ms.filter((m) => m.group === fGroup);

  const mkChip = (label, val) =>
    `<a class="chip ${fStatus === val ? "active" : ""}" href="#/resultados?estado=${val}${fGroup ? "&g=" + fGroup : ""}">${label}</a>`;

  const groupOpts = ["", ...CTX.groupsData.groups.map((g) => g.id)]
    .map((id) => `<option value="${id}" ${id === fGroup ? "selected" : ""}>${id ? "Grupo " + id : "Todos los grupos"}</option>`).join("");

  // Agrupar por jornada.
  const byDay = {};
  for (const m of ms) (byDay[m.matchday] ||= []).push(m);

  const sections = Object.keys(byDay).sort().map((j) => `
    ${sectionTitle("calendar", `Jornada ${j}`)}
    <div class="grid grid-2">${byDay[j].map((m) => matchCard(m)).join("")}</div>`).join("");

  return `
  <div class="page-head"><h1>${icon("calendar-days")}Resultados y calendario</h1><p>${CTX.matches.filter((m) => m.status === "finished").length} de ${CTX.matches.length} partidos finalizados.</p></div>
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

  const list = scorers.length
    ? `<div class="scorer-table">${scorers.map((s, i) => scorerRow(s, i + 1)).join("")}</div>`
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
function resolveBracketSlot(slot) {
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
  if (slot.type === "t") return { label: "3º " + slot.g.join("/"), third: true };
  // El ganador de una eliminatoria no se conoce hasta que se juega: como en los
  // cuadros oficiales, mostramos "Por definir" (no el nº interno de partido).
  if (slot.type === "m") return { label: "Por definir", tbd: true, fromMatch: slot.n };
  return { label: "—" };
}

/** Una línea de equipo dentro de un partido del cuadro. */
function bracketTeam(slot) {
  const r = resolveBracketSlot(slot);
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
  const d = new Date(m.date).toLocaleDateString("es-ES", { day: "numeric", month: "short" });
  return `
    <div class="bk-card${mirror ? " mirror" : ""}">
      <div class="bk-head"><span class="bk-no">#${n}</span><span class="bk-date">${d}${m.venue ? " · " + esc(m.venue) : ""}</span></div>
      ${bracketTeam(m.home)}
      <div class="bk-vs"><span>VS</span></div>
      ${bracketTeam(m.away)}
    </div>`;
}

function bracketMatch(n, { mirror = false } = {}) {
  return `<div class="bk-match">${bracketCard(n, { mirror })}</div>`;
}

function bracketColumn(title, nums, { side, round, mirror = false } = {}) {
  return `
  <div class="bk-col ${side} r-${round}">
    <div class="bk-col-head">${esc(title)}</div>
    <div class="bk-round">${nums.map((n) => bracketMatch(n, { mirror })).join("")}</div>
  </div>`;
}

const BK_ROUND_ORDER = ["r32", "r16", "qf", "sf", "final"];

function viewEliminatorias(params) {
  const bk = CTX.bracket;
  if (!bk) return `<div class="card error-card">${icon("triangle-alert", "big")}<h2>No hay datos del cuadro</h2><p class="muted">Falta data/bracket.json.</p></div>`;
  const L = bk.layout.left, R = bk.layout.right, T = bk.rounds;
  // ----- Vista móvil: mini-cuadro de dos rondas conectadas (estilo Google) -----
  // La pestaña elegida muestra esa ronda (izquierda) enlazada con la ronda a la
  // que avanza (derecha). El orden lineal izquierda+derecha del layout garantiza
  // que cada par de partidos contiguos alimenta al de la columna siguiente.
  const sel = BK_ROUND_ORDER.includes(params?.get("ronda")) ? params.get("ronda") : "r32";
  const ADJ = { r32: "r16", r16: "qf", qf: "sf", sf: "final", final: null };
  const linRound = (r) => (r === "final" ? bk.layout.final : [...(L[r] || []), ...(R[r] || [])]);
  const roundChips = BK_ROUND_ORDER.map((r) =>
    `<a class="chip ${r === sel ? "active" : ""}" href="#/eliminatorias?ronda=${r}">${esc(T[r])}</a>`).join("");

  const leftNums = linRound(sel);
  const nextR = ADJ[sel];
  const rightNums = nextR ? linRound(nextR) : [];
  const miniH = Math.max(1, leftNums.length) * 122; // alto = nº de partidos de la columna izquierda (deja separación entre tarjetas)
  const mobileBracket = sel === "final"
    ? `<div class="bk-final-wrap">
         <div class="bk-champ inline">${icon("crown", "crown")}<span>Final · Campeón del Mundo</span></div>
         ${bracketCard(bk.layout.final[0])}
       </div>`
    : `<div class="bk-mini-scroll">
         <div class="bk-mini" style="height:${miniH}px">
           <div class="bk-mini-col send">${leftNums.map((n) => `<div class="bk-match">${bracketCard(n)}</div>`).join("")}</div>
           <div class="bk-mini-col recv">${rightNums.map((n) => `<div class="bk-match">${bracketCard(n)}</div>`).join("")}</div>
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
        ${bracketColumn(T.r32, L.r32, { side: "left", round: "r32" })}
        ${bracketColumn(T.r16, L.r16, { side: "left", round: "r16" })}
        ${bracketColumn(T.qf, L.qf, { side: "left", round: "qf" })}
        ${bracketColumn(T.sf, L.sf, { side: "left", round: "sf" })}
        <div class="bk-col final r-final">
          <div class="bk-col-head">${icon("trophy")}${esc(T.final)}</div>
          <div class="bk-round">${bracketMatch(bk.layout.final[0])}
            <div class="bk-champ">${icon("crown", "crown")}<span>Campeón del Mundo</span></div>
          </div>
        </div>
        ${bracketColumn(T.sf, R.sf, { side: "right", round: "sf", mirror: true })}
        ${bracketColumn(T.qf, R.qf, { side: "right", round: "qf", mirror: true })}
        ${bracketColumn(T.r16, R.r16, { side: "right", round: "r16", mirror: true })}
        ${bracketColumn(T.r32, R.r32, { side: "right", round: "r32", mirror: true })}
      </div>
    </div>`;

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

  <div class="bk-mobile">${mobileList}</div>
  <div class="bk-desktop">${fullBracket}
    <p class="muted table-note">Desliza el cuadro en horizontal para verlo entero. Cruces oficiales según el reglamento FIFA del Mundial 2026.</p>
  </div>`;
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
    ["participantes", "eliminatorias", "goleadores", "reglas"].includes(active)
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
        const cur = new URLSearchParams(location.hash.split("?")[1] || "").get("ronda") || "r32";
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
    const [rules, groupsData, matchesFile, participantsFile, tournament, scorersFile, bracketFile] = await Promise.all([
      loadJSON("scoring_rules.json"),
      loadJSON("groups.json"),
      loadJSON("matches.json"),
      loadJSON("participants.json"),
      loadJSON("tournament.json"),
      loadJSON("scorers.json").catch(() => ({ lastUpdated: null, scorers: [] })),
      loadJSON("bracket.json").catch(() => null),
    ]);
    CTX = buildContext({
      rules, groupsData,
      matches: matchesFile.matches,
      participants: participantsFile.participants,
      tournament,
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
