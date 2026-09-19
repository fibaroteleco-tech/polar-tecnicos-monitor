// Script para ejecutar el scraping manualmente en local/depuración.
// En producción, el scraping se dispara vía HTTP en /api/run-scrape
// (ver server.js), llamado cada hora desde GitHub Actions.
require('dotenv').config();
const { ensureSchema, pool } = require('./db');
const { ejecutarScraping } = require('./lib/scrapeCore');

ensureSchema()
  .then(() => ejecutarScraping())
  .then((r) => {
    console.log('Resultado:', JSON.stringify(r, null, 2));
    return pool.end();
  })
  .catch((err) => {
    console.error('Fallo:', err);
    process.exit(1);
  });
