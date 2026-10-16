const $ = (id) => document.getElementById(id);
const svgNS = 'http://www.w3.org/2000/svg';
const colors = ['#d9ebbf', '#ede7f4', '#f4e6d4', '#e6eddc', '#dce6ed', '#f2e9d8'];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let state;
let clockOffset = 0;
let renderedWheel = '';
let animationFrame;
let animationKey = '';
let participantLimit = 12;
let loading = false;
let refreshAgain = false;
let audioContext;
let soundEnabled = false;
let lastTick = 0;
let lastSector = -1;
let busy = false;

function icon(name) {
  const svg = document.createElementNS(svgNS, 'svg');
  svg.classList.add('icon');
  const use = document.createElementNS(svgNS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
function show(element, visible) { element.classList.toggle('hidden', !visible); }
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function avatar(target, user) {
  target.replaceChildren();
  target.style.backgroundColor = colors[Number(BigInt(user.id) % BigInt(colors.length))];
  if (user.avatar) {
    const img = document.createElement('img');
    img.src = user.avatar;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => { target.textContent = Array.from(user.name)[0]?.toUpperCase() || '?'; });
    target.append(img);
  } else target.textContent = Array.from(user.name)[0]?.toUpperCase() || '?';
}
function toast(message, error = false) {
  if (!message) return;
  const node = element('div', `toast${error ? ' error' : ''}`);
  const close = element('button');
  close.setAttribute('aria-label', 'Meldung schließen');
  close.append(icon('close'));
  close.addEventListener('click', () => node.remove());
  node.append(icon(error ? 'lock' : 'check'), element('span', '', message), close);
  $('toast-stack').append(node);
  setTimeout(() => node.remove(), error ? 10000 : 5000);
}
async function api(path, data) {
  const response = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Bitte erneut versuchen.');
  return result;
}
function acceptState(next) {
  clockOffset = next.serverTime - Date.now();
  if (state && state.round.id !== next.round.id) {
    participantLimit = 12;
    $('winner-dialog').close();
  }
  state = next;
  render();
}
async function refresh() {
  if (loading) { refreshAgain = true; return; }
  loading = true;
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error('Die Verbindung ist gerade unterbrochen.');
    acceptState(await response.json());
  } catch (error) {
    setConnection(false);
    if (!state) toast(error.message, true);
  } finally {
    loading = false;
    if (refreshAgain) { refreshAgain = false; refresh(); }
  }
}
function setConnection(connected) {
  $('connection').classList.toggle('offline', !connected);
  $('connection').replaceChildren(element('span', 'live-dot'), document.createTextNode(connected ? 'Live verbunden' : 'Verbindung wird aufgebaut'));
}

function svgElement(tag, attributes) {
  const node = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}
function renderWheel(entries) {
  const key = JSON.stringify(entries.map(({ id, name }) => [id, name]));
  if (key === renderedWheel) return;
  renderedWheel = key;
  const wheel = $('wheel');
  wheel.replaceChildren();
  const count = entries.length || 12;
  const step = 360 / count;
  const point = (angle, r = 248) => {
    const radians = angle * Math.PI / 180;
    return [250 + Math.cos(radians) * r, 250 + Math.sin(radians) * r];
  };
  for (let index = 0; index < count; index++) {
    const from = -90 + index * step;
    const to = from + step;
    const middle = from + step / 2;
    if (count === 1) wheel.append(svgElement('circle', { cx: 250, cy: 250, r: 248, fill: colors[0] }));
    else {
      const start = point(from), end = point(to);
      const path = svgElement('path', {
        d: `M250,250 L${start.join(',')} A248,248 0 ${step > 180 ? 1 : 0},1 ${end.join(',')} Z`,
        fill: colors[index % colors.length], stroke: '#fff', 'stroke-width': count > 100 ? '.3' : '1.5',
      });
      wheel.append(path);
    }
    if (count <= 110) {
      const labelPoint = point(middle, count < 4 ? 159 : 165);
      const flip = middle > 90 && middle < 270;
      const label = svgElement('text', {
        x: labelPoint[0], y: labelPoint[1], dy: '.35em',
        transform: `rotate(${middle + (flip ? 180 : 0)} ${labelPoint.join(' ')})`,
        'text-anchor': 'middle', fill: entries.length ? '#4a5940' : '#8a9b78',
        'font-family': 'DM Sans, sans-serif', 'font-size': count > 50 ? 7 : count > 28 ? 9 : 12,
        'font-weight': entries.length ? 600 : 500,
        'letter-spacing': entries.length ? 0 : .6,
      });
      const name = entries[index]?.name;
      label.textContent = name ? (Array.from(name).length > 17 ? Array.from(name).slice(0, 15).join('') + '…' : name)
        : ['VIEL GLÜCK', '✦', 'DEIN PLATZ'][index % 3];
      wheel.append(label);
    }
  }
  wheel.setAttribute('aria-label', entries.length ? `Glücksrad mit ${entries.length} gleich großen Losen.` : 'Glücksrad – noch keine Teilnehmer.');
}
function tick() {
  if (!soundEnabled || !audioContext || Date.now() - lastTick < 65) return;
  lastTick = Date.now();
  try {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(790, audioContext.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(420, audioContext.currentTime + .025);
    gain.gain.setValueAtTime(.035, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + .04);
    oscillator.connect(gain); gain.connect(audioContext.destination);
    oscillator.start(); oscillator.stop(audioContext.currentTime + .045);
  } catch { /* Audio can be suspended by the browser. */ }
}
function animateDraw(round) {
  if (!round.draw) {
    cancelAnimationFrame(animationFrame);
    animationKey = '';
    $('wheel').style.transform = 'rotate(0deg)';
    return;
  }
  const key = `${round.id}:${round.draw.startedAt}`;
  if (round.status === 'finished') {
    cancelAnimationFrame(animationFrame);
    $('wheel').style.transform = `rotate(${round.draw.rotation}deg)`;
    animationKey = key;
    return;
  }
  if (animationKey === key) return;
  animationKey = key;
  cancelAnimationFrame(animationFrame);
  const frame = () => {
    const progress = Math.min(1, Math.max(0, (Date.now() + clockOffset - round.draw.startedAt) / round.draw.durationMs));
    const eased = 1 - Math.pow(1 - progress, 5);
    const angle = reducedMotion.matches ? round.draw.rotation : round.draw.rotation * eased;
    $('wheel').style.transform = `rotate(${angle}deg)`;
    const sector = Math.floor(angle / (360 / round.total));
    if (lastSector !== sector && !reducedMotion.matches) tick();
    lastSector = sector;
    if (progress < 1) animationFrame = requestAnimationFrame(frame);
    else setTimeout(refresh, 100);
  };
  frame();
}
function renderGuilds() {
  $('guild-list').replaceChildren();
  for (const guild of state.guilds) {
    const checked = state.me?.guildIds.includes(guild.id);
    const link = element('a', 'guild');
    link.href = guild.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `${guild.name} ${checked ? '– Mitgliedschaft bestätigt' : guild.hasInvite ? 'beitreten' : 'auf Discord öffnen'}`);
    const image = element('span', 'guild-icon'); image.append(icon('discord'));
    const info = element('span', 'guild-info');
    info.append(element('span', 'guild-name', guild.name), element('span', 'guild-id', guild.id));
    const action = element('span', `guild-action${checked ? ' checked' : ''}`);
    action.append(icon(checked ? 'check' : 'external'));
    link.append(image, info, action);
    $('guild-list').append(link);
  }
  const checked = state.me?.twitch?.following;
  const link = element('a', 'guild twitch-guild');
  link.href = state.twitch.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', `${state.twitch.channel} auf Twitch ${checked ? '– Follow bestätigt' : 'folgen'}`);
  const image = element('span', 'guild-icon'); image.append(icon('twitch'));
  const info = element('span', 'guild-info');
  info.append(element('span', 'guild-name', state.twitch.channel),
    element('span', 'guild-id', checked ? `Follow bestätigt · ${state.me.twitch.name}` : 'Auf Twitch folgen'));
  const action = element('span', `guild-action${checked ? ' checked' : ''}`); action.append(icon(checked ? 'check' : 'external'));
  link.append(image, info, action); $('guild-list').append(link);
}
function renderParticipants() {
  const { entries, winner } = state.round;
  $('participants-count').textContent = entries.length;
  show($('more-button'), entries.length > participantLimit);
  if (!entries.length) {
    if (!$('participants-list').querySelector('.participants-empty')) {
      const empty = element('div', 'participants-empty');
      const image = element('span', 'empty-icon'); image.append(icon('users'));
      const text = element('div');
      text.append(element('strong', '', 'Der erste Platz wartet auf dich.'), element('p', '', 'Melde dich an und mach den Anfang.'));
      empty.append(image, text, element('span', 'empty-doodle', '↗'));
      $('participants-list').replaceChildren(empty);
    }
    return;
  }
  $('participants-list').replaceChildren();
  entries.slice(0, participantLimit).forEach((entry, index) => {
    const item = element('div', `participant${entry.id === state.me?.id ? ' mine' : ''}${entry.id === winner?.id ? ' winner' : ''}`);
    const image = element('span', 'avatar'); avatar(image, entry);
    const info = element('div', 'participant-info');
    info.append(element('span', 'participant-name', entry.name + (entry.id === state.me?.id ? ' (du)' : '')),
      element('span', 'participant-ticket', `Los № ${String(index + 1).padStart(3, '0')}`));
    item.append(image, info, icon(entry.id === winner?.id ? 'trophy' : 'ticket'));
    $('participants-list').append(item);
  });
}
function renderJoin() {
  const { me, round } = state;
  const entered = Boolean(me?.entered);
  $('join-card').classList.toggle('entered', entered);
  show($('join-default'), !entered);
  show($('my-ticket'), entered);
  show($('join-button'), !me);
  show($('twitch-button'), me && !me.twitch && !entered && round.status === 'open');
  show($('twitch-switch'), me?.twitch && !entered && round.status === 'open');
  show($('participate-button'), me && me.twitch && !entered);
  show($('logout-button'), Boolean(me));
  if (entered) {
    $('ticket-number').textContent = String(me.ticket).padStart(3, '0');
    $('ticket-name').textContent = me.name;
    avatar($('ticket-avatar'), me);
    $('join-note').replaceChildren(icon('check'), document.createTextNode(round.status === 'finished' ? 'Du warst bei dieser Runde dabei.' : 'Dein Los ist sicher im Lostopf.'));
  } else {
    const defaults = $('join-default');
    if (round.status !== 'open') {
      defaults.querySelector('h2').textContent = round.status === 'drawing' ? 'Jetzt wird’s spannend.' : 'Neues Glück kommt bald.';
      defaults.querySelector('p').textContent = round.status === 'drawing' ? 'Die Lose sind drin. Fiebere mit!' : 'Die nächste Runde wartet schon.';
      show($('join-button'), false); show($('participate-button'), false);
      $('join-note').replaceChildren(icon('lock'), document.createTextNode('Teilnahme für diese Runde geschlossen.'));
    } else {
      defaults.querySelector('h2').replaceChildren(document.createTextNode(me ? 'Bereit für dein ' : 'Du fehlst noch '), document.createElement('br'), document.createTextNode(me ? 'bisschen Glück?' : 'auf dem Rad.'));
      defaults.querySelector('p').textContent = me ? `Hey ${me.name}, sichere dir dein Los.` : 'Deine Community. Deine Chance.';
      if (me && !me.twitch) defaults.querySelector('p').textContent = 'Verbinde Twitch und bestätige deinen Follow.';
      else if (me?.twitch && !me.twitch.following) defaults.querySelector('p').textContent = 'Folge joedom auf Twitch. Dann kurz prüfen.';
      $('join-note').replaceChildren(icon('ticket'), document.createTextNode('Kostenlos dabei · Ein Los pro Person'));
      $('participate-button').querySelector('span').textContent = me?.guildIds.length < 2 ? 'Mitgliedschaft prüfen'
        : !me?.twitch?.following ? 'Follow prüfen & Los sichern' : 'Los sichern';
    }
  }
}
function render() {
  const { round, admin } = state;
  const status = $('round-status');
  status.classList.remove('drawing', 'finished');
  if (round.status !== 'open') status.classList.add(round.status);
  status.replaceChildren(element('span', 'live-dot'), document.createTextNode({ open: 'Teilnahme offen', drawing: 'Das Rad dreht sich', finished: 'Runde beendet' }[round.status]));
  $('wheel-count').textContent = round.total;
  let caption, subtitle;
  if (round.status === 'drawing') {
    caption = 'Ein Dreh. Ein Glücksmoment.';
    subtitle = 'Daumen drücken – gleich steht’s fest.';
  } else if (round.winner) {
    caption = `${round.winner.name} hat gewonnen!`;
    subtitle = `Runde ${round.id} · Glückwunsch zu deinem Glücksmoment.`;
  } else {
    caption = round.total ? 'Die Spannung steigt.' : 'Das Glück wartet auf dich';
    subtitle = round.total ? 'Der Admin startet das Rad. Bleib dabei.' : 'Sichere dir deinen Platz auf dem Rad.';
  }
  $('wheel-caption').replaceChildren(icon(round.winner ? 'trophy' : round.status === 'drawing' ? 'spark' : 'lock'), document.createTextNode(caption));
  $('wheel-subtitle').textContent = subtitle;
  show($('admin-controls'), admin);
  show($('draw-button'), round.status !== 'finished');
  show($('new-round-button'), round.status === 'finished');
  $('draw-button').disabled = busy || !round.total || round.status !== 'open';
  $('draw-button').replaceChildren(icon('refresh'), document.createTextNode(round.status === 'drawing' ? 'Ziehung läuft …' : 'Glücksrad starten'));
  $('admin-button').querySelector('span').textContent = admin ? 'Admin aktiv' : 'Admin';
  show($('admin-form'), !admin);
  show($('admin-logout-button'), admin);
  renderWheel(round.entries);
  renderJoin(); renderGuilds(); renderParticipants(); animateDraw(round);
  if (round.winner) revealWinner(round);
}
function revealWinner(round) {
  const key = `herbi-winner-${round.id}`;
  try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch { /* Private browser mode. */ }
  avatar($('winner-avatar'), round.winner);
  $('winner-name').textContent = round.winner.name;
  $('winner-description').textContent = `Ein Los unter ${round.total}. Und dieses Mal gehört das Glück dir.`;
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
  $('winner-dialog').showModal();
  confetti();
}
function confetti() {
  if (reducedMotion.matches) return;
  const canvas = $('confetti');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const width = canvas.width = innerWidth;
  const height = canvas.height = innerHeight;
  const particles = Array.from({ length: 100 }, () => ({
    x: width / 2, y: height * .4, vx: (Math.random() - .5) * 14,
    vy: Math.random() * -13 - 3, angle: Math.random() * 6, color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const started = performance.now();
  const frame = (time) => {
    ctx.clearRect(0, 0, width, height);
    for (const p of particles) {
      p.vy += .12; p.x += p.vx; p.y += p.vy; p.angle += .06;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.angle); ctx.fillStyle = p.color; ctx.fillRect(-3, -4, 6, 9); ctx.restore();
    }
    if (time - started < 4500) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, width, height);
  };
  requestAnimationFrame(frame);
}

document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
  const box = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dialog.close();
}));
$('how-button').addEventListener('click', () => $('how-dialog').showModal());
$('admin-button').addEventListener('click', () => { $('admin-error').textContent = ''; $('admin-dialog').showModal(); });
$('password-toggle').addEventListener('click', () => {
  const hidden = $('admin-password').type === 'password';
  $('admin-password').type = hidden ? 'text' : 'password';
  $('password-toggle').textContent = hidden ? 'Verbergen' : 'Zeigen';
  $('password-toggle').setAttribute('aria-label', hidden ? 'Passwort verbergen' : 'Passwort anzeigen');
});
$('admin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('[type="submit"]');
  button.disabled = true; $('admin-error').textContent = '';
  try {
    acceptState(await api('/api/admin/login', { password: $('admin-password').value }));
    $('admin-password').value = ''; $('admin-password').type = 'password';
    $('password-toggle').textContent = 'Zeigen';
    $('admin-dialog').close(); toast('Du bist als Admin angemeldet.');
  } catch (error) { $('admin-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('admin-logout-button').addEventListener('click', async () => {
  try { acceptState(await api('/api/admin/logout')); $('admin-dialog').close(); toast('Admin abgemeldet.'); }
  catch (error) { toast(error.message, true); }
});
$('join-button').addEventListener('click', (event) => {
  if (!state?.configured) {
    event.preventDefault();
    toast('Der Discord-Login wird noch eingerichtet. Schau gleich wieder vorbei.', true);
  }
});
$('twitch-button').addEventListener('click', (event) => {
  if (!state?.twitch.configured) {
    event.preventDefault();
    toast('Die Twitch-Verifizierung wird noch eingerichtet. Schau gleich wieder vorbei.', true);
  }
});
$('participate-button').addEventListener('click', async () => {
  $('participate-button').disabled = true;
  try { acceptState(await api('/api/participate')); toast('Dein Los ist im Lostopf. Viel Glück!'); }
  catch (error) { toast(error.message, true); await refresh(); }
  finally { $('participate-button').disabled = false; }
});
$('logout-button').addEventListener('click', async () => {
  try { await api('/api/logout'); await refresh(); toast('Du bist abgemeldet. Dein Los bleibt dabei.'); }
  catch (error) { toast(error.message, true); }
});
$('draw-button').addEventListener('click', async () => {
  if (busy) return;
  busy = true; $('draw-button').disabled = true;
  if (audioContext) await audioContext.resume().catch(() => {});
  try { acceptState(await api('/api/admin/draw')); }
  catch (error) { toast(error.message, true); await refresh(); }
  finally { busy = false; if (state) render(); }
});
$('new-round-button').addEventListener('click', () => $('new-round-dialog').showModal());
$('confirm-round-button').addEventListener('click', async () => {
  $('confirm-round-button').disabled = true;
  try { acceptState(await api('/api/admin/round')); $('new-round-dialog').close(); toast('Die neue Runde ist offen.'); }
  catch (error) { toast(error.message, true); }
  finally { $('confirm-round-button').disabled = false; }
});
$('sound-button').addEventListener('click', async () => {
  try {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    await audioContext.resume(); soundEnabled = !soundEnabled;
    $('sound-button').setAttribute('aria-pressed', String(soundEnabled));
    const label = `Ton ${soundEnabled ? 'aus' : 'ein'}schalten`;
    $('sound-button').setAttribute('aria-label', label); $('sound-button').title = label;
    $('sound-button').replaceChildren(icon(soundEnabled ? 'sound' : 'muted'));
    if (soundEnabled) tick();
  } catch { toast('Dein Browser kann den Ton gerade nicht aktivieren.', true); }
});
$('more-button').addEventListener('click', () => { participantLimit += 24; renderParticipants(); });
const errors = {
  setup: 'Der Discord-Login wird noch eingerichtet. Schau gleich wieder vorbei.',
  state: 'Die Anmeldung ist abgelaufen. Bitte erneut versuchen.',
  cancelled: 'Discord-Anmeldung abgebrochen. Du kannst es jederzeit erneut versuchen.',
  discord: 'Die Discord-Anmeldung hat nicht geklappt. Bitte erneut versuchen.',
  membership: 'Fast dabei! Tritt beiden Servern bei und prüfe deine Mitgliedschaft erneut.',
  'auth-rate': 'Zu viele Anmeldeversuche. Bitte in 15 Minuten erneut versuchen.',
  'discord-first': 'Bitte zuerst mit Discord anmelden. Danach kannst du Twitch verbinden.',
  'twitch-setup': 'Die Twitch-Verifizierung wird noch eingerichtet. Schau gleich wieder vorbei.',
  'twitch-cancelled': 'Twitch-Verifizierung abgebrochen. Du kannst es erneut versuchen.',
  twitch: 'Die Twitch-Verifizierung hat nicht geklappt. Bitte Twitch erneut verbinden.',
  'twitch-follow': 'Fast dabei! Folge joedom auf Twitch und prüfe den Follow erneut.',
  'twitch-used': 'Dieses Twitch-Konto hat in dieser Runde bereits ein Los.',
  'twitch-locked': 'Dein Los ist für diese Runde schon mit einem anderen Twitch-Konto verknüpft.',
};
const params = new URLSearchParams(location.search);
if (params.has('error')) toast(errors[params.get('error')] || 'Bitte erneut versuchen.', true);
if (params.get('joined') === '1') toast('Discord verbunden. Viel Glück!');
if (params.get('connected') === 'discord') toast('Discord verbunden. Jetzt noch Twitch verifizieren.');
if (params.get('connected') === 'twitch') toast('Twitch-Follow bestätigt. Deine Teilnahme wird angezeigt.');
if (params.has('error') || params.has('joined') || params.has('connected')) history.replaceState(null, '', location.pathname + location.hash);

refresh();
const events = new EventSource('/api/events');
events.addEventListener('change', () => { setConnection(true); refresh(); });
events.addEventListener('open', () => setConnection(true));
events.addEventListener('error', () => setConnection(false));
// Reconcile after device sleep and when live streams are unavailable.
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => { if (!document.hidden && events.readyState !== EventSource.OPEN) refresh(); }, 15000);
