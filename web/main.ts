import { SyncClient, type SocketLike } from '../src/client/syncClient.js';
import { diffText, shiftOffset } from '../src/client/textDiff.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const room = params.get('room') ?? 'demo';
const replica = `tab-${Math.random().toString(36).slice(2, 7)}`;
// Under `vite` dev the page is on :5173 and the relay on :8787; when the relay
// serves the built page itself, it is the same origin.
const serverUrl =
  params.get('server') ??
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:${
    location.port === '5173' ? '8787' : location.port
  }`;

const client = new SyncClient({
  url: serverUrl,
  room,
  replica,
  createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
});

const editor = $<HTMLTextAreaElement>('editor');
const offline = $<HTMLInputElement>('offline');
const status = $('status');
$('room').textContent = room;
$('me').textContent = replica;

/** What the textarea showed after the last sync with the CRDT. */
let shown = '';

editor.addEventListener('input', () => {
  const next = editor.value;
  const change = diffText(shown, next, editor.selectionEnd);
  if (change) {
    if (change.deleteCount > 0) client.delete(change.index, change.deleteCount);
    if (change.insert) client.insert(change.index, change.insert);
  }
  shown = client.doc.toString();
  if (shown !== next) editor.value = shown; // should never happen; keeps UI honest
  renderStats();
});

client.on('change', (effects) => {
  let start = editor.selectionStart;
  let end = editor.selectionEnd;
  for (const effect of effects) {
    start = shiftOffset(start, effect);
    end = shiftOffset(end, effect);
  }
  const scroll = editor.scrollTop;
  shown = client.doc.toString();
  editor.value = shown;
  editor.setSelectionRange(start, end);
  editor.scrollTop = scroll;
  renderStats();
});

client.on('status', (s) => {
  status.textContent = s;
  status.dataset.status = s;
  renderStats();
});

client.on('peers', (peers) => {
  const list = $('peers');
  list.replaceChildren(
    ...peers.map((p) => {
      const li = document.createElement('li');
      li.textContent = p.replica === replica ? `${p.name} (you)` : p.name;
      if (p.replica === replica) li.className = 'me';
      return li;
    }),
  );
});

offline.addEventListener('change', () => {
  if (offline.checked) client.disconnect();
  else client.connect();
});

function renderStats(): void {
  const s = client.doc.stats();
  const rows: [string, number][] = [
    ['chars', client.doc.length],
    ['tombstones', s.tombstones],
    ['lamport', client.doc.lamport],
    ['unsynced ops', client.unsynced],
  ];
  $('stats').replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = String(v);
      return [dt, dd];
    }),
  );
}

renderStats();
client.connect();
