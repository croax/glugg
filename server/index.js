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

async function fetchItemsByIds(server, ids) {
  const unique = Array.from(new Set(ids)).filter(Boolean);
  if (!unique.length) return [];
  const params = new URLSearchParams({
    Ids: unique.join(","),
    Fields: "Name,ParentId,Type,CollectionType",
  });
  const url = `${getEmbyBase(server.url)}/Items?${params.toString()}`;
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

async function fetchMediaFolders(server) {
  const url = `${getEmbyBase(server.url)}/Library/MediaFolders`;
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
  const folders = Array.isArray(payload.Items) ? payload.Items : [];
  const entries = [];
  folders.forEach((folder) => {
    if (Array.isArray(folder.Paths)) {
      folder.Paths.forEach((folderPath) => {
        entries.push({ name: folder.Name, path: folderPath });
      });
      return;
    }
    if (folder.Path) {
      entries.push({ name: folder.Name, path: folder.Path });
    }
  });
  return entries.filter((entry) => entry.name && entry.path);
}

async function fetchAncestors(server, itemId) {
  const url = `${getEmbyBase(server.url)}/Items/${itemId}/Ancestors`;
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

function inferLibraryFromPath(itemPath) {
  if (!itemPath) return null;
  const normalized = itemPath.toLowerCase();
  const tvMarkers = [
    "/tv/",
    "/tv 4k/",
    "/tv4k/",
    "/tv-4k/",
    "/tv_4k/",
    "/series/",
    "/shows/",
    "/television/",
  ];
  const movieMarkers = [
    "/movies/",
    "/movies 4k/",
    "/movies4k/",
    "/movies-4k/",
    "/movies_4k/",
    "/movie/",
    "/movie-4k/",
    "/movie_4k/",
    "/films/",
    "/film/",
  ];
  const isTv = tvMarkers.some((marker) => normalized.includes(marker));
  const isMovie = movieMarkers.some((marker) => normalized.includes(marker));
  const is4k =
    normalized.includes("/4k/") ||
    normalized.includes("/uhd/") ||
    normalized.includes("2160") ||
    normalized.includes("movies-4k") ||
    normalized.includes("tv-4k") ||
    normalized.includes("movies_4k") ||
    normalized.includes("tv_4k");
  if (!isTv && !isMovie) return null;
  if (is4k) return isTv ? "TV 4K" : "Movies 4K";
  return isTv ? "TV" : "Movies";
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

async function fetchSeriesQuality(server, seriesId) {
  const params = new URLSearchParams({
    ParentId: seriesId,
    IncludeItemTypes: "Episode",
    Recursive: "true",
    Limit: "1",
    Fields: "MediaStreams,Path",
  });
  const url = `${getEmbyBase(server.url)}/Items?${params.toString()}`;
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

async function resolveLibraries(server, items, mediaFolders) {
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
    const fetched = await fetchItemsByIds(server, batch);
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
    let currentId = rootId;
    let hops = 0;
    let libraryName = null;
    while (currentId && hops < 5) {
      const node = idToItem.get(currentId);
      if (!node) break;
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

  items.forEach((item) => {
    if (libraryMap.get(item.Id)) return;
    const inferred = inferLibraryFromPath(item.Path);
    if (inferred) {
      libraryMap.set(item.Id, inferred);
    }
  });

  const unresolved = items.filter((item) => !libraryMap.get(item.Id));
  if (unresolved.length) {
    await Promise.all(
      unresolved.map(async (item) => {
        const ancestors = await fetchAncestors(server, item.Id);
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
  const mediaFolders = await fetchMediaFolders(server);
  const libraryMap = await resolveLibraries(server, filtered, mediaFolders);
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
        quality = await fetchSeriesQuality(server, item.Id);
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

  if (url.pathname === "/api/servers") {
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
        const mediaFolders = await fetchMediaFolders({
          url: row.url,
          apiKey: row.api_key,
        });
        const debug = await Promise.all(
          items.map(async (item) => {
            const ancestors = await fetchAncestors(
              { url: row.url, apiKey: row.api_key },
              item.id
            );
            return {
              id: item.id,
              name: item.name,
              type: item.type,
              year: item.year,
              library: item.library,
              quality: item.quality,
              path: item.path || null,
              ancestors: ancestors.map((ancestor) => ({
                id: ancestor.Id,
                name: ancestor.Name,
                type: ancestor.Type,
                collectionType: ancestor.CollectionType || null,
              })),
            };
          })
        );
        json(res, 200, { server: row.name, mediaFolders, items: debug });
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
