// A capture server for the FU-1 tests, run as its own process. Usage:
//   node capture-server.js <config.json> <counts file>
// config: { packages: <as registry-stub.js>, key?: <PEM file>, cert?: <PEM file> }
// It is a registry, a forward proxy (absolute-form requests are answered from the same packages)
// and, given a key and certificate, a TLS-intercepting proxy for CONNECT. The dummy token to look
// for arrives in MARROW_CAPTURE_TOKEN; it is never printed or written. The counts file holds only
// { requests, token_hits } (the token, or its base64, anywhere in a request line or header).
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const tls = require('node:tls');

const [configPath, countsPath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const token = String(process.env.MARROW_CAPTURE_TOKEN || '');
delete process.env.MARROW_CAPTURE_TOKEN;
const needles = token ? [token, Buffer.from(token).toString('base64')] : [];
const counts = { requests: 0, token_hits: 0 };
const save = () => fs.writeFileSync(countsPath, JSON.stringify(counts));
save();

function record(text) {
  counts.requests += 1;
  for (const needle of needles) counts.token_hits += text.split(needle).length - 1;
  save();
}

function answer(req, res, origin) {
  record(`${req.method} ${req.url}\n${req.rawHeaders.join('\n')}`);
  const url = decodeURIComponent(new URL(req.url, origin).pathname);
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
    doc.versions[version] = {
      ...JSON.parse(fs.readFileSync(entry.manifest, 'utf8')),
      dist: { tarball: `${origin}/-/tarballs/${name}/${version}.tgz`, integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`, shasum: crypto.createHash('sha1').update(bytes).digest('hex') },
    };
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  return res.end(JSON.stringify(doc));
}

const inner = http.createServer((req, res) => answer(req, res, `https://${req.headers.host}`));
const server = http.createServer((req, res) => {
  const absolute = /^https?:\/\//.test(req.url);
  return answer(req, res, absolute ? new URL(req.url).origin : `http://${req.headers.host}`);
});
server.on('connect', (req, socket) => {
  record(`CONNECT ${req.url}\n${req.rawHeaders.join('\n')}`);
  if (!config.key || !config.cert) return socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  const secure = new tls.TLSSocket(socket, { isServer: true, key: fs.readFileSync(config.key), cert: fs.readFileSync(config.cert) });
  secure.on('error', () => {});
  return inner.emit('connection', secure);
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`${server.address().port}\n`));
