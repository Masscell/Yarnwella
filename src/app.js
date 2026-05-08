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
  cryptoLocked: false,
  privacyModalOpen: false
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

function normalizeUsername(value) {
  return String(value ?? "").trim().toLowerCase();
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

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
  } catch (error) {
    const requestError = new Error("Could not reach the YarnWella server. Check your connection and try again.");
    requestError.cause = error;
    requestError.isNetworkError = true;
    throw requestError;
  }

  if (response.status === 401 && state.auth?.refreshToken && !options.skipRefresh) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return request(path, { ...options, skipRefresh: true });
  }

  if (!response.ok) {
    let details = "";
    try {
      const errorBody = await response.json();
      if (typeof errorBody.detail === "string") {
        details = errorBody.detail;
      } else if (errorBody.detail) {
        details = JSON.stringify(errorBody.detail);
      }
    } catch {
      details = await response.text();
    }
    const error = new Error(details || `Request failed with ${response.status}`);
    error.status = response.status;
    throw error;
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
    if (form.password !== form.confirmPassword) {
      throw new Error("Passwords do not match");
    }
    const keys = await generateAccountKeys(form.password);
    const username = normalizeUsername(form.username);
    const response = await request("/auth/register", {
      method: "POST",
      body: {
        username,
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
    const enteredUsername = String(form.username ?? "").trim();
    const normalizedUsername = normalizeUsername(enteredUsername);
    let response;

    try {
      response = await request("/auth/login", {
        method: "POST",
        body: {
          username: enteredUsername,
          password: form.password
        },
        skipRefresh: true
      });
    } catch (error) {
      if (error.status !== 401 || enteredUsername === normalizedUsername) throw error;
      response = await request("/auth/login", {
        method: "POST",
        body: {
          username: normalizedUsername,
          password: form.password
        },
        skipRefresh: true
      });
    }

    const privateKey = await unwrapPrivateKey(
      form.password,
      response.user.wrapped_private_key,
      response.user.pbkdf2_salt
    );
    await applyAuth(response, privateKey);
    await bootAuthenticated();
  } catch (error) {
    const message = error.status === 401
      ? "Invalid username or password. Use the username you created, not your display name."
      : error.status >= 500 || error.isNetworkError
        ? "Login server is unavailable right now. Please check your connection and try again."
        : error.message || "Login failed";
    setBanner(message, "error");
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
      <section class="auth-panel" aria-label="Authentication">
        ${renderBanner()}
        <form id="login-form" class="auth-form">
          <div class="auth-heading">
            <img class="brand-logo" src="./public/logo.png" alt="YarnWella logo" />
            <h1>Log in</h1>
            <p>Enter your username and password to securely access your encrypted messages.</p>
          </div>
          <label>Username<input name="username" autocomplete="username" placeholder="Username" required /></label>
          <label class="password-field">Password<input name="password" id="login-password" type="password" autocomplete="current-password" placeholder="Enter your password" required /><button type="button" class="toggle-password" data-target="login-password" aria-label="Toggle password visibility"><svg class="eye-icon" viewBox="0 0 24 24" width="20" height="20"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zm0 12.5c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" fill="currentColor"/></svg></button></label>
          <button class="primary" type="submit" ${state.loading ? "disabled" : ""}>${state.loading ? "Signing in..." : "Login"}</button>
          <p class="auth-switch">Don't have an account? <button class="text-link" type="button" data-auth-tab="register">Sign Up here</button></p>
        </form>
        <form id="register-form" class="auth-form hidden">
          <div class="auth-heading">
            <img class="brand-logo" src="./public/logo.png" alt="YarnWella logo" />
            <h1>Sign up</h1>
            <p>Create your private account. Your encryption keys are generated in this browser.</p>
          </div>
          <label>Full Name<input name="displayName" autocomplete="name" minlength="1" maxlength="128" placeholder="Your full name" required /></label>
          <label>Username<input name="username" autocomplete="username" minlength="3" maxlength="32" placeholder="Choose a username" required /></label>
          <label class="password-field">Password<input name="password" id="register-password" type="password" autocomplete="new-password" minlength="8" maxlength="128" placeholder="Create a strong password" required /><button type="button" class="toggle-password" data-target="register-password" aria-label="Toggle password visibility"><svg class="eye-icon" viewBox="0 0 24 24" width="20" height="20"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zm0 12.5c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" fill="currentColor"/></svg></button></label>
          <label class="password-field">Confirm Password<input name="confirmPassword" id="register-confirm" type="password" autocomplete="new-password" minlength="8" maxlength="128" placeholder="Confirm your password" required /><button type="button" class="toggle-password" data-target="register-confirm" aria-label="Toggle password visibility"><svg class="eye-icon" viewBox="0 0 24 24" width="20" height="20"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zm0 12.5c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" fill="currentColor"/></svg></button></label>
          <button class="primary" type="submit" ${state.loading ? "disabled" : ""}>${state.loading ? "Creating account..." : "Create Account"}</button>
          <p class="auth-switch">Already have an account? <button class="text-link" type="button" data-auth-tab="login">Log in here</button></p>
        </form>
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
        <div class="signed-in-brand">
          <img class="app-logo" src="./public/logo.png" alt="" aria-hidden="true" />
          <div>
            <p class="eyebrow">Signed in</p>
            <h2>${escapeHtml(state.auth.user.display_name)}</h2>
          </div>
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
  const privacyNotice = `
    <p class="privacy-notice">
      End-to-end encryption keeps your personal messages and calls between you and the people you choose.
      No one outside of the chat, not even YarnWella can read, listen to, or share them.
      <button class="inline-link" type="button" data-action="open-privacy-modal">Read more</button>
    </p>
  `;

  if (!state.activeUser) {
    return `
      <section class="chat-empty">
        <img class="empty-logo" src="./public/logo.png" alt="" aria-hidden="true" />
        <h2>Choose a conversation</h2>
        ${privacyNotice}
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
      </header>
      <div class="messages" id="messages">
        ${messages.join("") || `<div class="empty-state new-chat-notice">${privacyNotice}</div>`}
      </div>
      <form id="composer-form" class="composer">
        <textarea id="composer" placeholder="Type a message" rows="1">${escapeHtml(state.composer)}</textarea>
        <button class="primary send" type="submit" ${state.composer.trim() ? "" : "disabled"}>Send</button>
      </form>
    </section>
  `;
}

function privacyIcon(path) {
  return `
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
      <path d="${path}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
  `;
}

function renderPrivacyModal() {
  if (!state.privacyModalOpen) return "";
  const items = [
    ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z M8 8h8 M8 12h6", "Text and voice messages"],
    ["M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.11 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.77.62 2.61a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.47-1.19a2 2 0 0 1 2.11-.45c.84.29 1.71.5 2.61.62A2 2 0 0 1 22 16.92z", "Audio and video calls"],
    ["M4 4h16v16H4z M8 16l3-3 2 2 3-4 4 5 M8 8h.01 M2 8v14h14", "Photos, videos and documents"],
    ["M21 10c0 7-9 12-9 12S3 17 3 10a9 9 0 1 1 18 0z M12 10h.01", "Location sharing"],
    ["M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z M4.93 4.93l2.12 2.12 M16.95 16.95l2.12 2.12 M19.07 4.93l-2.12 2.12 M7.05 16.95l-2.12 2.12", "Status updates"]
  ];

  return `
    <div class="modal-backdrop" role="presentation">
      <section class="privacy-modal" role="dialog" aria-modal="true" aria-labelledby="privacy-title">
        <button class="modal-close" type="button" data-action="close-privacy-modal" aria-label="Close">x</button>
        <svg class="privacy-illustration" viewBox="0 0 280 150" aria-hidden="true">
          <circle cx="86" cy="74" r="40" fill="#fffaf0" stroke="#111827" stroke-width="3"/>
          <path d="M62 59l53 33M116 58L63 92" stroke="#111827" stroke-width="6" stroke-linecap="round"/>
          <rect x="104" y="50" width="92" height="66" rx="18" fill="#dcfce7" stroke="#111827" stroke-width="3"/>
          <path d="M126 50V32a24 24 0 0 1 48 0v18" fill="none" stroke="#111827" stroke-width="4"/>
          <circle cx="150" cy="76" r="10" fill="#dcfce7" stroke="#111827" stroke-width="3"/>
          <path d="M150 86l-12 26h24z" fill="#dcfce7" stroke="#111827" stroke-width="3"/>
          <circle cx="203" cy="71" r="43" fill="#25d366" stroke="#111827" stroke-width="3"/>
          <path d="M189 78l22-22" stroke="#111827" stroke-width="5" stroke-linecap="round"/>
          <circle cx="221" cy="43" r="2.5" fill="#111827"/>
          <circle cx="234" cy="65" r="2.5" fill="#111827"/>
          <circle cx="228" cy="90" r="2.5" fill="#111827"/>
          <rect x="173" y="116" width="89" height="16" rx="8" fill="#f9fafb" stroke="#111827" stroke-width="3"/>
          <rect x="173" y="116" width="50" height="16" rx="8" fill="#25d366" stroke="#111827" stroke-width="3"/>
          <circle cx="224" cy="124" r="16" fill="#25d366" stroke="#111827" stroke-width="3"/>
        </svg>
        <h2 id="privacy-title">Your chats and calls are private</h2>
        <p class="privacy-copy">End-to-end encryption keeps your personal messages and calls between you and the people you choose. No one outside of the chat, not even YarnWella, can read, listen to, or share them. This includes your:</p>
        <ul class="privacy-list">
          ${items.map(([icon, label]) => `<li>${privacyIcon(icon)}<span>${label}</span></li>`).join("")}
        </ul>
      </section>
    </div>
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
    ${renderPrivacyModal()}
  `;
}

function render() {
  const activeElement = document.activeElement;
  const restoreSearchFocus = activeElement?.id === "user-search";
  const searchSelectionStart = restoreSearchFocus ? activeElement.selectionStart : null;
  const searchSelectionEnd = restoreSearchFocus ? activeElement.selectionEnd : null;

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

  if (restoreSearchFocus) {
    requestAnimationFrame(() => {
      const searchInput = document.querySelector("#user-search");
      if (!searchInput) return;
      searchInput.focus();
      if (searchSelectionStart !== null && searchSelectionEnd !== null) {
        searchInput.setSelectionRange(searchSelectionStart, searchSelectionEnd);
      }
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

  // Handle password visibility toggle
  if (target.classList.contains("toggle-password")) {
    event.preventDefault();
    const targetId = target.dataset.target;
    const input = document.querySelector(`#${targetId}`);
    if (input) {
      input.type = input.type === "password" ? "text" : "password";
      target.classList.toggle("active");
    }
    return;
  }

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

  if (target.dataset.action === "open-privacy-modal") {
    state.privacyModalOpen = true;
    render();
    return;
  }

  if (target.dataset.action === "close-privacy-modal") {
    state.privacyModalOpen = false;
    render();
    return;
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
    state.searchQuery = target.value;
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
