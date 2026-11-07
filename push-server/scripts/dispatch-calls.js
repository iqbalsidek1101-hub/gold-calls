#!/usr/bin/env node
'use strict';

/* Post calls.json to the push server after a score or analysis publish.
   The dispatch token is read from the environment only. Do not pass it as an argument. */

const fs = require('fs');
const http = require('http');
const https = require('https');

function fail(message, code) {
  console.error(message);
  process.exit(code);
}

function main() {
  const origin = process.env.CHARLIE_PUSH_ORIGIN || '';
  const token = process.env.CHARLIE_DISPATCH_TOKEN || '';
  const file = process.argv[2];
  if (!origin || !token || !file) {
    fail('Set CHARLIE_PUSH_ORIGIN and CHARLIE_DISPATCH_TOKEN in the environment, and pass the calls.json path.', 2);
  }
  if (process.argv.slice(2).some((arg) => arg && token && arg.indexOf(token) >= 0)) {
    fail('Do not pass the dispatch token on the command line.', 2);
  }
  let url;
  try { url = new URL('/v1/dispatch', origin); }
  catch (err) { fail('CHARLIE_PUSH_ORIGIN is not a URL.', 2); }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    fail('Refusing to send the dispatch token over non-local HTTP.', 2);
  }
  let body;
  try { body = fs.readFileSync(file); }
  catch (err) { fail('Cannot read calls.json.', 2); }
  try { JSON.parse(body.toString('utf8')); }
  catch (err) { fail('calls.json is not JSON.', 2); }

  const lib = url.protocol === 'https:' ? https : http;
  const req = lib.request({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      Authorization: 'Bearer ' + token
    },
    timeout: 30000
  }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      process.stdout.write(text + (text.endsWith('\n') ? '' : '\n'));
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
  });
  req.on('timeout', () => {
    req.destroy();
    fail('Dispatch timed out.', 1);
  });
  req.on('error', () => fail('Dispatch request failed.', 1));
  req.end(body);
}

main();
