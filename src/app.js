const API_BASE = "https://whisperbox.koyeb.app";
const WS_BASE = "wss://whisperbox.koyeb.app/ws";
const DB_NAME = "yarnwella-secure-store";
const DB_VERSION = 1;
const STORE_NAME = "vault";
const TOKEN_SKEW_MS = 30_000;

const app = document.querySelector("#app");

const state = {
  auth: null,
  privateKey: null,
  publicKey: null,
  conversations: [],
  activeUser: null,
  messages: new Map(),
  users: [],
  socket: null,
  socketStatus: "offline",
  refreshTimer: null,
  loading: false,
  banner: null,
  composer: "",
  searchQuery: "",
  searchLoading: false,
  cryptoLocked: false
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric"
  }).format(date);
}

function sortByCreatedAt(messages) {
  return [...messages].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function uniqueById(items) {
  const seen = new Map();
  for (const item of items) seen.set(item.id, item);
  return [...seen.values()];
}

function setBanner(message, tone = "info") {
  state.banner = message ? { message, tone } : null;
  render();
}

function getConversationKey(userId) {
  return `thread:${userId}`;
}

function getPartnerId(message) {
  return message.from_user_id === state.auth?.user.id ? message.to_user_id : message.from_user_id;
}

function currentThread() {
  if (!state.activeUser) return [];
  return state.messages.get(getConversationKey(state.activeUser.id)) || [];
}

async function openVault() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function vaultGet(key) {
  const db = await openVault();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

async function vaultSet(key, value) {
  const db = await openVault();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function vaultDelete(key) {
  const db = await openVault();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function deriveWrappingKey(password, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 310_000,
      hash: "SHA-256"
    },
    keyMaterial,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt", "decrypt"]
  );
}

async function generateAccountKeys(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 4096,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["encrypt", "decrypt"]
  );

  const publicKey = await crypto.subtle.exportKey("spki", keyPair.publicKey);
  const privateKey = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const wrappingKey = await deriveWrappingKey(password, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrappedPrivateKey = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    wrappingKey,
    privateKey
  );
  // Combine IV + ciphertext
  const ciphertext = new Uint8Array(wrappedPrivateKey);
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv);
  combined.set(ciphertext, iv.length);
  const privateKeyForUse = await crypto.subtle.importKey(
    "pkcs8",
    privateKey,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"]
  );

  return {
    publicKey: keyPair.publicKey,
    privateKey: privateKeyForUse,
    public_key: bytesToBase64(publicKey),
    wrapped_private_key: bytesToBase64(combined),
    pbkdf2_salt: bytesToBase64(salt)
  };
}

async function unwrapPrivateKey(password, wrappedPrivateKey, salt) {
  const wrappingKey = await deriveWrappingKey(password, base64ToBytes(salt));
  const combined = base64ToBytes(wrappedPrivateKey);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const privateKeyBytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    wrappingKey,
    ciphertext
  );
  return crypto.subtle.importKey(
    "pkcs8",
    privateKeyBytes,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"]
  );
}

async function importPublicKey(publicKey) {
  return crypto.subtle.importKey(
    "spki",
    base64ToBytes(publicKey),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"]
  );
}

async function encryptForRecipient(plaintext, recipientPublicKeyBase64, senderPublicKeyBase64) {
  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    enc.encode(plaintext)
  );
  const rawKey = await crypto.subtle.exportKey("raw", aesKey);
  const recipientPublicKey = await importPublicKey(recipientPublicKeyBase64);
  const senderPublicKey = await importPublicKey(senderPublicKeyBase64);
  const encryptedKey = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, recipientPublicKey, rawKey);
  const encryptedKeyForSelf = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, senderPublicKey, rawKey);

  return {
    ciphertext: bytesToBase64(ciphertext),
    iv: bytesToBase64(iv),
    encryptedKey: bytesToBase64(encryptedKey),
    encryptedKeyForSelf: bytesToBase64(encryptedKeyForSelf)
  };
}

async function decryptPayload(message) {
  const payload = message.payload || {};
  const keyBlob =
    message.from_user_id === state.auth?.user.id ? payload.encryptedKeyForSelf : payload.encryptedKey;

  if (!keyBlob || !payload.ciphertext || !payload.iv) {
    throw new Error("Encrypted payload is incomplete");
  }

  const rawAesKey = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    state.privateKey,
    base64ToBytes(keyBlob)
  );
  const aesKey = await crypto.subtle.importKey(
    "raw",
    rawAesKey,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(payload.iv) },
    aesKey,
    base64ToBytes(payload.ciphertext)
  );

  return dec.decode(plaintext);
}

async function hydrateMessage(message) {
  try {
    return {
      ...message,
      plaintext: await decryptPayload(message),
      decryptError: null
    };
  } catch (error) {
    return {
      ...message,
      plaintext: "",
      decryptError: error.message || "Unable to decrypt message"
    };
  }
}

async function request(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...options.headers
  };

  if (state.auth?.accessToken) {
    headers.Authorization = `Bearer ${state.auth.accessToken}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (response.status === 401 && state.auth?.refreshToken && !options.skipRefresh) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return request(path, { ...options, skipRefresh: true });
  }

  if (!response.ok) {
    let details = "";
    try {
      const errorBody = await response.json();
      details = errorBody.detail ? JSON.stringify(errorBody.detail) : "";
    } catch {
      details = await response.text();
    }
    throw new Error(details || `Request failed with ${response.status}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function saveSession(auth) {
  await vaultSet("session", {
    refreshToken: auth.refreshToken,
    user: auth.user,
    expiresAt: auth.expiresAt
  });
  sessionStorage.setItem("yarnwella_access", auth.accessToken);
}

async function applyAuth(response, privateKey) {
  state.auth = {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: Date.now() + response.expires_in * 1000,
    user: response.user
  };
  state.privateKey = privateKey;
  state.publicKey = await importPublicKey(response.user.public_key);
  state.cryptoLocked = false;
  await saveSession(state.auth);
  scheduleRefresh();
}

async function refreshAccessToken() {
  if (!state.auth?.refreshToken) return false;

  try {
    const response = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: state.auth.refreshToken })
    });
    if (!response.ok) throw new Error("Refresh failed");
    const token = await response.json();
    state.auth.accessToken = token.access_token;
    state.auth.expiresAt = Date.now() + token.expires_in * 1000;
    sessionStorage.setItem("yarnwella_access", token.access_token);
    await saveSession(state.auth);
    scheduleRefresh();
    reconnectSocket();
    return true;
  } catch {
    await clearSession();
    setBanner("Session expired. Sign in again to unlock your messages.", "warning");
    return false;
  }
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  if (!state.auth?.expiresAt) return;
  const delay = Math.max(5_000, state.auth.expiresAt - Date.now() - TOKEN_SKEW_MS);
  state.refreshTimer = setTimeout(refreshAccessToken, delay);
}

async function register(form) {
  state.loading = true;
  render();

  try {
    const keys = await generateAccountKeys(form.password);
    const response = await request("/auth/register", {
      method: "POST",
      body: {
        username: form.username.trim(),
        display_name: form.displayName.trim(),
        password: form.password,
        public_key: keys.public_key,
        wrapped_private_key: keys.wrapped_private_key,
        pbkdf2_salt: keys.pbkdf2_salt
      },
      skipRefresh: true
    });
    await applyAuth(response, keys.privateKey);
    setBanner("Account created. Messages now leave this browser encrypted.", "success");
    await bootAuthenticated();
  } catch (error) {
    setBanner(error.message || "Registration failed", "error");
  } finally {
    state.loading = false;
    render();
  }
}

async function login(form) {
  state.loading = true;
  render();

  try {
    const response = await request("/auth/login", {
      method: "POST",
      body: {
        username: form.username.trim(),
        password: form.password
      },
      skipRefresh: true
    });
    const privateKey = await unwrapPrivateKey(
      form.password,
      response.user.wrapped_private_key,
      response.user.pbkdf2_salt
    );
    await applyAuth(response, privateKey);
    setBanner("Signed in. Your private key was unwrapped locally.", "success");
    await bootAuthenticated();
  } catch (error) {
    setBanner(error.message || "Login failed", "error");
  } finally {
    state.loading = false;
    render();
  }
}

async function unlockWithPassword(password) {
  if (!state.auth?.user) return;
  state.loading = true;
  render();

  try {
    state.privateKey = await unwrapPrivateKey(
      password,
      state.auth.user.wrapped_private_key,
      state.auth.user.pbkdf2_salt
    );
    state.cryptoLocked = false;
    setBanner("Message vault unlocked for this session.", "success");
    await bootAuthenticated();
  } catch {
    setBanner("That password could not unlock the local key vault.", "error");
  } finally {
    state.loading = false;
    render();
  }
}

async function restoreSession() {
  const saved = await vaultGet("session");
  const accessToken = sessionStorage.getItem("yarnwella_access");
  if (!saved?.refreshToken || !saved?.user) return false;

  state.auth = {
    accessToken,
    refreshToken: saved.refreshToken,
    expiresAt: saved.expiresAt || 0,
    user: saved.user
  };
  state.cryptoLocked = true;

  if (!accessToken || Date.now() > (saved.expiresAt || 0) - TOKEN_SKEW_MS) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) return false;
  } else {
    scheduleRefresh();
  }

  return true;
}

async function clearSession() {
  disconnectSocket();
  clearTimeout(state.refreshTimer);
  state.auth = null;
  state.privateKey = null;
  state.publicKey = null;
  state.conversations = [];
  state.activeUser = null;
  state.messages.clear();
  state.cryptoLocked = false;
  sessionStorage.removeItem("yarnwella_access");
  await vaultDelete("session");
  render();
}

async function logout() {
  try {
    if (state.auth?.refreshToken) {
      await request("/auth/logout", {
        method: "POST",
        body: { refresh_token: state.auth.refreshToken }
      });
    }
  } catch {
    // Local logout still clears sensitive in-memory keys if the network is unavailable.
  }
  await clearSession();
  setBanner("Logged out. Plaintext keys were cleared from memory.", "info");
}

async function loadConversations() {
  const conversations = await request("/conversations");
  state.conversations = conversations;
}

async function loadMessages(user) {
  state.activeUser = user;
  render();

  try {
    const history = await request(`/conversations/${user.id}/messages?limit=50`);
    const hydrated = await Promise.all(history.map(hydrateMessage));
    state.messages.set(getConversationKey(user.id), sortByCreatedAt(hydrated));
  } catch (error) {
    setBanner(error.message || "Could not load conversation", "error");
  }
  render();
}

async function searchUsers(query) {
  state.searchQuery = query;
  if (!query.trim()) {
    state.users = [];
    render();
    return;
  }

  state.searchLoading = true;
  render();
  try {
    state.users = await request(`/users/search?q=${encodeURIComponent(query.trim())}`);
  } catch (error) {
    setBanner(error.message || "Search failed", "error");
  } finally {
    state.searchLoading = false;
    render();
  }
}

async function startConversation(user) {
  const summary = {
    user_id: user.id,
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    last_message_at: null
  };
  state.activeUser = {
    id: user.id,
    username: user.username,
    display_name: user.display_name
  };
  state.conversations = uniqueById([
    {
      ...summary,
      id: user.id
    },
    ...state.conversations.map((conversation) => ({
      ...conversation,
      id: conversation.user_id
    }))
  ]);
  state.users = [];
  state.searchQuery = "";
  await loadMessages(state.activeUser);
}

async function sendMessage() {
  const text = state.composer.trim();
  if (!text || !state.activeUser || !state.auth || state.cryptoLocked) return;

  state.composer = "";
  render();

  try {
    const publicKeyResponse = await request(`/users/${state.activeUser.id}/public-key`);
    const payload = await encryptForRecipient(
      text,
      publicKeyResponse.public_key,
      state.auth.user.public_key
    );
    const outgoing = {
      to: state.activeUser.id,
      payload
    };

    let stored = null;
    if (state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ type: "message.send", ...outgoing }));
    } else {
      stored = await request("/messages", {
        method: "POST",
        body: outgoing
      });
    }

    const optimistic = stored || {
      id: crypto.randomUUID(),
      from_user_id: state.auth.user.id,
      to_user_id: state.activeUser.id,
      payload,
      delivered: state.socket?.readyState === WebSocket.OPEN,
      created_at: new Date().toISOString()
    };
    await addIncomingMessage(optimistic);
  } catch (error) {
    state.composer = text;
    setBanner(error.message || "Message failed to send", "error");
  }
  render();
}

async function addIncomingMessage(message) {
  const partnerId = getPartnerId(message);
  const hydrated = await hydrateMessage(message);
  const key = getConversationKey(partnerId);
  const thread = state.messages.get(key) || [];
  state.messages.set(key, sortByCreatedAt(uniqueById([...thread, hydrated])));

  if (!state.conversations.some((conversation) => conversation.user_id === partnerId)) {
    state.conversations.unshift({
      user_id: partnerId,
      display_name: partnerId === state.activeUser?.id ? state.activeUser.display_name : "Encrypted contact",
      username: partnerId === state.activeUser?.id ? state.activeUser.username : "unknown",
      last_message_at: message.created_at
    });
  } else {
    state.conversations = state.conversations.map((conversation) =>
      conversation.user_id === partnerId
        ? { ...conversation, last_message_at: message.created_at }
        : conversation
    );
  }
}

function parseSocketMessage(event) {
  try {
    const frame = JSON.parse(event.data);
    if (frame.type === "message.receive" && frame.message) return frame.message;
    if (frame.type === "message.receive") return frame;
    if (frame.payload && frame.from_user_id) return frame;
    return null;
  } catch {
    return null;
  }
}

function connectSocket() {
  if (!state.auth?.accessToken || state.cryptoLocked) return;
  disconnectSocket();

  const socket = new WebSocket(`${WS_BASE}?token=${encodeURIComponent(state.auth.accessToken)}`);
  state.socket = socket;
  state.socketStatus = "connecting";
  render();

  socket.addEventListener("open", () => {
    state.socketStatus = "online";
    render();
  });

  socket.addEventListener("message", async (event) => {
    const message = parseSocketMessage(event);
    if (message) {
      await addIncomingMessage(message);
      render();
    }
  });

  socket.addEventListener("close", () => {
    if (state.socket === socket) {
      state.socketStatus = "offline";
      render();
      if (state.auth && !state.cryptoLocked) {
        setTimeout(() => {
          if (state.auth && state.socketStatus === "offline") connectSocket();
        }, 4_000);
      }
    }
  });

  socket.addEventListener("error", () => {
    state.socketStatus = "offline";
    render();
  });
}

function disconnectSocket() {
  if (state.socket) {
    state.socket.onclose = null;
    state.socket.close();
  }
  state.socket = null;
  state.socketStatus = "offline";
}

function reconnectSocket() {
  if (state.auth && !state.cryptoLocked) connectSocket();
}

async function bootAuthenticated() {
  if (!state.privateKey) {
    state.cryptoLocked = true;
    render();
    return;
  }

  try {
    await loadConversations();
  } catch (error) {
    setBanner(error.message || "Could not load conversations", "error");
  }
  connectSocket();
  render();
}

function renderBanner() {
  if (!state.banner) return "";
  return `
    <div class="banner ${state.banner.tone}" role="status">
      <span>${escapeHtml(state.banner.message)}</span>
      <button type="button" data-action="dismiss-banner" aria-label="Dismiss">x</button>
    </div>
  `;
}

function renderAuth() {
  return `
    <main class="auth-screen">
      <section class="brand-panel">
        <div class="brand-mark" aria-hidden="true">
          <span></span>
          <span></span>
          <span></span>
        </div>
        <p class="eyebrow">Zero-knowledge messaging</p>
        <h1>YarnWella</h1>
        <p class="lede">Private conversations encrypted before they leave your browser, built against the WhisperBox E2EE backend.</p>
        <div class="trust-grid" aria-label="Security properties">
          <div><strong>AES-GCM</strong><span>Per-message encryption</span></div>
          <div><strong>RSA-OAEP</strong><span>Recipient key wrapping</span></div>
          <div><strong>PBKDF2</strong><span>Local private-key vault</span></div>
        </div>
      </section>
      <section class="auth-panel" aria-label="Authentication">
        ${renderBanner()}
        <div class="tabs" role="tablist">
          <button class="tab active" type="button" data-auth-tab="login">Sign in</button>
          <button class="tab" type="button" data-auth-tab="register">Create account</button>
        </div>
        <form id="login-form" class="auth-form">
          <label>Username<input name="username" autocomplete="username" required /></label>
          <label>Password<input name="password" type="password" autocomplete="current-password" required /></label>
          <button class="primary" type="submit" ${state.loading ? "disabled" : ""}>${state.loading ? "Unlocking..." : "Sign in securely"}</button>
        </form>
        <form id="register-form" class="auth-form hidden">
          <label>Display name<input name="displayName" autocomplete="name" minlength="1" maxlength="128" required /></label>
          <label>Username<input name="username" autocomplete="username" minlength="3" maxlength="32" required /></label>
          <label>Password<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required /></label>
          <button class="primary" type="submit" ${state.loading ? "disabled" : ""}>${state.loading ? "Generating keys..." : "Create encrypted account"}</button>
        </form>
        <p class="fine-print">Private keys are generated locally and stored only as wrapped encrypted key material.</p>
      </section>
    </main>
  `;
}

function renderLocked() {
  return `
    <main class="locked-screen">
      <section class="unlock-panel">
        ${renderBanner()}
        <p class="eyebrow">Session restored</p>
        <h1>Unlock YarnWella</h1>
        <p>Your refresh token restored the session, but your private key still needs your password before messages can be decrypted.</p>
        <form id="unlock-form" class="auth-form">
          <label>Password<input name="password" type="password" autocomplete="current-password" required /></label>
          <button class="primary" type="submit" ${state.loading ? "disabled" : ""}>${state.loading ? "Unlocking..." : "Unlock messages"}</button>
        </form>
        <button class="ghost wide" type="button" data-action="logout">Use a different account</button>
      </section>
    </main>
  `;
}

function renderConversations() {
  const conversations = state.conversations.map((conversation) => {
    const id = conversation.user_id;
    const active = state.activeUser?.id === id ? "active" : "";
    return `
      <button class="conversation ${active}" type="button" data-open-user="${escapeHtml(id)}">
        <span class="avatar">${escapeHtml((conversation.display_name || conversation.username || "?").slice(0, 1).toUpperCase())}</span>
        <span class="conversation-meta">
          <strong>${escapeHtml(conversation.display_name)}</strong>
          <small>@${escapeHtml(conversation.username)} · ${formatTime(conversation.last_message_at) || "No messages yet"}</small>
        </span>
        <span class="lock" title="End-to-end encrypted">lock</span>
      </button>
    `;
  });

  const results = state.users.map((user) => `
    <button class="search-result" type="button" data-start-user="${escapeHtml(user.id)}">
      <span class="avatar">${escapeHtml((user.display_name || user.username || "?").slice(0, 1).toUpperCase())}</span>
      <span><strong>${escapeHtml(user.display_name)}</strong><small>@${escapeHtml(user.username)}</small></span>
    </button>
  `);

  return `
    <aside class="sidebar">
      <div class="sidebar-head">
        <div>
          <p class="eyebrow">Signed in</p>
          <h2>${escapeHtml(state.auth.user.display_name)}</h2>
        </div>
        <button class="icon-button" type="button" data-action="logout" title="Log out" aria-label="Log out">out</button>
      </div>
      <label class="search-box">
        <span>Search users</span>
        <input id="user-search" value="${escapeHtml(state.searchQuery)}" placeholder="Name or username" autocomplete="off" />
      </label>
      <div class="search-results">
        ${state.searchLoading ? '<div class="empty-state compact">Searching...</div>' : results.join("")}
      </div>
      <div class="conversation-list">
        ${conversations.join("") || '<div class="empty-state">Search for someone to start an encrypted thread.</div>'}
      </div>
    </aside>
  `;
}

function renderMessages() {
  if (!state.activeUser) {
    return `
      <section class="chat-empty">
        <div class="encryption-orbit" aria-hidden="true">
          <span></span><span></span><span></span>
        </div>
        <h2>Choose a conversation</h2>
        <p>YarnWella encrypts every message locally with AES-GCM, then wraps the message key for the intended recipient.</p>
      </section>
    `;
  }

  const messages = currentThread().map((message) => {
    const mine = message.from_user_id === state.auth.user.id ? "mine" : "theirs";
    return `
      <article class="message ${mine}">
        <div class="bubble ${message.decryptError ? "failed" : ""}">
          <p>${message.decryptError ? "Unable to decrypt this message." : escapeHtml(message.plaintext)}</p>
          <footer>
            <span title="End-to-end encrypted">lock</span>
            <time>${formatTime(message.created_at)}</time>
            ${message.delivered ? "<small>delivered</small>" : "<small>queued</small>"}
          </footer>
        </div>
      </article>
    `;
  });

  return `
    <section class="chat-panel">
      <header class="chat-head">
        <div class="avatar large">${escapeHtml((state.activeUser.display_name || state.activeUser.username || "?").slice(0, 1).toUpperCase())}</div>
        <div>
          <h2>${escapeHtml(state.activeUser.display_name)}</h2>
          <p>@${escapeHtml(state.activeUser.username)} · <span class="status ${state.socketStatus}">${state.socketStatus}</span></p>
        </div>
        <span class="secure-pill">lock E2EE</span>
      </header>
      <div class="messages" id="messages">
        ${messages.join("") || '<div class="empty-state">No messages in this thread yet.</div>'}
      </div>
      <form id="composer-form" class="composer">
        <textarea id="composer" placeholder="Write an encrypted message" rows="1">${escapeHtml(state.composer)}</textarea>
        <button class="primary send" type="submit" ${state.composer.trim() ? "" : "disabled"}>Send</button>
      </form>
    </section>
  `;
}

function renderApp() {
  return `
    <main class="messenger">
      ${renderConversations()}
      <section class="workspace">
        ${renderBanner()}
        ${renderMessages()}
      </section>
    </main>
  `;
}

function render() {
  if (!state.auth) {
    app.innerHTML = renderAuth();
  } else if (state.cryptoLocked) {
    app.innerHTML = renderLocked();
  } else {
    app.innerHTML = renderApp();
    requestAnimationFrame(() => {
      const messages = document.querySelector("#messages");
      if (messages) messages.scrollTop = messages.scrollHeight;
    });
  }
}

function getFormValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

let searchTimer = null;

app.addEventListener("submit", async (event) => {
  event.preventDefault();
  const target = event.target;
  if (!(target instanceof HTMLFormElement)) return;

  if (target.id === "login-form") await login(getFormValues(target));
  if (target.id === "register-form") await register(getFormValues(target));
  if (target.id === "unlock-form") {
    const values = getFormValues(target);
    await unlockWithPassword(values.password);
  }
  if (target.id === "composer-form") await sendMessage();
});

app.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;

  if (target.dataset.authTab) {
    const loginForm = document.querySelector("#login-form");
    const registerForm = document.querySelector("#register-form");
    document.querySelectorAll("[data-auth-tab]").forEach((tab) => tab.classList.remove("active"));
    target.classList.add("active");
    loginForm.classList.toggle("hidden", target.dataset.authTab !== "login");
    registerForm.classList.toggle("hidden", target.dataset.authTab !== "register");
  }

  if (target.dataset.action === "dismiss-banner") {
    state.banner = null;
    render();
  }

  if (target.dataset.action === "logout") await logout();

  if (target.dataset.openUser) {
    const conversation = state.conversations.find((item) => item.user_id === target.dataset.openUser);
    if (conversation) {
      await loadMessages({
        id: conversation.user_id,
        display_name: conversation.display_name,
        username: conversation.username
      });
    }
  }

  if (target.dataset.startUser) {
    const user = state.users.find((item) => item.id === target.dataset.startUser);
    if (user) await startConversation(user);
  }
});

app.addEventListener("input", (event) => {
  const target = event.target;

  if (target?.id === "user-search") {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => searchUsers(target.value), 250);
  }

  if (target?.id === "composer") {
    state.composer = target.value;
    const button = document.querySelector(".composer .send");
    if (button) button.disabled = !state.composer.trim();
    target.style.height = "auto";
    target.style.height = `${Math.min(target.scrollHeight, 160)}px`;
  }
});

async function main() {
  if (!window.isSecureContext) {
    setBanner("Web Crypto requires HTTPS or localhost. Start YarnWella with npm run dev.", "error");
  }
  render();

  try {
    const restored = await restoreSession();
    if (restored) render();
  } catch {
    await clearSession();
  }
}

main();
