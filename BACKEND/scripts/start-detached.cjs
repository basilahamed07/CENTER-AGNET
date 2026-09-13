#!/usr/bin/env node
/**
 * Cross-platform detached manager start (Windows + Linux + macOS).
 *
 * Behavior mirrors the previous start-detached.ps1:
 *  - if the manager already responds on /health, do nothing
 *  - otherwise spawn `node dist/index.js` detached and verify health
 *
 * Uses only Node built-ins so it runs the same on every OS.
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = Number(process.env.PORT || 4242);
const HOST = process.env.HOST || '127.0.0.1';
const HEALTH_URL = `http://${HOST}:${PORT}/health`;
const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'dist', 'index.js');

function checkHealth(timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get(HEALTH_URL, { timeout: timeoutMs }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => {
        if (response.statusCode === 200) {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve({ status: 'ok' });
          }
        } else {
          reject(new Error(`health responded ${response.statusCode}`));
        }
      });
    });
    request.on('timeout', () => {
      request.destroy(new Error('health check timed out'));
    });
    request.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  try {
    const health = await checkHealth(2000);
    console.log(`Manager already running on ${HOST}:${PORT} pid=${health.pid}`);
    process.exit(0);
  } catch {
    // Not running yet — continue.
  }

  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    // Fully detach so the manager survives the parent terminal closing.
    windowsHide: true,
  });
  child.unref();
  console.log(`Manager spawned pid=${child.pid}`);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(1000);
    try {
      const health = await checkHealth(2000);
      console.log(`Manager started on ${HOST}:${PORT} pid=${health.pid}`);
      process.exit(0);
    } catch {
      // Retry until the server accepts connections.
    }
  }

  console.error(`Manager did not start. Run 'node dist/index.js' inside BACKEND to see the startup error.`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
