# Pizarra de conclusiones · IV encuentro de la construcción CAPECO

Pizarra didáctica en tiempo real donde los participantes publican sus conclusiones, de forma anónima.
Vue 3 (CDN) + Gun.js + qrcode.js. Sin base de datos.

| Ruta | Quién | Qué hace |
|---|---|---|
| `/` | Participantes | Publicar conclusiones y marcar «Coincido». Sin registro. |
| `/proyector` | Moderadores (PIN) | Pizarra a pantalla completa con tarjetas (6 por página, rota cada 12 s), destacada en grande y QR. Mueve el ratón para ver los controles. **F** = pantalla completa. |
| `/moderar` | Moderadores (PIN) | Panel para móvil o portátil: destacar, ocultar o mostrar, y abrir o cerrar la recepción. |

## Local

```bash
npm install
MOD_PIN=482915 npm start      # http://localhost:8765
```

En Windows (PowerShell): `$env:MOD_PIN="482915"; npm start`.
Si no defines `MOD_PIN`, el servidor genera uno temporal y lo imprime en la consola.

## Render

1. Sube la carpeta a un repositorio de GitHub.
2. En Render: **New → Blueprint**. Usa `render.yaml` y te pedirá el valor de `MOD_PIN`.
3. Para cambiar el PIN: *Environment → MOD_PIN*. Al cambiarlo se cierran todas las sesiones abiertas.

## Seguridad

- **PIN validado en el servidor.** `/proyector` y `/moderar` muestran un formulario de PIN si no hay sesión. La sesión es una cookie `HttpOnly` firmada (HMAC) que dura 12 h.
- **Fuerza bruta.** Tras 5 PIN incorrectos, esa IP queda bloqueada 10 minutos.
- **Moderación fuera de Gun.** Destacar, responder, ocultar y cerrar la recepción se hacen solo vía `POST /api/mod` con sesión, y se difunden a todos por Server-Sent Events (`/api/events`).
- **Firewall en el relay.** El servidor valida cada escritura que llega por Gun:
  - Solo se aceptan texto y fecha de preguntas, y votos con valor 0 o 1.
  - El ID de cada pregunta lleva un hash de su texto, así que nadie puede reescribir una pregunta ajena.
  - El texto pasa por el mismo filtro de groserías que el navegador (`public/shared.js`).
  - Con la recepción cerrada se rechazan preguntas nuevas.
  - Se descarta cualquier dato ajeno a la app.
- **Cabeceras HTTP.** `X-Frame-Options: DENY`, `nosniff` y verificación de `Origin` en la API (CSRF).

**Limitación conocida:** sin cuentas de usuario no se puede impedir del todo que alguien con conocimientos técnicos infle votos generando IDs anónimos. Si ocurre, el moderador decide qué se destaca: los votos solo ordenan, no publican nada en pantalla.

## Datos

- Preguntas y votos: `localStorage` de cada navegador y `./radata` en el servidor.
- Moderación: `./moderation.json`.
- Con `DATA_DIR` cambias la carpeta, por ejemplo hacia un *Persistent Disk* de Render. En el plan gratuito el disco se borra al reiniciar. El proyector y los asistentes re-siembran las preguntas al reconectar, pero las marcas de moderación se perderían.
- Pizarra nueva para otro evento: cambia `NAMESPACE` en `public/shared.js`.
- Palabras prohibidas: arrays `WORDS` y `ROOTS` en `public/shared.js`.
