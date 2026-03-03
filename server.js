const config = require('./config');
const llmConfig = require('./config/llm'); // validate LLM config at startup (exits if invalid)
const { createApp } = require('./app');
const { runLlmCheckup } = require('./src/lib/llmCheckup');

async function main() {
  await runLlmCheckup();
  const app = createApp(config);
  const server = app.listen(config.port, () => {
    console.log(`bft-api listening on port ${config.port} (${config.nodeEnv})`);
  });

  const intervalMs = llmConfig.checkupIntervalSec * 1000;
  const timer = setInterval(() => {
    runLlmCheckup().catch((err) => {
      console.error('[LLM checkup]', err.message);
    });
  }, intervalMs);
  server.on('close', () => clearInterval(timer));
}

main().catch((err) => {
  console.error('[startup] LLM checkup failed:', err.message);
  process.exit(1);
});
