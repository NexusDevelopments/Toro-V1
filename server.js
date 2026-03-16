import dotenv from "dotenv";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import compress from "@fastify/compress";
import fastifyCookie from "@fastify/cookie";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { scryptSync, timingSafeEqual } from "node:crypto";
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
    if (e) { e.city = d.city||''; e.state = d.regionName||''; e.country = d.country||''; e.vpn = !!(d.proxy||d.hosting); e.isp = d.isp||''; e.geoFetched = true; }
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
      // Admin endpoint: bypass Fastify/static entirely so React Router never intercepts it
      const pathname = new URL(req.url || '/', 'http://local').pathname;
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
  if (!req.url.startsWith('/logs/')) recordIp(req.raw);
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
#login{background:#111;border:1px solid #1c1c1c;border-radius:.75rem;padding:2rem;max-width:380px}
#login p{margin-bottom:1rem;font-size:.85rem;opacity:.5}
#pw{width:100%;padding:.6rem .9rem;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:.5rem;color:#fff;font-family:monospace;font-size:.875rem;outline:none;margin-bottom:.75rem;display:block}
#pw:focus{border-color:#dc2626}
#auth-btn{padding:.6rem 1.5rem;background:#dc2626;color:#fff;border:none;border-radius:.5rem;cursor:pointer;font-size:.85rem}
#auth-btn:hover{background:#b91c1c}
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
.btn-v{padding:.22rem .6rem;background:transparent;border:1px solid #2a2a2a;border-radius:.3rem;color:#777;cursor:pointer;font-size:.68rem;font-family:monospace;white-space:nowrap}
.btn-v:hover{border-color:#dc2626;color:#dc2626}
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
        ? '<button class="btn-v" onclick="toggle(this,\'' + eId + '\')">View Logs</button>'
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
