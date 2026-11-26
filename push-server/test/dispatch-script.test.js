'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { boot, TOKEN } = require('./helpers');

const script = path.join(__dirname, '..', 'scripts', 'dispatch-calls.js');

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script].concat(args), {
      env: Object.assign({}, process.env, env)
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status: status, stdout: stdout, stderr: stderr }));
  });
}

test('dispatch script posts the file without putting the token on argv', async () => {
  const ctx = await boot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charlie-dispatch-'));
  const file = path.join(dir, 'calls.json');
  fs.writeFileSync(file, JSON.stringify({
    generated_myt: '2026-11-07 18:40:00',
    calls: [{
      id: 'V-S004', asset: 'FXVOL80', type: 'SCALP', name: 'Vol 80 · Scalping #4',
      direction: 'SELL', status: 'PENDING', created_myt: '2026-11-07 18:40:00',
      entry_lo: 43000, entry_hi: 43200
    }]
  }));
  const env = {
    CHARLIE_PUSH_ORIGIN: 'http://127.0.0.1:' + ctx.port,
    CHARLIE_DISPATCH_TOKEN: TOKEN
  };
  try {
    const leaked = await run([file, TOKEN], env);
    assert.notEqual(leaked.status, 0);
    assert.match(leaked.stderr, /command line/);
    const first = await run([file], env);
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const body = JSON.parse(first.stdout);
    assert.equal(body.baselined, true);
    assert.equal(body.events.length, 0);
    assert.equal(ctx.sent.length, 0);
    assert.equal(first.stdout.includes(TOKEN), false);
    const changed = path.join(dir, 'next.json');
    const nextDoc = JSON.parse(fs.readFileSync(file, 'utf8'));
    nextDoc.calls[0].status = 'TP';
    nextDoc.calls[0].r_result = 1.7;
    nextDoc.calls[0].fill_px = 43000;
    nextDoc.generated_myt = '2026-11-07 18:50:00';
    fs.writeFileSync(changed, JSON.stringify(nextDoc));
    const second = await run([changed], env);
    assert.equal(second.status, 0, second.stderr + second.stdout);
    const delivered = JSON.parse(second.stdout);
    assert.equal(delivered.baselined, false);
    assert.ok(delivered.events.some((event) => event.category === 'tp' && event.name === 'Vol 80 · Scalping #4'));
    assert.equal(delivered.realtime, false);
    assert.equal(delivered.scoreMinutes, 10);
    assert.equal(second.stdout.includes(TOKEN), false);
  } finally {
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
