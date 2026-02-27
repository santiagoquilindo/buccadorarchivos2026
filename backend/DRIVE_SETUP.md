# Drive Incremental Sync Setup

## 1) Variables
Crea `backend/.env` (no lo subas a git) con:

```
PORT=3000
HOST=127.0.0.1
DRIVE_AUTH_MODE=oauth
DRIVE_FOLDER_ID=TU_FOLDER_ID
GOOGLE_CLIENT_ID=[REDACTED]
GOOGLE_CLIENT_SECRET=[REDACTED]
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth2/callback
GOOGLE_REFRESH_TOKEN=[REDACTED]
```

Para Shared Drive:

```
DRIVE_USE_SHARED_DRIVE=true
DRIVE_ID=TU_SHARED_DRIVE_ID
```

## 2) Obtener refresh token (OAuth)
Desde `backend/`:

```
npm run oauth:url
```

Autoriza la app y copia `code` del redirect.

```
npm run oauth:token -- --code=TU_CODE
```

Guarda el valor como `GOOGLE_REFRESH_TOKEN`.

## 3) Sync incremental
Manual:

```
npm run drive:sync
```

Por API (requiere login admin):

- `POST /api/drive/sync`
- `GET /api/drive/status`

## 4) Webhook push (opcional)
Requiere URL HTTPS publica del backend:

```
DRIVE_WEBHOOK_URL=https://tu-dominio/api/drive/webhook
DRIVE_WEBHOOK_TOKEN=[REDACTED]
DRIVE_WATCH_EXPIRATION_MS=86400000
```

Activar canal:

- `POST /api/drive/watch/start`
- `POST /api/drive/watch/stop`

Importante: el webhook solo dispara sync; la verdad la mantiene Changes API.

## 5) Buenas practicas
- Nunca compartas `client_secret` ni `refresh_token`.
- Rota secretos si se exponen.
- Usa cuenta de servicio solo si aplica a Workspace/shared drive.
- Monitorea `GET /api/drive/status` para expiracion del watch.
