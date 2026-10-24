/* =====================================================================
   IPL Management System - frontend (plain JavaScript, no build step)
   Every request shows the SQL that ran in the "Show SQL" panel.
   ===================================================================== */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = $('#view');

/* ---------- small helpers ---------------------------------------- */
const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const label = k => k.replace(/_/g, ' ').replace(/\bid\b/i, 'ID').replace(/\bpct\b/i, '%');
const CRORE = 1e7;
function money(n) {
  n = Number(n);
  if (!isFinite(n)) return '—';
  if (Math.abs(n) >= CRORE) return '₹' + (n / CRORE).toFixed(n % CRORE === 0 ? 0 : 2) + ' Cr';
  return '₹' + n.toLocaleString('en-IN');
}
const MONEY_KEY = /(price|purse|value|fee|spent|remaining|revenue|budget|lifetime)/i;
const NOT_MONEY = /^(squad_size|players_in_pool)$/;
const STATUS_CLASS = { Completed: 'ok', Sold: 'ok', Scheduled: 'warn', Pending: 'warn', 'No Result': 'bad', Unsold: 'bad' };

function cell(k, v, row) {
  if (v === null || v === undefined || v === '') return '<span class="muted">—</span>';
  if (typeof v === 'boolean') return v ? '<span class="pill ok">Yes</span>' : '<span class="muted">—</span>';
  if (k === 'status') return `<span class="pill ${STATUS_CLASS[v] || ''}">${esc(v)}</span>`;
  if (k === 'is_captain') return v ? '<span class="pill warn">Captain</span>' : '';
  if (typeof v === 'number' && MONEY_KEY.test(k) && !NOT_MONEY.test(k)) return money(v);
  return esc(v);
}

/* cols: array of 'key' | {k, h, f(value,row) -> html} */
function table(rows, cols, opt = {}) {
  if (!rows || !rows.length) return `<div class="empty">${esc(opt.empty || 'No rows')}</div>`;
  cols = cols || Object.keys(rows[0]);
  cols = cols.map(c => (typeof c === 'string' ? { k: c } : c));
  const head = cols.map(c => `<th class="${typeof rows[0][c.k] === 'number' ? 'num' : ''}">${esc(c.h ?? label(c.k))}</th>`).join('');
  const body = rows.map(r => {
    const href = opt.href ? opt.href(r) : null;
    return `<tr class="${href ? 'click' : ''}" ${href ? `data-href="${esc(href)}"` : ''}>` + cols.map(c => {
      const v = r[c.k];
      const html = c.f ? c.f(v, r) : cell(c.k, v, r);
      return `<td class="${typeof v === 'number' ? 'num' : ''}">${html}</td>`;
    }).join('') + '</tr>';
  }).join('');
  return `<div class="tbl-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
const kpi = (value, text) => `<div class="kpi"><b>${value}</b><span>${esc(text)}</span></div>`;
const card = (title, body) => `<section class="card"><h3>${esc(title)}</h3>${body}</section>`;
const chips = arr => `<div class="chips">${arr.map(x => `<span class="chip">${esc(x)}</span>`).join('')}</div>`;

/* make table rows with data-href clickable */
function wireLinks(root = view) {
  $$('tr[data-href], .card[data-href]', root).forEach(el =>
    el.addEventListener('click', e => { if (!e.target.closest('button, a')) location.hash = el.dataset.href; }));
}

/* ---------- state ------------------------------------------------- */
const state = { season: null, lookups: null };
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

/* ---------- Show SQL panel --------------------------------------- */
const SQL_TOKEN = /(--[^\n]*)|('(?:[^']|'')*')|(\$\d+)|\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|CROSS|ON|GROUP BY|ORDER BY|HAVING|LIMIT|AS|AND|OR|NOT|IN|EXISTS|CASE|WHEN|THEN|ELSE|END|WITH|UNION ALL|UNION|OVER|PARTITION BY|FILTER|DISTINCT|INSERT INTO|VALUES|UPDATE|SET|DELETE|CALL|BEGIN|COMMIT|ROLLBACK|READ ONLY|RETURNING|IS|NULL|DESC|ASC|ILIKE|LIKE|USING|ROLLUP|NULLS LAST|ON CONFLICT|DO UPDATE|UNNEST|WHERE|BETWEEN)\b/gi;
function highlight(sql) {
  return esc(sql).replace(SQL_TOKEN, (m, com, str, par) =>
    com ? `<span class="com">${m}</span>` : str ? `<span class="str">${m}</span>` :
    par ? `<span class="par">${m}</span>` : `<span class="kw">${m}</span>`);
}
function showSql(queries, error) {
  const qs = queries || [];
  $('#sqlCount').textContent = `${qs.length} ${qs.length === 1 ? 'query' : 'queries'}` + (error ? ' · error' : ' · last request');
  $('#sqlBody').innerHTML = qs.map(q =>
    `<pre>${highlight(q.text)}</pre>` +
    (q.params && q.params.length ? `<div class="params">params: ${esc(JSON.stringify(q.params))}</div>` : '')).join('') +
    (error ? `<div class="err"><b>PostgreSQL rejected this:</b> ${esc(error)}</div>` : '');
  if (error) $('#sqlbar').classList.add('open');
}
$('#sqlToggle').addEventListener('click', () => $('#sqlbar').classList.toggle('open'));

/* ---------- toast + api ------------------------------------------ */
function toast(msg, kind = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast' + (kind === 'err' ? ' err' : '');
  t.innerHTML = `<b>${kind === 'err' ? 'Database error' : 'Done'}</b>${esc(msg)}`;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 7000 : 3200);
}
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  showSql(j.queries, j.error);
  if (!r.ok) { toast(j.error, 'err'); const e = new Error(j.error); e.handled = true; throw e; }
  return j.data;
}
const get = url => api('GET', url);
const post = (url, body) => api('POST', url, body);
const put = (url, body) => api('PUT', url, body);
const remove = url => api('DELETE', url);

/* row buttons: btn() registers a click handler and returns the button html */
const handlers = new Map();
let handlerId = 0;
const btn = (text, fn, cls = '') => {
  const id = ++handlerId;
  handlers.set(id, fn);
  return `<button class="btn sm ${cls}" data-fn="${id}">${text}</button>`;
};
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-fn]');
  if (!b) return;
  e.stopPropagation();
  try { await handlers.get(Number(b.dataset.fn))(); } catch (err) { if (!err.handled) toast(err.message, 'err'); }
});
const editDel = (onEdit, onDel) => `<span class="rowact">${btn('Edit', onEdit)}${btn('Delete', onDel, 'danger')}</span>`;
/* confirm, DELETE, then refresh */
const confirmDelete = (what, url, after) => async () => {
  if (!confirm(`Delete ${what}? This cannot be undone.`)) return;
  await remove(url);
  toast('Deleted');
  await refreshLookups();
  (after || render)();
};
const ACT = { k: '_act', h: '' };
const S = url => url + (url.includes('?') ? '&' : '?') + 'season=' + state.season;

/* ---------- form dialog ------------------------------------------ */
function fieldHtml(f) {
  const req = f.required === false ? '' : 'required';
  let input;
  if (f.type === 'select') {
    input = `<select name="${f.name}" ${req}>${f.blank ? `<option value="">${esc(f.blank)}</option>` : ''}${f.options.map(o =>
      `<option value="${esc(o.v)}" ${String(o.v) === String(f.value ?? '') ? 'selected' : ''}>${esc(o.l)}</option>`).join('')}</select>`;
  } else if (f.type === 'checks') {
    input = `<div class="checks">${f.options.map(o => `<label><input type="checkbox" name="${f.name}" value="${esc(o.v)}" ${(f.checked || []).map(String).includes(String(o.v)) ? 'checked' : ''}> ${esc(o.l)}</label>`).join('')}</div>`;
  } else if (f.type === 'textarea') {
    input = `<textarea name="${f.name}" rows="3">${esc(f.value ?? '')}</textarea>`;
  } else {
    input = `<input name="${f.name}" type="${f.type || 'text'}" ${req} value="${esc(f.value ?? '')}"
      ${f.step ? `step="${f.step}"` : ''} ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''}
      ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}>`;
  }
  // checkbox groups must not sit inside a <label> (clicking the caption would toggle the first box)
  const tag = f.type === 'checks' ? 'div' : 'label';
  return `<${tag} class="field"><span>${esc(f.label)}</span>${input}</${tag}>`;
}
function openForm({ title, note, fields, submit = 'Save', onSubmit }) {
  const dlg = $('#dlg');
  dlg.innerHTML = `<form class="form" method="dialog"><h3>${esc(title)}</h3>${note ? `<p class="note">${esc(note)}</p>` : ''}
    ${fields.map(fieldHtml).join('')}
    <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">${esc(submit)}</button></div></form>`;
  const form = $('form', dlg);
  $('[data-close]', dlg).onclick = () => dlg.close();
  form.onsubmit = async e => {
    e.preventDefault();
    const vals = {};
    for (const f of fields) {
      if (f.type === 'checks') vals[f.name] = $$(`input[name="${f.name}"]:checked`, form).map(x => x.value);
      else {
        const v = form.elements[f.name].value;
        vals[f.name] = v === '' ? null : (f.type === 'number' || f.num ? Number(v) : v);
      }
    }
    try { await onSubmit(vals); dlg.close(); } catch (err) { if (!err.handled) toast(err.message, 'err'); }
  };
  dlg.showModal();
}
const opts = (rows, v, l) => rows.map(r => ({ v: r[v], l: r[l] }));

/* ---------- router ------------------------------------------------ */
const NAV = [['dashboard', 'Dashboard'], ['seasons', 'Seasons'], ['teams', 'Teams'], ['players', 'Players'],
  ['auctions', 'Auctions'], ['matches', 'Matches'], ['stadiums', 'Stadiums'], ['umpires', 'Umpires'],
  ['sponsors', 'Sponsors'], ['reports', 'Reports'], ['console', 'SQL Console']];
$('#nav').innerHTML = NAV.map(([k, t]) => `<a href="#/${k}" data-k="${k}">${t}</a>`).join('');

async function render() {
  const [page, id] = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/');
  const fn = pages[page] || pages.dashboard;
  $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.k === page));
  $('#pageTitle').textContent = (NAV.find(n => n[0] === page) || NAV[0])[1];
  $('#side').classList.remove('open');
  try { await fn(id); wireLinks(); }
  catch (e) { if (!e.handled) console.error(e); view.innerHTML = `<div class="empty">Could not load this page: ${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', render);
$('#menuBtn').addEventListener('click', () => $('#side').classList.toggle('open'));
$('#seasonSel').addEventListener('change', e => { state.season = Number(e.target.value); store.set('ipl.season', state.season); render(); });

/* =====================================================================
   PAGES
   ===================================================================== */
const back = (href, text) => `<p><a href="${href}">← ${esc(text)}</a></p>`;
const pages = {};

/* ---------- Dashboard -------------------------------------------- */
pages.dashboard = async () => {
  const d = await get(S('/api/dashboard'));
  const k = d.kpi;
  view.innerHTML = `
    <div class="kpis">${kpi(k.teams, 'Teams')}${kpi(k.players, 'Players in squads')}${kpi(k.played, 'Matches played')}
      ${kpi(k.remaining, 'Matches remaining')}${kpi(money(k.sponsorship), 'Sponsorship value')}</div>
    ${card('Points table (view: v_points_table)', table(d.points, ['position', 'team_name', 'played', 'won', 'lost', 'no_result', 'points']))}
    <div class="grid g2" style="margin-top:16px">
      ${card('Top run scorers', table(d.runs, ['player_name', 'runs'], { empty: 'No performances yet' }))}
      ${card('Top wicket takers', table(d.wickets, ['player_name', 'wickets'], { empty: 'No performances yet' }))}
    </div>`;
};

/* ---------- Seasons ---------------------------------------------- */
pages.seasons = async () => {
  const rows = await get('/api/seasons');
  view.innerHTML = `<div class="bar"><span class="grow muted">Total matches and title sponsor are <b>calculated</b> from other tables, not stored.</span>
      <button class="btn primary" id="addSeason">+ New season</button></div>
    ${table(rows, ['season_year', 'start_date', 'end_date', 'teams', 'total_matches', 'title_sponsor',
      { ...ACT, f: (_, r) => editDel(() => openForm({
          title: `Edit season ${r.season_year}`, note: 'CHECK constraint: end date must be after start date.',
          fields: [{ name: 'season_year', label: 'Year', type: 'number', value: r.season_year },
            { name: 'start_date', label: 'Start date', type: 'date', value: r.start_date }, { name: 'end_date', label: 'End date', type: 'date', value: r.end_date }],
          onSubmit: async v => { await put('/api/seasons/' + r.season_id, v); toast('Season updated'); await refreshLookups(); render(); },
        }), confirmDelete(`season ${r.season_year}`, '/api/seasons/' + r.season_id)) }],
      { href: r => '#/seasons/' + r.season_id })}
    <div id="sdetail" style="margin-top:18px"></div>`;
  $('#addSeason').onclick = () => openForm({
    title: 'New season', note: 'CHECK constraint: end date must be after start date.',
    fields: [{ name: 'season_year', label: 'Year', type: 'number', value: new Date().getFullYear() },
      { name: 'start_date', label: 'Start date', type: 'date' }, { name: 'end_date', label: 'End date', type: 'date' }],
    onSubmit: async v => { await post('/api/seasons', v); toast('Season created'); await refreshLookups(); render(); },
  });
};
pages.seasons.detail = null;
const seasonsDetail = async id => {
  const d = await get('/api/seasons/' + id);
  const tabs = {
    Teams: table(d.teams), Matches: table(d.matches, ['match_date', 'match_type', 'team1', 'team2', 'status', 'winner']),
    Sponsors: table(d.sponsors), Auction: table(d.auctions, ['auction_date', 'venue'], { href: r => '#/auctions/' + r.auction_id }),
  };
  const box = $('#sdetail');
  const draw = name => {
    box.innerHTML = `<div class="tabs">${Object.keys(tabs).map(t => `<button class="${t === name ? 'on' : ''}" data-t="${t}">${t}</button>`).join('')}</div>${tabs[name]}`;
    $$('button[data-t]', box).forEach(b => b.onclick = () => draw(b.dataset.t));
    wireLinks(box);
  };
  draw('Teams');
};
{ const base = pages.seasons; pages.seasons = async id => { await base(); if (id) await seasonsDetail(id); }; }

/* ---------- Teams ------------------------------------------------- */
let editTeam;
pages.teams = async id => {
  if (id) return teamDetail(id);
  const d = await get(S('/api/teams'));
  view.innerHTML = `<div class="bar"><span class="grow muted">Teams registered for the selected season (team_season) with purse from view v_team_purse.</span>
    <button class="btn" id="newTeam">+ New team</button>
    <button class="btn primary" id="regTeam" ${d.unregistered.length ? '' : 'disabled'}>+ Register team for season</button></div>
    <div class="grid g3">${d.teams.map(t => `
      <section class="card link" data-href="#/teams/${t.team_id}">
        <h3 style="font-size:16px">${esc(t.team_name)}</h3>
        <div class="muted">${esc(t.home_city)} · est. ${esc(t.founded_year ?? '—')}</div>
        <dl class="kv" style="margin-top:10px"><dt>Coach</dt><dd>${esc(t.coach_name ?? '—')}</dd><dt>Owner</dt><dd>${esc(t.owner_name ?? '—')}</dd><dt>Squad</dt><dd>${t.squad_size} players</dd></dl>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, 100 * t.purse_spent / t.purse_total)}%"></div></div>
        <small>Purse: ${money(t.purse_spent)} spent of ${money(t.purse_total)} · <b>${money(t.purse_remaining)}</b> left</small>
        <div class="rowact" style="margin-top:10px">${btn('Edit', () => editTeam(t))}${btn('Edit purse', () => openForm({
          title: `Purse: ${t.team_name}`, note: 'Cannot go below what the team has already spent (database trigger).',
          fields: [{ name: 'purse_cr', label: 'Auction purse (₹ crore)', type: 'number', step: 0.5, min: 0, value: t.purse_total / CRORE }],
          onSubmit: async v => { await put(`/api/team_season/${t.team_id}/${state.season}`, v); toast('Purse updated'); render(); },
        }))}${btn('Unregister', confirmDelete(`${t.team_name} from this season`, `/api/team_season/${t.team_id}/${state.season}`))}${btn('Delete team', confirmDelete(`team ${t.team_name} (all seasons)`, '/api/teams/' + t.team_id), 'danger')}</div>
      </section>`).join('') || '<div class="empty">No teams registered for this season</div>'}</div>`;
  const teamFields = t => [
    { name: 'team_name', label: 'Team name', value: t?.team_name }, { name: 'home_city', label: 'Home city', value: t?.home_city },
    { name: 'coach_name', label: 'Coach', required: false, value: t?.coach_name }, { name: 'owner_name', label: 'Owner', required: false, value: t?.owner_name },
    { name: 'founded_year', label: 'Founded year', type: 'number', required: false, value: t?.founded_year }];
  editTeam = t => openForm({
    title: `Edit ${t.team_name}`, fields: teamFields(t),
    onSubmit: async v => { await put('/api/teams/' + t.team_id, v); toast('Team updated'); await refreshLookups(); render(); },
  });
  $('#newTeam').onclick = () => openForm({
    title: 'New team', fields: teamFields(),
    onSubmit: async v => { await post('/api/teams', v); toast('Team created'); await refreshLookups(); render(); },
  });
  $('#regTeam').onclick = () => openForm({
    title: 'Register team for this season', note: 'Inserts into team_season (REGISTERED). Only registered teams can sign players and play matches.',
    fields: [{ name: 'team_id', label: 'Team', type: 'select', options: opts(d.unregistered, 'team_id', 'team_name') },
      { name: 'purse_cr', label: 'Auction purse (₹ crore)', type: 'number', value: 90, step: 0.5, min: 0 }],
    onSubmit: async v => { await post('/api/team_season', { ...v, season_id: state.season }); toast('Team registered'); render(); },
  });
};
async function teamDetail(id) {
  const d = await get(S('/api/teams/' + id));
  const t = d.team;
  view.innerHTML = `${back('#/teams', 'All teams')}
    <div class="kpis">${kpi(esc(t.team_name), t.home_city + ' · coach ' + (t.coach_name ?? '—'))}
      ${kpi(d.record.played, 'Matches played')}${kpi(d.record.won, 'Won')}${kpi(d.record.win_pct == null ? '—' : d.record.win_pct + '%', 'Win %')}</div>
    <div class="grid g2">${card('Squad (this season)', table(d.squad, ['player_name', 'jersey_no', 'roles', 'price', 'is_captain'], { href: r => '#/players/' + r.player_id, empty: 'No players signed for this season' }))}
    ${card('Matches (this season)', table(d.matches, ['match_date', 'match_type', 'opponent', 'status', 'winner'], { href: r => '#/matches/' + r.match_id }))}</div>`;
}

/* ---------- Players ----------------------------------------------- */
const playerFields = (p, roles = []) => [
  { name: 'player_name', label: 'Full name', value: p?.player_name }, { name: 'dob', label: 'Date of birth', type: 'date', value: p?.dob },
  { name: 'nationality', label: 'Nationality', value: p?.nationality },
  { name: 'batting_style', label: 'Batting style', type: 'select', required: false, blank: '—', value: p?.batting_style, options: [{ v: 'Right-hand', l: 'Right-hand' }, { v: 'Left-hand', l: 'Left-hand' }] },
  { name: 'bowling_style', label: 'Bowling style', required: false, placeholder: 'e.g. Right-arm fast', value: p?.bowling_style },
  { name: 'roles', label: 'Roles', type: 'checks', checked: roles, options: ['Batter', 'Bowler', 'All-rounder', 'Wicket-keeper'].map(r => ({ v: r, l: r })) }];
let editPlayer;
pages.players = async id => {
  if (id) return playerProfile(id);
  const f = { search: '', role: '', nationality: '' };
  view.innerHTML = `<div class="bar">
      <input id="fSearch" placeholder="Search name…" style="width:200px">
      <select id="fRole"><option value="">All roles</option>${['Batter', 'Bowler', 'All-rounder', 'Wicket-keeper'].map(r => `<option>${r}</option>`).join('')}</select>
      <select id="fNat"><option value="">All nationalities</option></select>
      <span class="grow"></span><button class="btn primary" id="addPlayer">+ Add player</button></div>
    <div id="plist"></div>`;
  let natsLoaded = false, timer;
  const load = async () => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    const d = await get(S('/api/players' + (qs ? '?' + qs : '')));
    if (!natsLoaded) { natsLoaded = true; $('#fNat').insertAdjacentHTML('beforeend', d.nationalities.map(n => `<option>${esc(n.nationality)}</option>`).join('')); }
    $('#plist').innerHTML = table(d.players, ['player_name', 'age', 'nationality', 'roles', 'batting_style', 'bowling_style', 'current_team',
      { ...ACT, f: (_, r) => editDel(() => editPlayer(r.player_id), confirmDelete(`player ${r.player_name}`, '/api/players/' + r.player_id, load)) }],
      { href: r => '#/players/' + r.player_id, empty: 'No players match these filters' });
    wireLinks($('#plist'));
  };
  $('#fSearch').oninput = e => { f.search = e.target.value; clearTimeout(timer); timer = setTimeout(load, 250); };
  $('#fRole').onchange = e => { f.role = e.target.value; load(); };
  $('#fNat').onchange = e => { f.nationality = e.target.value; load(); };
  $('#addPlayer').onclick = () => openForm({
    title: 'Add player', note: 'Name + date of birth must be unique (duplicate registrations are rejected by the database).',
    fields: playerFields(),
    onSubmit: async v => { await post('/api/players', v); toast('Player added'); load(); },
  });
  editPlayer = async pid => {
    const d = await get('/api/players/' + pid);
    openForm({
      title: `Edit ${d.player.player_name}`, fields: playerFields(d.player, d.roles.map(r => r.role)),
      onSubmit: async v => { await put('/api/players/' + pid, v); toast('Player updated'); load(); },
    });
  };
  await load();
};
async function playerProfile(id) {
  const d = await get('/api/players/' + id);
  const p = d.player, c = d.career;
  view.innerHTML = `${back('#/players', 'All players')}
    <div class="grid g2">
      ${card(p.player_name, `<dl class="kv"><dt>Age</dt><dd>${p.age} <small>(computed from DOB ${esc(p.dob)})</small></dd><dt>Nationality</dt><dd>${esc(p.nationality)}</dd>
        <dt>Batting</dt><dd>${esc(p.batting_style ?? '—')}</dd><dt>Bowling</dt><dd>${esc(p.bowling_style ?? '—')}</dd>
        <dt>Roles</dt><dd>${d.roles.length ? chips(d.roles.map(r => r.role)) : '—'}</dd>
        <dt>Mentor / mentees</dt><dd>${d.relations.length ? d.relations.map(r => `<a href="#/players/${r.player_id}">${esc(r.player_name)}</a> <small>(${r.relation})</small> ${btn('Remove', confirmDelete('this mentor relationship', r.relation === 'Mentor' ? `/api/mentor/${r.player_id}/${id}` : `/api/mentor/${id}/${r.player_id}`), 'danger')}`).join('<br>') : '—'}</dd></dl>
        <div class="rowact" style="margin-top:12px"><button class="btn sm" id="addMentor">+ Mentor relationship</button>
          ${btn('Edit player', () => openForm({
            title: `Edit ${p.player_name}`, fields: playerFields(p, d.roles.map(r => r.role)),
            onSubmit: async v => { await put('/api/players/' + id, v); toast('Player updated'); render(); },
          }))}${btn('Delete player', confirmDelete(`player ${p.player_name}`, '/api/players/' + id, () => { location.hash = '#/players'; }), 'danger')}</div>`)}
      ${card('Career stats (all seasons)', `<div class="kpis" style="margin:0">${kpi(c.matches, 'Matches')}${kpi(c.runs, 'Runs')}${kpi(c.highest_score, 'Highest')}${kpi(c.strike_rate ?? '—', 'Strike rate')}${kpi(c.wickets, 'Wickets')}${kpi(c.catches, 'Catches')}</div>`)}
    </div>
    <h3 style="margin:20px 0 8px">Team history</h3>${table(d.history, ['season_year', 'team_name', 'jersey_no', 'price', 'is_captain'], { empty: 'Not signed in any season' })}`;
  $('#addMentor').onclick = async () => {
    const all = await get('/api/player_options');
    openForm({
      title: 'Add mentor relationship', note: 'Recursive relationship: a player cannot mentor themselves (CHECK).',
      fields: [{ name: 'mentor_id', label: 'Mentor', type: 'select', options: opts(all, 'player_id', 'player_name'), num: true },
        { name: 'mentee_id', label: 'Mentee', type: 'select', value: id, options: opts(all, 'player_id', 'player_name'), num: true }],
      onSubmit: async v => { await post('/api/mentor', v); toast('Saved'); render(); },
    });
  };
}

/* ---------- Auctions ---------------------------------------------- */
pages.auctions = async id => {
  if (id) return auctionDetail(id);
  const rows = await get('/api/auctions');
  view.innerHTML = `<div class="bar"><span class="grow muted">Click an auction to run the player sale.</span><button class="btn primary" id="newAuc">+ New auction</button></div>
    ${table(rows, ['season_year', 'auction_date', 'venue', 'players_in_pool', 'sold', 'unsold', 'pending', 'total_spent',
      { ...ACT, f: (_, r) => editDel(() => openForm({
          title: 'Edit auction', fields: [{ name: 'auction_date', label: 'Date', type: 'date', value: r.auction_date }, { name: 'venue', label: 'Venue', value: r.venue }],
          onSubmit: async v => { await put('/api/auctions/' + r.auction_id, v); toast('Auction updated'); render(); },
        }), confirmDelete(`the ${r.season_year} auction on ${r.auction_date}`, '/api/auctions/' + r.auction_id)) }],
      { href: r => '#/auctions/' + r.auction_id })}`;
  $('#newAuc').onclick = () => openForm({
    title: 'New auction', fields: [
      { name: 'season_id', label: 'Season', type: 'select', value: state.season, options: opts(state.lookups.seasons, 'season_id', 'season_year') },
      { name: 'auction_date', label: 'Date', type: 'date' }, { name: 'venue', label: 'Venue' }],
    onSubmit: async v => { await post('/api/auctions', v); toast('Auction created'); render(); },
  });
};
async function auctionDetail(id) {
  const d = await get('/api/auctions/' + id);
  const a = d.auction;
  view.innerHTML = `${back('#/auctions', 'All auctions')}
    <div class="bar"><div class="grow"><b style="font-size:17px">IPL ${a.season_year} auction</b> <span class="muted">· ${esc(a.venue)} · ${esc(a.auction_date)}</span></div>
      <button class="btn primary" id="addPool" ${d.addable.length ? '' : 'disabled'}>+ Add player to pool</button></div>
    <div class="grid g3" style="margin-bottom:18px">${d.purses.map(p => `
      <section class="card"><b>${esc(p.team_name)}</b> <small>· ${p.squad_size} players</small>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, 100 * p.purse_spent / p.purse_total)}%"></div></div>
        <small>${money(p.purse_spent)} spent · <b>${money(p.purse_remaining)}</b> left of ${money(p.purse_total)}</small></section>`).join('')}</div>
    ${table(d.pool, [
      'player_name', 'nationality', 'base_price', 'status', 'sold_price', { k: 'team_name', h: 'Bought by' },
      { k: '_', h: '', f: (_, r) => r.status === 'Sold'
          ? `<button class="btn sm danger" data-act="undo" data-p="${r.player_id}">Undo sale</button>`
          : `<button class="btn sm primary" data-act="sell" data-p="${r.player_id}">Sell</button>
             ${r.status === 'Pending' ? `<button class="btn sm" data-act="unsold" data-p="${r.player_id}">Unsold</button>` : ''}
             ${btn('Base price', () => openForm({
               title: `Base price: ${r.player_name}`, fields: [{ name: 'base_price_cr', label: 'Base price (₹ crore)', type: 'number', step: 0.05, min: 0.05, value: r.base_price / CRORE }],
               onSubmit: async v => { await put(`/api/auctions/${id}/pool/${r.player_id}`, v); toast('Base price updated'); render(); },
             }))}${btn('Remove', confirmDelete(`${r.player_name} from the pool`, `/api/auctions/${id}/pool/${r.player_id}`), 'danger')}` }])}
    <p class="muted" style="margin-top:12px">Selling calls <code>CALL sell_player(...)</code>. Triggers then create the signing, check the purse, and enforce one team per player per season. Try an invalid sale to see the database reject it.</p>`;
  const poolRow = pid => d.pool.find(r => r.player_id === Number(pid));
  $$('[data-act]', view).forEach(b => b.onclick = () => {
    const r = poolRow(b.dataset.p), act = b.dataset.act;
    if (act === 'sell') openForm({
      title: `Sell ${r.player_name}`, note: `Base price ${money(r.base_price)}. The database blocks sales above the team's remaining purse.`,
      submit: 'Confirm sale',
      fields: [{ name: 'team_id', label: 'Buying team', type: 'select', num: true, options: d.purses.map(p => ({ v: p.team_id, l: `${p.team_name} (${money(p.purse_remaining)} left)` })) },
        { name: 'price_cr', label: 'Sold price (₹ crore)', type: 'number', step: 0.05, min: 0, value: r.base_price / CRORE }],
      onSubmit: async v => { await post(`/api/auctions/${id}/sell`, { player_id: r.player_id, ...v }); toast(`${r.player_name} sold`); render(); },
    });
    else (async () => {
      try { await post(`/api/auctions/${id}/unsold`, { player_id: r.player_id }); toast(act === 'undo' ? 'Sale undone, signing removed' : 'Marked unsold'); render(); }
      catch { /* shown */ }
    })();
  });
  $('#addPool').onclick = () => openForm({
    title: 'Add player to auction pool', note: 'This is the APPLIES relationship.',
    fields: [{ name: 'player_id', label: 'Player', type: 'select', num: true, options: opts(d.addable, 'player_id', 'player_name') },
      { name: 'base_price_cr', label: 'Base price (₹ crore)', type: 'number', step: 0.05, min: 0.05, value: 2 }],
    onSubmit: async v => { await post(`/api/auctions/${id}/pool`, v); toast('Added to pool'); render(); },
  });
}

/* ---------- Matches ----------------------------------------------- */
pages.matches = async id => {
  if (id) return matchDetail(id);
  const f = { team: '', type: '', status: '' };
  view.innerHTML = `<div class="bar"><select id="fTeam"><option value="">All teams</option></select>
      <select id="fType"><option value="">All types</option>${['League', 'Qualifier 1', 'Eliminator', 'Qualifier 2', 'Final'].map(t => `<option>${t}</option>`).join('')}</select>
      <select id="fStatus"><option value="">Any status</option><option>Scheduled</option><option>Completed</option><option>No Result</option></select>
      <span class="grow"></span><button class="btn primary" id="sched">+ Schedule match</button></div><div id="mlist"></div>`;
  let teams = [], teamsLoaded = false;
  const load = async () => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    const d = await get(S('/api/matches' + (qs ? '?' + qs : '')));
    teams = d.teams;
    if (!teamsLoaded) { teamsLoaded = true; $('#fTeam').insertAdjacentHTML('beforeend', d.teams.map(t => `<option value="${t.team_id}">${esc(t.team_name)}</option>`).join('')); }
    $('#mlist').innerHTML = table(d.matches, ['match_date', 'match_time', 'match_type', 'team1', 'team2', 'stadium_name', 'status', 'winner'],
      { href: r => '#/matches/' + r.match_id, empty: 'No matches' });
    wireLinks($('#mlist'));
  };
  $('#fTeam').onchange = e => { f.team = e.target.value; load(); };
  $('#fType').onchange = e => { f.type = e.target.value; load(); };
  $('#fStatus').onchange = e => { f.status = e.target.value; load(); };
  $('#sched').onclick = () => openForm({
    title: 'Schedule match', note: 'Calls schedule_match(): the match and its umpires are saved in one transaction. At least 2 on-field umpires are required.',
    fields: [
      { name: 'match_type', label: 'Match type', type: 'select', options: ['League', 'Qualifier 1', 'Eliminator', 'Qualifier 2', 'Final'].map(x => ({ v: x, l: x })) },
      { name: 'team1_id', label: 'Team 1', type: 'select', num: true, options: opts(teams, 'team_id', 'team_name') },
      { name: 'team2_id', label: 'Team 2', type: 'select', num: true, options: opts(teams, 'team_id', 'team_name'), value: teams[1] && teams[1].team_id },
      { name: 'stadium_id', label: 'Stadium', type: 'select', num: true, options: opts(state.lookups.stadiums, 'stadium_id', 'stadium_name') },
      { name: 'match_date', label: 'Date', type: 'date' }, { name: 'match_time', label: 'Time', type: 'time', value: '19:30' },
      { name: 'umpires', label: 'On-field umpires (pick 2)', type: 'checks', options: opts(state.lookups.umpires, 'umpire_id', 'umpire_name') },
      { name: 'fee', label: 'Fee per umpire (₹)', type: 'number', min: 0, step: 1000, value: 150000 },
      { name: 'third_umpire', label: 'Third umpire', type: 'select', num: true, required: false, blank: '— none —', options: opts(state.lookups.umpires, 'umpire_id', 'umpire_name') }],
    onSubmit: async v => {
      const r = await post('/api/matches', { ...v, season_id: state.season, umpires: v.umpires.map(Number) });
      toast('Match scheduled'); location.hash = '#/matches/' + r.match_id;
    },
  });
  await load();
};
async function matchDetail(id) {
  const d = await get('/api/matches/' + id);
  const m = d.match;
  const played = m.status !== 'Scheduled';
  view.innerHTML = `${back('#/matches', 'All matches')}
    <div class="card"><div class="bar" style="margin:0"><div class="grow">
      <div style="font-size:20px;font-weight:700">${esc(m.team1)} <span class="muted">vs</span> ${esc(m.team2)}</div>
      <div class="muted">${esc(m.match_type)} · IPL ${m.season_year} · ${esc(m.match_date)} ${esc(m.match_time)} · ${esc(m.stadium_name)}, ${esc(m.city)}</div></div>
      <span class="pill ${STATUS_CLASS[m.status] || ''}">${esc(m.status)}</span></div>
      <dl class="kv" style="margin-top:12px"><dt>Toss won by</dt><dd>${esc(m.toss_winner ?? '—')}</dd><dt>Winner</dt><dd>${esc(m.winner ?? '—')}</dd>
        <dt>Result</dt><dd>${esc(m.result_text ?? '—')}</dd><dt>Man of the match</dt><dd>${esc(m.man_of_match ?? '—')}</dd></dl>
      <div class="bar" style="margin:14px 0 0">
        <button class="btn primary" id="rec">${played ? 'Edit result' : 'Record result'}</button>
        <button class="btn" id="perf" ${played ? '' : 'disabled title="Record the result first"'}>Enter performance</button>
        <button class="btn" id="mom" ${d.performance.length ? '' : 'disabled title="Needs a performance row first"'}>Set man of the match</button>
        <button class="btn" id="editMatch">Edit match</button>
        ${btn('Delete match', confirmDelete('this match with its umpires and scorecard', '/api/matches/' + id, () => { location.hash = '#/matches'; }), 'danger')}</div></div>
    <div class="grid g2" style="margin-top:16px">${card('Umpires', table(d.umpires, ['umpire_name', 'nationality', 'role', 'fee',
        { ...ACT, f: (_, r) => btn('Edit fee', () => openForm({
            title: `Fee: ${r.umpire_name}`, note: 'Fee for this match only (match_umpire.fee).',
            fields: [{ name: 'fee', label: 'Fee (₹)', type: 'number', min: 0, step: 1000, value: r.fee }],
            onSubmit: async v => { await put(`/api/matches/${id}/umpires/${r.umpire_id}`, v); toast('Fee updated'); render(); },
          })) }]))}
      ${card('Scorecard (strike rate & economy are generated columns)', table(d.performance, ['player_name', 'team_name', 'runs', 'balls', 'strike_rate', 'wickets', 'overs', 'runs_conceded', 'economy', 'catches',
        { ...ACT, f: (_, r) => editDel(() => perfForm(r), confirmDelete(`${r.player_name}'s performance`, `/api/matches/${id}/performance/${r.player_id}`)) }], { empty: 'No performances entered' }))}</div>`;
  $('#editMatch').onclick = () => openForm({
    title: 'Edit match', note: 'Teams are fixed; delete and re-schedule the match to change them. Date must be inside the season, and the stadium cannot be double-booked.',
    fields: [
      { name: 'match_type', label: 'Match type', type: 'select', value: m.match_type, options: ['League', 'Qualifier 1', 'Eliminator', 'Qualifier 2', 'Final'].map(x => ({ v: x, l: x })) },
      { name: 'stadium_id', label: 'Stadium', type: 'select', num: true, value: m.stadium_id, options: opts(d.stadiums, 'stadium_id', 'stadium_name') },
      { name: 'match_date', label: 'Date', type: 'date', value: m.match_date }, { name: 'match_time', label: 'Time', type: 'time', value: m.match_time }],
    onSubmit: async v => { await put('/api/matches/' + id, v); toast('Match updated'); render(); },
  });
  const teamOpts = [{ v: m.team1_id, l: m.team1 }, { v: m.team2_id, l: m.team2 }];
  $('#rec').onclick = () => openForm({
    title: 'Record result', note: 'Calls record_result(). The winner must be one of the two teams (CHECK). Choose "No result" for abandoned matches.',
    fields: [{ name: 'toss_winner_id', label: 'Toss won by', type: 'select', num: true, options: teamOpts },
      { name: 'winner_id', label: 'Match winner', type: 'select', num: true, required: false, blank: 'No result', options: teamOpts },
      { name: 'result_text', label: 'Result text', required: false, placeholder: 'e.g. CSK won by 5 wickets' }],
    onSubmit: async v => { await post(`/api/matches/${id}/result`, v); toast('Result saved'); render(); },
  });
  const perfForm = r => openForm({
    title: r ? `Edit performance: ${r.player_name}` : 'Enter performance', note: 'Weak entity: key is (match, player). Only players of the two teams are accepted (trigger). Overs use cricket notation: 3.4 = 3 overs 4 balls.',
    fields: [{ name: 'player_id', label: 'Player', type: 'select', num: true, value: r?.player_id, options: d.eligible.filter(p => !r || p.player_id === r.player_id).map(p => ({ v: p.player_id, l: `${p.player_name} (${p.team_name})` })) },
      { name: 'runs', label: 'Runs scored', type: 'number', value: r?.runs ?? 0, min: 0 }, { name: 'balls', label: 'Balls faced', type: 'number', value: r?.balls ?? 0, min: 0 },
      { name: 'wickets', label: 'Wickets taken', type: 'number', value: r?.wickets ?? 0, min: 0, max: 10 },
      { name: 'overs', label: 'Overs bowled', type: 'number', value: r?.overs ?? 0, min: 0, max: 4, step: 0.1 },
      { name: 'runs_conceded', label: 'Runs conceded', type: 'number', value: r?.runs_conceded ?? 0, min: 0 }, { name: 'catches', label: 'Catches', type: 'number', value: r?.catches ?? 0, min: 0 }],
    onSubmit: async v => { await post(`/api/matches/${id}/performance`, v); toast('Performance saved'); render(); },
  });
  $('#perf').onclick = () => perfForm();
  $('#mom').onclick = () => openForm({
    title: 'Man of the match', note: 'Trigger: the player must have a performance row in this match.',
    fields: [{ name: 'player_id', label: 'Player', type: 'select', num: true, options: d.eligible.map(p => ({ v: p.player_id, l: `${p.player_name} (${p.team_name})` })) }],
    onSubmit: async v => { await post(`/api/matches/${id}/mom`, v); toast('Saved'); render(); },
  });
}

/* ---------- Stadiums / Umpires ------------------------------------ */
const stadiumFields = s => [{ name: 'stadium_name', label: 'Name', value: s?.stadium_name }, { name: 'city', label: 'City', value: s?.city },
  { name: 'capacity', label: 'Capacity', type: 'number', min: 1, value: s?.capacity },
  { name: 'pitch_type', label: 'Pitch type', type: 'select', required: false, blank: '—', value: s?.pitch_type, options: ['Batting', 'Bowling', 'Balanced', 'Spin-friendly'].map(x => ({ v: x, l: x })) }];
pages.stadiums = async () => {
  const rows = await get('/api/stadiums');
  view.innerHTML = `<div class="bar"><span class="grow muted">Aggregates computed per stadium with LEFT JOIN + GROUP BY.</span><button class="btn primary" id="add">+ Add stadium</button></div>
    ${table(rows, ['stadium_name', 'city', 'capacity', 'pitch_type', 'matches_hosted', 'toss_winner_won', { k: 'toss_winner_won_pct', h: 'Toss winner won %' },
      { ...ACT, f: (_, r) => editDel(() => openForm({
          title: `Edit ${r.stadium_name}`, fields: stadiumFields(r),
          onSubmit: async v => { await put('/api/stadiums/' + r.stadium_id, v); toast('Stadium updated'); await refreshLookups(); render(); },
        }), confirmDelete(`stadium ${r.stadium_name}`, '/api/stadiums/' + r.stadium_id)) }])}`;
  $('#add').onclick = () => openForm({
    title: 'Add stadium', fields: stadiumFields(),
    onSubmit: async v => { await post('/api/stadiums', v); toast('Stadium added'); await refreshLookups(); render(); },
  });
};
const umpireFields = u => [{ name: 'umpire_name', label: 'Name', value: u?.umpire_name }, { name: 'nationality', label: 'Nationality', value: u?.nationality },
  { name: 'experience_years', label: 'Experience (years)', type: 'number', min: 0, value: u?.experience_years ?? 0 }];
pages.umpires = async () => {
  const rows = await get('/api/umpires');
  view.innerHTML = `<div class="bar"><span class="grow muted">Umpires are assigned to matches when a match is scheduled (see Matches).</span><button class="btn primary" id="add">+ Add umpire</button></div>
    ${table(rows, ['umpire_name', 'nationality', 'experience_years', 'matches_officiated', 'total_fee',
      { ...ACT, f: (_, r) => editDel(() => openForm({
          title: `Edit ${r.umpire_name}`, fields: umpireFields(r),
          onSubmit: async v => { await put('/api/umpires/' + r.umpire_id, v); toast('Umpire updated'); await refreshLookups(); render(); },
        }), confirmDelete(`umpire ${r.umpire_name}`, '/api/umpires/' + r.umpire_id)) }])}`;
  $('#add').onclick = () => openForm({
    title: 'Add umpire', fields: umpireFields(),
    onSubmit: async v => { await post('/api/umpires', v); toast('Umpire added'); await refreshLookups(); render(); },
  });
};

/* ---------- Sponsors ---------------------------------------------- */
pages.sponsors = async () => {
  const d = await get(S('/api/sponsors'));
  view.innerHTML = `<div class="bar"><span class="grow muted">Many-to-many between sponsors and seasons; the contract lives on the link table.</span>
      <button class="btn" id="addSp">+ New sponsor</button><button class="btn primary" id="link">+ Link sponsor to season</button></div>
    <h3 style="margin:0 0 8px">Sponsors</h3>${table(d.sponsors, ['company_name', { k: 'industries', h: 'Industries', f: v => v ? chips(v.split(', ')) : '—' }, 'seasons_sponsored', 'lifetime_value',
      { ...ACT, f: (_, r) => editDel(() => openForm({
          title: `Edit ${r.company_name}`, note: 'Industry is multivalued: separate several with commas.',
          fields: [{ name: 'company_name', label: 'Company', value: r.company_name }, { name: 'industries', label: 'Industries', required: false, value: r.industries }],
          onSubmit: async v => { await put('/api/sponsors/' + r.sponsor_id, v); toast('Sponsor updated'); render(); },
        }), confirmDelete(`sponsor ${r.company_name}`, '/api/sponsors/' + r.sponsor_id)) }])}
    <h3 style="margin:22px 0 8px">Contracts in the selected season</h3>${table(d.contracts, ['company_name', 'sponsorship_type', 'contract_value', 'start_date', 'end_date',
      { ...ACT, f: (_, r) => editDel(() => openForm({
          title: `Edit contract: ${r.company_name}`, note: 'Only one Title sponsor is allowed per season (unique index).',
          fields: [{ name: 'sponsorship_type', label: 'Type', type: 'select', value: r.sponsorship_type, options: ['Title', 'Associate', 'Official Partner', 'Broadcast', 'Kit'].map(x => ({ v: x, l: x })) },
            { name: 'contract_cr', label: 'Contract value (₹ crore)', type: 'number', min: 0, step: 0.5, value: r.contract_value / CRORE },
            { name: 'start_date', label: 'Start date', type: 'date', value: r.start_date }, { name: 'end_date', label: 'End date', type: 'date', value: r.end_date }],
          onSubmit: async v => { await put(`/api/season_sponsor/${r.season_id}/${r.sponsor_id}`, v); toast('Contract updated'); render(); },
        }), confirmDelete(`the ${r.company_name} contract`, `/api/season_sponsor/${r.season_id}/${r.sponsor_id}`)) }],
      { empty: 'No sponsors for this season' })}`;
  $('#addSp').onclick = () => openForm({
    title: 'New sponsor', note: 'Industry is multivalued: separate several with commas.',
    fields: [{ name: 'company_name', label: 'Company' }, { name: 'industries', label: 'Industries', required: false, placeholder: 'Fantasy Sports, Gaming' }],
    onSubmit: async v => { await post('/api/sponsors', v); toast('Sponsor added'); render(); },
  });
  $('#link').onclick = () => openForm({
    title: 'Link sponsor to season', note: 'Only one Title sponsor is allowed per season (unique index).',
    fields: [{ name: 'sponsor_id', label: 'Sponsor', type: 'select', num: true, options: opts(d.options, 'sponsor_id', 'company_name') },
      { name: 'sponsorship_type', label: 'Type', type: 'select', options: ['Title', 'Associate', 'Official Partner', 'Broadcast', 'Kit'].map(x => ({ v: x, l: x })) },
      { name: 'contract_cr', label: 'Contract value (₹ crore)', type: 'number', min: 0, step: 0.5 },
      { name: 'start_date', label: 'Start date', type: 'date' }, { name: 'end_date', label: 'End date', type: 'date' }],
    onSubmit: async v => { await post('/api/season_sponsor', { ...v, season_id: state.season }); toast('Linked'); render(); },
  });
};

/* ---------- Reports ------------------------------------------------ */
pages.reports = async () => {
  const list = await get('/api/reports');
  view.innerHTML = `<p class="muted">One click runs the query and shows its SQL in the panel below. Each report demonstrates a different SQL concept.</p>
    <div class="grid g3" id="rlist">${list.map(r => `<section class="card link" data-k="${r.key}"><b>${esc(r.title)}</b><div style="margin-top:6px"><span class="chip">${esc(r.concept)}</span></div></section>`).join('')}</div>
    <div id="rout" style="margin-top:20px"></div>`;
  $$('#rlist .card').forEach(c => c.onclick = async () => {
    $$('#rlist .card').forEach(x => x.style.borderColor = '');
    c.style.borderColor = 'var(--accent)';
    const r = await get('/api/reports/' + c.dataset.k);
    $('#rout').innerHTML = `<h3 style="margin:0 0 4px">${esc(r.title)}</h3><p class="muted" style="margin:0 0 10px">${esc(r.concept)} · ${r.rows.length} row${r.rows.length === 1 ? '' : 's'}</p>${table(r.rows, null, { empty: 'No rows (the condition is not met by the sample data)' })}`;
    $('#sqlbar').classList.add('open');
  });
};

/* ---------- SQL Console -------------------------------------------- */
pages.console = async () => {
  const examples = [
    ['Teams', 'SELECT team_id, team_name, home_city FROM team ORDER BY team_name'],
    ['Join', 'SELECT p.player_name, t.team_name, pt.price\nFROM player_team pt\nJOIN player p ON p.player_id = pt.player_id\nJOIN team t ON t.team_id = pt.team_id\nWHERE pt.season_id = 1\nORDER BY pt.price DESC'],
    ['Aggregate', 'SELECT t.team_name, COUNT(*) AS wins\nFROM matches m JOIN team t ON t.team_id = m.winner_id\nGROUP BY t.team_name\nORDER BY wins DESC'],
    ['View', 'SELECT * FROM v_points_table ORDER BY season_year, position'],
  ];
  view.innerHTML = `<p class="muted">Read-only: only a single SELECT is accepted and it runs inside a READ ONLY transaction.</p>
    <div class="bar">${examples.map((e, i) => `<button class="btn sm" data-ex="${i}">${e[0]}</button>`).join('')}</div>
    <textarea class="sql" id="sqlIn" spellcheck="false">${esc(examples[3][1])}</textarea>
    <div class="bar" style="margin-top:10px"><button class="btn primary" id="runSql">Run query</button><span class="muted">Ctrl + Enter</span></div><div id="cout"></div>`;
  $$('[data-ex]').forEach(b => b.onclick = () => { $('#sqlIn').value = examples[b.dataset.ex][1]; });
  const run = async () => {
    try {
      const r = await post('/api/console', { sql: $('#sqlIn').value });
      $('#cout').innerHTML = `<p class="muted">${r.rows.length} row${r.rows.length === 1 ? '' : 's'}${r.truncated ? ' (showing first 500)' : ''}</p>` + table(r.rows, null, { empty: 'Query returned no rows' });
    } catch { $('#cout').innerHTML = ''; }
  };
  $('#runSql').onclick = run;
  $('#sqlIn').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run(); });
};

/* ---------- boot --------------------------------------------------- */
async function refreshLookups() {
  state.lookups = await get('/api/lookups');
  const sel = $('#seasonSel');
  const saved = Number(store.get('ipl.season'));
  const ids = state.lookups.seasons.map(s => s.season_id);
  state.season = ids.includes(state.season) ? state.season : ids.includes(saved) ? saved : ids[0];
  sel.innerHTML = state.lookups.seasons.map(s => `<option value="${s.season_id}" ${s.season_id === state.season ? 'selected' : ''}>IPL ${s.season_year}</option>`).join('');
}
(async () => {
  try { await refreshLookups(); await render(); }
  catch (e) { view.innerHTML = `<div class="empty">Cannot reach the database API. Is the server running and the database set up?<br><small>${esc(e.message)}</small></div>`; }
})();
