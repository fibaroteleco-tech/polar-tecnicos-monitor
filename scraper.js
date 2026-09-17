require('dotenv').config();
const { ensureSchema, pool } = require('./db');
const { ejecutarScraping } = require('./lib/scrapeCore');

(async () => {
  await ensureSchema();
  const resultado = await ejecutarScraping();
  console.log(JSON.stringify(resultado, null, 2));
  await pool.end();
})().catch((err) => {
  console.error('Fallo general del scraper:', err);
  process.exit(1);
});
