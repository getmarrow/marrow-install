// A local npm registry for self-heal tests, run as its own process (hooks are started with
// spawnSync, which would block a server in the test process). Usage:
//   node registry-stub.js <config.json> <log file>
// config: { packages: { "<name>": { "<version>": { tarball: "<path>", integrity?: "<sha512-...>" } } } }
// It prints its port on stdout, serves packuments and tarballs, and appends one line per request
// to the log file. The integrity it announces is the tarball's own unless the config overrides it.
// config.status answers every request with that HTTP status (registry down); config.hang never
// answers (a registry that hangs).
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');

const [configPath, logPath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const server = http.createServer((req, res) => {
  fs.appendFileSync(logPath, `${req.method} ${req.url}\n`);
  if (config.hang) return undefined;
  if (config.status) return res.writeHead(config.status, { 'content-type': 'application/json' }).end('{"error":"down"}');
  const url = decodeURIComponent(req.url.split('?')[0]);
  const port = server.address().port;
  const tarball = url.match(/^\/-\/tarballs\/(.+)\/(\d+\.\d+\.\d+)\.tgz$/);
  if (tarball) {
    const entry = config.packages[tarball[1]]?.[tarball[2]];
    if (!entry) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    return res.end(fs.readFileSync(entry.tarball));
  }
  const name = url.slice(1);
  const versions = config.packages[name];
  if (!versions) return res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
  const doc = { name, 'dist-tags': { latest: Object.keys(versions).pop() }, versions: {} };
  for (const [version, entry] of Object.entries(versions)) {
    const bytes = fs.readFileSync(entry.tarball);
    const manifest = JSON.parse(fs.readFileSync(entry.manifest, 'utf8'));
    doc.versions[version] = {
      ...manifest,
      dist: {
        tarball: `http://127.0.0.1:${port}/-/tarballs/${name}/${version}.tgz`,
        integrity: entry.integrity || `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
        shasum: crypto.createHash('sha1').update(bytes).digest('hex'),
      },
    };
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  return res.end(JSON.stringify(doc));
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`${server.address().port}\n`));
