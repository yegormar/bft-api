const config = require('./config');
require('./config/llm'); // validate LLM config at startup (exits if invalid)
const { createApp } = require('./app');

const app = createApp(config);

app.listen(config.port, () => {
  console.log(`bft-api listening on port ${config.port} (${config.nodeEnv})`);
});
