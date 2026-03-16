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
// Password hash (scrypt, salt: a3f8c1e290bd4751) of the admin password — never stored in plain text
const LOG_SALT = 'a3f8c1e290bd4751';
const LOG_HASH = Buffer.from('8a5fd87579ddd37ba91e7fb02c4a4d178d53752f6726283ea44714f8261eaa4a1e3b8e005b813e942572d8dd873de77e23a559517a24068c9172577b6b7c875e', 'hex');
const ipLog = []; // in-memory ring buffer, max 2000 entries

function verifyLogPassword(candidate) {
  try {
    const candidateHash = scryptSync(candidate, LOG_SALT, 64);
    return timingSafeEqual(candidateHash, LOG_HASH);
  } catch {
    return false;
  }
}

function recordIp(req) {
  const xff = req.headers['x-forwarded-for'];
  const ip = xff ? xff.split(',')[0].trim() : (req.socket?.remoteAddress ?? 'unknown');
  ipLog.push({ ip, path: req.url, method: req.method, ts: new Date().toISOString() });
  if (ipLog.length > 2000) ipLog.shift();
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
  serverFactory: h => (
    server.on("request", (req, res) =>
      bare?.shouldRoute(req) ? bare.routeRequest(req, res) : h(req, res)
    ),
    server
  ),
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
const logsHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IP Logs</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0a0a0a;color:#e5e5e5;font-family:monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem}#app{width:100%;max-width:900px}h1{color:#dc2626;font-size:1.5rem;margin-bottom:1.5rem}#login{background:#111;border:1px solid #222;border-radius:.75rem;padding:2rem}#login p{margin-bottom:1rem;font-size:.875rem;opacity:.6}#login input{width:100%;padding:.6rem .9rem;background:#1a1a1a;border:1px solid #333;border-radius:.5rem;color:#fff;font-family:monospace;font-size:.875rem;outline:none;margin-bottom:1rem}#login input:focus{border-color:#dc2626}#login button{padding:.6rem 1.4rem;background:#dc2626;color:#fff;border:none;border-radius:.5rem;cursor:pointer;font-size:.875rem}#login button:hover{background:#b91c1c}#err{color:#f87171;font-size:.8rem;margin-top:.75rem;display:none}#log{display:none}#log h2{font-size:1rem;margin-bottom:1rem;opacity:.5}table{width:100%;border-collapse:collapse;font-size:.8rem}th{text-align:left;padding:.5rem .75rem;border-bottom:1px solid #222;color:#dc2626;opacity:.8}td{padding:.45rem .75rem;border-bottom:1px solid #111;word-break:break-all}tr:hover td{background:#111}#count{margin-bottom:.75rem;font-size:.8rem;opacity:.5}</style></head><body><div id="app"><h1>IP Logs</h1><div id="login"><p>Enter admin password to view logs.</p><input type="password" id="pw" placeholder="Password" /><br><button onclick="submit()">View Logs</button><div id="err">Incorrect password.</div></div><div id="log"><div id="count"></div><h2>Recent Requests</h2><table><thead><tr><th>#</th><th>IP</th><th>Method</th><th>Path</th><th>Time</th></tr></thead><tbody id="tbody"></tbody></table></div></div><script>document.getElementById('pw').addEventListener('keydown',e=>{if(e.key==='Enter')submit();});async function submit(){const pw=document.getElementById('pw').value;const res=await fetch('/logs/ips',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});if(res.status===401){document.getElementById('err').style.display='block';return;}const data=await res.json();document.getElementById('login').style.display='none';document.getElementById('log').style.display='block';document.getElementById('count').textContent=data.length+' entries logged';const tbody=document.getElementById('tbody');tbody.innerHTML='';data.forEach((r,i)=>{const tr=document.createElement('tr');tr.innerHTML='<td>'+(i+1)+'</td><td>'+r.ip+'</td><td>'+r.method+'</td><td>'+r.path+'</td><td>'+r.ts+'</td>';tbody.appendChild(tr);});}</script></body></html>`;

app.get('/logs/ips', async (req, reply) => {
  reply.type('text/html').send(logsHtml);
});

app.post('/logs/ips', async (req, reply) => {
  const { password } = req.body ?? {};
  if (typeof password !== 'string' || !verifyLogPassword(password)) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  return reply.send([...ipLog].reverse());
});
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
