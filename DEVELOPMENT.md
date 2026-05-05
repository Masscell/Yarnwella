# YarnWella Development Guide

## Project Overview

YarnWella is a secure, end-to-end encrypted messaging client that runs entirely in the browser. All encryption/decryption happens client-side; the backend never sees plaintext.

## Architecture

### Frontend (Browser)
- **Framework**: Vanilla JavaScript (no framework dependencies)
- **Encryption**: Web Crypto API
- **Storage**: IndexedDB + sessionStorage
- **Real-time**: WebSocket
- **Entry Point**: `src/app.js`

### Backend
- **Role**: Authentication, key distribution, encrypted message storage/routing
- **API**: REST + WebSocket
- **Base URL**: `https://whisperbox.koyeb.app/`
- **Docs**: https://whisperbox.koyeb.app/docs

### Local Development Server
- **File**: `server.js`
- **Port**: 4173 (configurable via PORT env var)
- **Purpose**: Static file serving with CSP headers

## Getting Started

### Prerequisites
- Node.js 16+ (for running dev server)
- Modern browser with Web Crypto API support (Chrome, Firefox, Safari, Edge)
- Internet connection (to reach WhisperBox API)

### Installation & Development

```bash
# Clone/enter the project directory
cd c:\Users\marce\OneDrive\Desktop\chat-app

# Install dependencies (none required for client)
npm install

# Start development server
npm run dev

# Open browser to http://localhost:4173
# (Web Crypto requires secure context; localhost is treated as secure)
```

### Syntax Check
```bash
npm run check
```

## Code Structure

### Core Functions

#### Authentication
- `register(form)` - Create new account with generated RSA keypair
- `login(form)` - Sign in and unwrap private key with password
- `logout()` - Clear session and all sensitive keys
- `refreshAccessToken()` - Renew access token before expiry
- `restoreSession()` - Restore session from storage on page load

#### Key Management
- `generateAccountKeys(password)` - Generate RSA-4096 keypair, wrap with password
- `deriveWrappingKey(password, salt)` - PBKDF2 key derivation
- `unwrapPrivateKey(password, wrappedKey, salt)` - Decrypt private key
- `importPublicKey(publicKeyBase64)` - Import public key for encryption

#### Encryption
- `encryptForRecipient(plaintext, recipientPubKey, senderPubKey)` - Encrypt message
- `decryptPayload(message)` - Decrypt received message
- `hydrateMessage(message)` - Parse encrypted payload with error handling

#### Messaging
- `sendMessage()` - Compose and send encrypted message
- `addIncomingMessage(message)` - Process received message
- `loadMessages(user)` - Fetch and decrypt conversation history

#### WebSocket
- `connectSocket()` - Establish WebSocket connection
- `disconnectSocket()` - Close WebSocket and cleanup
- `parseSocketMessage(event)` - Parse incoming WebSocket frames

#### Storage
- `openVault()` - Open IndexedDB
- `vaultGet(key)` - Retrieve from IndexedDB
- `vaultSet(key, value)` - Store in IndexedDB
- `vaultDelete(key)` - Delete from IndexedDB

#### UI
- `render()` - Main render function
- `renderAuth()` - Login/register form
- `renderApp()` - Messenger UI
- `renderMessages()` - Message thread
- `renderConversations()` - Conversation list

### State Object

```javascript
state = {
  auth: {                    // Current authentication
    accessToken,
    refreshToken,
    expiresAt,
    user: { id, username, display_name, public_key, ... }
  },
  privateKey,               // CryptoKey (non-extractable)
  publicKey,                // CryptoKey
  conversations: [],        // List of threads
  activeUser,               // Currently selected conversation
  messages: Map,            // Encrypted/decrypted messages per conversation
  users: [],                // Search results
  socket,                   // WebSocket connection
  socketStatus,             // 'online' | 'offline' | 'connecting'
  // ... (loading, banner, composer, etc.)
}
```

## API Integration

### REST Endpoints Used

```
POST   /auth/register              - Create account
POST   /auth/login                 - Sign in
POST   /auth/refresh               - Renew access token
POST   /auth/logout                - Invalidate refresh token

GET    /conversations              - List user conversations
GET    /conversations/{userId}/messages  - Fetch thread history
GET    /users/search?q=...        - Search users
GET    /users/{userId}/public-key - Get user's public key

POST   /messages                   - Send message via HTTP
```

### WebSocket Connection

```
wss://whisperbox.koyeb.app/ws?token=<access_token>

Incoming frames:
{
  "type": "message.receive",
  "message": {
    "id": "uuid",
    "from_user_id": "uuid",
    "to_user_id": "uuid",
    "payload": {
      "ciphertext": "base64",
      "iv": "base64",
      "encryptedKey": "base64",
      "encryptedKeyForSelf": "base64"
    },
    "created_at": "2024-01-01T00:00:00Z"
  }
}

Outgoing frames:
{
  "type": "message.send",
  "to": "recipient_user_id",
  "payload": { ... encrypted payload ... }
}
```

## Encryption Flow Diagram

```
┌─────────────────────────────────────────┐
│ SENDER                                  │
├─────────────────────────────────────────┤
│ 1. User types message: "Hello"          │
│ 2. Generate fresh AES-256 key           │
│ 3. Generate random 96-bit IV            │
│ 4. Encrypt plaintext with AES-GCM       │
│    result: ciphertext                   │
│ 5. Export AES key as raw bytes          │
│ 6. Encrypt key with recipient's RSA pub │
│    result: encryptedKey                 │
│ 7. Encrypt key with sender's RSA pub    │
│    result: encryptedKeyForSelf          │
│ 8. Send to backend:                     │
│    {ciphertext, iv, encryptedKey,       │
│     encryptedKeyForSelf}                │
└────────────────────────────────────────┬┘
                                         │
                    ┌────────────────────┴───────────────────┐
                    │ BACKEND (Storage Only)                 │
                    │ - Cannot decrypt                       │
                    │ - Cannot see plaintext                 │
                    │ - Routes to recipient or persists      │
                    └────────────────────┬───────────────────┘
                                         │
┌────────────────────────────────────────┴──────────────────┐
│ RECIPIENT                                                 │
├───────────────────────────────────────────────────────────┤
│ 1. Receive encrypted payload from backend                 │
│ 2. Extract encryptedKey (for them) from payload           │
│ 3. Decrypt RSA blob with private key                      │
│    result: raw AES key bytes                              │
│ 4. Import AES key as CryptoKey                            │
│ 5. Decrypt ciphertext with AES-GCM + IV                   │
│    result: plaintext bytes                                │
│ 6. Decode bytes to text: "Hello"                          │
│ 7. Display in UI                                          │
└───────────────────────────────────────────────────────────┘
```

## Password Reset Flow

YarnWella does **not** support password resets. This is intentional:

- Resetting password would require a way to re-encrypt the private key (which requires knowing the old password)
- Or allowing the backend to decrypt and re-wrap (security vulnerability)
- **Recommendation**: Create new account if password is forgotten

If users lose password and device:
- All messages are lost
- Cannot recover account
- Emphasize password securely with users

## Error Handling

### Decryption Failures
- Messages that fail to decrypt show: "Unable to decrypt this message"
- Errors don't expose raw payloads or stack traces
- Message metadata still visible (sender, timestamp)

### Network Errors
- HTTP failures show banner with error message
- WebSocket failures automatically reconnect after 4 seconds
- Messages queue locally if offline, send when connection restored

### Crypto Errors
- If key unwrap fails: "That password could not unlock the local key vault"
- If key derivation fails: "Decryption failed"
- All crypto exceptions caught and displayed to user

## Security Checklist for Deployment

- [ ] Serve over HTTPS only (no HTTP)
- [ ] Verify CSP headers are sent correctly
- [ ] Test Web Crypto availability in target browsers
- [ ] Verify IndexedDB is available (fallback needed?)
- [ ] Test message encryption/decryption with another user
- [ ] Verify wrapped keys are never logged
- [ ] Test session persistence across page reloads
- [ ] Verify access token cleared on page close
- [ ] Test offline message queueing
- [ ] Verify WebSocket reconnection works
- [ ] Test with network throttling (slow/offline scenarios)
- [ ] Verify CSP blocks inline scripts
- [ ] Test with browser DevTools (no sensitive data logged)

## Performance Considerations

### Crypto Operations (Per Message)
- RSA-4096 encryption: ~50-100ms
- AES-GCM encryption: <1ms
- RSA-4096 decryption: ~500-1000ms
- AES-GCM decryption: <1ms

### Optimization Tips
- Batch message history parsing with `Promise.all()`
- Lazy decrypt messages when displayed (not implemented)
- Cache public keys after fetch (TODO)
- Consider WebWorker for crypto on slow devices

## Testing

### Manual Test Cases

1. **Register new account**
   - Create username, password, display name
   - Verify account created successfully
   - Verify private key encrypted and stored

2. **Login**
   - Use credentials from registration
   - Verify private key unwrapped with password
   - Verify can view old messages

3. **Send message**
   - Compose message
   - Verify encrypted before sending
   - Verify received on recipient's screen
   - Verify delivery status shows correct state

4. **Session restoration**
   - Login, refresh browser
   - Verify session restored without re-login
   - Verify password required to decrypt
   - Verify can view messages after unlock

5. **Connection states**
   - Observe online indicator when connected
   - Turn off network, see offline indicator
   - Message shows "queued" when offline
   - Turn network back on, see message delivered

### Debugging

Enable console logging (add to app.js):
```javascript
function log(...args) {
  console.log('[YarnWella]', ...args);
}
```

Common issues:
- `TypeError: Cannot read property 'subtle' of undefined` → Web Crypto unavailable, check HTTPS/localhost
- `InvalidAccessError: The request is not allowed by the user agent's policy` → CSP violation
- `QuotaExceededError` → IndexedDB storage full

## Build & Deployment

### Production Build
No build step needed! YarnWella is a static site.

```bash
# Files to deploy:
- index.html
- src/app.js
- src/styles.css
- server.js (optional, for serving)
```

### Hosting Options
1. **Static host** (Netlify, Vercel, GitHub Pages)
   - Ensure HTTPS enabled
   - CSP headers configured
   - All requests to WhisperBox API work

2. **Node.js server** (Heroku, Railway, Render)
   - Run `npm run dev`
   - Environment variable: `PORT=3000`
   - Forward requests to frontend

3. **Docker** (optional)
   - Create Dockerfile with Node.js base
   - Run `npm run dev`
   - Expose port 4173

## Contributing

When modifying YarnWella:
- Never log sensitive data (keys, tokens, plaintext)
- Always use `escapeHtml()` on user input before displaying
- Never store plaintext private keys
- Run `npm run check` before committing
- Update SECURITY.md if crypto changes
- Document all API changes in README.md

---

**Last Updated**: May 5, 2026
