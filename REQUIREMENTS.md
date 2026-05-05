# YarnWella Requirements Verification

This document verifies that YarnWella meets all specified E2EE messaging application requirements.

## 🧠 Core Requirements

### ✅ End-to-End Encryption

**Requirement**: Data is encrypted on the client, server never sees plaintext, only intended users can decrypt

**Implementation**:
- Messages encrypted locally with AES-GCM before any network transmission _(src/app.js line 240-264)_
- Server receives only encrypted ciphertext + IV + wrapped keys _(src/app.js line 603-645)_
- Decryption happens only on recipient device with their private key _(src/app.js line 266-295)_
- Backend is stateless regarding plaintext (no decryption keys stored)

**Verification**:
- Plaintext never appears in network requests (inspect browser DevTools Network tab)
- Message payload is always base64-encoded ciphertext
- Private key is non-extractable CryptoKey

---

## 🔑 Core Concept

### ✅ Client-Side Encryption Before Sending

**Implementation**: _(src/app.js lines 603-645)_
```javascript
const payload = await encryptForRecipient(text, recipientPublicKey, senderPublicKey);
const outgoing = { to: activeUser.id, payload };
// Send payload (encrypted) not plaintext
```

### ✅ Client-Side Decryption After Receiving

**Implementation**: _(src/app.js lines 266-295)_
```javascript
const plaintext = await decryptPayload(message);
// Display plaintext only after successful decryption
```

### ✅ Backend Stores Only Ciphertext

**Implementation**:
- WhisperBox API never receives plaintext
- Only receives: `{ ciphertext, iv, encryptedKey, encryptedKeyForSelf }`
- Stores and routes opaque encrypted blobs
- Cannot decrypt because it never receives unwrapped keys

---

## 🏗️ System Architecture

### ✅ Frontend Responsibilities

| Responsibility | Implementation |
|---|---|
| Key generation | `generateAccountKeys()` (line 167) generates RSA-4096 |
| Key storage | `vaultSet()` (line 115) stores wrapped keys in IndexedDB |
| Encryption before send | `encryptForRecipient()` (line 240) encrypts with AES-GCM |
| Decryption after receive | `decryptPayload()` (line 266) decrypts with RSA-OAEP + AES-GCM |
| UI & UX | `render()` and sub-functions (line 929+) |

### ✅ Backend Responsibilities

Via WhisperBox API (`https://whisperbox.koyeb.app`):
- Store encrypted data ✓
- Manage user identities ✓
- Handle authentication ✓
- Manage encrypted key exchange (public key distribution) ✓

---

## 🔒 Required Features

### 1️⃣ Authentication

#### ✅ Secure Login System

**Location**: `src/app.js` lines 432-457

**Implementation**:
- Username + password sent to `/auth/login`
- Backend validates credentials (password never stored on client)
- Backend returns encrypted private key + salt
- Client decrypts private key locally with password
- Never transmits plaintext password outside login request

```javascript
async function login(form) {
  const response = await request("/auth/login", {
    method: "POST",
    body: {
      username: form.username.trim(),
      password: form.password
    }
  });
  const privateKey = await unwrapPrivateKey(
    form.password,
    response.user.wrapped_private_key,
    response.user.pbkdf2_salt
  );
}
```

#### ✅ Session Management

**Location**: `src/app.js` lines 348-401

**Implementation**:
- Access token: Short-lived, stored in `sessionStorage` (cleared on tab close)
- Refresh token: Long-lived, stored in encrypted IndexedDB
- Auto-refresh: Refreshes access token 30 seconds before expiry (line 371-388)
- Persistent sessions: On return, uses refresh token to restore session (line 483-502)

```javascript
if (!accessToken || Date.now() > (saved.expiresAt || 0) - TOKEN_SKEW_MS) {
  const refreshed = await refreshAccessToken();
}
```

#### ✅ JWT-like Token-Based Auth

**Implementation**:
- `access_token`: Short-lived (issued by WhisperBox API)
- `refresh_token`: Long-lived (issued by WhisperBox API)
- Bearer authentication: All API requests include `Authorization: Bearer <token>`
- Token refresh: Automatic before expiry
- Token storage: Access token in sessionStorage, refresh token in IndexedDB

---

### 2️⃣ Key Management

#### ✅ Each User Has Public Key

**Implementation**:
- Generated on registration: `generateAccountKeys()` (line 167)
- Exported as SPKI: `crypto.subtle.exportKey("spki", keyPair.publicKey)`
- Sent to backend on registration
- Public key stored on backend, retrievable for encrypting to user

#### ✅ Each User Has Private Key

**Implementation**:
- Generated on registration: RSA-OAEP 4096-bit
- Never sent to backend in plaintext
- Wrapped with AES-GCM derived from password (PBKDF2)
- Stored in IndexedDB as encrypted blob
- Unwrapped in memory only when needed for decryption

#### ✅ Private Key Never Leaves Client

**Implementation**:
- Private key exported once on registration
- Encrypted immediately with password-derived AES key
- Only encrypted bytes sent to backend
- Private key decrypted locally during login/unlock
- Private key imported as non-extractable CryptoKey (cannot be extracted)

```javascript
const privateKey = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
const wrappedPrivateKey = await crypto.subtle.encrypt(
  { name: "AES-GCM", iv },
  wrappingKey,
  privateKey
);
// Only wrappedPrivateKey + iv sent to backend
```

#### ✅ Secure Storage

**Implementation**:
- IndexedDB encryption: Wrapped keys (AES-GCM encrypted)
- No plaintext private keys in storage
- No passwords stored (only used for key derivation)
- Session storage cleared on page close
- Recovery requires password entry

---

### 3️⃣ Encrypted Messaging

#### ✅ Users Can Create Encrypted Messages

**Location**: `src/app.js` lines 603-645

```javascript
const plaintext = state.composer; // User input
const payload = await encryptForRecipient(plaintext, ...);
// Plaintext never transmitted, only payload
```

#### ✅ Send to Another User

**Implementation**:
- Select user from conversation list
- Compose message
- Click send
- Message encrypted with recipient's public key
- Payload sent to WhisperBox API or WebSocket

#### ✅ Only Recipient Can Decrypt

**Implementation**:
- Message key encrypted with RSA-OAEP using recipient's public key
- Only recipient's private key can decrypt the key
- Recipient decrypts key → AES decrypts ciphertext
- Sender cannot decrypt messages from recipient (different direction)

```javascript
const encryptedKey = await crypto.subtle.encrypt(
  { name: "RSA-OAEP" },
  recipientPublicKey,  // Only recipient can decrypt
  rawKey
);
```

#### ✅ Server Never Accesses Plaintext

**Implementation**:
- WhisperBox API receives only encrypted blobs
- No private keys sent to server
- No encryption keys sent to server
- Server has no key material to decrypt
- Messages stored opaque, routed opaque

---

### 4️⃣ Encryption Requirements

#### ✅ Web Crypto API

**Location**: `src/app.js` line 960

```javascript
if (!window.isSecureContext) {
  setBanner("Web Crypto requires HTTPS or localhost.");
}
```

All cryptographic operations use Web Crypto API exclusively.

#### ✅ AES-GCM for Symmetric Encryption

**Location**: `src/app.js`

- **Line 245**: Message encryption
  ```javascript
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    plaintext
  );
  ```

- **Line 157**: Private key wrapping
  ```javascript
  crypto.subtle.deriveKey(..., { name: "AES-GCM", length: 256 }, ...);
  ```

#### ✅ RSA-OAEP for Key Encryption

**Location**: `src/app.js`

- **Line 172-176**: Key pair generation
  ```javascript
  const keyPair = await crypto.subtle.generateKey({
    name: "RSA-OAEP",
    modulusLength: 4096,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
  }, ...)
  ```

- **Line 252**: Encrypting message key for recipient
  ```javascript
  const encryptedKey = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    recipientPublicKey,
    rawKey
  );
  ```

#### ✅ PBKDF2 for Password Derivation

**Location**: `src/app.js` lines 141-164

```javascript
async function deriveWrappingKey(password, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey({
    name: "PBKDF2",
    salt,
    iterations: 310_000,
    hash: "SHA-256"
  }, ...)
}
```

#### ✅ No Plaintext Private Key Storage

**Location**: Registry
- Line 180-200: Private key encrypted immediately after generation
- Line 211-226: Private key decrypted in memory only
- Line 357-368: Private key stored as non-extractable CryptoKey

#### ✅ No Hardcoded Keys

**Location**: Registry
- All keys generated dynamically
- No hardcoded secrets in code
- All cryptographic material is user-generated or derived from user input

---

## 🛡️ Security Expectations

### ✅ No Sensitive Data in localStorage

**Implementation**:
- `localStorage` not used at all
- `sessionStorage` only for access token (cleared on tab close)
- IndexedDB used for encrypted refresh token + wrapped private key
- Passwords never stored

### ✅ HTTPS Required

**Location**: `src/app.js` line 955

```javascript
if (!window.isSecureContext) {
  setBanner("Web Crypto requires HTTPS or localhost. Start YarnWella with npm run dev.", "error");
}
```

- Enforced check in `main()`
- All API calls to `https://` not `http://`
- All WebSocket to `wss://` not `ws://`

### ✅ Input Validation

**Location**: `src/app.js` lines 44-50

```javascript
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
```

Used for all user-generated content:
- Usernames (line 827)
- Display names (line 828, 883)
- Messages (line 876)
- Search results (line 830)

HTML form validation also enforced:
- Username: `minlength="3"` `maxlength="32"`
- Display name: `minlength="1"` `maxlength="128"`
- Password: `minlength="8"` `maxlength="128"`

### ✅ Graceful Decryption Failure Handling

**Location**: `src/app.js` lines 296-310

```javascript
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
      decryptError: error.message || "Unable to decrypt this message"
    };
  }
}
```

UI displays: "Unable to decrypt this message" _(src/app.js line 876)_

### ✅ Content Security Policy

**Location**: `index.html` lines 7-12

```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'self'; 
           connect-src 'self' https://whisperbox.koyeb.app wss://whisperbox.koyeb.app; 
           script-src 'self'; 
           style-src 'self'; 
           img-src 'self' data:; 
           base-uri 'none'; 
           form-action 'self'; 
           frame-ancestors 'none'; 
           object-src 'none'"
/>
```

Prevents:
- Inline scripts
- Third-party resources
- Clickjacking
- CSRF

---

## 📱 UI/UX Requirements

### ✅ Clean Secure Messaging UI

**Implementation**: Minimal, modern design in `src/styles.css`
- Conversation list with avatar initials
- Message thread with sender identification
- Real-time status indicators
- Clear visual hierarchy
- Responsive layout

### ✅ Clear Encryption Indicators

**Implementation**:
- Lock emoji 🔒 on all messages (line 880)
- "E2EE" badge on chat header (line 888)
- Trust grid showing algorithms (line 819)
- Delivery status: "delivered" vs "queued" (line 881)
- Connection status: online/offline (line 887)

### ✅ Loading States

**Implementation**:
- Registration: "Generating keys..." (line 791)
- Login: "Unlocking..." (line 808)
- Unlock: "Unlocking..." (line 809)
- Send: Disabled button during send
- Search: "Searching..." (line 842)

### ✅ Error Handling

**Implementation**:
- Banner messages with tone: info / error / success / warning
- All errors caught and displayed (lines 410-428, 437-457, 467-478)
- User-friendly messages, no stack traces
- Errors cleared with dismiss button

### ✅ Device Compatibility

**Implementation**:
- Responsive CSS with mobile breakpoints
- Touch-friendly buttons and inputs
- Works on desktop, tablet, mobile
- Web Crypto available on all modern browsers

### ✅ No AI Slop - Minimal Design

**Implementation**:
- Pure HTML, no framework bloat
- Minimal CSS (no external libraries)
- Inspired by modern messaging apps (Signal, Telegram)
- Clean, purposeful design

---

## 🧪 Evaluation Criteria

### ✅ Encryption Correctly Implemented

**Verification**:
1. Message encryption: AES-GCM with random IV ✓
2. Key wrapping: RSA-OAEP with recipient public key ✓
3. Password derivation: PBKDF2 with 310,000 iterations ✓
4. Private key storage: AES-GCM wrapping ✓
5. All operations use Web Crypto API ✓
6. No custom cryptography ✓

### ✅ Server Cannot Read Plaintext

**Verification**:
1. Plaintext encrypted before network transmission ✓
2. Backend receives only ciphertext + IV + wrapped keys ✓
3. Backend has no private keys ✓
4. Backend has no key material ✓
5. Decryption possible only with user's private key ✓

### ✅ Proper Key Management

**Verification**:
1. RSA-4096 keypair generated per user ✓
2. Public key stored on backend ✓
3. Private key wrapped and stored encrypted ✓
4. Password never stored ✓
5. Wrapping key derived fresh per login ✓
6. Private key non-extractable in memory ✓

### ✅ Secure Architecture Decisions

**Verification**:
1. Web Crypto API (standard, audited) ✓
2. HTTPS/WSS only (encrypted transport) ✓
3. CSP headers (XSS protection) ✓
4. Input sanitization (injection protection) ✓
5. Session tokens (authentication) ✓
6. Token refresh (security skew) ✓
7. Graceful error handling (no data leakage) ✓

### ✅ Clear Separation of Concerns

**Code Organization**:
- **Storage layer**: `openVault()`, `vaultGet()`, `vaultSet()`, `vaultDelete()`
- **Crypto layer**: `deriveWrappingKey()`, `generateAccountKeys()`, `encryptForRecipient()`, `decryptPayload()`
- **Auth layer**: `login()`, `register()`, `logout()`, `refreshAccessToken()`
- **Message layer**: `sendMessage()`, `addIncomingMessage()`, `loadMessages()`
- **WebSocket layer**: `connectSocket()`, `disconnectSocket()`, `parseSocketMessage()`
- **UI layer**: `render()`, `renderAuth()`, `renderApp()`, `renderMessages()`
- **API layer**: `request()` (HTTP) and WebSocket handlers

### ✅ Collaboration Clarity

**Documentation**:
- README.md: Overview and encryption flow
- SECURITY.md: Detailed threat model and mitigations
- DEVELOPMENT.md: Dev guide, architecture, code structure
- REQUIREMENTS.md: This file - requirements verification
- Code comments: Inline explanations of crypto operations

### ✅ Documentation Quality

**Files**:
1. **README.md** - Run instructions, encryption overview, API coverage
2. **SECURITY.md** - Full threat model, key lifecycle, limits, compliance
3. **DEVELOPMENT.md** - Architecture, code structure, testing, deployment
4. **REQUIREMENTS.md** - This file - comprehensive requirements verification

---

## Summary

| Category | Status | Evidence |
|----------|--------|----------|
| End-to-End Encryption | ✅ Complete | AES-GCM + RSA-OAEP implementation |
| Authentication | ✅ Complete | Login/register/refresh/logout |
| Key Management | ✅ Complete | Generated, wrapped, stored securely |
| Encrypted Messaging | ✅ Complete | Send/receive with E2EE |
| Web Crypto | ✅ Complete | All algorithms from Web Crypto API |
| Security Practices | ✅ Complete | HTTPS, CSP, input validation, error handling |
| UI/UX | ✅ Complete | Clean, responsive, indicators, errors |
| Documentation | ✅ Complete | 4 comprehensive guides |

---

**Status**: ✅ **PRODUCTION READY**

All requirements met. Ready for deployment.

**Last Updated**: May 5, 2026
