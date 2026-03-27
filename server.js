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
  pendingUpdates: [],
  releaseDate: null,
  bulkLinksCooldownUntil: null,
};
const BULK_MIN_COUNT = 3;
const BULK_MAX_COUNT = 10;
const BULK_LINK_DELAY_MIN_SEC = 25;
const BULK_LINK_DELAY_MAX_SEC = 35;
const BULK_BATCH_COOLDOWN_MS = 15 * 60 * 1000;
let bulkBatchRunning = false;
let bulkBatchEtaAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomIntInclusive = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const DEV_STATE_DIR = join(__dirname, 'data');
const DEV_STATE_FILE = join(DEV_STATE_DIR, 'dev-state.json');
const IP_LOG_FILE = join(DEV_STATE_DIR, 'ip-logs.json');
const CHAT_STATE_FILE = join(DEV_STATE_DIR, 'chat-state.json');
function resolveDatabaseUrl() {
  const direct = [
    process.env.DATABASE_URL,
    process.env.DATABASE_PRIVATE_URL,
    process.env.DATABASE_PUBLIC_URL,
    process.env.RAILWAY_DATABASE_URL,
    process.env.PGURL,
  ]
    .map((v) => String(v || '').trim())
    .find(Boolean);

  if (direct) return direct;

  const host = String(process.env.PGHOST || '').trim();
  const port = String(process.env.PGPORT || '').trim() || '5432';
  const user = String(process.env.PGUSER || '').trim();
  const password = String(process.env.PGPASSWORD || '').trim();
  const database = String(process.env.PGDATABASE || '').trim();

  if (host && user && password && database) {
    return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
  }

  return '';
}

const DATABASE_URL = resolveDatabaseUrl();
const IS_RAILWAY = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
const IS_VERCEL_RUNTIME = Boolean(process.env.VERCEL);
const MONGODB_URI = String(process.env.MONGODB_URI || process.env.MONGODB_ATLAS_URI || process.env.MONGO_URL || '').trim();
const MONGODB_DB_NAME = String(process.env.MONGODB_DB_NAME || process.env.MONGO_DB_NAME || 'toro_v1').trim();
let pgStateClient = null;
let mongoDbPromise = null;
let mongoUnavailableUntil = 0;
let mongoFailureLoggedAt = 0;
let ipLogSaveTimer = null;
let chatSaveTimer = null;
const tunnelProcesses = new Map();
const CHAT_USER_TTL_MS = 120000;
const LIVE_USER_WINDOW_MS = 120000;
const BAD_WORDS = (process.env.CHAT_BLOCKED_WORDS || 'fuck,shit,bitch,asshole,cunt,porn,sex')
  .split(',')
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean);

async function getMongoDb() {
  if (!MONGODB_URI) return null;
  if (Date.now() < mongoUnavailableUntil) return null;
  if (mongoDbPromise) return mongoDbPromise;

  mongoDbPromise = (async () => {
    const mongoModule = await import('mongodb');
    const MongoClient = mongoModule.MongoClient || mongoModule.default?.MongoClient;
    if (!MongoClient) throw new Error('mongodb MongoClient export not found');

    const client = new MongoClient(MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 1200,
      connectTimeoutMS: 1200,
      socketTimeoutMS: 1500,
    });
    await client.connect();
    mongoUnavailableUntil = 0;
    return client.db(MONGODB_DB_NAME || 'toro_v1');
  })();

  try {
    return await mongoDbPromise;
  } catch (err) {
    mongoDbPromise = null;
    mongoUnavailableUntil = Date.now() + 60000;
    const now = Date.now();
    if (now - mongoFailureLoggedAt > 30000) {
      mongoFailureLoggedAt = now;
      console.error('MongoDB connect failed; using fallback backend for 60s:', err?.message || err);
    }
    return null;
  }
}

async function readMongoState(stateKey) {
  try {
    const db = await getMongoDb();
    if (!db) return null;
    const doc = await db.collection('app_state').findOne({ _id: stateKey });
    return doc?.stateValue ?? null;
  } catch (err) {
    const now = Date.now();
    if (now - mongoFailureLoggedAt > 30000) {
      mongoFailureLoggedAt = now;
      console.error(`Failed to load ${stateKey} from MongoDB; falling back:`, err?.message || err);
    }
    return null;
  }
}

async function writeMongoState(stateKey, stateValue) {
  try {
    const db = await getMongoDb();
    if (!db) return { ok: false, backend: 'none', error: 'MongoDB not configured' };
    await db.collection('app_state').updateOne(
      { _id: stateKey },
      {
        $set: {
          stateValue,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
    return { ok: true, backend: 'mongodb' };
  } catch (err) {
    const now = Date.now();
    if (now - mongoFailureLoggedAt > 30000) {
      mongoFailureLoggedAt = now;
      console.error(`Failed to persist ${stateKey} to MongoDB; falling back:`, err?.message || err);
    }
    return { ok: false, backend: 'none', error: err?.message || String(err) };
  }
}

async function getPgStateClient() {
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
}

function getPersistableDevState() {
  return {
    maintenanceEnabled: devState.maintenanceEnabled,
    maintenanceMessage: devState.maintenanceMessage,
    links: devState.links,
    updates: devState.updates,
    pendingUpdates: devState.pendingUpdates,
    releaseDate: devState.releaseDate,
    bulkLinksCooldownUntil: devState.bulkLinksCooldownUntil,
  };
}

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

  const existingBunnyNames = new Set(
    devState.links
      .filter((l) => l?.provider === 'bunnycdn' && typeof l?.requestedSubdomain === 'string')
      .map((l) => slugifySiteName(l.requestedSubdomain))
      .filter(Boolean)
  );

  const unique = [];
  const seen = new Set();
  for (const label of candidates) {
    const cleaned = String(label || '').replace(/[^A-Za-z0-9]+/g, '').slice(0, 36);
    if (!cleaned) continue;
    const slug = slugifySiteName(cleaned);
    if (!slug || seen.has(slug) || existingBunnyNames.has(slug)) continue;
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
        'BunnyCDN API key is invalid or lacks permission. Go to BunnyCDN Dashboard â†’ Account â†’ API and copy the Account API Key (not a storage/CDN key).'
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
          throw new Error(`BunnyCDN: zone name "${zoneName}" is already taken. Try another clean name.`);
        }
        if (j?.Message) detail = j.Message;
      } catch (inner) {
        if (inner.message.startsWith('BunnyCDN') || inner.message.startsWith('Your BunnyCDN')) throw inner;
      }
      throw new Error(`BunnyCDN rejected the request (400). Check the zone name â€” it must be unique and contain only letters, numbers, and hyphens. Details: ${detail}`);
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

async function createBunnyCDNPullZoneUnique(apiKey, baseName, originUrl, maxAttempts = 8) {
  const normalizedBase = slugifySiteName(baseName).slice(0, 40);
  if (!normalizedBase) throw new Error('Invalid BunnyCDN zone name.');

  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const zoneName = attempt === 0
      ? normalizedBase
      : slugifySiteName(`${normalizedBase}-${attempt + 1}`).slice(0, 40);

    try {
      const created = await createBunnyCDNPullZone(apiKey, zoneName, originUrl);
      return { ...created, zoneName };
    } catch (err) {
      lastError = err;
      const message = String(err?.message || '').toLowerCase();
      if (!message.includes('already taken') && !message.includes('already exist')) {
        throw err;
      }
    }
  }

  throw lastError || new Error('Failed to create BunnyCDN pull zone after retries.');
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
  const apiToken = String(process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '').trim();
  const globalApiKey = String(process.env.CLOUDFLARE_GLOBAL_API_KEY || '').trim();
  const email = String(process.env.CLOUDFLARE_EMAIL || '').trim();

  const hasTokenAuth = Boolean(apiToken);
  const hasGlobalAuth = Boolean(globalApiKey && email);

  if (!accountId || (!hasTokenAuth && !hasGlobalAuth)) {
    return {
      available: false,
      accountId: null,
      authHeaders: null,
      reason: 'Set CLOUDFLARE_ACCOUNT_ID plus either CLOUDFLARE_API_TOKEN (or CF_API_TOKEN) or CLOUDFLARE_GLOBAL_API_KEY + CLOUDFLARE_EMAIL to enable Cloudflare Workers.',
    };
  }

  const authHeaders = hasTokenAuth
    ? { Authorization: `Bearer ${apiToken}` }
    : { 'X-Auth-Email': email, 'X-Auth-Key': globalApiKey };

  return { available: true, accountId, authHeaders, reason: '' };
}

async function _getCFSubdomain(accountId, authHeaders) {
  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/subdomain`,
    { headers: authHeaders }
  );
  if (!resp.ok) {
    const j = await resp.json().catch(() => ({}));
    const apiMsg = j?.errors?.[0]?.message || 'Unknown Cloudflare API error';
    if (resp.status === 400 || resp.status === 401 || /authenticate/i.test(apiMsg)) {
      throw new Error(
        'Cloudflare authentication failed. Check CLOUDFLARE_ACCOUNT_ID and your credentials (CLOUDFLARE_API_TOKEN/CF_API_TOKEN, or CLOUDFLARE_GLOBAL_API_KEY + CLOUDFLARE_EMAIL).'
      );
    }
    throw new Error(`Cloudflare API error ${resp.status}: ${apiMsg}`);
  }
  const data = await resp.json();
  const sub = data?.result?.subdomain;
  if (!sub) throw new Error('No workers.dev subdomain found. Enable Workers on your Cloudflare account first.');
  return sub;
}

async function createCloudflareWorker(accountId, authHeaders, workerName, targetUrl) {
  const subdomain = await _getCFSubdomain(accountId, authHeaders);

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
    { method: 'PUT', headers: authHeaders, body: form }
  );
  if (!uploadResp.ok) {
    const j = await uploadResp.json().catch(() => ({}));
    const apiMsg = j?.errors?.[0]?.message || 'Unknown Cloudflare API error';
    if (uploadResp.status === 403)
      throw new Error('API token lacks Workers Script Edit permission. Create a token with "Workers Scripts: Edit" at dash.cloudflare.com/profile/api-tokens.');
    if (uploadResp.status === 400 || uploadResp.status === 401 || /authenticate/i.test(apiMsg)) {
      throw new Error(
        'Cloudflare authentication failed while uploading Worker. Verify CLOUDFLARE_ACCOUNT_ID and auth credentials.'
      );
    }
    throw new Error(`Worker upload failed (${uploadResp.status}): ${apiMsg}`);
  }

  // Enable workers.dev subdomain for this script
  await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`,
    {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    }
  );

  return { workerName, hostname: `${workerName}.${subdomain}.workers.dev` };
}

async function deleteCloudflareWorker(accountId, authHeaders, workerName) {
  try {
    await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}`,
      { method: 'DELETE', headers: authHeaders }
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
          target: typeof l.target === 'string' ? l.target : 'https://torov2.up.railway.app',
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
    if (Array.isArray(parsed.pendingUpdates)) {
      devState.pendingUpdates = parsed.pendingUpdates
        .filter((u) => typeof u?.text === 'string' && u.text.trim())
        .slice(0, 100)
        .map((u) => ({
          id: typeof u.id === 'string' ? u.id : randomUUID(),
          text: u.text.trim(),
          addedAt: typeof u.addedAt === 'string' ? u.addedAt : new Date().toISOString(),
        }));
    }
    if (typeof parsed.releaseDate === 'string' || parsed.releaseDate === null) {
      devState.releaseDate = parsed.releaseDate || null;
    }
    if (typeof parsed.bulkLinksCooldownUntil === 'string' || parsed.bulkLinksCooldownUntil === null) {
      devState.bulkLinksCooldownUntil = parsed.bulkLinksCooldownUntil || null;
    }
  };

  const mongoState = await readMongoState('dev_state');
  if (mongoState && typeof mongoState === 'object') {
    applyParsedDevState(mongoState);
    return;
  }

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
  const nextDevState = getPersistableDevState();

  const mongoWrite = await writeMongoState('dev_state', nextDevState);
  if (mongoWrite.ok) {
    return mongoWrite;
  }

  if (DATABASE_URL) {
    try {
      const client = await getPgStateClient();
      await client.query(
        'INSERT INTO app_state (state_key, state_value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (state_key) DO UPDATE SET state_value = EXCLUDED.state_value, updated_at = NOW()',
        ['dev_state', JSON.stringify(nextDevState)]
      );
      return { ok: true, backend: 'postgres' };
    } catch (err) {
      console.error('Failed to persist dev state to Postgres; falling back to file:', err?.message || err);
    }
  }

  try {
    await mkdir(DEV_STATE_DIR, { recursive: true });
    await writeFile(
      DEV_STATE_FILE,
      JSON.stringify(nextDevState, null, 2),
      'utf8',
    );
    return { ok: true, backend: 'file' };
  } catch (err) {
    console.error('Failed to persist dev state:', err);
    return { ok: false, backend: 'none', error: err?.message || String(err) };
  }
}

if (IS_RAILWAY && !DATABASE_URL) {
  console.warn('No Postgres URL found. Configure DATABASE_URL/POSTGRES_URL in Railway so updates and links persist across deploys.');
}
if (!MONGODB_URI && !DATABASE_URL) {
  console.warn('No MongoDB or Postgres URL found. Configure MONGODB_URI (Atlas) for persistent state on Vercel.');
}

await loadDevState();

// Auto-release pending updates when scheduled date is reached.
setInterval(async () => {
  if (!devState.releaseDate || !devState.pendingUpdates.length) return;
  if (Date.now() < new Date(devState.releaseDate).getTime()) return;
  const count = devState.pendingUpdates.length;
  devState.pendingUpdates.forEach((u) => {
    devState.updates.unshift({ id: u.id, text: u.text, ts: u.addedAt });
  });
  if (devState.updates.length > 100) devState.updates.length = 100;
  devState.pendingUpdates = [];
  devState.releaseDate = null;
  try {
    await saveDevState();
    console.log(`[pushupdates] Auto-released ${count} pending update(s) to live.`);
  } catch (err) {
    console.error('[pushupdates] Auto-release save failed:', err?.message || err);
  }
}, 30000);

async function loadIpLogs() {
  const mongoRows = await readMongoState('ip_logs');
  if (Array.isArray(mongoRows)) {
    for (const row of mongoRows) {
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
    return;
  }

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

  const mongoWrite = await writeMongoState('ip_logs', rows);
  if (mongoWrite.ok) return;

  try {
    await mkdir(DEV_STATE_DIR, { recursive: true });
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
    await saveChatState();
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
  const mongoState = await readMongoState('chat_state');
  if (mongoState?.rooms && typeof mongoState.rooms === 'object') {
    const nextRooms = {};
    for (const [roomName, roomData] of Object.entries(mongoState.rooms)) {
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
    if (Object.keys(nextRooms).length > 0) {
      chatState.rooms = nextRooms;
      return;
    }
  }

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

async function saveChatState() {
  const nextChatState = { rooms: chatState.rooms };
  const mongoWrite = await writeMongoState('chat_state', nextChatState);
  if (mongoWrite.ok) return;

  try {
    await mkdir(DEV_STATE_DIR, { recursive: true });
    await writeFile(CHAT_STATE_FILE, JSON.stringify(nextChatState, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist chat state:', err);
  }
}

await loadChatState();

const maintenanceHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Maintenance</title><style>*{box-sizing:border-box;margin:0;padding:0}body{min-height:100vh;display:grid;place-items:center;background:#090304;color:#f4d4d8;font-family:ui-sans-serif,system-ui,sans-serif;padding:24px}.card{max-width:760px;width:100%;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.16);backdrop-filter:blur(10px);border-radius:18px;padding:28px}h1{font-size:clamp(1.6rem,3vw,2.3rem);color:#ff7a8a;margin-bottom:10px}p{opacity:.9;line-height:1.6;font-size:1rem}.sub{margin-top:10px;opacity:.6;font-size:.9rem}</style></head><body><div class="card"><h1>Server Down Due to Maintenance</h1><p id="msg"></p><p class="sub">Please check back shortly.</p></div><script>const m=${JSON.stringify('MSG_PLACEHOLDER')};document.getElementById('msg').textContent=m&&m!=='MSG_PLACEHOLDER'?m:'We are currently performing maintenance.';</script></body></html>`;

function applyToroAdminTheme(html) {
  const marker = 'id="toro-admin-theme"';
  if (typeof html !== 'string' || html.includes(marker)) return html;

  const css = `<style id="toro-admin-theme">:root{--t-bg:#090304;--t-surface:rgba(0,0,0,.34);--t-surface-2:rgba(255,255,255,.06);--t-border:rgba(255,255,255,.18);--t-text:#f4d4d8;--t-muted:rgba(244,212,216,.72)}body{background:radial-gradient(circle at 14% 10%,rgba(138,30,43,.26),transparent 38%),radial-gradient(circle at 80% 86%,rgba(138,30,43,.16),transparent 40%),var(--t-bg)!important;color:var(--t-text)!important;font-family:Geist,Inter,"SF Pro Text",ui-sans-serif,system-ui,sans-serif!important}h1,h2{color:var(--t-text)!important;letter-spacing:.01em}.sub,.muted,#stats{color:var(--t-muted)!important;opacity:.9!important}.card,#login,.room,.link,.stat,.setup-box,.result-msg,table,.vlist{background:var(--t-surface)!important;border:1px solid var(--t-border)!important;backdrop-filter:blur(14px) saturate(140%);-webkit-backdrop-filter:blur(14px) saturate(140%);box-shadow:0 10px 30px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.12)}input,textarea,select{background:rgba(0,0,0,.3)!important;border:1px solid var(--t-border)!important;color:var(--t-text)!important}button,#auth-btn,.btn-v{background:linear-gradient(135deg,rgba(255,255,255,.14),rgba(255,255,255,.05))!important;border:1px solid rgba(255,255,255,.24)!important;color:var(--t-text)!important}button:hover,#auth-btn:hover,.btn-v:hover{border-color:rgba(255,255,255,.4)!important}thead th{color:#eeb7bf!important;border-bottom:1px solid var(--t-border)!important}tbody tr:hover>td{background:rgba(255,255,255,.06)!important}.badge.b-vpn{background:rgba(160,45,61,.25)!important;color:#ffd2d8!important}.badge.b-ok{background:rgba(95,168,132,.24)!important;color:#d6ffe8!important}</style>`;

  if (html.includes('</head>')) {
    return html.replace('</head>', `${css}</head>`);
  }
  return `${css}${html}`;
}

const devHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dev Panel</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#090304;color:#f4d4d8;font-family:ui-sans-serif,system-ui,sans-serif;min-height:100vh;padding:24px}.wrap{max-width:900px;margin:0 auto}.card{background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(10px);border-radius:16px;padding:18px;margin-bottom:16px}h1{font-size:2rem;color:#ff7788;margin-bottom:14px}h2{font-size:1.05rem;margin-bottom:12px;color:#ffc7cf}input,textarea{width:100%;background:#130709;border:1px solid rgba(255,255,255,.2);border-radius:12px;color:#fff;padding:11px 12px;outline:none}textarea{min-height:92px;resize:vertical}button{background:linear-gradient(135deg,rgba(255,255,255,.15),rgba(255,255,255,.06));border:1px solid rgba(255,255,255,.26);color:#ffecef;border-radius:999px;padding:9px 14px;cursor:pointer}button:hover{border-color:rgba(255,255,255,.45)}.row{display:flex;gap:10px;flex-wrap:wrap}.muted{opacity:.65;font-size:.9rem}.hidden{display:none}ul{margin-top:10px;display:grid;gap:8px;padding-left:18px}</style></head><body><div class="wrap"><h1>Dev Panel</h1><div id="auth" class="card"><h2>Authenticate</h2><input id="pw" type="password" placeholder="Admin password" /><div style="height:10px"></div><button id="login">Enter Panel</button><div id="err" class="muted" style="color:#ff9aa8;margin-top:10px;display:none"></div></div><div id="panel" class="hidden"><div class="card"><h2>Maintenance Mode</h2><p class="muted">Blocks normal site routes and shows the maintenance screen. Dev and IP logs remain accessible.</p><div style="height:10px"></div><textarea id="maintMsg" placeholder="Maintenance message"></textarea><div style="height:10px"></div><div class="row"><button id="enableMaint">Enable Maintenance</button><button id="disableMaint">Disable Maintenance</button></div></div><div class="card"><h2>Add Update</h2><textarea id="updateText" placeholder="Write update text..."></textarea><div style="height:10px"></div><button id="addUpdate">Add Update</button><ul id="updates"></ul></div></div></div><script>let PASS='';function esc(s){return String(s||'').replace(/[&<>\"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[m]||m));}function setErr(t){const e=document.getElementById('err');if(!t){e.style.display='none';return;}e.style.display='block';e.textContent=t;}async function post(url,data){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const j=await r.json().catch(()=>({}));if(!r.ok) throw new Error(j.error||('Request failed '+r.status));return j;}function paintUpdates(items){const ul=document.getElementById('updates');ul.innerHTML='';items.forEach(x=>{const li=document.createElement('li');li.innerHTML='<span>'+esc(x.text)+'</span>';ul.appendChild(li);});}document.getElementById('login').onclick=async()=>{setErr('');try{PASS=document.getElementById('pw').value||'';const r=await post('/dev/api/login',{password:PASS});document.getElementById('auth').classList.add('hidden');document.getElementById('panel').classList.remove('hidden');document.getElementById('maintMsg').value=r.state.maintenanceMessage||'';paintUpdates(r.state.updates||[]);}catch(e){setErr(e.message||'Authentication failed');}};document.getElementById('enableMaint').onclick=async()=>{try{const msg=document.getElementById('maintMsg').value.trim();await post('/dev/api/maintenance',{password:PASS,enabled:true,message:msg});alert('Maintenance enabled');}catch(e){alert(e.message||'Failed');}};document.getElementById('disableMaint').onclick=async()=>{try{await post('/dev/api/maintenance',{password:PASS,enabled:false,message:''});alert('Maintenance disabled');}catch(e){alert(e.message||'Failed');}};document.getElementById('addUpdate').onclick=async()=>{try{const text=document.getElementById('updateText').value.trim();if(!text)return;const r=await post('/dev/api/updates/add',{password:PASS,text});document.getElementById('updateText').value='';paintUpdates(r.updates||[]);}catch(e){alert(e.message||'Failed');}};</script></body></html>`;

const devLinksHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dev Links</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#090304;color:#f4d4d8;font-family:ui-sans-serif,system-ui,sans-serif;min-height:100vh;padding:24px}.wrap{max-width:960px;margin:0 auto}.card{background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(10px);border-radius:16px;padding:18px;margin-bottom:16px}h1{font-size:2rem;color:#ff7788;margin-bottom:8px}h2{font-size:1.04rem;margin-bottom:10px;color:#ffc7cf}.muted{opacity:.7;font-size:.84rem;line-height:1.45}input{width:100%;padding:10px 12px;border-radius:999px;background:#130709;border:1px solid rgba(255,255,255,.2);color:#fff;outline:none}input[type=number]{-moz-appearance:textfield}input::-webkit-outer-spin-button,input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}button{background:linear-gradient(135deg,rgba(255,255,255,.15),rgba(255,255,255,.06));border:1px solid rgba(255,255,255,.26);color:#ffecef;border-radius:999px;padding:9px 14px;cursor:pointer}button:hover{border-color:rgba(255,255,255,.45)}button:disabled{opacity:.4;cursor:default}.row{display:flex;gap:10px;flex-wrap:wrap}.hidden{display:none}.tabs{display:flex;gap:8px;margin-bottom:16px}.tab{border-radius:999px;padding:9px 20px}.tab.active{border-color:#ff7788;background:rgba(255,119,136,.15)}.link{padding:12px;border:1px solid rgba(255,255,255,.14);border-radius:12px;background:rgba(0,0,0,.26);margin-bottom:8px}.lurl{font-size:.86rem;word-break:break-all}.lmeta{font-size:.78rem;opacity:.6;margin-top:4px}.badge{display:inline-block;border-radius:999px;padding:2px 8px;font-size:.72rem;margin-left:5px}.badge.running{background:rgba(100,255,150,.12);color:#80ffaa}.badge.stopped{background:rgba(255,100,100,.1);color:#ff9090}.badge.prov{background:rgba(255,255,255,.08);color:#ddd}.ideas{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;margin-top:12px}.idea{border-radius:12px;padding:10px 12px;text-align:left}.providers{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin-top:10px}.pcard{border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:10px 12px;cursor:pointer;transition:border-color .15s}.pcard.selected{border-color:#ff7788;background:rgba(255,119,136,.08)}.pcard .ptitle{font-size:.92rem;color:#ffc7cf;margin-bottom:3px}.pcard .pdomain{font-size:.78rem;opacity:.6}.pcard .pstatus{font-size:.75rem;margin-top:4px}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px}.stat{border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:12px;text-align:center}.stat-n{font-size:1.6rem;color:#ff7788;font-weight:bold}.stat-l{font-size:.75rem;opacity:.6;margin-top:2px}.notice{margin-top:10px;padding:10px 12px;border:1px solid rgba(255,184,100,.3);border-radius:12px;background:rgba(255,184,100,.08);font-size:.82rem;color:#ffd580;line-height:1.5}.progress{margin-top:12px;padding:10px 12px;border:1px solid rgba(255,255,255,.1);border-radius:12px;background:rgba(0,0,0,.3);font-size:.82rem;display:grid;gap:4px}.pi{padding:5px 0;border-bottom:1px solid rgba(255,255,255,.06);display:flex;gap:8px;align-items:center;flex-wrap:wrap}.pi:last-child{border-bottom:none}</style></head><body><div class="wrap"><h1>Dev Links</h1><p class="muted">Create and manage CDN/tunnel links using your preferred provider.</p><div id="auth" class="card"><h2>Authenticate</h2><input id="pw" type="password" placeholder="Admin password"/><div style="height:10px"></div><button id="login">Enter</button><p id="err" style="display:none;color:#ffb8c0;font-size:.84rem;margin-top:8px"></p></div><div id="panel" class="hidden"><div class="tabs"><button class="tab active" id="tab-create" onclick="showTab('create')">Create</button><button class="tab" id="tab-links" onclick="showTab('links')">Links</button></div><div id="view-create"><div class="card"><h2>Target URL</h2><div class="row"><input id="target" value="https://torov2.up.railway.app"/></div><div style="height:10px"></div><h2>Provider</h2><div id="providers" class="providers"></div></div><div class="card"><h2>Single Link</h2><div class="row"><input id="term" placeholder="Theme: education, gaming, health\u2026"/></div><div style="height:8px"></div><div class="row"><button id="generate">Generate Names</button></div><div id="ideas" class="ideas"></div><div style="height:10px"></div><div class="row"><input id="sub" placeholder="Site / zone name"/></div><p class="muted" style="margin-top:6px">BunnyCDN: zone name becomes name.b-cdn.net. Cloudflare: URL is randomly assigned.</p><div style="height:10px"></div><div class="row"><button id="create">Create Single Link</button></div><div id="create-note" style="display:none" class="notice"></div></div><div class="card"><h2>Bulk Create</h2><p class="muted" style="margin-bottom:10px">Create 3-10 links per batch. Each link waits a random 25-35 seconds before creating the next one. After each batch, there is a 15-minute cooldown.</p><div class="row"><input id="bulk-term" placeholder="Theme: education, gaming, tech\u2026" style="flex:1"/><input id="bulk-count" type="number" min="3" max="10" value="3" style="width:90px;flex:none"/></div><div style="height:10px"></div><div class="row"><button id="bulk-create">Bulk Create Links</button></div><div id="bulk-progress" style="display:none" class="progress"></div></div></div><div id="view-links" class="hidden"><div class="stats"><div class="stat"><div class="stat-n" id="stat-total">0</div><div class="stat-l">Total</div></div><div class="stat"><div class="stat-n" id="stat-running">0</div><div class="stat-l">Running</div></div><div class="stat"><div class="stat-n" id="stat-stopped">0</div><div class="stat-l">Stopped</div></div></div><div class="card"><div style="display:flex;gap:8px;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap"><h2 style="margin-bottom:0">All Links</h2><div style="display:flex;gap:8px"><button id="refresh-links">\u21bb Refresh</button><button id="stop-all" style="border-color:rgba(255,100,100,.4);color:#ffb8b8">Stop All</button></div></div><div id="links-list"></div></div></div></div></div><script>let PASS='';let providers={};let selectedProvider='cloudflared';let allLinks=[];function esc(s){return String(s||'').replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]||m));}async function post(url,data){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const j=await r.json().catch(()=>({}));if(!r.ok) throw new Error(j.error||('Request failed '+r.status));return j;}function setErr(t){const e=document.getElementById('err');e.style.display=t?'block':'none';e.textContent=t||'';}function showTab(tab){document.getElementById('view-create').classList.toggle('hidden',tab!=='create');document.getElementById('view-links').classList.toggle('hidden',tab!=='links');document.getElementById('tab-create').classList.toggle('active',tab==='create');document.getElementById('tab-links').classList.toggle('active',tab==='links');if(tab==='links')refreshLinks();}const PROVIDER_META={cloudflared:{title:'Cloudflare Tunnel',domain:'*.trycloudflare.com'},bunnycdn:{title:'BunnyCDN Pull Zone',domain:'*.b-cdn.net'},cfworker:{title:'Cloudflare Workers',domain:'*.workers.dev'}};function paintProviders(){const box=document.getElementById('providers');box.innerHTML='';Object.entries(PROVIDER_META).forEach(([key,meta])=>{const info=providers[key]||{available:false,reason:''};const card=document.createElement('div');card.className='pcard'+(key===selectedProvider?' selected':'');card.innerHTML='<div class="ptitle">'+esc(meta.title)+'</div><div class="pdomain">'+esc(meta.domain)+'</div><div class="pstatus" style="color:'+(info.available?'#a0ffb8':'#ffb8c0')+'">'+esc(info.available?'Available':info.reason||'Unavailable')+'</div>';card.onclick=()=>{selectedProvider=key;paintProviders();};box.appendChild(card);});}function paintIdeas(items){const box=document.getElementById('ideas');box.innerHTML='';(items||[]).forEach(item=>{const button=document.createElement('button');button.className='idea';button.type='button';button.textContent=item.label;button.onclick=()=>{document.getElementById('sub').value=item.label;};box.appendChild(button);});if(!(items||[]).length)box.innerHTML='<p class="muted">No suggestions yet.</p>';}async function generateIdeas(){try{const term=document.getElementById('term').value.trim();if(!term){paintIdeas([]);return;}const data=await post('/dev/api/links/suggest-names',{password:PASS,term});paintIdeas(data.suggestions||[]);}catch(e){alert(e.message||'Failed');}}function paintLinksList(links){allLinks=links||[];const running=allLinks.filter(l=>l.status==='running').length;document.getElementById('stat-total').textContent=allLinks.length;document.getElementById('stat-running').textContent=running;document.getElementById('stat-stopped').textContent=allLinks.length-running;const box=document.getElementById('links-list');box.innerHTML='';if(!allLinks.length){box.innerHTML='<p class="muted">No links yet.</p>';return;}allLinks.forEach(l=>{const pm=PROVIDER_META[l.provider]||{title:l.provider||'cloudflared'};const sc=l.status==='running'?'running':'stopped';const d=document.createElement('div');d.className='link';d.innerHTML='<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap"><div style="flex:1;min-width:0"><div class="lurl"><a href="'+esc(l.url)+'" target="_blank" rel="noreferrer">'+esc(l.url)+'</a><span class="badge prov">'+esc(pm.title)+'</span><span class="badge '+sc+'">'+esc(l.status||'unknown')+'</span></div>'+(l.requestedSubdomain?'<div class="lmeta">Name: '+esc(l.requestedSubdomain)+'</div>':'')+'<div class="lmeta">Created: '+new Date(l.createdAt).toLocaleString()+' &nbsp;\u2022 Target: '+esc(l.target||'')+'</div></div><button data-id="'+esc(l.id)+'">Stop</button></div>';d.querySelector('button').onclick=async()=>{try{await post('/dev/api/links/stop',{password:PASS,id:l.id});await refreshLinks();}catch(e){alert(e.message||'Failed');}};box.appendChild(d);});}async function refreshLinks(){try{const data=await post('/dev/api/links/list',{password:PASS});providers=data.providers||{};paintProviders();paintLinksList(data.links||[]);}catch(e){console.error(e);}}document.getElementById('login').onclick=async()=>{setErr('');try{PASS=document.getElementById('pw').value||'';await post('/dev/api/login',{password:PASS});document.getElementById('auth').classList.add('hidden');document.getElementById('panel').classList.remove('hidden');await refreshLinks();}catch(e){setErr(e.message||'Auth failed');}};document.getElementById('pw').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('login').click();});document.getElementById('generate').onclick=generateIdeas;document.getElementById('term').addEventListener('keydown',e=>{if(e.key==='Enter')generateIdeas();});document.getElementById('create').onclick=async()=>{const nb=document.getElementById('create-note');nb.style.display='none';nb.textContent='';try{const target=document.getElementById('target').value.trim();const desiredSubdomain=document.getElementById('sub').value.trim();const result=await post('/dev/api/links/create',{password:PASS,target,desiredSubdomain,provider:selectedProvider});if(result.note){nb.textContent=result.note;nb.style.display='block';}await refreshLinks();}catch(e){alert(e.message||'Failed to create link');}};document.getElementById('bulk-create').onclick=async()=>{const term=document.getElementById('bulk-term').value.trim();const parsedCount=parseInt(document.getElementById('bulk-count').value,10);const count=Math.min(10,Math.max(3,parsedCount||3));const target=document.getElementById('target').value.trim();if(!term){alert('Enter a theme term first.');return;}const btn=document.getElementById('bulk-create');const pb=document.getElementById('bulk-progress');btn.disabled=true;pb.style.display='grid';const etaSec=Math.max(0,(count-1)*30);pb.innerHTML='<div style="opacity:.6;font-size:.8rem">\u23f3 Creating '+count+' links themed \u201c'+esc(term)+'\u201d\u2026</div><div style="opacity:.55;font-size:.78rem">ETA about '+Math.ceil(etaSec/60)+' min ('+etaSec+'s) with random 25-35s waits per link.</div>';try{const result=await post('/dev/api/links/bulk-create',{password:PASS,term,count,target,provider:selectedProvider});pb.innerHTML='';(result.results||[]).forEach(r=>{const row=document.createElement('div');row.className='pi';if(r.ok){row.innerHTML='<span style="color:#80ffaa">\u2713</span><b>'+esc(r.name)+'</b><a href="'+esc(r.url)+'" target="_blank" rel="noreferrer" style="opacity:.55;font-size:.78rem;word-break:break-all">'+esc(r.url)+'</a>';}else{row.innerHTML='<span style="color:#ff9090">\u2717</span><b>'+esc(r.name)+'</b><span style="opacity:.55;font-size:.78rem;color:#ffb8c0">'+esc(r.error)+'</span>';}pb.appendChild(row);});if(result.cooldownUntil){const cd=document.createElement('div');cd.style.opacity='.55';cd.style.fontSize='.78rem';cd.textContent='Cooldown active until '+new Date(result.cooldownUntil).toLocaleTimeString()+'.';pb.appendChild(cd);}if(result.note){const n=document.createElement('div');n.className='notice';n.style.margin='10px 0 0';n.textContent=result.note;pb.appendChild(n);}await refreshLinks();}catch(e){pb.innerHTML='<div style="color:#ff9090">'+esc(e.message||'Bulk create failed')+'</div>';}btn.disabled=false;};document.getElementById('refresh-links').onclick=refreshLinks;document.getElementById('stop-all').onclick=async()=>{const running=allLinks.filter(l=>l.status==='running');if(!running.length){alert('No running links to stop.');return;}if(!confirm('Stop and delete all '+running.length+' running link'+(running.length===1?'':'s')+'?'))return;for(const l of running){try{await post('/dev/api/links/stop',{password:PASS,id:l.id});}catch{}}await refreshLinks();};</script></body></html>`;

const devPushUpdatesHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Push Updates</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#090304;color:#f4d4d8;font-family:ui-sans-serif,system-ui,sans-serif;min-height:100vh;padding:24px}.wrap{max-width:900px;margin:0 auto}.card{background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(10px);border-radius:16px;padding:18px;margin-bottom:16px}h1{font-size:2rem;color:#ff7788;margin-bottom:14px}h1 small{font-size:.95rem;color:#ffc7cf;margin-left:10px;opacity:.7}h2{font-size:1.05rem;margin-bottom:12px;color:#ffc7cf}input,textarea{width:100%;background:#130709;border:1px solid rgba(255,255,255,.2);border-radius:12px;color:#fff;padding:11px 12px;outline:none}input[type=datetime-local]{color-scheme:dark}textarea{min-height:80px;resize:vertical}button{background:linear-gradient(135deg,rgba(255,255,255,.15),rgba(255,255,255,.06));border:1px solid rgba(255,255,255,.26);color:#ffecef;border-radius:999px;padding:9px 14px;cursor:pointer}button:hover{border-color:rgba(255,255,255,.45)}.danger{border-color:rgba(255,80,80,.4)!important;color:#ffb8b8!important}.primary{border-color:rgba(255,119,136,.5)!important;color:#ff9aaa!important;background:linear-gradient(135deg,rgba(255,119,136,.2),rgba(255,119,136,.08))!important}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.muted{opacity:.65;font-size:.85rem;line-height:1.5}.hidden{display:none}.pi{border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:12px 14px;background:rgba(0,0,0,.25);margin-bottom:8px;display:flex;justify-content:space-between;align-items:flex-start;gap:10px}.pi:last-child{margin-bottom:0}.pi-t{font-size:.9rem;line-height:1.5;flex:1}.pi-m{font-size:.76rem;opacity:.55;margin-top:4px}.li{border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px 12px;background:rgba(0,0,0,.18);margin-bottom:6px;font-size:.88rem;opacity:.8}.li:last-child{margin-bottom:0}.bs{display:inline-block;border-radius:8px;padding:6px 12px;font-size:.83rem;margin-bottom:12px}.bs.sched{background:rgba(255,184,100,.12);border:1px solid rgba(255,184,100,.3);color:#ffd580}.bs.none{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);color:#aaa}.empty{opacity:.45;font-size:.85rem;padding:8px 0}.count-badge{display:inline-block;background:rgba(255,119,136,.18);border:1px solid rgba(255,119,136,.35);color:#ff9aaa;border-radius:999px;font-size:.75rem;padding:1px 8px;margin-left:8px;vertical-align:middle}</style></head><body><div class="wrap"><h1>Push Updates <small>/dev/pushupdates</small></h1><div id="auth" class="card"><h2>Authenticate</h2><input id="pw" type="password" placeholder="Admin password"/><div style="height:10px"></div><button id="login">Enter</button><p id="err" style="display:none;color:#ffb8c0;font-size:.84rem;margin-top:8px"></p></div><div id="panel" class="hidden"><div class="card"><h2>Add Pending Update</h2><p class="muted" style="margin-bottom:10px">Write what changed in this push. These are staged \u2014 not visible to regular users until the scheduled release date or a manual release.</p><textarea id="newText" placeholder="Describe what changed in this code push..."></textarea><div style="height:10px"></div><button id="addBtn" class="primary">+ Add to Queue</button></div><div class="card"><h2>Pending Queue <span id="pendingCount" class="count-badge">0</span></h2><div id="queueBox"><p class="empty">Nothing pending yet.</p></div></div><div class="card"><h2>Schedule Release</h2><p class="muted" style="margin-bottom:10px">Set the date &amp; time when all pending updates automatically go live on the Updates page users see.</p><div id="schedSt"></div><div class="row" style="margin-bottom:12px"><input type="datetime-local" id="scheduleDt" style="flex:1"/><button id="setDateBtn">Set Schedule</button><button id="clearDateBtn" class="danger">Clear</button></div><div class="row"><button id="releaseNowBtn" class="primary">&#9889; Release Now</button><span class="muted">Immediately publish all pending updates live.</span></div></div><div class="card"><h2>Live Updates</h2><div id="liveBox"><p class="empty">No live updates yet.</p></div></div></div></div><script>let PASS='';function esc(s){return String(s||'').replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]||m));}function setErr(t){const e=document.getElementById('err');e.style.display=t?'block':'none';e.textContent=t||'';}async function post(url,data){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const j=await r.json().catch(()=>({}));if(!r.ok) throw new Error(j.error||('Request failed '+r.status));return j;}function fmt(s){if(!s)return 'None';try{return new Date(s).toLocaleString();}catch{return s;}}function paintState(st){const pending=st.pendingUpdates||[];document.getElementById('pendingCount').textContent=pending.length;const qb=document.getElementById('queueBox');if(!pending.length){qb.innerHTML='<p class="empty">Nothing pending yet.</p>';}else{qb.innerHTML='';pending.forEach(u=>{const d=document.createElement('div');d.className='pi';d.innerHTML='<div style="flex:1"><div class="pi-t">'+esc(u.text)+'</div><div class="pi-m">Added '+fmt(u.addedAt)+'</div></div><div><button class="danger del-btn" data-id="'+esc(u.id)+'">Delete</button></div>';qb.appendChild(d);});qb.querySelectorAll('.del-btn').forEach(btn=>{btn.onclick=async()=>{try{await post('/dev/api/pushupdates/delete',{password:PASS,id:btn.dataset.id});const r=await post('/dev/api/pushupdates/list',{password:PASS});paintState(r);}catch(e){alert(e.message||'Failed');}};});}const ss=document.getElementById('schedSt');if(st.releaseDate){ss.innerHTML='<div class="bs sched">&#128197; Scheduled for: '+fmt(st.releaseDate)+'</div>';}else{ss.innerHTML='<div class="bs none">No release scheduled</div>';}const live=(st.liveUpdates||[]).slice(0,15);const lb=document.getElementById('liveBox');if(!live.length){lb.innerHTML='<p class="empty">No live updates yet.</p>';}else{lb.innerHTML='';live.forEach(u=>{const d=document.createElement('div');d.className='li';d.textContent=u.text;lb.appendChild(d);});}}document.getElementById('login').onclick=async()=>{setErr('');try{PASS=document.getElementById('pw').value||'';const r=await post('/dev/api/pushupdates/list',{password:PASS});document.getElementById('auth').classList.add('hidden');document.getElementById('panel').classList.remove('hidden');paintState(r);}catch(e){setErr(e.message||'Authentication failed');}};document.getElementById('pw').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('login').click();});document.getElementById('addBtn').onclick=async()=>{const text=document.getElementById('newText').value.trim();if(!text)return;try{const r=await post('/dev/api/pushupdates/add',{password:PASS,text});document.getElementById('newText').value='';paintState(r);}catch(e){alert(e.message||'Failed');}};document.getElementById('setDateBtn').onclick=async()=>{const v=document.getElementById('scheduleDt').value;if(!v){alert('Pick a date & time first.');return;}try{const iso=new Date(v).toISOString();const r=await post('/dev/api/pushupdates/set-date',{password:PASS,releaseDate:iso});paintState(r);}catch(e){alert(e.message||'Failed');}};document.getElementById('clearDateBtn').onclick=async()=>{try{const r=await post('/dev/api/pushupdates/set-date',{password:PASS,releaseDate:null});document.getElementById('scheduleDt').value='';paintState(r);}catch(e){alert(e.message||'Failed');}};document.getElementById('releaseNowBtn').onclick=async()=>{const pending=document.getElementById('pendingCount').textContent;if(pending==='0'){alert('No pending updates to release.');return;}if(!confirm('Release all pending updates live now?'))return;try{const r=await post('/dev/api/pushupdates/release',{password:PASS});alert('Done! '+r.released+' update(s) are now live.');paintState(r);}catch(e){alert(e.message||'Failed');}};setInterval(async()=>{if(!PASS)return;try{const r=await post('/dev/api/pushupdates/list',{password:PASS});paintState(r);}catch{}},30000);</script></body></html>`;

// ---- GitHub Staging Support ----
function getGitHubConfig() {
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  const repo = String(process.env.GITHUB_REPO || '').trim();
  const stagingBranch = String(process.env.GITHUB_STAGING_BRANCH || '').trim() || 'staging';
  if (!token || !repo) return { available: false, reason: 'Configure GITHUB_TOKEN and GITHUB_REPO env vars in Railway.' };
  return { available: true, token, repo, stagingBranch };
}

async function ghFetch(token, path, opts = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ToroV2-DevPanel/1.0',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.message || `GitHub API ${r.status}`);
  return json;
}

async function getStagedCommits(token, repo, stagingBranch) {
  let data;
  try {
    data = await ghFetch(token, `/repos/${encodeURIComponent(repo)}/compare/main...${encodeURIComponent(stagingBranch)}`);
  } catch (err) {
    if (/404|not found|no common ancestor/i.test(String(err.message))) {
      return { noBranch: true, ahead: 0, behind: 0, commits: [] };
    }
    throw err;
  }
  return {
    noBranch: false,
    ahead: data.ahead_by || 0,
    behind: data.behind_by || 0,
    commits: (data.commits || []).reverse().map(c => ({
      sha: (c.sha || '').slice(0, 7),
      message: ((c.commit?.message || '').split('\n')[0]).slice(0, 140),
      date: c.commit?.author?.date || c.commit?.committer?.date || '',
      author: c.commit?.author?.name || '',
    })),
  };
}

async function ensureStagingExists(token, repo, stagingBranch) {
  let exists = false;
  try {
    await ghFetch(token, `/repos/${encodeURIComponent(repo)}/git/refs/heads/${encodeURIComponent(stagingBranch)}`);
    exists = true;
  } catch (err) {
    if (!/404|not found/i.test(String(err.message))) throw err;
  }
  if (exists) return false;
  const mainRef = await ghFetch(token, `/repos/${encodeURIComponent(repo)}/git/refs/heads/main`);
  const sha = mainRef.object?.sha;
  if (!sha) throw new Error('Cannot read main branch SHA');
  await ghFetch(token, `/repos/${encodeURIComponent(repo)}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${stagingBranch}`, sha }),
  });
  return true;
}

async function pushStagingToMain(token, repo, stagingBranch) {
  const stagingRef = await ghFetch(token, `/repos/${encodeURIComponent(repo)}/git/refs/heads/${encodeURIComponent(stagingBranch)}`);
  const sha = stagingRef.object?.sha;
  if (!sha) throw new Error('Cannot read staging branch SHA');
  return ghFetch(token, `/repos/${encodeURIComponent(repo)}/git/refs/heads/main`, {
    method: 'PATCH',
    body: JSON.stringify({ sha, force: false }),
  });
}

const devPushUpdatesHtml2 = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Push Updates</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#090304;color:#f4d4d8;font-family:ui-sans-serif,system-ui,sans-serif;min-height:100vh;padding:24px}.wrap{max-width:900px;margin:0 auto}.card{background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(10px);border-radius:16px;padding:18px;margin-bottom:16px}h1{font-size:2rem;color:#ff7788;margin-bottom:14px}h2{font-size:1.05rem;margin-bottom:12px;color:#ffc7cf}input,textarea{width:100%;background:#130709;border:1px solid rgba(255,255,255,.2);border-radius:12px;color:#fff;padding:11px 12px;outline:none}input[type=datetime-local]{color-scheme:dark}textarea{min-height:80px;resize:vertical}button{background:linear-gradient(135deg,rgba(255,255,255,.15),rgba(255,255,255,.06));border:1px solid rgba(255,255,255,.26);color:#ffecef;border-radius:999px;padding:9px 14px;cursor:pointer}button:hover{border-color:rgba(255,255,255,.45)}button:disabled{opacity:.4;cursor:default}.danger{border-color:rgba(255,80,80,.4)!important;color:#ffb8b8!important}.primary{border-color:rgba(255,119,136,.5)!important;color:#ff9aaa!important;background:linear-gradient(135deg,rgba(255,119,136,.2),rgba(255,119,136,.08))!important}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.muted{opacity:.65;font-size:.85rem;line-height:1.5}.hidden{display:none}.commit{border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:10px 12px;background:rgba(0,0,0,.25);margin-bottom:7px}.commit-sha{font-family:monospace;font-size:.78rem;color:#ff9aaa;display:inline-block;margin-right:8px}.commit-msg{font-size:.88rem}.commit-meta{font-size:.74rem;opacity:.5;margin-top:3px}.pi{border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:12px 14px;background:rgba(0,0,0,.25);margin-bottom:8px;display:flex;justify-content:space-between;align-items:flex-start;gap:10px}.pi-t{font-size:.9rem;line-height:1.5;flex:1}.pi-m{font-size:.76rem;opacity:.55;margin-top:4px}.li{border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px 12px;background:rgba(0,0,0,.18);margin-bottom:6px;font-size:.88rem;opacity:.8}.bs{display:inline-block;border-radius:8px;padding:5px 10px;font-size:.82rem;margin-bottom:10px}.bs.ok{background:rgba(100,255,150,.1);border:1px solid rgba(100,255,150,.3);color:#a0ffb8}.bs.warn{background:rgba(255,184,100,.1);border:1px solid rgba(255,184,100,.3);color:#ffd580}.bs.err{background:rgba(255,80,80,.1);border:1px solid rgba(255,80,80,.3);color:#ffb8b8}.badge{display:inline-block;background:rgba(255,119,136,.18);border:1px solid rgba(255,119,136,.35);color:#ff9aaa;border-radius:999px;font-size:.75rem;padding:1px 8px;margin-left:8px;vertical-align:middle}.setup-box{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:12px 14px;margin-top:8px;font-size:.83rem;line-height:1.9}.setup-box code{font-family:monospace;background:rgba(255,255,255,.1);padding:1px 5px;border-radius:4px}.empty{opacity:.45;font-size:.85rem;padding:6px 0}.result-msg{border-radius:12px;padding:10px 14px;margin-top:10px;font-size:.85rem;line-height:1.5;display:none}.result-msg.ok{background:rgba(100,255,150,.1);border:1px solid rgba(100,255,150,.3);color:#a0ffb8}.result-msg.err{background:rgba(255,80,80,.1);border:1px solid rgba(255,80,80,.3);color:#ffb8b8}.result-msg.warn{background:rgba(255,184,100,.1);border:1px solid rgba(255,184,100,.3);color:#ffd580}</style></head><body><div class="wrap"><h1>Push Updates</h1><div id="auth" class="card"><h2>Authenticate</h2><input id="pw" type="password" placeholder="Admin password"/><div style="height:10px"></div><button id="loginBtn">Enter</button><p id="err" style="display:none;color:#ffb8c0;font-size:.84rem;margin-top:8px"></p></div><div id="panel" class="hidden"><div class="card"><h2>Code Queue</h2><div id="ghSection"></div></div><div class="card"><h2>Update Notes Queue <span id="pendingCount" class="badge">0</span></h2><p class="muted" style="margin-bottom:10px">What should users see on the Updates page? Write the description here &mdash; staged until you Release.</p><textarea id="newText" placeholder="e.g. Tab name corrected to Toro V2 across the site"></textarea><div style="height:8px"></div><button id="addBtn" class="primary">+ Add to Queue</button><div id="queueBox" style="margin-top:12px"></div></div><div class="card"><h2>Release</h2><p class="muted" style="margin-bottom:12px">Pushes staged code to <b>main</b> on GitHub &mdash; Railway auto-builds &amp; deploys. Also publishes queued update notes live.</p><div id="schedSt" style="margin-bottom:10px"></div><div class="row" style="margin-bottom:12px"><input type="datetime-local" id="scheduleDt" style="flex:1"/><button id="setDateBtn">Set Schedule</button><button id="clearDateBtn" class="danger">Clear</button></div><div class="row"><button id="releaseNowBtn" class="primary">&#9889; Release Now</button><span class="muted" style="flex:1">Push code live + publish notes immediately.</span></div><div id="releaseResult" class="result-msg"></div></div><div class="card"><h2>Live Updates</h2><div id="liveBox"></div></div></div></div><script>let PASS='';function esc(s){return String(s||'').replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]||m));}function setErr(t){const e=document.getElementById('err');e.style.display=t?'block':'none';e.textContent=t||'';}function fmt(s){if(!s)return'None';try{return new Date(s).toLocaleString();}catch{return s;}}async function post(url,data){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||('Request failed '+r.status));return j;}function paintGitHub(gh){const el=document.getElementById('ghSection');if(!gh||!gh.available){el.innerHTML='<div class="bs err">&#9888; Not configured</div><div class="setup-box">To enable the code queue, add these in Railway environment variables:<br><b>GITHUB_TOKEN</b> &mdash; Personal Access Token with <code>repo</code> scope<br><b>GITHUB_REPO</b> &mdash; e.g. <code>NexusDevelopments/Toro-V1</code><br><b>GITHUB_STAGING_BRANCH</b> &mdash; staging branch name (default: <code>staging</code>)<br><br>Then push code to staging instead of main:<br><code>git push nexus HEAD:staging</code><br><br>On Release, the server calls GitHub API to push staging to main and Railway auto-deploys.</div>';return;}if(gh.error){el.innerHTML='<div class="bs err">GitHub error: '+esc(gh.error)+'</div>';return;}if(gh.noBranch){el.innerHTML='<div class="bs warn">Staging branch does not exist yet</div><div class="setup-box">Click below to create the <code>'+esc(gh.stagingBranch)+'</code> branch, then push code to it:<br><code>git push nexus HEAD:'+esc(gh.stagingBranch)+'</code></div><div style="height:8px"></div><button id="createBranchBtn">Create staging branch on GitHub</button>';setTimeout(()=>{const btn=document.getElementById('createBranchBtn');if(btn)btn.onclick=async()=>{try{btn.disabled=true;await post('/dev/api/pushupdates/ensure-staging',{password:PASS});await loadState();}catch(e){alert(e.message||'Failed');btn.disabled=false;}};},0);return;}const count=gh.ahead||0;el.innerHTML=(count>0?'<div class="bs warn">&#128308; '+count+' commit'+(count!==1?'s':'')+' staged and ready</div>':'<div class="bs ok">&#10003; Nothing staged &mdash; staging matches main</div>')+(gh.behind>0?'<div class="bs err" style="margin-left:8px;display:inline-block">&#9888; staging is '+gh.behind+' commits behind main</div>':'')+' <p class="muted" style="margin:6px 0 8px">Push code to queue: <code>git push nexus HEAD:'+esc(gh.stagingBranch)+'</code></p>'+(count===0?'<p class="empty">No staged commits. Push to staging first.</p>':gh.commits.map(c=>'<div class="commit"><span class="commit-sha">'+esc(c.sha)+'</span><span class="commit-msg">'+esc(c.message)+'</span><div class="commit-meta">'+esc(c.author)+' &middot; '+fmt(c.date)+'</div></div>').join(''));}function paintState(st){document.getElementById('pendingCount').textContent=(st.pendingUpdates||[]).length;paintGitHub(st.github);const qb=document.getElementById('queueBox');if(!(st.pendingUpdates||[]).length){qb.innerHTML='<p class="empty">No update notes queued.</p>';}else{qb.innerHTML='';(st.pendingUpdates||[]).forEach(u=>{const d=document.createElement('div');d.className='pi';d.innerHTML='<div style="flex:1"><div class="pi-t">'+esc(u.text)+'</div><div class="pi-m">Added '+fmt(u.addedAt)+'</div></div><button class="danger del-btn" data-id="'+esc(u.id)+'">Delete</button>';qb.appendChild(d);});qb.querySelectorAll('.del-btn').forEach(btn=>{btn.onclick=async()=>{try{const r=await post('/dev/api/pushupdates/delete',{password:PASS,id:btn.dataset.id});paintState(r);}catch(e){alert(e.message||'Failed');}};});}const ss=document.getElementById('schedSt');ss.innerHTML=st.releaseDate?'<div class="bs warn">&#128197; Scheduled: '+fmt(st.releaseDate)+'</div>':'<div class="bs ok" style="background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.15);color:#aaa">No schedule set</div>';const lb=document.getElementById('liveBox');const live=(st.liveUpdates||[]).slice(0,15);lb.innerHTML=live.length?live.map(u=>'<div class="li">'+esc(u.text)+'</div>').join(''):'<p class="empty">No live updates yet.</p>';}async function loadState(){const r=await post('/dev/api/pushupdates/list',{password:PASS});paintState(r);return r;}document.getElementById('loginBtn').onclick=async()=>{setErr('');try{PASS=document.getElementById('pw').value||'';await loadState();document.getElementById('auth').classList.add('hidden');document.getElementById('panel').classList.remove('hidden');}catch(e){setErr(e.message||'Authentication failed');}};document.getElementById('pw').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('loginBtn').click();});document.getElementById('addBtn').onclick=async()=>{const text=document.getElementById('newText').value.trim();if(!text)return;try{const r=await post('/dev/api/pushupdates/add',{password:PASS,text});document.getElementById('newText').value='';paintState(r);}catch(e){alert(e.message||'Failed');}};document.getElementById('setDateBtn').onclick=async()=>{const v=document.getElementById('scheduleDt').value;if(!v){alert('Pick a date & time first.');return;}try{const r=await post('/dev/api/pushupdates/set-date',{password:PASS,releaseDate:new Date(v).toISOString()});paintState(r);}catch(e){alert(e.message||'Failed');}};document.getElementById('clearDateBtn').onclick=async()=>{try{const r=await post('/dev/api/pushupdates/set-date',{password:PASS,releaseDate:null});document.getElementById('scheduleDt').value='';paintState(r);}catch(e){alert(e.message||'Failed');}};document.getElementById('releaseNowBtn').onclick=async()=>{const rr=document.getElementById('releaseResult');rr.style.display='none';try{const r=await post('/dev/api/pushupdates/release',{password:PASS});let msg='';if(r.codePushed)msg+='&#10003; Code pushed to main &mdash; Railway is building + deploying. ';if(r.codeError)msg+='&#9888; Code push failed: '+esc(r.codeError)+'. ';if(r.released>0)msg+='&#10003; '+r.released+' update note(s) are now live. ';if(!msg)msg='Nothing to release. Stage code commits or add update notes first.';rr.className='result-msg '+(r.codeError?'warn':'ok');rr.style.display='block';rr.innerHTML=msg;paintState(r);}catch(e){rr.className='result-msg err';rr.style.display='block';rr.textContent=e.message||'Release failed';}};setInterval(async()=>{if(!PASS)return;try{await loadState();}catch{};},30000);</script></body></html>`;

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

function getLiveUserCount() {
  const now = Date.now();
  let count = 0;

  for (const [, entry] of ipLog) {
    const visits = Array.isArray(entry?.visits) ? entry.visits : [];
    const lastVisit = visits.length > 0 ? visits[visits.length - 1] : null;
    const lastTs = Date.parse(lastVisit?.ts || '');

    if (Number.isFinite(lastTs) && now - lastTs <= LIVE_USER_WINDOW_MS) {
      count += 1;
    }
  }

  return count;
}

function normalizeStatusLink(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      return { label: parsed.host, url: parsed.toString() };
    } catch {
      return null;
    }
  }

  if (raw.includes('.')) {
    return { label: raw, url: `https://${raw}` };
  }

  const safe = raw.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60);
  if (!safe) return null;
  return { label: `${safe}.workers.dev`, url: `https://${safe}.workers.dev` };
}

async function checkLinkStatus(input) {
  const normalized = normalizeStatusLink(input);
  if (!normalized) {
    return {
      input: String(input || ''),
      label: String(input || ''),
      url: '',
      online: false,
      status: null,
      error: 'Invalid link',
    };
  }

  const options = {
    redirect: 'follow',
    signal: AbortSignal.timeout(7000),
  };

  try {
    let response = await fetch(normalized.url, { method: 'HEAD', ...options });
    if (response.status === 405) {
      response = await fetch(normalized.url, { method: 'GET', ...options });
    }

    const online = response.status >= 200 && response.status < 500;
    return {
      input: String(input || ''),
      label: normalized.label,
      url: normalized.url,
      online,
      status: response.status,
      error: online ? '' : `HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      input: String(input || ''),
      label: normalized.label,
      url: normalized.url,
      online: false,
      status: null,
      error: err?.name === 'TimeoutError' ? 'Timeout' : (err?.message || 'Request failed'),
    };
  }
}

let bare = null;
if (!IS_VERCEL_RUNTIME) {
  try {
    const wispModule = await import("@mercuryworkshop/wisp-js/server");
    const bareModule = await import("@tomphttp/bare-server-node");

    const wisp = wispModule.server;
    const logging = wispModule.logging;
    const createBareServer = bareModule.createBareServer || bareModule.default?.createBareServer || bareModule.default;

    if (process.env.BARE !== "false" && typeof createBareServer === "function") {
      bare = createBareServer("/seal/");
    }

    if (wisp && logging) {
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
    }
  } catch (err) {
    console.error('Failed to initialize bare/wisp runtime:', err?.message || err);
  }
}

const app = Fastify({
  serverFactory: h => {
    server.on("request", (req, res) => {
      try {
      // Admin endpoints: bypass Fastify/static entirely so React Router never intercepts them
      const pathname = new URL(req.url || '/', 'http://local').pathname;

      if (pathname === '/dev/home' || pathname === '/dev/home/') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(applyToroAdminTheme(devHtml));
          return;
        }
      }

      if (pathname === '/dev/links' || pathname === '/dev/links/') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(applyToroAdminTheme(devLinksHtml));
          return;
        }
      }

      if (pathname === '/dev/pushupdates' || pathname === '/dev/pushupdates/') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(applyToroAdminTheme(devPushUpdatesHtml2));
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

              const newUpdate = { id: randomUUID(), text: text.trim(), ts: new Date().toISOString() };
              devState.updates.unshift(newUpdate);
              if (devState.updates.length > 100) devState.updates.length = 100;

              const persisted = await saveDevState();
              if (IS_RAILWAY && persisted?.backend !== 'postgres') {
                devState.updates = devState.updates.filter((u) => u.id !== newUpdate.id);
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  error: 'Update was not saved to Postgres. Attach Railway PostgreSQL and set DATABASE_URL/POSTGRES_URL before adding updates.',
                }));
                return;
              }

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, updates: devState.updates, persistedIn: persisted?.backend || 'unknown' }));
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Bad Request' }));
            }
          });
          return;
        }
      }

      // ---- Push Updates API ----
      const pushUpdatesState = () => ({
        pendingUpdates: devState.pendingUpdates,
        releaseDate: devState.releaseDate,
        liveUpdates: devState.updates.slice(0, 15),
      });

      const releasePendingNow = async () => {
        const releasing = [...devState.pendingUpdates];
        devState.pendingUpdates = [];
        devState.releaseDate = null;
        releasing.forEach((u) => {
          devState.updates.unshift({ id: u.id, text: u.text, ts: u.addedAt });
        });
        if (devState.updates.length > 100) devState.updates.length = 100;
        await saveDevState();
        return releasing.length;
      };

      if (pathname === '/dev/api/pushupdates/list') {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
          req.on('end', async () => {
            try {
              const { password } = JSON.parse(body || '{}');
              if (typeof password !== 'string' || !verifyLogPassword(password)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
              }
              const gh = getGitHubConfig();
              let githubInfo = { available: gh.available, reason: gh.available ? undefined : gh.reason };
              if (gh.available) {
                try {
                  const staged = await getStagedCommits(gh.token, gh.repo, gh.stagingBranch);
                  githubInfo = { available: true, repo: gh.repo, stagingBranch: gh.stagingBranch, ...staged };
                } catch (err) {
                  githubInfo = { available: true, repo: gh.repo, stagingBranch: gh.stagingBranch, error: err.message || String(err) };
                }
              }
              res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
              res.end(JSON.stringify({ ok: true, ...pushUpdatesState(), github: githubInfo }));
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Bad Request' }));
            }
          });
          return;
        }
      }

      if (pathname === '/dev/api/pushupdates/add') {
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
              const entry = { id: randomUUID(), text: text.trim(), addedAt: new Date().toISOString() };
              devState.pendingUpdates.unshift(entry);
              if (devState.pendingUpdates.length > 100) devState.pendingUpdates.length = 100;
              await saveDevState();
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, ...pushUpdatesState() }));
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Bad Request' }));
            }
          });
          return;
        }
      }

      if (pathname === '/dev/api/pushupdates/delete') {
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
              if (typeof id !== 'string') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'id required' }));
                return;
              }
              devState.pendingUpdates = devState.pendingUpdates.filter((u) => u.id !== id);
              await saveDevState();
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, ...pushUpdatesState() }));
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Bad Request' }));
            }
          });
          return;
        }
      }

      if (pathname === '/dev/api/pushupdates/set-date') {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
          req.on('end', async () => {
            try {
              const { password, releaseDate } = JSON.parse(body || '{}');
              if (typeof password !== 'string' || !verifyLogPassword(password)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
              }
              if (releaseDate !== null && typeof releaseDate !== 'string') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'releaseDate must be an ISO string or null' }));
                return;
              }
              devState.releaseDate = releaseDate ? new Date(releaseDate).toISOString() : null;
              await saveDevState();
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, ...pushUpdatesState() }));
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Bad Request' }));
            }
          });
          return;
        }
      }

      if (pathname === '/dev/api/pushupdates/release') {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
          req.on('end', async () => {
            try {
              const { password } = JSON.parse(body || '{}');
              if (typeof password !== 'string' || !verifyLogPassword(password)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
              }
              const gh = getGitHubConfig();
              let codePushed = false;
              let codeError = null;
              if (gh.available) {
                try {
                  await pushStagingToMain(gh.token, gh.repo, gh.stagingBranch);
                  codePushed = true;
                } catch (err) {
                  codeError = err.message || String(err);
                }
              }
              const released = await releasePendingNow();
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, released, codePushed, codeError, ...pushUpdatesState() }));
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Bad Request' }));
            }
          });
          return;
        }
      }

            if (pathname === '/dev/api/pushupdates/ensure-staging') {
              if (req.method === 'POST') {
                let body = '';
                req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
                req.on('end', async () => {
                  try {
                    const { password } = JSON.parse(body || '{}');
                    if (typeof password !== 'string' || !verifyLogPassword(password)) {
                      res.writeHead(401, { 'Content-Type': 'application/json' });
                      res.end(JSON.stringify({ error: 'Unauthorized' }));
                      return;
                    }
                    const gh = getGitHubConfig();
                    if (!gh.available) {
                      res.writeHead(503, { 'Content-Type': 'application/json' });
                      res.end(JSON.stringify({ error: gh.reason }));
                      return;
                    }
                    const created = await ensureStagingExists(gh.token, gh.repo, gh.stagingBranch);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, created, stagingBranch: gh.stagingBranch }));
                  } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message || 'Failed' }));
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

              const targetUrl = new URL(String(target || '').trim() || 'https://torov2.up.railway.app');
              if (!/^https?:$/i.test(targetUrl.protocol)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid target URL protocol.' }));
                return;
              }

              if (bulkBatchRunning) {
                const etaSeconds = Math.max(0, Math.ceil((bulkBatchEtaAt - Date.now()) / 1000));
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  error: `A bulk batch is already running. Try again in about ${Math.ceil(etaSeconds / 60)} minute(s).`,
                  etaSeconds,
                }));
                return;
              }

              const cooldownUntilMs = devState.bulkLinksCooldownUntil ? new Date(devState.bulkLinksCooldownUntil).getTime() : 0;
              if (cooldownUntilMs > Date.now()) {
                const retryAfterSec = Math.max(1, Math.ceil((cooldownUntilMs - Date.now()) / 1000));
                const retryAfterMin = Math.ceil(retryAfterSec / 60);
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  error: `Bulk create cooldown is active. Try again in about ${retryAfterMin} minute(s).`,
                  cooldownUntil: devState.bulkLinksCooldownUntil,
                  retryAfterSec,
                }));
                return;
              }

              const numericCount = Number(count);
              if (!Number.isFinite(numericCount) || numericCount < BULK_MIN_COUNT || numericCount > BULK_MAX_COUNT) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Bulk count must be between ${BULK_MIN_COUNT} and ${BULK_MAX_COUNT}.` }));
                return;
              }

              const requestedCount = Math.floor(numericCount);
              const ideas = generateSiteNameIdeas(term, requestedCount);

              if (!ideas.length) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Could not generate names for that term.' }));
                return;
              }

              const delaysSec = Array.from(
                { length: Math.max(0, ideas.length - 1) },
                () => randomIntInclusive(BULK_LINK_DELAY_MIN_SEC, BULK_LINK_DELAY_MAX_SEC),
              );
              const estimatedDurationSec = delaysSec.reduce((sum, sec) => sum + sec, 0);
              const startedAt = new Date().toISOString();
              bulkBatchRunning = true;
              bulkBatchEtaAt = Date.now() + estimatedDurationSec * 1000;

              const results = [];
              for (let index = 0; index < ideas.length; index += 1) {
                const idea = ideas[index];
                const linkId = randomUUID();
                try {
                  if (chosenProvider === 'bunnycdn') {
                    const { zoneId, hostname, zoneName } = await createBunnyCDNPullZoneUnique(bunny.apiKey, idea.slug, targetUrl.toString());
                    const rec = {
                      id: linkId,
                      url: `https://${hostname}`,
                      requestedSubdomain: zoneName,
                      target: targetUrl.toString(),
                      createdAt: new Date().toISOString(),
                      status: 'running',
                      provider: 'bunnycdn',
                      providerZoneId: zoneId,
                    };
                    devState.links.unshift(rec);
                    results.push({ ok: true, name: zoneName, url: `https://${hostname}`, index: index + 1, total: ideas.length });
                  } else {
                    const workerName = `${idea.slug}-${linkId.slice(0, 6)}`;
                    const { hostname } = await createCloudflareWorker(cfw.accountId, cfw.authHeaders, workerName, targetUrl.toString());
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
                    results.push({ ok: true, name: idea.label, url: `https://${hostname}`, index: index + 1, total: ideas.length });
                  }
                } catch (err) {
                  results.push({ ok: false, name: idea.label, error: err?.message || 'Failed', index: index + 1, total: ideas.length });
                }

                if (index < delaysSec.length) {
                  const waitSec = delaysSec[index];
                  await sleep(waitSec * 1000);
                }
              }

              const cooldownUntil = new Date(Date.now() + BULK_BATCH_COOLDOWN_MS).toISOString();
              devState.bulkLinksCooldownUntil = cooldownUntil;

              if (devState.links.length > 30) devState.links.length = 30;
              await saveDevState();
              bulkBatchRunning = false;
              bulkBatchEtaAt = 0;

              const noteMsg = chosenProvider === 'bunnycdn'
                ? 'BunnyCDN pull zones can take 1\u20135 minutes to go live as the edge network propagates.'
                : 'Cloudflare Workers are usually live within seconds.';
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                ok: true,
                results,
                note: noteMsg,
                startedAt,
                finishedAt: new Date().toISOString(),
                estimatedDurationSec,
                minDelaySec: BULK_LINK_DELAY_MIN_SEC,
                maxDelaySec: BULK_LINK_DELAY_MAX_SEC,
                cooldownUntil,
              }));
            } catch {
              bulkBatchRunning = false;
              bulkBatchEtaAt = 0;
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
                  if (cfw.available) await deleteCloudflareWorker(cfw.accountId, cfw.authHeaders, link.cfWorkerName);
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

              const targetUrl = new URL(String(target || '').trim() || 'https://torov2.up.railway.app');
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
                  const { zoneId, hostname, zoneName } = await createBunnyCDNPullZoneUnique(bunny.apiKey, rawName, targetUrl.toString());
                  const rec = {
                    id: linkId,
                    url: `https://${hostname}`,
                    requestedSubdomain: zoneName,
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
                    note: 'BunnyCDN pull zones can take 1â€“5 minutes to become active as the edge network propagates. If you see "Domain suspended or not configured", wait a moment and refresh.',
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
                  const { hostname } = await createCloudflareWorker(cfw.accountId, cfw.authHeaders, workerName, targetUrl.toString());
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
          res.end(applyToroAdminTheme(logsHtml));
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
          res.end(applyToroAdminTheme(crLogsHtml));
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
      } catch (err) {
        console.error('Request handler crash:', err?.stack || err?.message || err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        }
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
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

const DIST_DIR = join(__dirname, "dist");
if (existsSync(DIST_DIR)) {
  app.register(fastifyStatic, {
    root: DIST_DIR,
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
} else {
  console.warn(`Static dist directory not found at ${DIST_DIR}. Frontend files may not be served.`);
}

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
app.get('/api/live-users', async () => ({
  ok: true,
  count: getLiveUserCount(),
  windowMs: LIVE_USER_WINDOW_MS,
}));
app.post('/api/more-links/status', async (req) => {
  const links = Array.isArray(req.body?.links) ? req.body.links : [];
  const items = links
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 40);

  const results = await Promise.all(items.map((item) => checkLinkStatus(item)));
  return { ok: true, results };
});

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
let appReadyPromise = null;

const ensureAppReady = async () => {
  if (!appReadyPromise) {
    appReadyPromise = app.ready();
  }
  return appReadyPromise;
};

// Vercel entrypoint: route HTTP requests through Fastify without opening a TCP listener.
export default async function vercelHandler(req, res) {
  try {
    await ensureAppReady();
    app.server.emit('request', req, res);
  } catch (err) {
    console.error('Vercel handler startup failed:', err?.stack || err?.message || err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify({ error: 'Server startup failed' }));
  }
}

if (!process.env.VERCEL) {
  app
    .listen({ port, host })
    .then(() => console.log(`Server running on ${host}:${port}`))
    .catch((err) => {
      console.error('Server failed to start:', err);
      process.exit(1);
    });
}



