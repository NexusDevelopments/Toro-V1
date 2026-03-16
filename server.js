import dotenv from "dotenv";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import compress from "@fastify/compress";
import fastifyCookie from "@fastify/cookie";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { scryptSync, timingSafeEqual, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
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
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
let pgStateClient = null;
let ipLogSaveTimer = null;
let chatSaveTimer = null;
const tunnelProcesses = new Map();
const CHAT_USER_TTL_MS = 120000;
const BAD_WORDS = (process.env.CHAT_BLOCKED_WORDS || 'fuck,shit,bitch,asshole,cunt,porn,sex')
  .split(',')
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean);

const SITE_NAME_THEME_MAP = {
  education: {
    keywords: ['education', 'school', 'study', 'learning', 'college', 'class', 'academic', 'teacher', 'campus'],
    leads: ['Campus', 'Scholar', 'Lesson', 'Study', 'Academy', 'Bright', 'Clever', 'Pencil'],
    tails: ['Compass', 'Bridge', 'Atlas', 'Desk', 'Works', 'Path', 'Central', 'Library'],
  },
  technology: {
    keywords: ['tech', 'technology', 'coding', 'code', 'developer', 'software', 'computer', 'programming'],
    leads: ['Code', 'Pixel', 'Circuit', 'Logic', 'Stack', 'Binary', 'Dev', 'Signal'],
    tails: ['Forge', 'Lab', 'Grid', 'Core', 'Flow', 'Foundry', 'Base', 'Works'],
  },
  gaming: {
    keywords: ['gaming', 'game', 'esports', 'arcade', 'stream'],
    leads: ['Arcade', 'Quest', 'Level', 'Pixel', 'Spawn', 'Victory', 'Guild', 'Respawn'],
    tails: ['Arena', 'Zone', 'Hub', 'Portal', 'Vault', 'Deck', 'Pulse', 'Base'],
  },
  business: {
    keywords: ['business', 'finance', 'money', 'startup', 'office', 'market', 'sales'],
    leads: ['Summit', 'Ledger', 'Capital', 'Market', 'Prime', 'Vertex', 'Growth', 'Trade'],
    tails: ['Works', 'Point', 'Bridge', 'Desk', 'Central', 'Partners', 'Flow', 'Board'],
  },
  health: {
    keywords: ['health', 'medical', 'wellness', 'fitness', 'care', 'clinic'],
    leads: ['Vital', 'Well', 'Care', 'Pulse', 'Active', 'Core', 'Bloom', 'Health'],
    tails: ['Bridge', 'Center', 'Path', 'Works', 'Studio', 'Guide', 'Collective', 'Point'],
  },
  media: {
    keywords: ['news', 'media', 'blog', 'music', 'video', 'podcast', 'art'],
    leads: ['Signal', 'Echo', 'Canvas', 'Story', 'Melody', 'Frame', 'Studio', 'Spotlight'],
    tails: ['Daily', 'House', 'Wave', 'Hub', 'Press', 'Collective', 'Feed', 'Room'],
  },
};

function toTitleToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function slugifySiteName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function detectSiteNameTheme(term) {
  const normalized = String(term || '').toLowerCase();
  for (const [themeName, theme] of Object.entries(SITE_NAME_THEME_MAP)) {
    if (theme.keywords.some((keyword) => normalized.includes(keyword))) {
      return themeName;
    }
  }
  return 'generic';
}

function generateSiteNameIdeas(term, max = 8) {
  const normalizedTerm = String(term || '').trim().toLowerCase();
  if (!normalizedTerm) return [];

  const safeToken = toTitleToken(normalizedTerm) || 'Nimbus';
  const themeName = detectSiteNameTheme(normalizedTerm);
  const theme = SITE_NAME_THEME_MAP[themeName] || {
    leads: ['North', 'Blue', 'Open', 'Bright', 'Prime', 'Clear', 'Nova', 'Summit'],
    tails: ['Works', 'Hub', 'Point', 'Atlas', 'Bridge', 'Studio', 'Collective', 'Base'],
  };
  const maxCount = Math.min(20, Math.max(1, Number(max) || 8));

  // Build a large candidate pool to support up to 20 unique names
  const candidates = [
    `${safeToken}Hub`,
    `${safeToken}Central`,
    `${safeToken}Atlas`,
    `${safeToken}Works`,
    `${safeToken}Studio`,
    `${safeToken}Lab`,
    `${safeToken}Base`,
    `${safeToken}Point`,
    `${safeToken}Bridge`,
    `${safeToken}Collective`,
    ...theme.leads.map((l, i) => `${l}${theme.tails[i % theme.tails.length]}`),
    ...theme.tails.map((t, i) => `${theme.leads[i % theme.leads.length]}${t}`),
    ...theme.leads.map((l) => `${l}${safeToken}`),
    ...theme.tails.map((t) => `${safeToken}${t}`),
    ...theme.leads.map((l, i) => `${l}${theme.tails[(i + 3) % theme.tails.length]}`),
  ];

  // Short random suffix (4 alphanumeric chars) so the same theme can be
  // bulk-created multiple times without hitting BunnyCDN uniqueness errors.
  const randSuffix = Math.random().toString(36).slice(2, 6);

  const unique = [];
  const seen = new Set();
  for (const label of candidates) {
    const cleaned = String(label || '').replace(/[^A-Za-z0-9]+/g, '').slice(0, 36);
    if (!cleaned) continue;
    const slug = slugifySiteName(`${cleaned}-${randSuffix}`);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    unique.push({ label: cleaned, slug });
    if (unique.length >= maxCount) break;
  }

  return unique;
}

function getBunnyCDNSupport() {
  const apiKey = String(process.env.BUNNYCDN_API_KEY || '').trim();
  if (!apiKey) {
    return {
      available: false,
      apiKey: null,
      reason: 'Set the BUNNYCDN_API_KEY environment variable to enable BunnyCDN pull zones.',
    };
  }
  return { available: true, apiKey, reason: '' };
}

async function createBunnyCDNPullZone(apiKey, zoneName, originUrl) {
  const payload = JSON.stringify({
    Name: zoneName,
    OriginUrl: originUrl,
    Type: 0,
    Enabled: true,
    IgnoreQueryStrings: false,
    DisableCookies: false,
    CacheControlMaxAgeOverride: -1,
  });
  const resp = await fetch('https://api.bunny.net/pullzone', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      AccessKey: apiKey,
    },
    body: payload,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    if (resp.status === 401) {
      throw new Error(
        'BunnyCDN API key is invalid or lacks permission. Go to BunnyCDN Dashboard → Account → API and copy the Account API Key (not a storage/CDN key).'
      );
    }
    if (resp.status === 400) {
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        if (j?.ErrorKey === 'user.insufficient_balance') {
          throw new Error('Your BunnyCDN account has insufficient balance / is not allowed to add new pull zones. Add billing credits at dash.bunny.net/billing.');
        }
        if (j?.ErrorKey === 'pullzone.nameAlreadyExists' || /already exist/i.test(j?.Message || '')) {
          throw new Error(`BunnyCDN: zone name "${zoneName}" is already taken. Choose a different name or try again (names include a random suffix).`);
        }
        if (j?.Message) detail = j.Message;
      } catch (inner) {
        if (inner.message.startsWith('BunnyCDN') || inner.message.startsWith('Your BunnyCDN')) throw inner;
      }
      throw new Error(`BunnyCDN rejected the request (400). Check the zone name — it must be unique and contain only letters, numbers, and hyphens. Details: ${detail}`);
    }
    throw new Error(`BunnyCDN API error ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  const zoneId = data.Id;
  if (!zoneId) throw new Error('BunnyCDN did not return a zone ID.');

  // If the zone came back disabled (can happen on trial/new accounts), explicitly enable it.
  if (data.Enabled === false) {
    await fetch(`https://api.bunny.net/pullzone/${encodeURIComponent(zoneId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', AccessKey: apiKey },
      body: JSON.stringify({ Enabled: true }),
    }).catch(() => {});
  }

  const hostname =
    (Array.isArray(data?.Hostnames) && data.Hostnames[0]?.Value) ||
    (data?.Name ? `${data.Name}.b-cdn.net` : null);
  if (!hostname) throw new Error('BunnyCDN did not return a hostname.');
  return { zoneId, hostname };
}

async function deleteBunnyCDNPullZone(apiKey, zoneId) {
  try {
    await fetch(`https://api.bunny.net/pullzone/${encodeURIComponent(zoneId)}`, {
      method: 'DELETE',
      headers: { AccessKey: apiKey },
    });
  } catch {
    // best-effort cleanup
  }
}

// --------------- Cloudflare Workers provider ---------------

function getCFWorkersSupport() {
  const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const apiToken = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
  if (!accountId || !apiToken) {
    return {
      available: false,
      accountId: null,
      apiToken: null,
      reason: 'Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers Scripts: Edit permission) to enable this provider.',
    };
  }
  return { available: true, accountId, apiToken, reason: '' };
}

async function _getCFSubdomain(accountId, apiToken) {
  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/subdomain`,
    { headers: { Authorization: `Bearer ${apiToken}` } }
  );
  if (!resp.ok) {
    const j = await resp.json().catch(() => ({}));
    throw new Error(`Cloudflare API error ${resp.status}: ${j?.errors?.[0]?.message || ''}`);
  }
  const data = await resp.json();
  const sub = data?.result?.subdomain;
  if (!sub) throw new Error('No workers.dev subdomain found. Enable Workers on your Cloudflare account first.');
  return sub;
}

async function createCloudflareWorker(accountId, apiToken, workerName, targetUrl) {
  const subdomain = await _getCFSubdomain(accountId, apiToken);

  // Minimal module-format Worker that proxies all requests to the target origin
  const script = `export default {
  async fetch(request) {
    const target = new URL("${targetUrl.replace(/"/g, '\\"')}");
    const incoming = new URL(request.url);
    incoming.hostname = target.hostname;
    incoming.protocol = target.protocol;
    incoming.port = target.port;
    const init = { method: request.method, headers: new Headers(request.headers), redirect: "follow" };
    if (!["GET", "HEAD"].includes(request.method)) init.body = request.body;
    return fetch(incoming.toString(), init);
  }
};`;

  const form = new FormData();
  form.append('script', new Blob([script], { type: 'application/javascript+module' }), 'worker.js');
  form.append('metadata', new Blob([JSON.stringify({ main_module: 'worker.js' })], { type: 'application/json' }));

  const uploadResp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}`,
    { method: 'PUT', headers: { Authorization: `Bearer ${apiToken}` }, body: form }
  );
  if (!uploadResp.ok) {
    const j = await uploadResp.json().catch(() => ({}));
    if (uploadResp.status === 403)
      throw new Error('API token lacks Workers Script Edit permission. Create a token with "Workers Scripts: Edit" at dash.cloudflare.com/profile/api-tokens.');
    throw new Error(`Worker upload failed (${uploadResp.status}): ${j?.errors?.[0]?.message || ''}`);
  }

  // Enable workers.dev subdomain for this script
  await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    }
  );

  return { workerName, hostname: `${workerName}.${subdomain}.workers.dev` };
}

async function deleteCloudflareWorker(accountId, apiToken, workerName) {
  try {
    await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${apiToken}` } }
    );
  } catch {
    // best-effort cleanup
  }
}

function getCloudflaredSupport() {
  if (process.env.DISABLE_CLOUDFLARED === 'true') {
    return {
      available: false,
      command: null,
      reason: 'Cloudflare quick tunnels are disabled for this deployment.',
    };
  }

  const configuredCommand = String(process.env.CLOUDFLARED_PATH || '').trim();
  if (configuredCommand) {
    const probe = spawnSync(configuredCommand, ['--version'], { stdio: 'ignore' });
    if (!probe.error) {
      return { available: true, command: configuredCommand, reason: '' };
    }

    return {
      available: false,
      command: configuredCommand,
      reason: `CLOUDFLARED_PATH is set, but the binary is not executable (${probe.error?.code || 'unknown'}).`,
    };
  }

  if (process.platform === 'win32') {
    const bundledCommand = join(__dirname, 'cloudflared.exe');
    if (existsSync(bundledCommand)) {
      return { available: true, command: bundledCommand, reason: '' };
    }

    return {
      available: false,
      command: bundledCommand,
      reason: 'Bundled cloudflared.exe was not found on this server.',
    };
  }

  const probe = spawnSync('cloudflared', ['--version'], { stdio: 'ignore' });
  if (!probe.error) {
    return { available: true, command: 'cloudflared', reason: '' };
  }

  return {
    available: false,
    command: 'cloudflared',
    reason: 'Cloudflare quick tunnels are unavailable here because cloudflared is not installed on the server.',
  };
}

async function loadDevState() {
  const applyParsedDevState = (parsed) => {
    if (!parsed || typeof parsed !== 'object') return;

    if (typeof parsed.maintenanceEnabled === 'boolean') {
      devState.maintenanceEnabled = parsed.maintenanceEnabled;
    }
    if (typeof parsed.maintenanceMessage === 'string' && parsed.maintenanceMessage.trim()) {
      devState.maintenanceMessage = parsed.maintenanceMessage;
    }
    if (Array.isArray(parsed.links)) {
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
          provider: typeof l.provider === 'string' ? l.provider : 'cloudflared',
          providerZoneId: typeof l.providerZoneId === 'number' ? l.providerZoneId : undefined,
          cfWorkerName: typeof l.cfWorkerName === 'string' ? l.cfWorkerName : undefined,
        }));
    }
    if (Array.isArray(parsed.updates)) {
      devState.updates = parsed.updates
        .filter((u) => typeof u?.text === 'string' && u.text.trim())
        .slice(0, 100)
        .map((u) => ({
          id: typeof u.id === 'string' ? u.id : randomUUID(),
          text: u.text.trim(),
          ts: typeof u.ts === 'string' ? u.ts : new Date().toISOString(),
        }));
    }
  };

  const getPgStateClient = async () => {
    if (!DATABASE_URL) return null;
    if (pgStateClient) return pgStateClient;

    const pgModule = await import('pg');
    const Client = pgModule.Client || pgModule.default?.Client;
    if (!Client) throw new Error('pg Client export not found');

    const client = new Client({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
    });
    await client.connect();
    await client.query(
      'CREATE TABLE IF NOT EXISTS app_state (state_key TEXT PRIMARY KEY, state_value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())'
    );
    pgStateClient = client;
    return client;
  };

  // Prefer Postgres when DATABASE_URL is configured so state survives Railway deploys.
  if (DATABASE_URL) {
    try {
      const client = await getPgStateClient();
      if (client) {
        const result = await client.query('SELECT state_value FROM app_state WHERE state_key = $1 LIMIT 1', ['dev_state']);
        if (result.rows?.[0]?.state_value) {
          applyParsedDevState(result.rows[0].state_value);
          return;
        }
      }
    } catch (err) {
      console.error('Failed to load dev state from Postgres; falling back to file:', err?.message || err);
    }
  }

  try {
    const raw = await readFile(DEV_STATE_FILE, 'utf8');
    applyParsedDevState(JSON.parse(raw));
  } catch {
    // No persisted file yet; defaults stay in memory.
  }
}

async function saveDevState() {
  if (DATABASE_URL) {
    try {
      if (!pgStateClient) {
        const pgModule = await import('pg');
        const Client = pgModule.Client || pgModule.default?.Client;
        if (!Client) throw new Error('pg Client export not found');

        pgStateClient = new Client({
          connectionString: DATABASE_URL,
          ssl: DATABASE_URL.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
        });
        await pgStateClient.connect();
      }

      await pgStateClient.query(
        'CREATE TABLE IF NOT EXISTS app_state (state_key TEXT PRIMARY KEY, state_value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())'
      );
      await pgStateClient.query(
        'INSERT INTO app_state (state_key, state_value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (state_key) DO UPDATE SET state_value = EXCLUDED.state_value, updated_at = NOW()',
        [
          'dev_state',
          JSON.stringify({
            maintenanceEnabled: devState.maintenanceEnabled,
            maintenanceMessage: devState.maintenanceMessage,
            links: devState.links,
            updates: devState.updates,
          }),
        ]
      );
      return;
    } catch (err) {
      console.error('Failed to persist dev state to Postgres; falling back to file:', err?.message || err);
    }
  }

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

const devLinksHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dev Links</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#090304;color:#f4d4d8;font-family:ui-sans-serif,system-ui,sans-serif;min-height:100vh;padding:24px}.wrap{max-width:960px;margin:0 auto}.card{background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(10px);border-radius:16px;padding:18px;margin-bottom:16px}h1{font-size:2rem;color:#ff7788;margin-bottom:8px}h2{font-size:1.04rem;margin-bottom:10px;color:#ffc7cf}.muted{opacity:.7;font-size:.84rem;line-height:1.45}input{width:100%;padding:10px 12px;border-radius:999px;background:#130709;border:1px solid rgba(255,255,255,.2);color:#fff;outline:none}input[type=number]{-moz-appearance:textfield}input::-webkit-outer-spin-button,input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}button{background:linear-gradient(135deg,rgba(255,255,255,.15),rgba(255,255,255,.06));border:1px solid rgba(255,255,255,.26);color:#ffecef;border-radius:999px;padding:9px 14px;cursor:pointer}button:hover{border-color:rgba(255,255,255,.45)}button:disabled{opacity:.4;cursor:default}.row{display:flex;gap:10px;flex-wrap:wrap}.hidden{display:none}.tabs{display:flex;gap:8px;margin-bottom:16px}.tab{border-radius:999px;padding:9px 20px}.tab.active{border-color:#ff7788;background:rgba(255,119,136,.15)}.link{padding:12px;border:1px solid rgba(255,255,255,.14);border-radius:12px;background:rgba(0,0,0,.26);margin-bottom:8px}.lurl{font-size:.86rem;word-break:break-all}.lmeta{font-size:.78rem;opacity:.6;margin-top:4px}.badge{display:inline-block;border-radius:999px;padding:2px 8px;font-size:.72rem;margin-left:5px}.badge.running{background:rgba(100,255,150,.12);color:#80ffaa}.badge.stopped{background:rgba(255,100,100,.1);color:#ff9090}.badge.prov{background:rgba(255,255,255,.08);color:#ddd}.ideas{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;margin-top:12px}.idea{border-radius:12px;padding:10px 12px;text-align:left}.providers{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin-top:10px}.pcard{border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:10px 12px;cursor:pointer;transition:border-color .15s}.pcard.selected{border-color:#ff7788;background:rgba(255,119,136,.08)}.pcard .ptitle{font-size:.92rem;color:#ffc7cf;margin-bottom:3px}.pcard .pdomain{font-size:.78rem;opacity:.6}.pcard .pstatus{font-size:.75rem;margin-top:4px}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px}.stat{border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:12px;text-align:center}.stat-n{font-size:1.6rem;color:#ff7788;font-weight:bold}.stat-l{font-size:.75rem;opacity:.6;margin-top:2px}.notice{margin-top:10px;padding:10px 12px;border:1px solid rgba(255,184,100,.3);border-radius:12px;background:rgba(255,184,100,.08);font-size:.82rem;color:#ffd580;line-height:1.5}.progress{margin-top:12px;padding:10px 12px;border:1px solid rgba(255,255,255,.1);border-radius:12px;background:rgba(0,0,0,.3);font-size:.82rem;display:grid;gap:4px}.pi{padding:5px 0;border-bottom:1px solid rgba(255,255,255,.06);display:flex;gap:8px;align-items:center;flex-wrap:wrap}.pi:last-child{border-bottom:none}</style></head><body><div class="wrap"><h1>Dev Links</h1><p class="muted">Create and manage CDN/tunnel links using your preferred provider.</p><div id="auth" class="card"><h2>Authenticate</h2><input id="pw" type="password" placeholder="Admin password"/><div style="height:10px"></div><button id="login">Enter</button><p id="err" style="display:none;color:#ffb8c0;font-size:.84rem;margin-top:8px"></p></div><div id="panel" class="hidden"><div class="tabs"><button class="tab active" id="tab-create" onclick="showTab('create')">Create</button><button class="tab" id="tab-links" onclick="showTab('links')">Links</button></div><div id="view-create"><div class="card"><h2>Target URL</h2><div class="row"><input id="target" value="https://torov1.up.railway.app"/></div><div style="height:10px"></div><h2>Provider</h2><div id="providers" class="providers"></div></div><div class="card"><h2>Single Link</h2><div class="row"><input id="term" placeholder="Theme: education, gaming, health\u2026"/></div><div style="height:8px"></div><div class="row"><button id="generate">Generate Names</button></div><div id="ideas" class="ideas"></div><div style="height:10px"></div><div class="row"><input id="sub" placeholder="Site / zone name"/></div><p class="muted" style="margin-top:6px">BunnyCDN: zone name becomes name.b-cdn.net. Cloudflare: URL is randomly assigned.</p><div style="height:10px"></div><div class="row"><button id="create">Create Single Link</button></div><div id="create-note" style="display:none" class="notice"></div></div><div class="card"><h2>Bulk Create</h2><p class="muted" style="margin-bottom:10px">Enter a theme and how many links to auto-generate. Names are created from the theme. BunnyCDN only.</p><div class="row"><input id="bulk-term" placeholder="Theme: education, gaming, tech\u2026" style="flex:1"/><input id="bulk-count" type="number" min="1" max="20" value="3" style="width:90px;flex:none"/></div><div style="height:10px"></div><div class="row"><button id="bulk-create">Bulk Create Links</button></div><div id="bulk-progress" style="display:none" class="progress"></div></div></div><div id="view-links" class="hidden"><div class="stats"><div class="stat"><div class="stat-n" id="stat-total">0</div><div class="stat-l">Total</div></div><div class="stat"><div class="stat-n" id="stat-running">0</div><div class="stat-l">Running</div></div><div class="stat"><div class="stat-n" id="stat-stopped">0</div><div class="stat-l">Stopped</div></div></div><div class="card"><div style="display:flex;gap:8px;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap"><h2 style="margin-bottom:0">All Links</h2><div style="display:flex;gap:8px"><button id="refresh-links">\u21bb Refresh</button><button id="stop-all" style="border-color:rgba(255,100,100,.4);color:#ffb8b8">Stop All</button></div></div><div id="links-list"></div></div></div></div></div><script>let PASS='';let providers={};let selectedProvider='cloudflared';let allLinks=[];function esc(s){return String(s||'').replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]||m));}async function post(url,data){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const j=await r.json().catch(()=>({}));if(!r.ok) throw new Error(j.error||('Request failed '+r.status));return j;}function setErr(t){const e=document.getElementById('err');e.style.display=t?'block':'none';e.textContent=t||'';}function showTab(tab){document.getElementById('view-create').classList.toggle('hidden',tab!=='create');document.getElementById('view-links').classList.toggle('hidden',tab!=='links');document.getElementById('tab-create').classList.toggle('active',tab==='create');document.getElementById('tab-links').classList.toggle('active',tab==='links');if(tab==='links')refreshLinks();}const PROVIDER_META={cloudflared:{title:'Cloudflare Tunnel',domain:'*.trycloudflare.com'},bunnycdn:{title:'BunnyCDN Pull Zone',domain:'*.b-cdn.net'},cfworker:{title:'Cloudflare Workers',domain:'*.workers.dev'}};function paintProviders(){const box=document.getElementById('providers');box.innerHTML='';Object.entries(PROVIDER_META).forEach(([key,meta])=>{const info=providers[key]||{available:false,reason:''};const card=document.createElement('div');card.className='pcard'+(key===selectedProvider?' selected':'');card.innerHTML='<div class="ptitle">'+esc(meta.title)+'</div><div class="pdomain">'+esc(meta.domain)+'</div><div class="pstatus" style="color:'+(info.available?'#a0ffb8':'#ffb8c0')+'">'+esc(info.available?'Available':info.reason||'Unavailable')+'</div>';card.onclick=()=>{selectedProvider=key;paintProviders();};box.appendChild(card);});}function paintIdeas(items){const box=document.getElementById('ideas');box.innerHTML='';(items||[]).forEach(item=>{const button=document.createElement('button');button.className='idea';button.type='button';button.textContent=item.label;button.onclick=()=>{document.getElementById('sub').value=item.label;};box.appendChild(button);});if(!(items||[]).length)box.innerHTML='<p class="muted">No suggestions yet.</p>';}async function generateIdeas(){try{const term=document.getElementById('term').value.trim();if(!term){paintIdeas([]);return;}const data=await post('/dev/api/links/suggest-names',{password:PASS,term});paintIdeas(data.suggestions||[]);}catch(e){alert(e.message||'Failed');}}function paintLinksList(links){allLinks=links||[];const running=allLinks.filter(l=>l.status==='running').length;document.getElementById('stat-total').textContent=allLinks.length;document.getElementById('stat-running').textContent=running;document.getElementById('stat-stopped').textContent=allLinks.length-running;const box=document.getElementById('links-list');box.innerHTML='';if(!allLinks.length){box.innerHTML='<p class="muted">No links yet.</p>';return;}allLinks.forEach(l=>{const pm=PROVIDER_META[l.provider]||{title:l.provider||'cloudflared'};const sc=l.status==='running'?'running':'stopped';const d=document.createElement('div');d.className='link';d.innerHTML='<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap"><div style="flex:1;min-width:0"><div class="lurl"><a href="'+esc(l.url)+'" target="_blank" rel="noreferrer">'+esc(l.url)+'</a><span class="badge prov">'+esc(pm.title)+'</span><span class="badge '+sc+'">'+esc(l.status||'unknown')+'</span></div>'+(l.requestedSubdomain?'<div class="lmeta">Name: '+esc(l.requestedSubdomain)+'</div>':'')+'<div class="lmeta">Created: '+new Date(l.createdAt).toLocaleString()+' &nbsp;\u2022 Target: '+esc(l.target||'')+'</div></div><button data-id="'+esc(l.id)+'">Stop</button></div>';d.querySelector('button').onclick=async()=>{try{await post('/dev/api/links/stop',{password:PASS,id:l.id});await refreshLinks();}catch(e){alert(e.message||'Failed');}};box.appendChild(d);});}async function refreshLinks(){try{const data=await post('/dev/api/links/list',{password:PASS});providers=data.providers||{};paintProviders();paintLinksList(data.links||[]);}catch(e){console.error(e);}}document.getElementById('login').onclick=async()=>{setErr('');try{PASS=document.getElementById('pw').value||'';await post('/dev/api/login',{password:PASS});document.getElementById('auth').classList.add('hidden');document.getElementById('panel').classList.remove('hidden');await refreshLinks();}catch(e){setErr(e.message||'Auth failed');}};document.getElementById('pw').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('login').click();});document.getElementById('generate').onclick=generateIdeas;document.getElementById('term').addEventListener('keydown',e=>{if(e.key==='Enter')generateIdeas();});document.getElementById('create').onclick=async()=>{const nb=document.getElementById('create-note');nb.style.display='none';nb.textContent='';try{const target=document.getElementById('target').value.trim();const desiredSubdomain=document.getElementById('sub').value.trim();const result=await post('/dev/api/links/create',{password:PASS,target,desiredSubdomain,provider:selectedProvider});if(result.note){nb.textContent=result.note;nb.style.display='block';}await refreshLinks();}catch(e){alert(e.message||'Failed to create link');}};document.getElementById('bulk-create').onclick=async()=>{const term=document.getElementById('bulk-term').value.trim();const count=Math.min(20,Math.max(1,parseInt(document.getElementById('bulk-count').value)||3));const target=document.getElementById('target').value.trim();if(!term){alert('Enter a theme term first.');return;}const btn=document.getElementById('bulk-create');const pb=document.getElementById('bulk-progress');btn.disabled=true;pb.style.display='grid';pb.innerHTML='<div style="opacity:.6;font-size:.8rem">\u23f3 Creating '+count+' links themed \u201c'+esc(term)+'\u201d\u2026</div>';try{const result=await post('/dev/api/links/bulk-create',{password:PASS,term,count,target,provider:selectedProvider});pb.innerHTML='';(result.results||[]).forEach(r=>{const row=document.createElement('div');row.className='pi';if(r.ok){row.innerHTML='<span style="color:#80ffaa">\u2713</span><b>'+esc(r.name)+'</b><a href="'+esc(r.url)+'" target="_blank" rel="noreferrer" style="opacity:.55;font-size:.78rem;word-break:break-all">'+esc(r.url)+'</a>';}else{row.innerHTML='<span style="color:#ff9090">\u2717</span><b>'+esc(r.name)+'</b><span style="opacity:.55;font-size:.78rem;color:#ffb8c0">'+esc(r.error)+'</span>';}pb.appendChild(row);});if(result.note){const n=document.createElement('div');n.className='notice';n.style.margin='10px 0 0';n.textContent=result.note;pb.appendChild(n);}await refreshLinks();}catch(e){pb.innerHTML='<div style="color:#ff9090">'+esc(e.message||'Bulk create failed')+'</div>';}btn.disabled=false;};document.getElementById('refresh-links').onclick=refreshLinks;document.getElementById('stop-all').onclick=async()=>{const running=allLinks.filter(l=>l.status==='running');if(!running.length){alert('No running links to stop.');return;}if(!confirm('Stop and delete all '+running.length+' running link'+(running.length===1?'':'s')+'?'))return;for(const l of running){try{await post('/dev/api/links/stop',{password:PASS,id:l.id});}catch{}}await refreshLinks();};</script></body></html>`;

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
              const cloudflared = getCloudflaredSupport();
              const bunny = getBunnyCDNSupport();
              const cfworker = getCFWorkersSupport();
              const links = devState.links.map((l) => ({
                ...l,
                status: tunnelProcesses.has(l.id) ? 'running' : l.status || 'stopped',
              }));
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                links,
                providers: {
                  cloudflared: { available: cloudflared.available, reason: cloudflared.reason },
                  bunnycdn: { available: bunny.available, reason: bunny.reason },
                  cfworker: { available: cfworker.available, reason: cfworker.reason },
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

      if (pathname === '/dev/api/links/suggest-names') {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
          req.on('end', () => {
            try {
              const { password, term } = JSON.parse(body || '{}');
              if (typeof password !== 'string' || !verifyLogPassword(password)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
              }

              if (typeof term !== 'string' || !term.trim()) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'A search term is required.' }));
                return;
              }

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ suggestions: generateSiteNameIdeas(term) }));
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Bad Request' }));
            }
          });
          return;
        }
      }

      if (pathname === '/dev/api/links/bulk-create') {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', c => { body += c; if (body.length > 16384) req.destroy(); });
          req.on('end', async () => {
            try {
              const { password, term, count, target, provider } = JSON.parse(body || '{}');
              if (typeof password !== 'string' || !verifyLogPassword(password)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
              }

              if (typeof term !== 'string' || !term.trim()) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'A theme term is required.' }));
                return;
              }

              const chosenProvider = String(provider || 'bunnycdn').toLowerCase();
              if (!['bunnycdn', 'cfworker'].includes(chosenProvider)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Bulk create is only supported with BunnyCDN or Cloudflare Workers. Select one of those providers and try again.' }));
                return;
              }

              const bunny = chosenProvider === 'bunnycdn' ? getBunnyCDNSupport() : null;
              const cfw = chosenProvider === 'cfworker' ? getCFWorkersSupport() : null;
              if (bunny && !bunny.available) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: bunny.reason }));
                return;
              }
              if (cfw && !cfw.available) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: cfw.reason }));
                return;
              }

              const targetUrl = new URL(String(target || '').trim() || 'https://torov1.up.railway.app');
              if (!/^https?:$/i.test(targetUrl.protocol)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid target URL protocol.' }));
                return;
              }

              const requestedCount = Math.min(20, Math.max(1, Number(count) || 3));
              const ideas = generateSiteNameIdeas(term, requestedCount);

              if (!ideas.length) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Could not generate names for that term.' }));
                return;
              }

              const results = [];
              for (const idea of ideas) {
                const linkId = randomUUID();
                try {
                  if (chosenProvider === 'bunnycdn') {
                    const { zoneId, hostname } = await createBunnyCDNPullZone(bunny.apiKey, idea.slug, targetUrl.toString());
                    const rec = {
                      id: linkId,
                      url: `https://${hostname}`,
                      requestedSubdomain: idea.label,
                      target: targetUrl.toString(),
                      createdAt: new Date().toISOString(),
                      status: 'running',
                      provider: 'bunnycdn',
                      providerZoneId: zoneId,
                    };
                    devState.links.unshift(rec);
                    results.push({ ok: true, name: idea.label, url: `https://${hostname}` });
                  } else {
                    const workerName = `${idea.slug}-${linkId.slice(0, 6)}`;
                    const { hostname } = await createCloudflareWorker(cfw.accountId, cfw.apiToken, workerName, targetUrl.toString());
                    const rec = {
                      id: linkId,
                      url: `https://${hostname}`,
                      requestedSubdomain: idea.label,
                      target: targetUrl.toString(),
                      createdAt: new Date().toISOString(),
                      status: 'running',
                      provider: 'cfworker',
                      cfWorkerName: workerName,
                    };
                    devState.links.unshift(rec);
                    results.push({ ok: true, name: idea.label, url: `https://${hostname}` });
                  }
                } catch (err) {
                  results.push({ ok: false, name: idea.label, error: err?.message || 'Failed' });
                }
              }

              if (devState.links.length > 30) devState.links.length = 30;
              await saveDevState();

              const noteMsg = chosenProvider === 'bunnycdn'
                ? 'BunnyCDN pull zones can take 1\u20135 minutes to go live as the edge network propagates.'
                : 'Cloudflare Workers are usually live within seconds.';
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                ok: true,
                results,
                note: noteMsg,
              }));
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
              if (idx !== -1) {
                const link = devState.links[idx];
                if (link.provider === 'bunnycdn' && link.providerZoneId) {
                  const bunny = getBunnyCDNSupport();
                  if (bunny.available) await deleteBunnyCDNPullZone(bunny.apiKey, link.providerZoneId);
                }
                if (link.provider === 'cfworker' && link.cfWorkerName) {
                  const cfw = getCFWorkersSupport();
                  if (cfw.available) await deleteCloudflareWorker(cfw.accountId, cfw.apiToken, link.cfWorkerName);
                }
                devState.links[idx].status = 'stopped';
              }
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
              const { password, target, desiredSubdomain, provider } = JSON.parse(body || '{}');
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

              const chosenProvider = String(provider || 'cloudflared').toLowerCase();
              const linkId = randomUUID();

              // --- BunnyCDN pull zone path ---
              if (chosenProvider === 'bunnycdn') {
                const bunny = getBunnyCDNSupport();
                if (!bunny.available) {
                  res.writeHead(503, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: bunny.reason }));
                  return;
                }

                const rawName = String(desiredSubdomain || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `toro-${linkId.slice(0, 8)}`;
                try {
                  const { zoneId, hostname } = await createBunnyCDNPullZone(bunny.apiKey, rawName, targetUrl.toString());
                  const rec = {
                    id: linkId,
                    url: `https://${hostname}`,
                    requestedSubdomain: rawName,
                    target: targetUrl.toString(),
                    createdAt: new Date().toISOString(),
                    status: 'running',
                    provider: 'bunnycdn',
                    providerZoneId: zoneId,
                  };
                  devState.links.unshift(rec);
                  if (devState.links.length > 30) devState.links.length = 30;
                  await saveDevState();
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({
                    ok: true,
                    link: rec,
                    note: 'BunnyCDN pull zones can take 1–5 minutes to become active as the edge network propagates. If you see "Domain suspended or not configured", wait a moment and refresh.',
                  }));
                } catch (err) {
                  res.writeHead(502, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: err?.message || 'BunnyCDN pull zone creation failed.' }));
                }
                return;
              }

              // --- Cloudflare Workers path ---
              if (chosenProvider === 'cfworker') {
                const cfw = getCFWorkersSupport();
                if (!cfw.available) {
                  res.writeHead(503, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: cfw.reason }));
                  return;
                }

                const rawName = String(desiredSubdomain || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || `toro-worker-${linkId.slice(0, 8)}`;
                const workerName = `${rawName}-${linkId.slice(0, 6)}`;
                try {
                  const { hostname } = await createCloudflareWorker(cfw.accountId, cfw.apiToken, workerName, targetUrl.toString());
                  const rec = {
                    id: linkId,
                    url: `https://${hostname}`,
                    requestedSubdomain: rawName,
                    target: targetUrl.toString(),
                    createdAt: new Date().toISOString(),
                    status: 'running',
                    provider: 'cfworker',
                    cfWorkerName: workerName,
                  };
                  devState.links.unshift(rec);
                  if (devState.links.length > 30) devState.links.length = 30;
                  await saveDevState();
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ ok: true, link: rec }));
                } catch (err) {
                  res.writeHead(502, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: err?.message || 'Cloudflare Worker creation failed.' }));
                }
                return;
              }

              // --- Cloudflared quick tunnel path ---
              const cloudflared = getCloudflaredSupport();
              if (!cloudflared.available || !cloudflared.command) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  error: cloudflared.reason,
                }));
                return;
              }

              const args = [
                'tunnel',
                '--url', targetUrl.toString(),
                '--http-host-header', targetUrl.host,
                '--no-autoupdate',
              ];

              const child = spawn(cloudflared.command, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
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

              const tryCaptureTunnelUrl = () => {
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
              };

              child.stdout.on('data', (d) => {
                output += String(d);
                tryCaptureTunnelUrl();
              });

              child.stderr.on('data', (d) => {
                output += String(d);
                tryCaptureTunnelUrl();
              });

              child.on('error', async (err) => {
                await done(
                  {
                    error: err?.code === 'ENOENT'
                      ? 'Cloudflare quick tunnels are unavailable here because cloudflared is not installed on the server.'
                      : `Failed to start cloudflared (${err?.code || 'unknown'}). Ensure cloudflared is installed and accessible.`,
                  },
                  500,
                );
              });

              child.on('exit', async (code, signal) => {
                tunnelProcesses.delete(linkId);
                const idx = devState.links.findIndex((l) => l.id === linkId);
                if (idx !== -1) {
                  devState.links[idx].status = 'stopped';
                  await saveDevState();
                }

                if (!finished) {
                  const tail = output.split('\n').slice(-8).join('\n').trim();
                  await done(
                    {
                      error: `cloudflared exited before a tunnel URL was created (code: ${code ?? 'null'}, signal: ${signal ?? 'null'}).`,
                      details: tail || 'No cloudflared output captured.',
                    },
                    502,
                  );
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
