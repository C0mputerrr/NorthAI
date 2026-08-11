/**
 * Static file serving for the web/ directory.
 *
 * Deliberately small: no build step, no bundler, no dependency. Files are read
 * from disk and cached in memory keyed by mtime, which keeps the dev loop
 * honest while costing nothing at runtime for a directory this size.
 */

import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const cache = new Map();

export async function serveStatic(root, urlPath, res) {
  // Resolve inside `root` and verify containment. `normalize` collapses
  // ../ segments; the prefix check rejects anything that escaped anyway.
  const rel = decodeURIComponent(urlPath.split('?')[0]);
  const target = normalize(join(root, rel === '/' ? '/index.html' : rel));
  if (!target.startsWith(root + sep) && target !== join(root, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return true;
  }

  let info;
  try {
    info = await stat(target);
    if (!info.isFile()) return false;
  } catch {
    return false;
  }

  const key = `${target}:${info.mtimeMs}`;
  let body = cache.get(key);
  if (!body) {
    body = await readFile(target);
    cache.clear(); // only ever hold the current generation
    cache.set(key, body);
  }

  res.writeHead(200, {
    'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
    'Content-Length': body.length,
    // The dashboard is local and changes when we edit it; don't fight ourselves.
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
  return true;
}
