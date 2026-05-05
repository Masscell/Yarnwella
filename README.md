# YarnWella

YarnWella is a secure browser messaging client for the WhisperBox API at `https://whisperbox.koyeb.app/`. It implements end-to-end encryption in the browser, so the backend stores and routes encrypted payloads without ever receiving plaintext.

## Run

```bash
npm run dev
```

Open `http://localhost:4173`. Web Crypto requires a secure context; `localhost` is treated as secure by modern browsers.

## Documentation

- **[SECURITY.md](./SECURITY.md)** - Comprehensive security architecture, threat model, and cryptographic details
- **[DEVELOPMENT.md](./DEVELOPMENT.md)** - Development guide, code structure, and testing procedures
- **[REQUIREMENTS.md](./REQUIREMENTS.md)** - Detailed verification of all E2EE requirements

## Encryption Flow

1. On registration, the browser generates a 4096-bit RSA-OAEP keypair with SHA-256.
2. The public key is exported as base64 SPKI and sent to the backend.
3. The private key is exported once, wrapped locally with AES-GCM, and stored/transmitted only as wrapped key material.
4. The AES-GCM wrapping key is derived from the user password using PBKDF2-SHA-256 with a random 128-bit salt and 310,000 iterations.
5. For each message, the sender creates a fresh AES-GCM 256-bit key and a random 96-bit IV.
6. The plaintext message is encrypted locally with AES-GCM.
7. The raw AES key is encrypted twice with RSA-OAEP: once for the recipient and once for the sender's own history.
8. The app sends only `ciphertext`, `iv`, `encryptedKey`, and `encryptedKeyForSelf` to WhisperBox.
9. The recipient decrypts the AES key locally with their private RSA key, then decrypts the message with AES-GCM.

## Key Management

- Plaintext private keys are never sent to the backend.
- The active private key is held only as a non-extractable `CryptoKey` in memory.
- Persisted key material is stored in IndexedDB as API-compatible wrapped private-key material.
- On restored sessions, the user must enter their password to unwrap the private key before messages can be decrypted.
- Access tokens are kept in `sessionStorage`; refresh tokens and wrapped key material are stored in IndexedDB.

## Backend Boundary

The backend is used only for authentication, public key distribution, encrypted message storage, conversation history, and WebSocket routing. It receives opaque encrypted blobs and cannot decrypt message contents because it never receives an unwrapped private key or a plaintext AES message key.

## Security Notes

- The app uses Web Crypto primitives instead of custom cryptography.
- AES-GCM IVs are generated randomly per message.
- Authentication calls use bearer tokens, with automatic access-token refresh.
- A Content Security Policy limits script, object, frame, and connection surfaces.
- Decryption failures are shown as message-level errors without exposing raw payloads.
- Production deployments must serve the app over HTTPS.

## API Coverage

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET /conversations`
- `GET /conversations/{userId}/messages`
- `GET /users/search`
- `GET /users/{userId}/public-key`
- `POST /messages`
- `wss://whisperbox.koyeb.app/ws?token=<access_token>`
