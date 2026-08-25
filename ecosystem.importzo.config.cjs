// PM2 config for the Importzo app.
// Named .cjs because package.json sets "type": "module" — PM2 requires CommonJS here.
//
// .env is loaded twice on purpose:
//   1. dotenv below, so PM2 stores the vars on the process (visible via `pm2 env <id>`)
//   2. node --env-file=.env, matching the package.json "start" script
const path = require("path");
const dotenv = require("dotenv");

const cwd = __dirname;
const env = dotenv.parse(require("fs").readFileSync(path.join(cwd, ".env")));

module.exports = {
  apps: [
    {
      name: "importzo",
      cwd,
      script: "./node_modules/@react-router/serve/bin.js",
      args: "./build/server/index.js",
      interpreter: "/home/dazzletech-importzo/.nvm/versions/node/v22.23.2/bin/node",
      interpreter_args: "--env-file=.env",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      // Stamp every log line with a timestamp.
      //
      // Without this PM2 writes bare lines, and working out WHEN something
      // happened means inferring it from the log file's mtime — which only
      // ever tells you about the last line written. Diagnosing whether a
      // theme-name 422 landed before or after a deploy took that exact
      // detour, and it only worked because the entry happened to be last in
      // the file. Anything further up would have been untimeable.
      log_date_format: "YYYY-MM-DD HH:mm:ss.SSS Z",
      env: {
        ...env,
        NODE_ENV: "production",
        PORT: env.PORT || "3000",
      },
    },
  ],
};
