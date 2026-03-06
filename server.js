const http = require('http');
const config = require('./config');
const llmConfig = require('./config/llm'); // validate LLM config at startup (exits if invalid)
require('./config/assessment'); // validate assessment/pregen config at startup (exits if invalid)
const { createApp } = require('./app');
const { runStartupChecks } = require('./src/lib/startupChecks');
const { runLlmCheckup } = require('./src/lib/llmCheckup');

async function main() {
  await runStartupChecks(config);
  const app = createApp(config);
  const server = http.createServer(app);
  server.listen({ port: config.port, reuseAddress: true }, () => {
    console.log(`bft-api listening on port ${config.port} (${config.nodeEnv})`);
  });

  const intervalMs = llmConfig.checkupIntervalSec * 1000;
  const timer = setInterval(() => {
    runLlmCheckup().catch((err) => {
      console.error('[LLM checkup]', err.message);
    });
  }, intervalMs);
  server.on('close', () => clearInterval(timer));

  function shutdown(signal) {
    console.log(`\n${signal}, closing server...`);
    clearInterval(timer);
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[startup]', err.message);
  process.exit(1);
});
