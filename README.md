# Polar Tecnicos Monitor

Herramienta interna para monitorizar automáticamente el portal de técnicos de
Orange (polar-tecnicos.orange.es): cada hora entra con las cuentas de los
técnicos dados de alta, recoge sus órdenes de trabajo y registra altas,
bajas y cambios de estado en un histórico consultable desde un panel web.

## Componentes

- `db.js` — conexión a Postgres, esquema de tablas, cifrado de contraseñas.
- `scraper.js` — se ejecuta cada hora vía GitHub Actions (gratis, ver
  `.github/workflows/scraper.yml`). Entra con cada técnico activo, extrae
  sus órdenes y guarda los cambios detectados.
- `server.js` — panel web (Render Web Service): órdenes activas por técnico,
  histórico filtrable y alta/baja de técnicos.

## Variables de entorno necesarias

- `DATABASE_URL` — cadena de conexión a Postgres.
- `ENCRYPTION_KEY` — clave hex de 64 caracteres (32 bytes) para cifrar las
  contraseñas de los técnicos en la base de datos.
- `PANEL_USER` / `PANEL_PASSWORD` — credenciales de acceso al panel web.

## Pendiente de ajustar

La función `extraerOrdenes()` en `scraper.js` usa selectores genéricos
provisionales. Hay que ajustarla en cuanto tengamos una captura o el HTML
real de la pantalla de listado de órdenes con sesión iniciada.

## Alta de técnicos

No se cargan credenciales por variables de entorno ni en el código: se dan
de alta desde el panel web (`/tecnicos`), donde la contraseña se cifra antes
de guardarse en la base de datos.
