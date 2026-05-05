# YarnWella Security Architecture

YarnWella implements End-to-End Encryption (E2EE) where all message encryption happens on the client, and the server never has access to plaintext message content or unwrapped private keys.

## Core Security Model

### Zero-Knowledge Backend
The backend stores and routes only encrypted data. It never receives:
- Plaintext messages
- Unwrapped private keys
- Message encryption keys
- Decryption material

### Cryptographic Algorithms

| Purpose | Algorithm | Details |
|---------|-----------|---------|
| Key Generation | RSA-OAEP | 4096-bit keys, SHA-256 hashing |
| Key Wrapping for Private Key Storage | AES-GCM | 256-bit keys, random 96-bit IV per message |
| Key Derivation | PBKDF2-SHA-256 | 310,000 iterations, 128-bit random salt |
| Message Encryption | AES-GCM | 256-bit key, fresh random 96-bit IV per message |
| Message Key Wrapping | RSA-OAEP | 4096-bit recipient public key |

## Key Lifecycle

### 1. Account Registration
```
User enters password
  ↓
Generate RSA-4096 keypair (public/private)
  ↓
Export public key as base64 SPKI → send to backend
  ↓
Export private key as pkcs8 bytes
  ↓
Derive AES-GCM key from password (PBKDF2)
  ↓
Encrypt private key bytes with AES-GCM
  ↓
Combine IV + ciphertext → send to backend as "wrapped_private_key"
  ↓
Store derived wrapping key in memory for this session only
```

### 2. Session Login
```
User enters username + password
  ↓
Request wrapped_private_key + pbkdf2_salt from backend
  ↓
Derive same AES-GCM key from password + salt (PBKDF2)
  ↓
Decrypt wrapped_private_key to recover pkcs8 bytes
  ↓
Import pkcs8 bytes as non-extractable CryptoKey
  ↓
Store in memory; derive key is never persisted
  ↓
Private key is now ready for message decryption
```

### 3. Message Encryption (Sender)
```
User composes plaintext message
  ↓
Generate fresh AES-256 key for this message
  ↓
Generate random 96-bit IV
  ↓
Encrypt plaintext with AES-GCM (key + IV)
  ↓
Export raw AES key as bytes
  ↓
Encrypt raw key twice with RSA-OAEP:
   - Once with recipient's public key (for recipient to decrypt)
   - Once with sender's public key (for sender's own archive)
  ↓
Send ciphertext + IV + encryptedKey + encryptedKeyForSelf to backend
```

### 4. Message Decryption (Recipient)
```
Receive encrypted message from backend
  ↓
Determine if sent by recipient (use encryptedKey) or self (use encryptedKeyForSelf)
  ↓
Decrypt RSA-OAEP blob with private key → raw AES key
  ↓
Import raw AES key as CryptoKey
  ↓
Decrypt ciphertext with AES-GCM (key + IV)
  ↓
Decode bytes to plaintext
```

## Storage Layers

### Memory
- **Active private key**: Stored as non-extractable `CryptoKey`
- **Access token**: In `sessionStorage` (cleared on page close)
- **Derived wrapping key**: Never persisted; exists only during active session

### IndexedDB (Encrypted vault)
- **Session data**: `{ refreshToken, user, expiresAt }`
- **Wrapped private key material**: From registration or login
- **PBKDF2 salt**: Required to re-derive wrapping key during login

### Not Stored
- Raw plaintext private keys
- Password (only used for key derivation)
- Message encryption keys (ephemeral, generated per message)
- Unwrapped message content (decrypted in memory only)

## Authentication & Session Management

### Initial Authentication
1. User registers or logs in with username + password
2. Backend validates credentials, generates JWT-like tokens
3. Tokens returned:
   - `access_token`: Short-lived (in sessionStorage)
   - `refresh_token`: Long-lived (in IndexedDB)
4. Private key unwrapped locally using password

### Token Refresh
- Background task refreshes access token when expired (with 30-second skew)
- Refresh token validated by backend before issuing new access token
- If refresh fails → session cleared, user must re-authenticate

### Session Persistence
- Closing the browser tab → access token cleared (sessionStorage)
- Returning later → app restores session via refresh token
- User must enter password to unlock private key before viewing messages
- This provides protection if device is stolen between sessions

## Input Validation & XSS Protection

### HTML Sanitization
All user-generated content is escaped via `escapeHtml()`:
```javascript
- & → &amp;
- < → &lt;
- > → &gt;
- " → &quot;
- ' → &#039;
```

This prevents stored XSS in message display, usernames, and display names.

### Content Security Policy
```
default-src 'self'
connect-src 'self' https://whisperbox.koyeb.app wss://whisperbox.koyeb.app
script-src 'self'
style-src 'self'
img-src 'self' data:
base-uri 'none'
form-action 'self'
frame-ancestors 'none'
object-src 'none'
```

This prevents:
- Inline scripts
- Unsafe external resources
- Clickjacking
- CSRF attacks (form-action limited)

## Decryption Error Handling

If a message fails to decrypt:
- Error message shown to user: "Unable to decrypt this message"
- Raw error details not exposed
- Message payload stored but marked as corrupted
- User can still see other messages
- Possible causes:
  - Wrong private key
  - Corrupted ciphertext
  - Tampered envelope
  - Key expiration/rotation (not implemented yet)

## Transport Security

### HTTPS Requirement
- App checks `window.isSecureContext`
- Displays error if not on HTTPS or localhost
- All API calls to `https://whisperbox.koyeb.app`
- All WebSocket connections to `wss://whisperbox.koyeb.app`

### Authentication Header
- Bearer token sent in `Authorization` header
- Token includes only the access token, never the refresh token
- Refresh token sent only to `/auth/refresh` endpoint

## Real-Time Messaging (WebSocket)

### Connection
- Access token passed as URL parameter (note: visible in browser history/logs)
- Future improvement: use subprotocol or header-based auth if backend supports

### Message Flow
1. Client sends: `{ type: "message.send", to: userId, payload: {...encrypted...} }`
2. Backend routes to recipient if online
3. Recipient receives encrypted blob, decrypts locally
4. If recipient offline, message persisted to database for history fetch

### Connection Resilience
- Automatic reconnection on disconnect (4-second delay)
- Graceful fallback to HTTP POST if WebSocket unavailable
- Message delivery status tracked:
  - `delivered: true` if sent via open WebSocket
  - `delivered: false` if queued via HTTP POST

## Threat Model & Mitigations

### Threat: Passive Network Eavesdropping
**Mitigation**: HTTPS/WSS encrypted transport, AES-GCM message encryption

### Threat: Active Man-in-the-Middle
**Mitigation**: HTTPS with certificate pinning (note: not implemented), Content-Security-Policy

### Threat: Backend Compromise
**Mitigation**: Backend never receives plaintext or unwrapped keys; encrypted blobs are useless without private key

### Threat: Device Compromise (Device Stolen)
**Mitigation**: 
- Private key requires password to unlock (not stored plaintext)
- Access token cleared on page close
- Refresh token stored in IndexedDB, but useless without password

### Threat: Password Weak/Compromised
**Mitigation**: 
- PBKDF2 with 310,000 iterations (resistant to brute-force)
- 128-bit random salt (different per user)
- Server validates username/password but never uses it to encrypt keys

### Threat: Replay Attacks
**Mitigation** (partial): 
- Each message has unique IV
- Access tokens are short-lived (auto-refresh)
- Refresh tokens single-use (future improvement: implement nonce tracking)

### Threat: Quantum Computers
**Current Status**: Not mitigated (RSA-4096 vulnerable long-term)
**Future**: Implement post-quantum cryptography when Web Crypto API supports it

## Known Limitations & Future Improvements

### Current Limitations
1. **Certificate Pinning**: Not implemented; relies on HTTPS + CSP
2. **Perfect Forward Secrecy**: Not implemented; compromised password exposes all past messages
3. **Key Rotation**: Not supported; users must create new account
4. **Message Signatures**: Not implemented; no sender authentication
5. **Offline Encryption**: If WebSocket offline, message sent via HTTP POST

### Recommended Future Features
1. Implement Perfect Forward Secrecy (ephemeral Diffie-Hellman per conversation)
2. Add message signatures with sender's private key
3. Implement key rotation protocol
4. Certificate pinning for whisperbox.koyeb.app
5. Post-quantum cryptography when available
6. End-to-end encrypted group conversations
7. Encrypted file attachments
8. Read receipts (with privacy consideration)

## Compliance & Standards

- **Web Crypto API**: Uses standard browser cryptography, no custom algorithms
- **OWASP**: Follows OWASP Web Application Security guidelines
- **NIST**: Algorithms and key sizes meet NIST recommendations
- **GDPR**: No personal data collected beyond what's necessary for messaging

## Testing & Verification

### Manual Testing Checklist
- [ ] Can register new account successfully
- [ ] Private key is encrypted and never sent plaintext
- [ ] Can send message to another user
- [ ] Recipient receives encrypted payload
- [ ] Recipient can decrypt and view plaintext
- [ ] Sender can see own message in encrypted archive
- [ ] Corrupted message shows error gracefully
- [ ] Refresh token auto-refreshes before expiry
- [ ] Closing browser clears access token
- [ ] Returning later requires password to unlock
- [ ] WebSocket connects when online
- [ ] Messages send via HTTP if WebSocket offline
- [ ] CSP headers prevent inline scripts

### Browser Security Check
```javascript
// Run in console:
console.log('Secure context:', window.isSecureContext);
console.log('Crypto available:', window.crypto?.subtle !== undefined);
```

## Questions & Support

For security-related questions or to report vulnerabilities, please contact the YarnWella team through the WhisperBox documentation or GitHub issues.

---

**Last Updated**: May 5, 2026
**Compliance**: End-to-End Encryption (E2EE) Standard
