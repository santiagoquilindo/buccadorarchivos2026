# Configuracion Google Drive (resumen)

Este proyecto usa Google Drive API para sincronizar archivos y responder webhooks.

## 1) Variables de entorno (backend/.env)

Agrega/edita estas variables:

```env
# OAuth
GOOGLE_CLIENT_ID=[REDACTED]
GOOGLE_CLIENT_SECRET=[REDACTED]
GOOGLE_REDIRECT_URI=https://developers.google.com/oauthplayground
GOOGLE_REFRESH_TOKEN=[REDACTED]

# Drive
DRIVE_ID=<REPLACE_WITH_DRIVE_ID>
DRIVE_FOLDER_ID=<REPLACE_WITH_DRIVE_FOLDER_ID>

# Webhook (opcional)
DRIVE_WEBHOOK_BASE_URL=<REPLACE_WITH_PUBLIC_HTTPS_URL>
DRIVE_WEBHOOK_TOKEN=[REDACTED]
```

## 2) Obtener URL de consentimiento

```bash
npm run oauth:url
```

## 3) Intercambiar `code` por refresh token

```bash
npm run oauth:token -- --code "<CODE>"
```

## 4) Sincronizacion manual

```bash
npm run drive:sync
```

## Seguridad

- Nunca subas `.env` al repositorio.
- Rota inmediatamente cualquier credencial que se haya filtrado.
- No compartas `client_secret`, `refresh_token` ni tokens de webhook.
