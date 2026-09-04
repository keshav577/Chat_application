/* Boots a server on a throwaway database, runs both suites, cleans up.
   Keeps fixture accounts out of your real chat.db.  Run:  npm test  */
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = process.env.TEST_PORT || 3411;
const DB = path.join(require('os').tmpdir(), `chatconnect-test-${Date.now()}.db`);
const URL = `http://localhost:${PORT}`;
const root = path.join(__dirname, '..');

const cleanup = () => ['', '-wal', '-shm'].forEach(s => fs.rmSync(DB + s, { force: true }));

(async () => {
    const server = spawn('node', ['server.js'], {
        cwd: root,
        env: { ...process.env, PORT, DB_PATH: DB, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});

    // Wait for it to accept connections.
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
        await new Promise(r => setTimeout(r, 200));
        try { await fetch(URL + '/'); up = true; } catch {}
    }
    if (!up) {
        console.error('Test server failed to start');
        server.kill('SIGKILL'); cleanup(); process.exit(1);
    }

    console.log(`Test server on ${URL} using a temporary database\n`);
    let failed = 0;
    for (const suite of ['api.test.js', 'ui.test.js']) {
        const r = spawnSync('node', [path.join(__dirname, suite)], {
            stdio: 'inherit', env: { ...process.env, TEST_URL: URL }
        });
        if (r.status !== 0) failed++;
        console.log('');
    }

    server.kill('SIGKILL');
    cleanup();
    console.log(failed ? `${failed} suite(s) failed.` : 'All suites passed.');
    process.exit(failed ? 1 : 0);
})();
