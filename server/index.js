import crypto from "node:crypto";
import http from "node:http";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "..", "web");
const port = Number(process.env.SERVER_PORT || 8787);
const dataDir = path.join(__dirname, "..", "data");
const dbPath = process.env.GLUGG_DB || path.join(dataDir, "glugg.db");
const sessionTtlMs = 1000 * 60 * 60 * 12;

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

await mkdir(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const seedServers = getServersFromEnv();
if (seedServers.length) {
  const count = db.prepare("SELECT COUNT(*) AS count FROM servers").get();
  if (count && count.count === 0) {
    const insert = db.prepare(
      "INSERT INTO servers (name, url, api_key, enabled) VALUES (?, ?, ?, 1)"
    );
    db.exec("BEGIN");
    try {
      seedServers.forEach((server) => {
        insert.run(server.name, server.url, server.apiKey);
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    console.log(`Seeded ${seedServers.length} server(s) from EMBY_SERVERS`);
  }
}

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  });
  res.end(JSON.stringify(body));
}

const sessions = new Map();

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("base64");
}

function verifyPassword(password, salt, storedHash) {
  const computed = hashPassword(password, salt);
  const stored = Buffer.from(storedHash, "base64");
  const candidate = Buffer.from(computed, "base64");
  if (stored.length !== candidate.length) return false;
  return crypto.timingSafeEqual(stored, candidate);
}

function createUser(username, password, role) {
  const salt = crypto.randomBytes(16).toString("base64");
  const passwordHash = hashPassword(password, salt);
  const stmt = db.prepare(
    "INSERT INTO users (username, password_hash, salt, role) VALUES (?, ?, ?, ?)"
  );
  stmt.run(username, passwordHash, salt, role);
}

function getUserByUsername(username) {
  return db
    .prepare("SELECT id, username, password_hash, salt, role FROM users WHERE username = ?")
    .get(username);
}

function getAllUsers() {
  return db
    .prepare("SELECT id, username, role, created_at FROM users ORDER BY id")
    .all();
}

function userCount() {
  const row = db.prepare("SELECT COUNT(*) AS count FROM users").get();
  return row ? row.count : 0;
}

function adminCount() {
  const row = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get();
  return row ? row.count : 0;
}

function parseCookies(header) {
  if (!header) return {};
  return header.split(";").reduce((acc, part) => {
    const [key, ...rest] = part.trim().split("=");
    acc[key] = decodeURIComponent(rest.join("=") || "");
    return acc;
  }, {});
}

function getSession(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies.glugg_session;
  if (!token) return null;
  const entry = sessions.get(token);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > sessionTtlMs) {
    sessions.delete(token);
    return null;
  }
  return entry;
}

function setSession(res, session) {
  const token = crypto.randomUUID();
  sessions.set(token, { ...session, createdAt: Date.now() });
  res.setHeader(
    "Set-Cookie",
    `glugg_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax`
  );
}

function clearSession(req, res) {
  const cookies = parseCookies(req.headers.cookie || "");
  if (cookies.glugg_session) {
    sessions.delete(cookies.glugg_session);
  }
  res.setHeader(
    "Set-Cookie",
    "glugg_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0"
  );
}

function requireAuth(req, res) {
  const session = getSession(req);
  if (!session) {
    json(res, 401, { error: "Unauthorized" });
    return null;
  }
  return session;
}

function requireAdmin(req, res) {
  const session = requireAuth(req, res);
  if (!session) return null;
  if (session.role !== "admin") {
    json(res, 403, { error: "Admin access required" });
    return null;
  }
  return session;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function normalizeServerInput(payload) {
  if (!payload || typeof payload !== "object") return null;
  const name = String(payload.name || "").trim();
  const url = String(payload.url || "").trim();
  const apiKey = String(payload.apiKey || "").trim();
  const enabled = payload.enabled === undefined ? 1 : payload.enabled ? 1 : 0;
  if (!name || !url || !apiKey) return null;
  return {
    name,
    url: url.replace(/\/+$/, ""),
    apiKey,
    enabled,
  };
}

function normalizeRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  if (normalized === "admin" || normalized === "user") return normalized;
  return null;
}

function getServersFromEnv() {
  if (!process.env.EMBY_SERVERS) return [];
  try {
    const parsed = JSON.parse(process.env.EMBY_SERVERS);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && entry.url && entry.apiKey)
      .map((entry) => ({
        name: entry.name || new URL(entry.url).host,
        url: entry.url.replace(/\/+$/, ""),
        apiKey: entry.apiKey,
      }));
  } catch {
    return [];
  }
}

function getServersFromDb() {
  return db
    .prepare("SELECT id, name, url, api_key, enabled FROM servers WHERE enabled = 1 ORDER BY id")
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      apiKey: row.api_key,
    }));
}

function getAllServersFromDb() {
  return db
    .prepare("SELECT id, name, url, api_key, enabled FROM servers ORDER BY id")
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      apiKey: row.api_key,
      enabled: Boolean(row.enabled),
    }));
}

function normalizeType(type) {
  switch (type) {
    case "movie":
      return "Movie";
    case "series":
      return "Series";
    default:
      return "Movie,Series";
  }
}

function getEmbyBase(url) {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/emby") ? trimmed : `${trimmed}/emby`;
}

function normalizeText(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const rows = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 0; i < a.length; i += 1) {
    let prev = i + 1;
    for (let j = 0; j < b.length; j += 1) {
      const cost = a[i] === b[j] ? 0 : 1;
      const next = Math.min(
        rows[j + 1] + 1,
        prev + 1,
        rows[j] + cost
      );
      rows[j] = prev;
      prev = next;
    }
    rows[b.length] = prev;
  }
  return rows[b.length];
}

function similarityScore(query, candidate) {
  const normalizedQuery = normalizeText(query);
  const normalizedCandidate = normalizeText(candidate);
  if (!normalizedQuery || !normalizedCandidate) return 0;
  if (normalizedCandidate.includes(normalizedQuery)) return 1;
  const distance = levenshtein(normalizedQuery, normalizedCandidate);
  const maxLen = Math.max(normalizedQuery.length, normalizedCandidate.length);
  return maxLen ? 1 - distance / maxLen : 0;
}

function parseQuery(query) {
  const match = query.match(/\b(19|20)\d{2}\b/);
  const year = match ? Number(match[0]) : null;
  const term = query.replace(/\b(19|20)\d{2}\b/g, "").replace(/\s+/g, " ").trim();
  return { term: term || query.trim(), year };
}

const stopWords = new Set(["the", "a", "an", "and", "or", "of"]);

function getWords(value) {
  return normalizeText(value)
    .split(" ")
    .map((word) => word.trim())
    .filter((word) => word && !stopWords.has(word));
}

function wordsMatch(query, candidate) {
  const queryWords = getWords(query);
  const candidateWords = getWords(candidate);
  if (!queryWords.length || !candidateWords.length) return false;
  return queryWords.every((queryWord) => {
    return candidateWords.some((candidateWord) => {
      if (candidateWord === queryWord) return true;
      const distance = levenshtein(queryWord, candidateWord);
      if (queryWord.length >= 5 && distance <= 1) return true;
      const maxLen = Math.max(queryWord.length, candidateWord.length);
      return maxLen ? 1 - distance / maxLen >= 0.84 : false;
    });
  });
}

function getQuality(item) {
  const streams = Array.isArray(item.MediaStreams) ? item.MediaStreams : [];
  const video = streams.find((stream) => stream.Type === "Video");
  if (video && typeof video.Height === "number") {
    if (video.Height >= 2160) return "4K";
    if (video.Height >= 1440) return "1440p";
    if (video.Height >= 1080) return "1080p";
    if (video.Height >= 720) return "720p";
    return `${video.Height}p`;
  }
  return null;
}

async function fetchItemsByIds(
  server,
  ids,
  fields = "Name,ParentId,Type,CollectionType",
  userId
) {
  const unique = Array.from(new Set(ids)).filter(Boolean);
  if (!unique.length) return [];
  const params = new URLSearchParams({
    Ids: unique.join(","),
    Fields: fields,
  });
  const base = userId
    ? `${getEmbyBase(server.url)}/Users/${userId}/Items`
    : `${getEmbyBase(server.url)}/Items`;
  const url = `${base}?${params.toString()}`;
  const response = await fetch(url, {
    headers: {
      "X-Emby-Token": server.apiKey,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    return [];
  }
  const payload = await response.json();
  return Array.isArray(payload.Items) ? payload.Items : [];
}

const libraryCache = new Map();
const libraryCacheTtlMs = 1000 * 60 * 5;
const itemLibraryCache = new Map();
const itemLibraryCacheTtlMs = 1000 * 60 * 30;

async function fetchCurrentUserId(server) {
  const url = `${getEmbyBase(server.url)}/Users/Me`;
  const response = await fetch(url, {
    headers: {
      "X-Emby-Token": server.apiKey,
      Accept: "application/json",
    },
  });
  if (response.ok) {
    const payload = await response.json();
    return payload.Id || payload.id || null;
  }
  const fallback = await fetch(`${getEmbyBase(server.url)}/Users`, {
    headers: {
      "X-Emby-Token": server.apiKey,
      Accept: "application/json",
    },
  });
  if (!fallback.ok) return null;
  const payload = await fallback.json();
  const users = Array.isArray(payload) ? payload : payload.Items;
  if (!Array.isArray(users) || !users.length) return null;
  return users[0].Id || users[0].id || null;
}

async function fetchLibraryViews(server) {
  const userId = await fetchCurrentUserId(server);
  if (!userId) return { userId: null, views: [] };
  const url = `${getEmbyBase(server.url)}/Users/${userId}/Views`;
  const response = await fetch(url, {
    headers: {
      "X-Emby-Token": server.apiKey,
      Accept: "application/json",
    },
  });
  if (!response.ok) return { userId: null, views: [] };
  const payload = await response.json();
  const items = Array.isArray(payload.Items) ? payload.Items : [];
  return { userId, views: items.map((item) => ({ id: item.Id, name: item.Name })) };
}

async function fetchLibraryFolders(server, endpoint) {
  const url = `${getEmbyBase(server.url)}${endpoint}`;
  const response = await fetch(url, {
    headers: {
      "X-Emby-Token": server.apiKey,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    return [];
  }
  const payload = await response.json();
  const items = Array.isArray(payload.Items) ? payload.Items : [];
  const entries = [];
  items.forEach((item) => {
    if (Array.isArray(item.Paths)) {
      item.Paths.forEach((folderPath) => {
        entries.push({ name: item.Name, path: folderPath });
      });
      return;
    }
    if (Array.isArray(item.Locations)) {
      item.Locations.forEach((folderPath) => {
        entries.push({ name: item.Name, path: folderPath });
      });
      return;
    }
    if (item.Path) {
      entries.push({ name: item.Name, path: item.Path });
    }
  });
  return entries.filter((entry) => entry.name && entry.path);
}

async function getLibraryEntries(server) {
  const cacheKey = server.url;
  const cached = libraryCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < libraryCacheTtlMs) {
    return cached;
  }
  const mediaFolders = await fetchLibraryFolders(server, "/Library/MediaFolders");
  const virtualFolders = await fetchLibraryFolders(server, "/Library/VirtualFolders");
  const { userId, views } = await fetchLibraryViews(server);
  const viewItems = await fetchItemsByIds(
    server,
    views.map((view) => view.id),
    "Name,Path,Locations"
    ,
    userId
  );
  const viewEntries = [];
  viewItems.forEach((item) => {
    if (Array.isArray(item.Locations)) {
      item.Locations.forEach((folderPath) => {
        viewEntries.push({ name: item.Name, path: folderPath });
      });
      return;
    }
    if (item.Path) {
      viewEntries.push({ name: item.Name, path: item.Path });
    }
  });
  const combined = [...mediaFolders, ...virtualFolders, ...viewEntries];
  const seen = new Set();
  const entries = combined.filter((entry) => {
    const key = `${entry.name}:${entry.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const result = { fetchedAt: Date.now(), entries, views, userId };
  libraryCache.set(cacheKey, result);
  return result;
}

async function fetchAncestors(server, itemId, userId) {
  const base = userId
    ? `${getEmbyBase(server.url)}/Users/${userId}/Items/${itemId}/Ancestors`
    : `${getEmbyBase(server.url)}/Items/${itemId}/Ancestors`;
  const url = base;
  const response = await fetch(url, {
    headers: {
      "X-Emby-Token": server.apiKey,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    return [];
  }
  const payload = await response.json();
  return Array.isArray(payload.Items) ? payload.Items : [];
}

function resolveLibraryByPath(itemPath, mediaFolders) {
  if (!itemPath || !mediaFolders.length) return null;
  const normalizedPath = itemPath.toLowerCase();
  let match = null;
  mediaFolders.forEach((folder) => {
    const folderPath = folder.path.toLowerCase();
    if (normalizedPath.startsWith(folderPath)) {
      if (!match || folderPath.length > match.path.length) {
        match = folder;
      }
    }
  });
  return match ? match.name : null;
}


function inferQualityFromPath(itemPath) {
  if (!itemPath) return null;
  const normalized = itemPath.toLowerCase();
  if (normalized.includes("2160") || normalized.includes("/4k/") || normalized.includes("/uhd/")) {
    return "4K";
  }
  if (normalized.includes("1440")) return "1440p";
  if (normalized.includes("1080")) return "1080p";
  if (normalized.includes("720")) return "720p";
  if (normalized.includes("480")) return "480p";
  return null;
}

function qualityRank(quality) {
  switch (quality) {
    case "4K":
      return 5;
    case "2160p":
      return 5;
    case "1440p":
      return 4;
    case "1080p":
      return 3;
    case "720p":
      return 2;
    case "480p":
      return 1;
    default:
      return 0;
  }
}

async function fetchSeriesQuality(server, seriesId, userId) {
  const params = new URLSearchParams({
    ParentId: seriesId,
    IncludeItemTypes: "Episode",
    Recursive: "true",
    Limit: "1",
    Fields: "MediaStreams,Path",
  });
  const base = userId
    ? `${getEmbyBase(server.url)}/Users/${userId}/Items`
    : `${getEmbyBase(server.url)}/Items`;
  const url = `${base}?${params.toString()}`;
  const response = await fetch(url, {
    headers: {
      "X-Emby-Token": server.apiKey,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    return null;
  }
  const payload = await response.json();
  const item = Array.isArray(payload.Items) ? payload.Items[0] : null;
  if (!item) return null;
  return getQuality(item) || inferQualityFromPath(item.Path);
}

async function resolveLibraries(server, items, mediaFolders, viewMap, userId) {
  if (!items.length) return new Map();
  const idToItem = new Map();
  const itemToRoot = new Map();
  const pending = new Set();

  items.forEach((item) => {
    const rootId = item.TopParentId || item.ParentId;
    if (rootId) {
      itemToRoot.set(item.Id, rootId);
      pending.add(rootId);
    }
  });

  let depth = 0;
  let current = new Set(pending);
  while (current.size && depth < 4) {
    const batch = Array.from(current);
    const fetched = await fetchItemsByIds(server, batch, "Name,ParentId,Type,CollectionType", userId);
    fetched.forEach((node) => {
      idToItem.set(node.Id, node);
    });
    const next = new Set();
    fetched.forEach((node) => {
      const name = (node.Name || "").trim().toLowerCase();
      const isLibrary = node.Type === "CollectionFolder" || node.CollectionType;
      if (!isLibrary || !name || name === "root") {
        if (node.ParentId && !idToItem.has(node.ParentId)) {
          next.add(node.ParentId);
        }
      }
    });
    current = next;
    depth += 1;
  }

  const libraryMap = new Map();
  itemToRoot.forEach((rootId, itemId) => {
    if (viewMap && viewMap.has(rootId)) {
      libraryMap.set(itemId, viewMap.get(rootId));
      return;
    }
    let currentId = rootId;
    let hops = 0;
    let libraryName = null;
    while (currentId && hops < 5) {
      const node = idToItem.get(currentId);
      if (!node) break;
      if (viewMap && node.ParentId && viewMap.has(node.ParentId)) {
        libraryName = viewMap.get(node.ParentId);
        break;
      }
      const name = (node.Name || "").trim();
      const isLibrary = node.Type === "CollectionFolder" || node.CollectionType;
      if (isLibrary && name && name.toLowerCase() !== "root") {
        libraryName = name;
        break;
      }
      currentId = node.ParentId;
      hops += 1;
    }
    libraryMap.set(itemId, libraryName);
  });

  if (mediaFolders.length) {
    items.forEach((item) => {
      if (libraryMap.get(item.Id)) return;
      const fallback = resolveLibraryByPath(item.Path, mediaFolders);
      if (fallback) {
        libraryMap.set(item.Id, fallback);
      }
    });
  }

  const unresolved = items.filter((item) => !libraryMap.get(item.Id));
  if (unresolved.length) {
    await Promise.all(
      unresolved.map(async (item) => {
        const ancestors = await fetchAncestors(server, item.Id, userId);
        const viewAncestor = ancestors.find((ancestor) => viewMap && viewMap.has(ancestor.Id));
        if (viewAncestor) {
          libraryMap.set(item.Id, viewMap.get(viewAncestor.Id));
          return;
        }
        const library = ancestors.find(
          (ancestor) =>
            (ancestor.Type === "CollectionFolder" || ancestor.CollectionType) &&
            ancestor.Name &&
            ancestor.Name.toLowerCase() !== "root"
        );
        if (library) {
          libraryMap.set(item.Id, library.Name);
        }
      })
    );
  }

  const stillUnresolved = items.filter((item) => !libraryMap.get(item.Id));
  if (stillUnresolved.length && viewMap && viewMap.size) {
    const viewIds = Array.from(viewMap.keys());
    await Promise.all(
      stillUnresolved.map(async (item) => {
        const cacheKey = `${server.url}:${item.Id}`;
        const cached = itemLibraryCache.get(cacheKey);
        if (cached && Date.now() - cached.fetchedAt < itemLibraryCacheTtlMs) {
          libraryMap.set(item.Id, cached.name);
          return;
        }
        if (!item.ParentId) return;
        const parentHits = new Map();
        await Promise.all(
          viewIds.map(async (viewId) => {
            const params = new URLSearchParams({
              ParentId: viewId,
              Recursive: "true",
              IncludeItemTypes: item.Type || "",
              Limit: "1",
              Fields: "Id",
              Ids: item.Id,
            });
            const url = `${getEmbyBase(server.url)}/Users/${userId}/Items?${params.toString()}`;
            const response = await fetch(url, {
              headers: {
                "X-Emby-Token": server.apiKey,
                Accept: "application/json",
              },
            });
            if (!response.ok) return;
            const payload = await response.json();
            const items = Array.isArray(payload.Items) ? payload.Items : [];
            if (items.find((entry) => entry.Id === item.Id)) {
              parentHits.set(item.Id, viewMap.get(viewId));
            }
          })
        );
        if (parentHits.has(item.Id)) {
          const libraryName = parentHits.get(item.Id);
          libraryMap.set(item.Id, libraryName);
          itemLibraryCache.set(cacheKey, { name: libraryName, fetchedAt: Date.now() });
        }
      })
    );
  }

  return libraryMap;
}

async function searchServer(server, query, type) {
  const parsed = parseQuery(query);
  const params = new URLSearchParams({
    SearchTerm: parsed.term,
    Recursive: "true",
    IncludeItemTypes: normalizeType(type),
    Fields: "Overview,ProductionYear,CommunityRating,MediaStreams,ParentId,TopParentId,Path",
    Limit: "25",
  });
  const url = `${getEmbyBase(server.url)}/Items?${params.toString()}`;
  const response = await fetch(url, {
    headers: {
      "X-Emby-Token": server.apiKey,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Emby ${response.status}`);
  }
  const payload = await response.json();
  const items = Array.isArray(payload.Items) ? payload.Items : [];
  const filtered = items.filter((item) => {
    const name = item.Name || "";
    const similarity = similarityScore(parsed.term, name);
    const matchesText = similarity >= 0.7 || wordsMatch(parsed.term, name);
    if (!matchesText) return false;
    if (parsed.year && item.ProductionYear && item.ProductionYear !== parsed.year) {
      return false;
    }
    return true;
  });
  const { entries: mediaFolders, views, userId } = await getLibraryEntries(server);
  const viewMap = new Map(views.map((view) => [view.id, view.name]));
  const libraryMap = await resolveLibraries(server, filtered, mediaFolders, viewMap, userId);
  return Promise.all(
    filtered.map(async (item) => {
      let quality = (() => {
        const fromStream = getQuality(item);
        const fromPath = inferQualityFromPath(item.Path);
        if (!fromStream) return fromPath;
        if (!fromPath) return fromStream;
        return qualityRank(fromPath) >= qualityRank(fromStream) ? fromPath : fromStream;
      })();
      if (!quality && item.Type === "Series") {
        quality = await fetchSeriesQuality(server, item.Id, userId);
      }
      return {
        id: item.Id,
        name: item.Name,
        type: item.Type,
        year: item.ProductionYear || null,
        rating: typeof item.CommunityRating === "number" ? item.CommunityRating : null,
        overview: item.Overview || null,
        library: libraryMap.get(item.Id) || null,
        quality,
        path: item.Path || null,
        topParentId: item.TopParentId || null,
        parentId: item.ParentId || null,
      };
    })
  );
}

async function serveStatic(req, res, pathname) {
  const target = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(path.join(webRoot, target));
  if (!safePath.startsWith(webRoot)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const stats = await stat(safePath);
    if (!stats.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(safePath);
    const contentType = contentTypes.get(ext) || "application/octet-stream";
    const data = await readFile(safePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    });
    res.end();
    return;
  }

  if (url.pathname === "/api/me") {
    const session = getSession(req);
    json(res, 200, {
      authenticated: Boolean(session),
      role: session ? session.role : null,
      username: session ? session.username : null,
    });
    return;
  }

  if (url.pathname === "/api/setup/status") {
    const needsSetup = userCount() === 0;
    json(res, 200, { needsSetup });
    return;
  }

  if (url.pathname === "/api/setup" && req.method === "POST") {
    if (userCount() > 0) {
      json(res, 409, { error: "Setup already completed" });
      return;
    }
    try {
      const payload = await readJson(req);
      const username = String(payload.username || "").trim();
      const password = String(payload.password || "");
      if (!username || !password) {
        json(res, 400, { error: "Missing username or password" });
        return;
      }
      createUser(username, password, "admin");
      json(res, 201, { ok: true });
      return;
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }
  }

  if (url.pathname === "/api/login" && req.method === "POST") {
    if (userCount() === 0) {
      json(res, 409, { error: "Setup required" });
      return;
    }
    try {
      const payload = await readJson(req);
      const username = String(payload.username || "").trim();
      const password = String(payload.password || "").trim();
      const user = getUserByUsername(username);
      if (!user || !verifyPassword(password, user.salt, user.password_hash)) {
        json(res, 401, { error: "Invalid credentials" });
        return;
      }
      setSession(res, { username: user.username, role: user.role });
      json(res, 200, { ok: true, role: user.role });
      return;
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }
  }

  if (url.pathname === "/api/logout" && req.method === "POST") {
    clearSession(req, res);
    json(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/users") {
    const session = requireAdmin(req, res);
    if (!session) return;
    if (req.method === "GET") {
      json(res, 200, { users: getAllUsers() });
      return;
    }
    if (req.method === "POST") {
      try {
        const payload = await readJson(req);
        const username = String(payload.username || "").trim();
        const password = String(payload.password || "");
        const role = normalizeRole(payload.role);
        if (!username || !password || !role) {
          json(res, 400, { error: "Missing username, password, or role" });
          return;
        }
        if (getUserByUsername(username)) {
          json(res, 409, { error: "Username already exists" });
          return;
        }
        createUser(username, password, role);
        json(res, 201, { ok: true });
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
      }
      return;
    }
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  if (url.pathname.startsWith("/api/users/")) {
    const session = requireAdmin(req, res);
    if (!session) return;
    const id = Number(url.pathname.split("/").pop());
    if (!Number.isFinite(id)) {
      json(res, 400, { error: "Invalid user id" });
      return;
    }
    if (req.method === "PUT") {
      try {
        const payload = await readJson(req);
        const username = String(payload.username || "").trim();
        const password = String(payload.password || "");
        const role = normalizeRole(payload.role);
        const existing = db
          .prepare("SELECT id, username, role FROM users WHERE id = ?")
          .get(id);
        if (!existing) {
          json(res, 404, { error: "User not found" });
          return;
        }
        if (!username || !role) {
          json(res, 400, { error: "Missing username or role" });
          return;
        }
        if (role !== existing.role && existing.role === "admin" && adminCount() === 1) {
          json(res, 409, { error: "At least one admin is required" });
          return;
        }
        if (username !== existing.username && getUserByUsername(username)) {
          json(res, 409, { error: "Username already exists" });
          return;
        }
        db.exec("BEGIN");
        try {
          db.prepare("UPDATE users SET username = ?, role = ? WHERE id = ?").run(
            username,
            role,
            id
          );
          if (password) {
            const salt = crypto.randomBytes(16).toString("base64");
            const passwordHash = hashPassword(password, salt);
            db.prepare("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?").run(
              passwordHash,
              salt,
              id
            );
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        json(res, 200, { ok: true });
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : "Invalid JSON body" });
      }
      return;
    }
    if (req.method === "DELETE") {
      const existing = db
        .prepare("SELECT id, username, role FROM users WHERE id = ?")
        .get(id);
      if (!existing) {
        json(res, 404, { error: "User not found" });
        return;
      }
      if (existing.role === "admin" && adminCount() === 1) {
        json(res, 409, { error: "At least one admin is required" });
        return;
      }
      if (existing.username === session.username && existing.role === "admin") {
        json(res, 409, { error: "Cannot delete the active admin session" });
        return;
      }
      db.prepare("DELETE FROM users WHERE id = ?").run(id);
      json(res, 200, { ok: true });
      return;
    }
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  if (url.pathname === "/api/servers") {
    const session = requireAdmin(req, res);
    if (!session) return;
    if (req.method === "GET") {
      json(res, 200, { servers: getAllServersFromDb() });
      return;
    }
    if (req.method === "POST") {
      try {
        const payload = await readJson(req);
        const normalized = normalizeServerInput(payload);
        if (!normalized) {
          json(res, 400, { error: "Missing name, url, or apiKey" });
          return;
        }
        const stmt = db.prepare(
          "INSERT INTO servers (name, url, api_key, enabled) VALUES (?, ?, ?, ?)"
        );
        const info = stmt.run(
          normalized.name,
          normalized.url,
          normalized.apiKey,
          normalized.enabled
        );
        json(res, 201, { id: info.lastInsertRowid });
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
      }
      return;
    }
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  if (url.pathname.startsWith("/api/servers/")) {
    const parts = url.pathname.split("/").filter(Boolean);
    const id = Number(parts[2]);
    if (!Number.isFinite(id)) {
      json(res, 400, { error: "Invalid server id" });
      return;
    }
    const session = requireAdmin(req, res);
    if (!session) return;
    if (parts.length === 4 && parts[3] === "debug") {
      if (req.method !== "GET") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const row = db
        .prepare("SELECT name, url, api_key FROM servers WHERE id = ?")
        .get(id);
      if (!row) {
        json(res, 404, { error: "Server not found" });
        return;
      }
      const query = url.searchParams.get("q") || "";
      const type = url.searchParams.get("type") || "all";
      if (!query) {
        json(res, 400, { error: "Missing q parameter" });
        return;
      }
      try {
        const items = await searchServer(
          { name: row.name, url: row.url, apiKey: row.api_key },
          query,
          type
        );
        const serverInfo = { url: row.url, apiKey: row.api_key };
        const { entries: mediaFolders, views, userId } = await getLibraryEntries(serverInfo);
        const debug = await Promise.all(
          items.map(async (item) => {
            const ancestors = await fetchAncestors(
              serverInfo,
              item.id,
              userId
            );
            return {
              id: item.id,
              name: item.name,
              type: item.type,
              year: item.year,
              library: item.library,
              quality: item.quality,
              path: item.path || null,
              topParentId: item.topParentId || null,
              parentId: item.parentId || null,
              ancestors: ancestors.map((ancestor) => ({
                id: ancestor.Id,
                name: ancestor.Name,
                type: ancestor.Type,
                collectionType: ancestor.CollectionType || null,
              })),
            };
          })
        );
        json(res, 200, { server: row.name, mediaFolders, views, items: debug });
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : "Debug failed" });
      }
      return;
    }
    if (parts.length === 4 && parts[3] === "test") {
      if (req.method !== "POST") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const row = db
        .prepare("SELECT name, url, api_key FROM servers WHERE id = ?")
        .get(id);
      if (!row) {
        json(res, 404, { error: "Server not found" });
        return;
      }
      const base = getEmbyBase(row.url);
      try {
        const response = await fetch(`${base}/System/Info/Public`, {
          headers: {
            "X-Emby-Token": row.api_key,
            Accept: "application/json",
          },
        });
        if (!response.ok) {
          json(res, 502, { ok: false, error: `Emby ${response.status}` });
          return;
        }
        const payload = await response.json();
        json(res, 200, {
          ok: true,
          name: payload.ServerName || row.name,
          version: payload.Version || null,
          id: payload.Id || null,
        });
      } catch (error) {
        json(res, 502, {
          ok: false,
          error: error instanceof Error ? error.message : "Connection failed",
        });
      }
      return;
    }
    if (req.method === "PUT") {
      try {
        const payload = await readJson(req);
        const normalized = normalizeServerInput(payload);
        if (!normalized) {
          json(res, 400, { error: "Missing name, url, or apiKey" });
          return;
        }
        const stmt = db.prepare(
          "UPDATE servers SET name = ?, url = ?, api_key = ?, enabled = ? WHERE id = ?"
        );
        const info = stmt.run(
          normalized.name,
          normalized.url,
          normalized.apiKey,
          normalized.enabled,
          id
        );
        if (info.changes === 0) {
          json(res, 404, { error: "Server not found" });
          return;
        }
        json(res, 200, { ok: true });
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
      }
      return;
    }
    if (req.method === "DELETE") {
      const stmt = db.prepare("DELETE FROM servers WHERE id = ?");
      const info = stmt.run(id);
      if (info.changes === 0) {
        json(res, 404, { error: "Server not found" });
        return;
      }
      json(res, 200, { ok: true });
      return;
    }
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  if (url.pathname === "/api/search") {
    const session = requireAuth(req, res);
    if (!session) return;
    const query = url.searchParams.get("q");
    const type = url.searchParams.get("type") || "all";
    if (!query) {
      json(res, 400, { error: "Missing q parameter" });
      return;
    }
    const servers = getServersFromDb();
    const fallback = servers.length ? servers : getServersFromEnv();
    if (!servers.length && fallback.length) {
      console.warn("Using EMBY_SERVERS from env; database has no configured servers.");
    }
    if (!fallback.length) {
      json(res, 400, { error: "No servers configured" });
      return;
    }
    const results = await Promise.all(
      fallback.map(async (server) => {
        try {
          const matches = await searchServer(server, query, type);
          return { server: { name: server.name, url: server.url }, ok: true, matches };
        } catch (error) {
          console.error(`Search failed for ${server.url}:`, error);
          return {
            server: { name: server.name, url: server.url },
            ok: false,
            error: error instanceof Error ? error.message : "Search failed",
          };
        }
      })
    );
    json(res, 200, { query, type, results });
    return;
  }

  await serveStatic(req, res, url.pathname);
});

server.listen(port, () => {
  console.log(`Glugg running on http://localhost:${port}`);
});
