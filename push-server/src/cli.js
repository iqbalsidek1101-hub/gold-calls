'use strict';

const fs = require('fs');
const path = require('path');
const { diffDocument, extractDocument } = require('./events');
const { FileStore } = require('./store');

function readDoc(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return extractDocument(parsed) || parsed;
}

async function baseline(file) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const store = new FileStore(path.join(dataDir, 'state.json'));
  const doc = readDoc(file);
  const nowIso = new Date().toISOString();
  await store.update((state) => {
    const result = diffDocument({ baselined: false }, doc, nowIso);
    state.snapshot = result.snapshot;
    state.snapshot.pending = [];
    return state;
  });
  const saved = await store.read();
  console.log(JSON.stringify({
    ok: true,
    baselined: true,
    events: 0,
    calls: Object.keys(saved.snapshot.calls).length,
    stamp: saved.snapshot.stamp
  }));
}

function diffFiles(beforeFile, afterFile) {
  const before = readDoc(beforeFile);
  const after = readDoc(afterFile);
  const anchored = diffDocument(null, before, new Date().toISOString());
  const next = diffDocument(anchored.snapshot, after, new Date().toISOString());
  console.log(JSON.stringify({
    ok: true,
    events: next.events.map((event) => ({
      id: event.id,
      category: event.category,
      asset: event.asset,
      callId: event.callId,
      name: event.name
    }))
  }));
}

function usage() {
  console.error('Usage: node src/cli.js baseline <calls.json>');
  console.error('       node src/cli.js diff <before.json> <after.json>');
  process.exit(2);
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'baseline' && process.argv[3]) return baseline(process.argv[3]);
  if (cmd === 'diff' && process.argv[3] && process.argv[4]) return diffFiles(process.argv[3], process.argv[4]);
  usage();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : 'cli_failed');
    process.exit(1);
  });
}

module.exports = { baseline, diffFiles };
