const form = document.getElementById("search-form");
const resultsGrid = document.getElementById("results-grid");
const resultsMeta = document.getElementById("results-meta");
const serverList = document.getElementById("server-list");
const addServerButton = document.getElementById("add-server");
const serversStatus = document.getElementById("servers-status");
const tabSearch = document.getElementById("tab-search");
const tabSettings = document.getElementById("tab-settings");
const serversPanel = document.getElementById("servers-panel");
const resultsPanel = document.getElementById("results-panel");

let servers = [];

async function searchProxy(query, type) {
  const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&type=${type}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Proxy search failed");
  }
  return response.json();
}

async function fetchServers() {
  const response = await fetch("/api/servers");
  if (!response.ok) {
    throw new Error("Failed to load servers");
  }
  const payload = await response.json();
  return Array.isArray(payload.servers) ? payload.servers : [];
}

async function saveServer(server) {
  const payload = {
    name: server.name,
    url: server.url,
    apiKey: server.apiKey,
    enabled: server.enabled,
  };
  if (server.id) {
    const response = await fetch(`/api/servers/${server.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error("Failed to update server");
    }
    return;
  }
  const response = await fetch("/api/servers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error("Failed to create server");
  }
  const created = await response.json();
  server.id = created.id;
}

async function deleteServer(server) {
  if (!server.id) return;
  const response = await fetch(`/api/servers/${server.id}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error("Failed to delete server");
  }
}

function createServerCard(server, index) {
  const card = document.createElement("div");
  card.className = "server-card";

  const status = document.createElement("p");
  status.className = "server-status";
  status.textContent = server.status || "";

  const nameInput = document.createElement("input");
  nameInput.placeholder = "Name";
  nameInput.value = server.name || "";
  nameInput.addEventListener("input", (event) => {
    servers[index].name = event.target.value;
  });

  const urlInput = document.createElement("input");
  urlInput.placeholder = "https://emby.example.com/emby";
  urlInput.value = server.url || "";
  urlInput.addEventListener("input", (event) => {
    servers[index].url = event.target.value;
  });

  const keyInput = document.createElement("input");
  keyInput.placeholder = "API key";
  keyInput.type = "password";
  keyInput.value = server.apiKey || "";
  keyInput.addEventListener("input", (event) => {
    servers[index].apiKey = event.target.value;
  });

  const enabledWrap = document.createElement("label");
  enabledWrap.className = "server-enabled";
  const enabledInput = document.createElement("input");
  enabledInput.type = "checkbox";
  enabledInput.checked = server.enabled !== false;
  enabledInput.addEventListener("change", (event) => {
    servers[index].enabled = event.target.checked;
  });
  const enabledText = document.createElement("span");
  enabledText.textContent = "Enabled";
  enabledWrap.append(enabledInput, enabledText);

  const actions = document.createElement("div");
  actions.className = "server-actions";

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.textContent = server.id ? "Save" : "Create";
  saveButton.addEventListener("click", async () => {
    serversStatus.textContent = "Saving...";
    try {
      await saveServer(servers[index]);
      serversStatus.textContent = "Saved.";
      await refreshServers();
    } catch (error) {
      serversStatus.textContent = error instanceof Error ? error.message : "Save failed.";
    }
  });

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "secondary";
  removeButton.textContent = "Remove";
  removeButton.addEventListener("click", async () => {
    serversStatus.textContent = "Removing...";
    try {
      await deleteServer(servers[index]);
      serversStatus.textContent = "Removed.";
      servers.splice(index, 1);
      await refreshServers();
    } catch (error) {
      serversStatus.textContent = error instanceof Error ? error.message : "Remove failed.";
    }
  });

  const testButton = document.createElement("button");
  testButton.type = "button";
  testButton.className = "secondary";
  testButton.textContent = "Test connection";
  testButton.addEventListener("click", async () => {
    if (!servers[index].id) {
      status.textContent = "Save the server before testing.";
      return;
    }
    status.textContent = "Testing connection...";
    try {
      const response = await fetch(`/api/servers/${servers[index].id}/test`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Connection failed.");
      }
      const version = payload.version ? ` (v${payload.version})` : "";
      status.textContent = `Connected to ${payload.name || "Emby"}${version}.`;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Connection failed.";
    }
  });

  actions.append(saveButton, testButton, removeButton);
  card.append(nameInput, urlInput, keyInput, enabledWrap, actions, status);
  return card;
}

function renderServers() {
  serverList.innerHTML = "";
  if (!servers.length) {
    const empty = document.createElement("p");
    empty.className = "servers-empty";
    empty.textContent = "No servers configured yet.";
    serverList.appendChild(empty);
    return;
  }
  servers.forEach((server, index) => {
    serverList.appendChild(createServerCard({ ...server, status: "" }, index));
  });
}

function setActiveTab(tab) {
  const isSettings = tab === "settings";
  tabSearch.classList.toggle("active", !isSettings);
  tabSettings.classList.toggle("active", isSettings);
  serversPanel.hidden = !isSettings;
  form.hidden = isSettings;
  resultsPanel.hidden = isSettings;
}

async function refreshServers() {
  try {
    servers = await fetchServers();
    serversStatus.textContent = servers.length ? "Servers loaded." : "No servers configured yet.";
    renderServers();
  } catch (error) {
    serversStatus.textContent = error instanceof Error ? error.message : "Failed to load servers.";
  }
}

function renderResults(payload) {
  resultsGrid.innerHTML = "";
  const { query, results } = payload;
  const total = results.length;
  const available = results.filter((result) => result.ok && result.matches.length).length;
  resultsMeta.textContent = `Searched ${total} server${total === 1 ? "" : "s"} for "${query}". ${available} had results.`;

  results.forEach((result) => {
    if (!result.ok) {
      const row = document.createElement("tr");
      row.className = "result-row error";
      row.innerHTML = `
        <td>${result.server.name}</td>
        <td colspan="5">${result.error || "Search failed"}</td>
      `;
      resultsGrid.appendChild(row);
      return;
    }
    if (!result.matches.length) {
      const row = document.createElement("tr");
      row.className = "result-row empty";
      row.innerHTML = `
        <td>${result.server.name}</td>
        <td colspan="5">No matches found.</td>
      `;
      resultsGrid.appendChild(row);
      return;
    }
    const seen = new Set();
    result.matches.forEach((item) => {
      const key = [
        result.server.name,
        item.name,
        item.year || "",
        item.quality || "",
        item.library || "",
      ].join("|");
      if (seen.has(key)) return;
      seen.add(key);
      const row = document.createElement("tr");
      row.className = "result-row";
      const year = item.year ? `${item.year}` : "—";
      const quality = item.quality || "—";
      const rating = typeof item.rating === "number" ? item.rating.toFixed(1) : "—";
      row.innerHTML = `
        <td>${result.server.name}</td>
        <td>${item.library || "—"}</td>
        <td>${item.name}</td>
        <td>${year}</td>
        <td>${quality}</td>
        <td>${rating}</td>
      `;
      resultsGrid.appendChild(row);
    });
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(form);
  const query = String(formData.get("query") || "").trim();
  const type = String(formData.get("type") || "all");

  if (!query) return;

  resultsMeta.textContent = "Searching...";
  resultsGrid.innerHTML = "";

  try {
    const payload = await searchProxy(query, type);
    renderResults(payload);
  } catch (error) {
    resultsMeta.textContent = error instanceof Error ? error.message : "Search failed.";
  }
});

addServerButton.addEventListener("click", () => {
  servers.push({ name: "", url: "", apiKey: "", enabled: true });
  serversStatus.textContent = "New server added. Fill details and save.";
  renderServers();
});

tabSearch.addEventListener("click", () => setActiveTab("search"));
tabSettings.addEventListener("click", () => {
  setActiveTab("settings");
  refreshServers();
});

refreshServers();
setActiveTab("search");
