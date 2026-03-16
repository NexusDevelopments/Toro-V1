import dotenv from "dotenv";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import compress from "@fastify/compress";
import fastifyCookie from "@fastify/cookie";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { scryptSync, timingSafeEqual, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { logging, server as wisp } from "@mercuryworkshop/wisp-js/server";
import { createBareServer } from "@tomphttp/bare-server-node";
import { MasqrMiddleware } from "./masqr.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const port = Number(process.env.PORT) || 3000;
const server = createServer();

// --- IP Logging ---
const LOG_SALT = 'a3f8c1e290bd4751';
const LOG_HASH = Buffer.from('8a5fd87579ddd37ba91e7fb02c4a4d178d53752f6726283ea44714f8261eaa4a1e3b8e005b813e942572d8dd873de77e23a559517a24068c9172577b6b7c875e', 'hex');
const ipLog = new Map(); // Map<ip, {city,state,country,vpn,isp,geoFetched,device,visits[]}>
const _geoQ = new Set();
const devState = {
  maintenanceEnabled: false,
  maintenanceMessage: 'Server Down Due to Maintenance',
  links: [],
  updates: [
    {
      id: randomUUID(),
      text: 'DuckDuckGo is now the default search engine, and Settings now lets you switch between DuckDuckGo and Google.',
      ts: new Date().toISOString(),
    },
  ],
};
const DEV_STATE_DIR = join(__dirname, 'data');
const DEV_STATE_FILE = join(DEV_STATE_DIR, 'dev-state.json');
const IP_LOG_FILE = join(DEV_STATE_DIR, 'ip-logs.json');
const CHAT_STATE_FILE = join(DEV_STATE_DIR, 'chat-state.json');
let ipLogSaveTimer = null;
let chatSaveTimer = null;
const tunnelProcesses = new Map();
const CHAT_USER_TTL_MS = 120000;
const BAD_WORDS = (process.env.CHAT_BLOCKED_WORDS || 'fuck,shit,bitch,asshole,cunt,porn,sex')
  .split(',')
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean);

async function loadDevState() {
  try {
    const raw = await readFile(DEV_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.maintenanceEnabled === 'boolean') {
      devState.maintenanceEnabled = parsed.maintenanceEnabled;
    }
    if (typeof parsed?.maintenanceMessage === 'string' && parsed.maintenanceMessage.trim()) {
      devState.maintenanceMessage = parsed.maintenanceMessage;
    }
    if (Array.isArray(parsed?.links)) {
      devState.links = parsed.links
        .filter((l) => typeof l?.id === 'string' && typeof l?.url === 'string')
        .slice(0, 30)
        .map((l) => ({
          id: l.id,
          url: l.url,
          requestedSubdomain: typeof l.requestedSubdomain === 'string' ? l.requestedSubdomain : '',
          target: typeof l.target === 'string' ? l.target : 'https://torov1.up.railway.app',
          createdAt: typeof l.createdAt === 'string' ? l.createdAt : new Date().toISOString(),
          status: typeof l.status === 'string' ? l.status : 'unknown',
        }));
    }
    if (Array.isArray(parsed?.updates)) {
      devState.updates = parsed.updates
        .filter((u) => typeof u?.text === 'string' && u.text.trim())
        .slice(0, 100)
        .map((u) => ({
          id: typeof u.id === 'string' ? u.id : randomUUID(),
          text: u.text.trim(),
          ts: typeof u.ts === 'string' ? u.ts : new Date().toISOString(),
        }));
    }
  } catch {
    // No persisted file yet; defaults stay in memory.
  }
}

async function saveDevState() {
  try {
    await mkdir(DEV_STATE_DIR, { recursive: true });
    await writeFile(
      DEV_STATE_FILE,
      JSON.stringify(
        {
          maintenanceEnabled: devState.maintenanceEnabled,
          maintenanceMessage: devState.maintenanceMessage,
          links: devState.links,
          updates: devState.updates,
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch (err) {
    console.error('Failed to persist dev state:', err);
  }
}

await loadDevState();

async function loadIpLogs() {
  try {
    const raw = await readFile(IP_LOG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;

    for (const row of parsed) {
      if (!row || typeof row.ip !== 'string') continue;
      const visits = Array.isArray(row.visits)
        ? row.visits
            .filter((v) => typeof v?.ts === 'string' && typeof v?.method === 'string' && typeof v?.path === 'string')
            .slice(-500)
        : [];

      ipLog.set(row.ip, {
        city: typeof row.city === 'string' ? row.city : '',
        state: typeof row.state === 'string' ? row.state : '',
        country: typeof row.country === 'string' ? row.country : '',
        vpn: typeof row.vpn === 'boolean' ? row.vpn : null,
        isp: typeof row.isp === 'string' ? row.isp : '',
        geoFetched: !!row.geoFetched,
        device: typeof row.device === 'string' ? row.device : 'Unknown',
        visits,
      });
    }
  } catch {
    // No persisted IP log file yet.
  }
}

async function saveIpLogs() {
  try {
    await mkdir(DEV_STATE_DIR, { recursive: true });
    const rows = [];
    for (const [ip, d] of ipLog) {
      rows.push({
        ip,
        city: d.city || '',
        state: d.state || '',
        country: d.country || '',
        vpn: d.vpn,
        isp: d.isp || '',
        geoFetched: !!d.geoFetched,
        device: d.device || 'Unknown',
        visits: Array.isArray(d.visits) ? d.visits.slice(-500) : [],
      });
    }
    await writeFile(IP_LOG_FILE, JSON.stringify(rows, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist IP logs:', err);
  }
}

function scheduleIpLogSave() {
  if (ipLogSaveTimer) return;
  ipLogSaveTimer = setTimeout(async () => {
    ipLogSaveTimer = null;
    await saveIpLogs();
  }, 1200);
}

await loadIpLogs();

const chatState = {
  rooms: {
    general: { name: 'general', messages: [] },
    gaming: { name: 'gaming', messages: [] },
    lounge: { name: 'lounge', messages: [] },
  },
  users: {}, // sessionId -> { username, room, lastSeen }
};

const hasBadWord = (value = '') => {
  const v = String(value).toLowerCase();
  return BAD_WORDS.some((w) => v.includes(w));
};

const normalizeRoomName = (room) =>
  String(room || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_ ]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 24);

const scheduleChatSave = () => {
  if (chatSaveTimer) return;
  chatSaveTimer = setTimeout(async () => {
    chatSaveTimer = null;
    try {
      await mkdir(DEV_STATE_DIR, { recursive: true });
      await writeFile(
        CHAT_STATE_FILE,
        JSON.stringify({ rooms: chatState.rooms }, null, 2),
        'utf8',
      );
    } catch (err) {
      console.error('Failed to persist chat state:', err);
    }
  }, 1000);
};

const pruneChatUsers = () => {
  const now = Date.now();
  for (const [sessionId, user] of Object.entries(chatState.users)) {
    if (!user?.lastSeen || now - user.lastSeen > CHAT_USER_TTL_MS) {
      delete chatState.users[sessionId];
    }
  }
};

const ensureRoom = (rawRoom) => {
  const room = normalizeRoomName(rawRoom);
  if (!room) return null;
  if (!chatState.rooms[room]) {
    chatState.rooms[room] = { name: room, messages: [] };
    scheduleChatSave();
  }
  return room;
};

const roomPresence = (room) => {
  pruneChatUsers();
  const usernames = Object.values(chatState.users)
    .filter((u) => u.room === room)
    .map((u) => u.username);
  return { userCount: usernames.length, usernames };
};

async function loadChatState() {
  try {
    const raw = await readFile(CHAT_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.rooms && typeof parsed.rooms === 'object') {
      const nextRooms = {};
      for (const [roomName, roomData] of Object.entries(parsed.rooms)) {
        const normalized = normalizeRoomName(roomName);
        if (!normalized) continue;
        const msgs = Array.isArray(roomData?.messages)
          ? roomData.messages
              .filter((m) => typeof m?.username === 'string' && typeof m?.ts === 'string')
              .slice(-5000)
              .map((m) => ({
                id: typeof m.id === 'string' ? m.id : randomUUID(),
                username: m.username.slice(0, 15),
                text: typeof m.text === 'string' ? m.text.slice(0, 1200) : '',
                image: typeof m.image === 'string' ? m.image.slice(0, 450000) : '',
                ts: m.ts,
              }))
          : [];
        nextRooms[normalized] = { name: normalized, messages: msgs };
      }
      if (Object.keys(nextRooms).length > 0) chatState.rooms = nextRooms;
    }
  } catch {
    // No persisted chat state file yet.
  }
}

await loadChatState();

const maintenanceHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Maintenance</title><style>*{box-sizing:border-box;margin:0;padding:0}body{min-height:100vh;display:grid;place-items:center;background:#090304;color:#f4d4d8;font-family:ui-sans-serif,system-ui,sans-serif;padding:24px}.card{max-width:760px;width:100%;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.16);backdrop-filter:blur(10px);border-radius:18px;padding:28px}h1{font-size:clamp(1.6rem,3vw,2.3rem);color:#ff7a8a;margin-bottom:10px}p{opacity:.9;line-height:1.6;font-size:1rem}.sub{margin-top:10px;opacity:.6;font-size:.9rem}</style></head><body><div class="card"><h1>Server Down Due to Maintenance</h1><p id="msg"></p><p class="sub">Please check back shortly.</p></div><script>const m=${JSON.stringify('MSG_PLACEHOLDER')};document.getElementById('msg').textContent=m&&m!=='MSG_PLACEHOLDER'?m:'We are currently performing maintenance.';</script></body></html>`;

const devHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dev Panel</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#090304;color:#f4d4d8;font-family:ui-sans-serif,system-ui,sans-serif;min-height:100vh;padding:24px}.wrap{max-width:900px;margin:0 auto}.card{background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(10px);border-radius:16px;padding:18px;margin-bottom:16px}h1{font-size:2rem;color:#ff7788;margin-bottom:14px}h2{font-size:1.05rem;margin-bottom:12px;color:#ffc7cf}input,textarea{width:100%;background:#130709;border:1px solid rgba(255,255,255,.2);border-radius:12px;color:#fff;padding:11px 12px;outline:none}textarea{min-height:92px;resize:vertical}button{background:linear-gradient(135deg,rgba(255,255,255,.15),rgba(255,255,255,.06));border:1px solid rgba(255,255,255,.26);color:#ffecef;border-radius:999px;padding:9px 14px;cursor:pointer}button:hover{border-color:rgba(255,255,255,.45)}.row{display:flex;gap:10px;flex-wrap:wrap}.muted{opacity:.65;font-size:.9rem}.hidden{display:none}ul{margin-top:10px;display:grid;gap:8px;padding-left:18px}</style></head><body><div class="wrap"><h1>Dev Panel</h1><div id="auth" class="card"><h2>Authenticate</h2><input id="pw" type="password" placeholder="Admin password" /><div style="height:10px"></div><button id="login">Enter Panel</button><div id="err" class="muted" style="color:#ff9aa8;margin-top:10px;display:none"></div></div><div id="panel" class="hidden"><div class="card"><h2>Maintenance Mode</h2><p class="muted">Blocks normal site routes and shows the maintenance screen. Dev and IP logs remain accessible.</p><div style="height:10px"></div><textarea id="maintMsg" placeholder="Maintenance message"></textarea><div style="height:10px"></div><div class="row"><button id="enableMaint">Enable Maintenance</button><button id="disableMaint">Disable Maintenance</button></div></div><div class="card"><h2>Add Update</h2><textarea id="updateText" placeholder="Write update text..."></textarea><div style="height:10px"></div><button id="addUpdate">Add Update</button><ul id="updates"></ul></div></div></div><script>let PASS='';function esc(s){return String(s||'').replace(/[&<>\"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[m]||m));}function setErr(t){const e=document.getElementById('err');if(!t){e.style.display='none';return;}e.style.display='block';e.textContent=t;}async function post(url,data){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const j=await r.json().catch(()=>({}));if(!r.ok) throw new Error(j.error||('Request failed '+r.status));return j;}function paintUpdates(items){const ul=document.getElementById('updates');ul.innerHTML='';items.forEach(x=>{const li=document.createElement('li');li.innerHTML='<span>'+esc(x.text)+'</span>';ul.appendChild(li);});}document.getElementById('login').onclick=async()=>{setErr('');try{PASS=document.getElementById('pw').value||'';const r=await post('/dev/api/login',{password:PASS});document.getElementById('auth').classList.add('hidden');document.getElementById('panel').classList.remove('hidden');document.getElementById('maintMsg').value=r.state.maintenanceMessage||'';paintUpdates(r.state.updates||[]);}catch(e){setErr(e.message||'Authentication failed');}};document.getElementById('enableMaint').onclick=async()=>{try{const msg=document.getElementById('maintMsg').value.trim();await post('/dev/api/maintenance',{password:PASS,enabled:true,message:msg});alert('Maintenance enabled');}catch(e){alert(e.message||'Failed');}};document.getElementById('disableMaint').onclick=async()=>{try{await post('/dev/api/maintenance',{password:PASS,enabled:false,message:''});alert('Maintenance disabled');}catch(e){alert(e.message||'Failed');}};document.getElementById('addUpdate').onclick=async()=>{try{const text=document.getElementById('updateText').value.trim();if(!text)return;const r=await post('/dev/api/updates/add',{password:PASS,text});document.getElementById('updateText').value='';paintUpdates(r.updates||[]);}catch(e){alert(e.message||'Failed');}};</script></body></html>`;

const devLinksHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dev Links</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#090304;color:#f4d4d8;font-family:ui-sans-serif,system-ui,sans-serif;min-height:100vh;padding:24px}.wrap{max-width:960px;margin:0 auto}.card{background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(10px);border-radius:16px;padding:18px;margin-bottom:16px}h1{font-size:2rem;color:#ff7788;margin-bottom:8px}h2{font-size:1.04rem;margin-bottom:10px;color:#ffc7cf}.muted{opacity:.7;font-size:.84rem}input{width:100%;padding:10px 12px;border-radius:999px;background:#130709;border:1px solid rgba(255,255,255,.2);color:#fff;outline:none}button{background:linear-gradient(135deg,rgba(255,255,255,.15),rgba(255,255,255,.06));border:1px solid rgba(255,255,255,.26);color:#ffecef;border-radius:999px;padding:9px 14px;cursor:pointer}button:hover{border-color:rgba(255,255,255,.45)}.row{display:flex;gap:10px;flex-wrap:wrap}.hidden{display:none}.link{padding:10px;border:1px solid rgba(255,255,255,.14);border-radius:12px;background:rgba(0,0,0,.26)}.line{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}.url{font-size:.86rem;word-break:break-all}.warn{margin-top:8px;color:#ffb8c0;font-size:.8rem}</style></head><body><div class="wrap"><h1>Dev Links</h1><p class="muted">Create temporary Cloudflare quick-tunnel links. Multiple links are supported.</p><div id="auth" class="card"><h2>Authenticate</h2><input id="pw" type="password" placeholder="Admin password"/><div style="height:10px"></div><button id="login">Enter</button><p id="err" class="warn" style="display:none"></p></div><div id="panel" class="hidden"><div class="card"><h2>Create Link</h2><div class="row"><input id="target" value="https://torov1.up.railway.app"/></div><div style="height:8px"></div><div class="row"><input id="sub" placeholder="Desired subdomain (info only, trycloudflare ignores this)"/></div><div style="height:10px"></div><div class="row"><button id="create">Create Temporary Link</button></div><p class="warn">You cannot choose a custom prefix under *.trycloudflare.com. For custom subdomains, use your own Cloudflare domain.</p></div><div class="card"><h2>Active / Saved Links</h2><div id="links" style="display:grid;gap:8px"></div></div></div></div><script>let PASS='';function esc(s){return String(s||'').replace(/[&<>\"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[m]||m));}async function post(url,data){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const j=await r.json().catch(()=>({}));if(!r.ok) throw new Error(j.error||('Request failed '+r.status));return j;}function setErr(t){const e=document.getElementById('err');if(!t){e.style.display='none';return;}e.style.display='block';e.textContent=t;}async function refresh(){const data=await post('/dev/api/links/list',{password:PASS});const box=document.getElementById('links');box.innerHTML='';(data.links||[]).forEach(l=>{const d=document.createElement('div');d.className='link';d.innerHTML='<div class="line"><div><div class="url"><a href="'+l.url+'" target="_blank" rel="noreferrer">'+esc(l.url)+'</a></div><div class="muted">status: '+esc(l.status||'unknown')+' • '+new Date(l.createdAt).toLocaleString()+'</div></div><button data-id="'+l.id+'">Stop</button></div>';d.querySelector('button').onclick=async()=>{try{await post('/dev/api/links/stop',{password:PASS,id:l.id});await refresh();}catch(e){alert(e.message||'Failed');}};box.appendChild(d);});if((data.links||[]).length===0){box.innerHTML='<p class="muted">No links yet.</p>';}}document.getElementById('login').onclick=async()=>{setErr('');try{PASS=document.getElementById('pw').value||'';await post('/dev/api/login',{password:PASS});document.getElementById('auth').classList.add('hidden');document.getElementById('panel').classList.remove('hidden');await refresh();}catch(e){setErr(e.message||'Auth failed');}};document.getElementById('create').onclick=async()=>{try{const target=document.getElementById('target').value.trim();const desiredSubdomain=document.getElementById('sub').value.trim();await post('/dev/api/links/create',{password:PASS,target,desiredSubdomain});await refresh();}catch(e){alert(e.message||'Failed to create link');}};</script></body></html>`;

function verifyLogPassword(candidate) {
  try {
    const candidateHash = scryptSync(candidate, LOG_SALT, 64);
    return timingSafeEqual(candidateHash, LOG_HASH);
  } catch {
    return false;
  }
}

function _device(ua) {
  if (!ua) return 'Unknown';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/CrOS/i.test(ua)) return 'Chromebook';
  if (/Android/i.test(ua)) { const m = ua.match(/Android [^;]+; ([^)]+)\)/); return m ? m[1].trim() : 'Android Device'; }
  if (/Windows NT 10/i.test(ua)) return 'Windows 10/11';
  if (/Windows NT/i.test(ua)) return 'Windows PC';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Linux/i.test(ua)) return 'Linux PC';
  return 'Unknown Device';
}

async function _geo(ip) {
  if (_geoQ.has(ip)) return;
  _geoQ.add(ip);
  try {
    const r = await fetch('http://ip-api.com/json/' + encodeURIComponent(ip) + '?fields=status,country,regionName,city,proxy,hosting,isp');
    if (!r.ok) return;
    const d = await r.json();
    if (d.status !== 'success') return;
    const e = ipLog.get(ip);
    if (e) {
      e.city = d.city||'';
      e.state = d.regionName||'';
      e.country = d.country||'';
      e.vpn = !!(d.proxy||d.hosting);
      e.isp = d.isp||'';
      e.geoFetched = true;
      scheduleIpLogSave();
    }
  } catch { /* geo lookup failed */ } finally { _geoQ.delete(ip); }
}

function recordIp(req) {
  const xff = req.headers['x-forwarded-for'];
  const ip = xff ? xff.split(',')[0].trim() : (req.socket?.remoteAddress ?? 'unknown');
  const device = _device(req.headers['user-agent'] || '');
  if (!ipLog.has(ip)) {
    ipLog.set(ip, { city: '', state: '', country: '', vpn: null, isp: '', geoFetched: false, device, visits: [] });
    _geo(ip);
  }
  const e = ipLog.get(ip);
  e.visits.push({ ts: new Date().toISOString(), method: req.method, path: req.url });
  if (e.visits.length > 500) e.visits.shift();
  scheduleIpLogSave();
}
const bare = process.env.BARE !== "false" ? createBareServer("/seal/") : null;
logging.set_level(logging.NONE);

Object.assign(wisp.options, {
  dns_method: "resolve",
  dns_servers: ["1.1.1.3", "1.0.0.3"],
  dns_result_order: "ipv4first"
});

server.on("upgrade", (req, sock, head) =>
  bare?.shouldRoute(req)
    ? bare.routeUpgrade(req, sock, head)
    : req.url.endsWith("/wisp/")
      ? wisp.routeRequest(req, sock, head)
      : sock.end()
);

const app = Fastify({
  serverFactory: h => {
    server.on("request", (req, res) => {
      // Admin endpoints: bypass Fastify/static entirely so React Router never intercepts them
      const pathname = new URL(req.url || '/', 'http://local').pathname;

      if (pathname === '/dev/home' || pathname === '/dev/home/') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(devHtml);
          return;
        }
      }

      if (pathname === '/dev/links' || pathname === '/dev/links/') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(devLinksHtml);
          return;
        }
      }

      if (pathname === '/dev/api/login') {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
          req.on('end', () => {
            try {
              const { password } = JSON.parse(body || '{}');
              if (typeof password !== 'string' || !verifyLogPassword(password)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
              }
              res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
              res.end(JSON.stringify({
                ok: true,
                state: {
                  maintenanceEnabled: devState.maintenanceEnabled,
                  maintenanceMessage: devState.maintenanceMessage,
                  updates: devState.updates,
                },
              }));
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Bad Request' }));
            }
          });
          return;
        }
      }

      if (pathname === '/dev/api/maintenance') {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
          req.on('end', async () => {
            try {
              const { password, enabled, message } = JSON.parse(body || '{}');
              if (typeof password !== 'string' || !verifyLogPassword(password)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
              }
              devState.maintenanceEnabled = !!enabled;
              if (typeof message === 'string' && message.trim()) {
                devState.maintenanceMessage = message.trim();
              }
              await saveDevState();
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, maintenanceEnabled: devState.maintenanceEnabled, maintenanceMessage: devState.maintenanceMessage }));
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Bad Request' }));
            }
          });
          return;
        }
      }

      if (pathname === '/dev/api/updates/add') {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', c => { body += c; if (body.length > 32768) req.destroy(); });
          req.on('end', async () => {
            try {
              const { password, text } = JSON.parse(body || '{}');
              if (typeof password !== 'string' || !verifyLogPassword(password)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
              }
              if (typeof text !== 'string' || !text.trim()) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Update text required' }));
                return;
              }
              devState.updates.unshift({ id: randomUUID(), text: text.trim(), ts: new Date().toISOString() });
              if (devState.updates.length > 100) devState.updates.length = 100;
              await saveDevState();
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, updates: devState.updates }));
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Bad Request' }));
            }
          });
          return;
        }
      }

      if (pathname === '/dev/api/links/list') {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
          req.on('end', () => {
            try {
              const { password } = JSON.parse(body || '{}');
              if (typeof password !== 'string' || !verifyLogPassword(password)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
              }
              const links = devState.links.map((l) => ({
                ...l,
                status: tunnelProcesses.has(l.id) ? 'running' : l.status || 'stopped',
              }));
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ links }));
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Bad Request' }));
            }
          });
          return;
        }
      }

      if (pathname === '/dev/api/links/stop') {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
          req.on('end', async () => {
            try {
              const { password, id } = JSON.parse(body || '{}');
              if (typeof password !== 'string' || !verifyLogPassword(password)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
              }
              const proc = tunnelProcesses.get(id);
              if (proc) {
                proc.kill();
                tunnelProcesses.delete(id);
              }
              const idx = devState.links.findIndex((l) => l.id === id);
              if (idx !== -1) devState.links[idx].status = 'stopped';
              await saveDevState();
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Bad Request' }));
            }
          });
          return;
        }
      }

      if (pathname === '/dev/api/links/create') {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', c => { body += c; if (body.length > 16384) req.destroy(); });
          req.on('end', async () => {
            try {
              const { password, target, desiredSubdomain } = JSON.parse(body || '{}');
              if (typeof password !== 'string' || !verifyLogPassword(password)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
              }

              const targetUrl = new URL(String(target || '').trim() || 'https://torov1.up.railway.app');
              if (!/^https?:$/i.test(targetUrl.protocol)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid target URL protocol' }));
                return;
              }

              const linkId = randomUUID();
              const cmd = process.env.CLOUDFLARED_PATH || (process.platform === 'win32' ? '.\\cloudflared.exe' : 'cloudflared');
              const args = [
                'tunnel',
                '--url', targetUrl.toString(),
                '--http-host-header', targetUrl.host,
                '--no-autoupdate',
              ];

              const child = spawn(cmd, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
              let output = '';
              let finished = false;

              const done = async (payload, code = 200) => {
                if (finished) return;
                finished = true;
                clearTimeout(timeout);
                res.writeHead(code, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(payload));
              };

              const parseUrl = () => {
                const m = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
                return m ? m[0] : null;
              };

              child.stdout.on('data', (d) => {
                output += String(d);
                const url = parseUrl();
                if (!url || tunnelProcesses.has(linkId)) return;

                tunnelProcesses.set(linkId, child);
                const rec = {
                  id: linkId,
                  url,
                  requestedSubdomain: String(desiredSubdomain || '').slice(0, 50),
                  target: targetUrl.toString(),
                  createdAt: new Date().toISOString(),
                  status: 'running',
                };
                devState.links.unshift(rec);
                if (devState.links.length > 30) devState.links.length = 30;
                saveDevState();

                done({
                  ok: true,
                  link: rec,
                  note:
                    'Cloudflare quick tunnels do not support custom subdomain prefixes under trycloudflare.com. For custom names, use your own Cloudflare domain with named tunnels.',
                });
              });

              child.stderr.on('data', (d) => {
                output += String(d);
              });

              child.on('exit', async () => {
                tunnelProcesses.delete(linkId);
                const idx = devState.links.findIndex((l) => l.id === linkId);
                if (idx !== -1) {
                  devState.links[idx].status = 'stopped';
                  await saveDevState();
                }
              });

              const timeout = setTimeout(async () => {
                if (!finished) {
                  child.kill();
                  await done({ error: 'Failed to create link. Ensure cloudflared is installed and available.' }, 500);
                }
              }, 25000);
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Bad Request' }));
            }
          });
          return;
        }
      }

      if (pathname === '/logs/ips' || pathname === '/logs/ips/') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(logsHtml);
          return;
        }
        if (req.method === 'POST') {
          let body = '';
          req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
          req.on('end', () => {
            try {
              const { password } = JSON.parse(body);
              if (typeof password !== 'string' || !verifyLogPassword(password)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
              }
              const rows = [];
              for (const [ip, d] of ipLog)
                rows.push({ ip, city: d.city, state: d.state, country: d.country, vpn: d.vpn, isp: d.isp, device: d.device, visits: [...d.visits].reverse() });
              rows.reverse();
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(rows));
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Bad Request' }));
            }
          });
          return;
        }
      }

      if (pathname === '/logs/crlogs' || pathname === '/logs/crlogs/') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(crLogsHtml);
          return;
        }
        if (req.method === 'POST') {
          let body = '';
          req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
          req.on('end', () => {
            try {
              const { password } = JSON.parse(body || '{}');
              if (typeof password !== 'string' || !verifyLogPassword(password)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
              }
              const rooms = Object.values(chatState.rooms).map((r) => ({
                room: r.name,
                messageCount: Array.isArray(r.messages) ? r.messages.length : 0,
                messages: Array.isArray(r.messages) ? r.messages.slice(-500) : [],
              }));
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(rooms));
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Bad Request' }));
            }
          });
          return;
        }
      }

      const exemptPath = pathname.startsWith('/logs/') || pathname.startsWith('/dev/') || pathname === '/health';
      if (devState.maintenanceEnabled && !exemptPath) {
        const html = maintenanceHtml.replace('MSG_PLACEHOLDER', devState.maintenanceMessage || 'We are currently performing maintenance.');
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      bare?.shouldRoute(req) ? bare.routeRequest(req, res) : h(req, res);
    });
    return server;
  },
  logger: false,
  keepAliveTimeout: 30000,
  connectionTimeout: 60000,
  forceCloseConnections: true
});

await app.register(fastifyCookie);
await app.register(compress, { global: true, encodings: ['gzip','deflate','br'] });

app.register(fastifyStatic, {
  root: join(__dirname, "dist"),
  prefix: "/",
  decorateReply: true,
  etag: true,
  lastModified: true,
  cacheControl: true,
  setHeaders(res, path) {
    if (path.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
    } else if (/\.[a-f0-9]{8,}\./.test(path)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      res.setHeader("Cache-Control", "public, max-age=3600");
    }
  }
});

if (process.env.MASQR === "true")
  app.addHook("onRequest", MasqrMiddleware);

// Record every incoming request IP (skip the log viewer itself to reduce noise)
app.addHook('onRequest', async (req) => {
  if (!req.url.startsWith('/logs/') && !req.url.startsWith('/dev/')) recordIp(req.raw);
});

const proxy = (url, type = "application/javascript") => async (req, reply) => {
  try {
    const res = await fetch(url(req));
    if (!res.ok) return reply.code(res.status).send();

    const hop = [
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
      "content-encoding"
    ];
    for (const [k, v] of res.headers) {
      if (!hop.includes(k.toLowerCase())) reply.header(k, v);
    }

    if (res.headers.getSetCookie) {
      const cookies = res.headers.getSetCookie();
      if (cookies.length) reply.header("set-cookie", cookies);
    }

    if (!res.headers.get("content-type")) reply.type(type);

    return reply.send(res.body);
  } catch {
    return reply.code(500).send();
  }
};

app.get("/assets/img/*", proxy(req => `https://dogeub-assets.pages.dev/img/${req.params["*"]}`, ""));
app.get("/assets-fb/*", proxy(req => `https://dogeub-assets.pages.dev/img/server/${req.params["*"]}`, ""));
app.get("/js/script.js", proxy(() => "https://byod.privatedns.org/js/script.js"));
app.get("/ds", (req, res) => res.redirect("https://discord.gg/ZBef7HnAeg"));
app.get('/health', async () => ({ ok: true }));
app.get('/api/updates', async () => devState.updates);

app.get('/api/chat/rooms', async () => {
  pruneChatUsers();
  return Object.values(chatState.rooms)
    .map((r) => {
      const p = roomPresence(r.name);
      const last = r.messages[r.messages.length - 1];
      return {
        name: r.name,
        userCount: p.userCount,
        usernames: p.usernames,
        lastMessageAt: last?.ts || null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
});

  const crLogsHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chat Room Logs</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#090304;color:#f4d4d8;font-family:ui-sans-serif,system-ui,sans-serif;padding:24px}.wrap{max-width:980px;margin:0 auto}h1{font-size:1.65rem;color:#ff7d8d;margin-bottom:8px}.sub{opacity:.55;font-size:.82rem;margin-bottom:18px}#auth{max-width:380px;padding:18px;border-radius:16px;border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.35);backdrop-filter:blur(10px)}input{width:100%;padding:10px 12px;border-radius:999px;background:#130709;border:1px solid rgba(255,255,255,.24);color:#fff;outline:none}button{padding:9px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.28);background:linear-gradient(135deg,rgba(255,255,255,.16),rgba(255,255,255,.06));color:#ffecef;cursor:pointer}button:hover{border-color:rgba(255,255,255,.42)}#err{color:#ff9eaa;display:none;margin-top:8px;font-size:.8rem}#out{display:none}.room{margin-top:12px;border:1px solid rgba(255,255,255,.16);border-radius:14px;background:rgba(0,0,0,.3);overflow:hidden}.head{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.12)}.name{font-weight:700}.count{opacity:.6;font-size:.8rem}.msgs{padding:10px 12px;max-height:320px;overflow:auto}.msg{padding:7px 0;border-bottom:1px solid rgba(255,255,255,.08)}.msg:last-child{border-bottom:none}.u{color:#ffb2bc;font-weight:700}.t{opacity:.86}.time{opacity:.45;font-size:.72rem;margin-left:8px}.img{display:block;max-width:240px;border-radius:10px;margin-top:6px;border:1px solid rgba(255,255,255,.2)}</style></head><body><div class="wrap"><h1>Chat Room Logs</h1><p class="sub">View each room and historical messages</p><div id="auth"><input id="pw" type="password" placeholder="Admin password"/><div style="height:10px"></div><button id="btn">View Chat Logs</button><p id="err">Incorrect password.</p></div><div id="out"></div></div><script>function esc(s){return String(s||'').replace(/[&<>\"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[m]||m));}document.getElementById('pw').addEventListener('keydown',e=>{if(e.key==='Enter')go();});document.getElementById('btn').onclick=go;async function go(){const err=document.getElementById('err');err.style.display='none';const pw=document.getElementById('pw').value;const r=await fetch('/logs/crlogs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});if(r.status===401){err.style.display='block';return;}if(!r.ok){err.textContent='Request failed';err.style.display='block';return;}const rooms=await r.json();document.getElementById('auth').style.display='none';const out=document.getElementById('out');out.style.display='block';out.innerHTML='';rooms.forEach(room=>{const box=document.createElement('div');box.className='room';const head=document.createElement('div');head.className='head';head.innerHTML='<span class="name">#'+esc(room.room)+'</span><span class="count">'+room.messageCount+' messages</span>';const msgs=document.createElement('div');msgs.className='msgs';(room.messages||[]).forEach(m=>{const row=document.createElement('div');row.className='msg';const txt=(m.text?'<div class="t">'+esc(m.text)+'</div>':'');const img=(m.image?'<img class="img" src="'+m.image+'" alt="img"/>':'');row.innerHTML='<div><span class="u">'+esc(m.username)+'</span><span class="time">'+new Date(m.ts).toLocaleString()+'</span></div>'+txt+img;msgs.appendChild(row);});box.appendChild(head);box.appendChild(msgs);out.appendChild(box);});}</script></body></html>`;

app.post('/api/chat/join', async (req, reply) => {
  pruneChatUsers();
  const { room: rawRoom, username: rawUsername, sessionId } = req.body || {};
  const room = ensureRoom(rawRoom);
  const username = String(rawUsername || '').trim();
  if (!room) return reply.code(400).send({ error: 'Invalid room name' });
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 120) {
    return reply.code(400).send({ error: 'Invalid session' });
  }
  if (!username || username.length < 2 || username.length > 15) {
    return reply.code(400).send({ error: 'Username must be 2-15 characters' });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return reply.code(400).send({ error: 'Username can use letters, numbers, _ and - only' });
  }
  if (hasBadWord(username)) {
    return reply.code(400).send({ error: 'Username contains blocked words' });
  }

  const lower = username.toLowerCase();
  const same = Object.entries(chatState.users).find(
    ([sid, u]) => sid !== sessionId && u?.username?.toLowerCase() === lower,
  );
  if (same) return reply.code(409).send({ error: 'Username is already in use' });

  chatState.users[sessionId] = { username, room, lastSeen: Date.now() };
  const p = roomPresence(room);
  return reply.send({ ok: true, room, username, users: p.usernames, userCount: p.userCount });
});

app.post('/api/chat/leave', async (req) => {
  const { sessionId } = req.body || {};
  if (sessionId && chatState.users[sessionId]) delete chatState.users[sessionId];
  return { ok: true };
});

app.post('/api/chat/ping', async (req, reply) => {
  const { sessionId } = req.body || {};
  if (!sessionId || !chatState.users[sessionId]) return reply.code(404).send({ error: 'Not joined' });
  chatState.users[sessionId].lastSeen = Date.now();
  return { ok: true };
});

app.get('/api/chat/room/:room', async (req) => {
  pruneChatUsers();
  const room = ensureRoom(req.params.room);
  const r = room ? chatState.rooms[room] : null;
  if (!r) return { room: null, users: [], messages: [] };
  const p = roomPresence(room);
  return {
    room,
    users: p.usernames,
    userCount: p.userCount,
    messages: r.messages.slice(-400),
  };
});

app.post('/api/chat/message', async (req, reply) => {
  pruneChatUsers();
  const { sessionId, room: rawRoom, text: rawText, image: rawImage } = req.body || {};
  const user = chatState.users[sessionId];
  const room = ensureRoom(rawRoom);
  if (!user || !room || user.room !== room) return reply.code(403).send({ error: 'Join room first' });

  const text = String(rawText || '').trim().slice(0, 1200);
  const image = String(rawImage || '').trim().slice(0, 450000);

  if (!text && !image) return reply.code(400).send({ error: 'Message is empty' });
  if (text && hasBadWord(text)) return reply.code(400).send({ error: 'Message contains blocked words' });

  if (image) {
    const okImage = image.startsWith('data:image/') || /^https?:\/\//i.test(image);
    if (!okImage) return reply.code(400).send({ error: 'Invalid image' });
  }

  const msg = {
    id: randomUUID(),
    username: user.username,
    text,
    image,
    ts: new Date().toISOString(),
  };

  chatState.rooms[room].messages.push(msg);
  if (chatState.rooms[room].messages.length > 5000) chatState.rooms[room].messages.shift();
  user.lastSeen = Date.now();
  scheduleChatSave();
  return reply.send({ ok: true, message: msg });
});

// --- /logs/ips : password-protected IP viewer ---
const logsHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>IP Logs \u2014 Toro Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0a;color:#e5e5e5;font-family:monospace;padding:2rem;min-height:100vh}
h1{color:#dc2626;font-size:1.5rem;margin-bottom:.3rem}
.sub{opacity:.3;font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;margin-bottom:2rem}
#login{background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.16);backdrop-filter:blur(10px);border-radius:.95rem;padding:2rem;max-width:380px}
#login p{margin-bottom:1rem;font-size:.85rem;opacity:.5}
#pw{width:100%;padding:.65rem .95rem;background:#130709;border:1px solid rgba(255,255,255,.24);border-radius:999px;color:#fff;font-family:monospace;font-size:.875rem;outline:none;margin-bottom:.75rem;display:block}
#pw:focus{border-color:rgba(255,255,255,.45)}
#auth-btn{padding:.62rem 1.45rem;background:linear-gradient(135deg,rgba(255,255,255,.17),rgba(255,255,255,.06));border:1px solid rgba(255,255,255,.28);color:#ffecef;border-radius:999px;cursor:pointer;font-size:.85rem}
#auth-btn:hover{border-color:rgba(255,255,255,.45)}
#err{color:#f87171;font-size:.76rem;margin-top:.65rem;display:none}
#log{display:none}
.stats{font-size:.74rem;opacity:.35;margin-bottom:1.2rem}
table{width:100%;border-collapse:collapse;font-size:.76rem}
thead th{text-align:left;padding:.5rem .7rem;border-bottom:1px solid #1c1c1c;color:#dc2626;white-space:nowrap;font-weight:normal;letter-spacing:.05em;font-size:.67rem}
td{padding:.48rem .7rem;border-bottom:1px solid #0f0f0f;vertical-align:middle}
tbody tr:hover>td{background:#0d0d0d}
.mono{font-family:monospace;font-size:.78rem}
.badge{display:inline-block;padding:.16rem .52rem;border-radius:.3rem;font-size:.67rem;font-weight:bold;letter-spacing:.04em}
.b-vpn{background:#7f1d1d;color:#fca5a5}
.b-ok{background:#14532d;color:#86efac}
.b-wait{background:#1a1a1a;color:#555}
.btn-v{padding:.28rem .7rem;background:linear-gradient(135deg,rgba(255,255,255,.16),rgba(255,255,255,.06));border:1px solid rgba(255,255,255,.26);border-radius:999px;color:#f4d4d8;cursor:pointer;font-size:.68rem;font-family:monospace;white-space:nowrap}
.btn-v:hover{border-color:rgba(255,255,255,.45)}
.xrow>td{padding:0;border:none}
.vlist{background:#0d0d0d;border-bottom:1px solid #1c1c1c;padding:.65rem 1rem}
.vi{display:flex;gap:.75rem;padding:.28rem 0;border-bottom:1px solid #131313;font-size:.73rem;align-items:baseline}
.vi:last-child{border-bottom:none}
.vn{opacity:.22;min-width:2.2rem;text-align:right;flex-shrink:0}
.vt{color:#dc2626;min-width:17rem;flex-shrink:0}
.vm{color:#60a5fa;min-width:3.5rem;flex-shrink:0}
.vp{opacity:.45;word-break:break-all}
.isp-td{max-width:10rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.55}
</style>
</head>
<body>
<h1>IP Logs</h1>
<p class="sub">Toro Admin &bull; Visitor Intelligence</p>
<div id="login">
  <p>Enter admin password to continue.</p>
  <input type="password" id="pw" placeholder="Password" />
  <button id="auth-btn" onclick="doAuth()">Authenticate</button>
  <p id="err">Incorrect password.</p>
</div>
<div id="log">
  <p class="stats" id="stats"></p>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>IP Address</th>
        <th>City</th>
        <th>State / Region</th>
        <th>Country</th>
        <th>Device</th>
        <th>ISP</th>
        <th>VPN</th>
        <th>Visits</th>
        <th>Last Seen / Logs</th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>
</div>
<script>
document.getElementById('pw').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') doAuth();
});
function fmt(ts) {
  var d = new Date(ts);
  return d.toLocaleDateString(undefined, {month:'short',day:'numeric',year:'numeric'})
    + ' \u2022 '
    + d.toLocaleTimeString(undefined, {hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
async function doAuth() {
  var pw = document.getElementById('pw').value;
  var err = document.getElementById('err');
  var btn = document.getElementById('auth-btn');
  err.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Authenticating...';
  try {
    var res = await fetch('/logs/ips', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({password: pw})
    });
    if (res.status === 401) {
      err.textContent = 'Incorrect password.';
      err.style.display = 'block';
      return;
    }
    if (!res.ok) {
      err.textContent = 'Request failed (' + res.status + ').';
      err.style.display = 'block';
      return;
    }
    var data = await res.json();
    if (!Array.isArray(data)) {
      err.textContent = 'Unexpected response from server.';
      err.style.display = 'block';
      return;
    }
    document.getElementById('login').style.display = 'none';
    document.getElementById('log').style.display = 'block';
    var total = data.reduce(function(a, b) { return a + b.visits.length; }, 0);
    document.getElementById('stats').textContent = data.length + ' unique IPs \u2014 ' + total + ' total requests';
    var tbody = document.getElementById('tbody');
    tbody.innerHTML = '';
    data.forEach(function(r, i) {
      var vpnHtml = r.vpn === null
        ? '<span class="badge b-wait">Checking\u2026</span>'
        : r.vpn
          ? '<span class="badge b-vpn">VPN ON</span>'
          : '<span class="badge b-ok">No VPN</span>';
      var last = r.visits[0];
      var eId = 'ex' + i;
      var action = r.visits.length > 1
        ? '<button class="btn-v" onclick="toggle(this,\\\'' + eId + '\\\')">View Logs</button>'
        : (last ? fmt(last.ts) : '\u2014');
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + (i + 1) + '</td>'
        + '<td class="mono">' + r.ip + '</td>'
        + '<td>' + (r.city || '\u2014') + '</td>'
        + '<td>' + (r.state || '\u2014') + '</td>'
        + '<td>' + (r.country || '\u2014') + '</td>'
        + '<td>' + (r.device || 'Unknown') + '</td>'
        + '<td class="isp-td" title="' + (r.isp || '') + '">' + (r.isp || '\u2014') + '</td>'
        + '<td>' + vpnHtml + '</td>'
        + '<td>' + r.visits.length + '</td>'
        + '<td>' + action + '</td>';
      tbody.appendChild(tr);
      if (r.visits.length > 1) {
        var xtr = document.createElement('tr');
        xtr.className = 'xrow'; xtr.id = eId; xtr.style.display = 'none';
        var items = r.visits.map(function(v, j) {
          return '<div class="vi">'
            + '<span class="vn">' + (j + 1) + '</span>'
            + '<span class="vt">' + fmt(v.ts) + '</span>'
            + '<span class="vm">' + v.method + '</span>'
            + '<span class="vp">' + v.path + '</span>'
            + '</div>';
        }).join('');
        xtr.innerHTML = '<td colspan="10"><div class="vlist">' + items + '</div></td>';
        tbody.appendChild(xtr);
      }
    });
  } catch {
    err.textContent = 'Network error. Try again.';
    err.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Authenticate';
  }
}
function toggle(btn, id) {
  var row = document.getElementById(id);
  var open = row.style.display !== 'none';
  row.style.display = open ? 'none' : 'table-row';
  btn.textContent = open ? 'View Logs' : 'Hide Logs';
}
</script>
</body>
</html>`;


app.get("/return", async (req, reply) =>
  req.query?.q
    ? fetch(`https://duckduckgo.com/ac/?q=${encodeURIComponent(req.query.q)}`)
        .then(r => r.json())
        .catch(() => reply.code(500).send({ error: "request failed" }))
    : reply.code(401).send({ error: "query parameter?" })
);

app.setNotFoundHandler((req, reply) =>
  req.raw.method === "GET" && req.headers.accept?.includes("text/html")
    ? reply.sendFile("index.html")
    : reply.code(404).send({ error: "Not Found" })
);

// Always bind all interfaces in containers; platform-provided HOST values can be non-bindable.
const host = "0.0.0.0";
app
  .listen({ port, host })
  .then(() => console.log(`Server running on ${host}:${port}`))
  .catch((err) => {
    console.error('Server failed to start:', err);
    process.exit(1);
  });
