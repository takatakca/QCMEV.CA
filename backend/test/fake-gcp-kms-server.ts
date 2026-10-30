/**
 * The in-memory Google Cloud KMS (fake-gcp-kms.ts) as a local HTTP server, to run the whole SEV with
 * SEV_KEY_CUSTODY=gcp-kms on the simulator (SIMULATOR / DEV only accept an http://127.0.0.1 KMS):
 *
 *   FAKE_KMS_PORT=4555 FAKE_KMS_SA_FILE=/tmp/x/sa.json npx ts-node --transpile-only test/fake-gcp-kms-server.ts
 *   SEV_KEY_CUSTODY=gcp-kms QCMEV_GCP_KMS_ENDPOINT=http://127.0.0.1:4555 QCMEV_GCP_KMS_CREDENTIALS_FILE=/tmp/x/sa.json \
 *   QCMEV_GCP_KMS_KEY_RING=projects/takatak-mev-test/locations/northamerica-northeast1/keyRings/qcmev-sev ...
 *
 * GET /_stats → keys created (with their protection level and state) and how many signatures KMS made.
 */
import * as fs from 'fs';
import * as http from 'http';
import { createFakeKms } from './fake-gcp-kms';

const port = Number(process.env.FAKE_KMS_PORT ?? 4555);
const base = `http://127.0.0.1:${port}`;
const kms = createFakeKms({ endpoint: base, tokenUri: `${base}/token` });
const saFile = process.env.FAKE_KMS_SA_FILE;
if (!saFile) throw new Error('FAKE_KMS_SA_FILE is required');
fs.writeFileSync(saFile, JSON.stringify(kms.serviceAccount), { mode: 0o600 });

http
  .createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      if (req.url === '/_stats') {
        const keys = [...kms.keys.values()].map((k) => ({ name: k.name, protectionLevel: k.protectionLevel, state: k.state }));
        const signatures = kms.calls.filter((c) => c.path.endsWith(':asymmetricSign')).length;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys, signatures, tokens: kms.tokensIssued }));
        return;
      }
      const r = await kms.fetch(`${base}${req.url}`, { method: req.method ?? 'GET', headers: { Authorization: String(req.headers.authorization ?? '') }, body: Buffer.concat(chunks).toString() || undefined });
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(await r.text());
    });
  })
  // eslint-disable-next-line no-console -- a test server tells where it listens
  .listen(port, '127.0.0.1', () => console.log(`fake Google Cloud KMS on ${base}`));
