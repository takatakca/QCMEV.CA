#!/usr/bin/env node
/**
 * Records the Takatak MEV walkthrough as a video, driving the real dashboard of a running demo stack
 * (tools/demo-video/stack.mjs) with Playwright. Every scene has a French caption burned into the picture.
 *
 *   node tools/demo-video/stack.mjs            # terminal 1, wait for READY
 *   node tools/demo-video/record.mjs           # terminal 2
 *
 * Reads <QCMEV_DEMO_DIR>/demo.json (written by stack.mjs). Writes the video and one screenshot per scene into
 * QCMEV_DEMO_OUT (default <demo dir>/video). Converts to MP4 when ffmpeg is installed.
 *
 * HONESTY: this is a rehearsal against QCMEV's LOCAL SIMULATOR with fictitious data. It is not a run in Revenu
 * Québec's DEV or ESSAI environment and proves nothing about certification. The opening and closing cards say so.
 * When Revenu Québec gives the personalized SW-77 cases and ESSAI access, record the official demonstration with the
 * stack pointed at ESSAI and the scenes replaced by those cases.
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = createRequire(path.join(spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout.trim(), 'x'))('playwright'));
}

const demoDir = process.env.QCMEV_DEMO_DIR;
if (!demoDir) {
  console.error('QCMEV_DEMO_DIR is required (the folder stack.mjs printed)');
  process.exit(1);
}
const demo = JSON.parse(fs.readFileSync(path.join(demoDir, 'demo.json'), 'utf8'));
const out = path.resolve(process.env.QCMEV_DEMO_OUT ?? path.join(demoDir, 'video'));
fs.mkdirSync(out, { recursive: true });

const W = 1280;
const H = 800;
const PACE = Number(process.env.QCMEV_DEMO_PACE ?? 1); // 1 = normal reading speed; 0.2 for a fast dry run
const pause = (ms) => new Promise((r) => setTimeout(r, Math.round(ms * PACE)));
const t0 = Date.now();
const log = (m) => console.log(`[demo-record ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

/** Backend call outside the browser (simulator switch only: the dashboard never exposes it). */
async function backend(method, p, body) {
  const r = await fetch(`${demo.api}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${await r.text()}`);
  return r.json();
}

// Caption bar + title cards, kept across page loads (localStorage) so every frame carries its explanation.
const OVERLAY = () => {
  const paint = () => {
    const cap = localStorage.getItem('demoCaption') || '';
    const card = localStorage.getItem('demoCard') || '';
    let bar = document.getElementById('demo-caption');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'demo-caption';
      bar.style.cssText =
        'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(10,20,60,.92);color:#fff;' +
        'font:600 19px/1.35 system-ui,sans-serif;padding:14px 28px;border-top:3px solid #3b82f6;white-space:pre-line;' +
        'pointer-events:none';
      document.body && (document.body.style.paddingBottom = '110px');
      document.documentElement.appendChild(bar);
    }
    bar.textContent = cap;
    bar.style.display = cap ? 'block' : 'none';
    let full = document.getElementById('demo-card');
    if (!full) {
      full = document.createElement('div');
      full.id = 'demo-card';
      full.style.cssText =
        'position:fixed;inset:0;z-index:2147483646;background:#0b1640;color:#fff;display:flex;align-items:center;' +
        'justify-content:center;text-align:center;font:500 26px/1.5 system-ui,sans-serif;padding:60px;white-space:pre-line;' +
        'pointer-events:none';
      document.documentElement.appendChild(full);
    }
    full.textContent = card;
    full.style.display = card ? 'flex' : 'none';
  };
  window.__demoPaint = paint;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint);
  else paint();
};

let shot = 0;
async function caption(page, text, ms = 3500) {
  await page.evaluate((t) => {
    localStorage.setItem('demoCaption', t);
    window.__demoPaint?.();
  }, text);
  await pause(ms);
  await page.screenshot({ path: path.join(out, `${String(++shot).padStart(2, '0')}.png`) });
}
async function card(page, text, ms = 5000) {
  await page.evaluate((t) => {
    localStorage.setItem('demoCard', t);
    localStorage.setItem('demoCaption', '');
    window.__demoPaint?.();
  }, text);
  await pause(ms);
  await page.screenshot({ path: path.join(out, `${String(++shot).padStart(2, '0')}.png`) });
  await page.evaluate(() => {
    localStorage.setItem('demoCard', '');
    window.__demoPaint?.();
  });
}
async function go(page, route) {
  await page.goto(demo.web + route);
  await page.waitForLoadState('networkidle');
}

/** Fill the « Nouvelle vente » form and issue it. Returns the transaction page URL. */
async function sale(page, s) {
  await go(page, '/transactions/new');
  for (let i = 0; i < s.items.length; i++) {
    if (i > 0) await page.getByRole('button', { name: '+ Ajouter' }).click();
    const row = page.locator('input[placeholder="Article"]').nth(i).locator('xpath=ancestor::div[contains(@class,"grid") or contains(@class,"flex")][1]');
    await page.locator('input[placeholder="Article"]').nth(i).fill(s.items[i][0]);
    const numbers = row.locator('input[type=number]');
    await numbers.nth(0).fill(String(s.items[i][1]));
    await numbers.nth(1).fill(String(s.items[i][2]));
    await row.locator('select').selectOption(s.items[i][3] ?? 'FP');
    await pause(300);
  }
  const form = page.locator('form');
  if (s.payment) await form.locator('select').filter({ hasText: 'Comptant' }).selectOption(s.payment);
  if (s.tip) await page.getByPlaceholder('0.00').fill(s.tip);
  if (s.table) await form.locator('label:has-text("N° de table") + input').fill(s.table);
  if (s.covers) await form.locator('label:has-text("Nbre de couverts") + input').fill(s.covers);
  if (s.kind) await page.locator('#documentKind').selectOption(s.kind);
  if (s.service) await page.locator('#serviceType').selectOption(s.service);
  if (s.format) await page.locator('#printFormat').selectOption(s.format);
  if (s.training) await page.locator('#training').check();
  await page.locator('button[type=submit]').scrollIntoViewIfNeeded();
  await caption(page, s.caption, 4500);
  await page.locator('button[type=submit]').click();
  await page.waitForURL(/\/transactions\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  return page.url();
}

async function showReceipt(page, text, ms = 6000) {
  await caption(page, text, 1500);
  await page.mouse.wheel(0, 260);
  await pause(ms / 2);
  await page.mouse.wheel(0, 500);
  await pause(ms / 2);
  await page.screenshot({ path: path.join(out, `${String(++shot).padStart(2, '0')}.png`) });
  await page.mouse.wheel(0, -2000);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: out, size: { width: W, height: H } }, locale: 'fr-CA' });
await context.addInitScript(OVERLAY);
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
let failed = null;

try {
  await backend('POST', '/mev-simulator/_control', { mevDown: false });
  await go(page, '/login');
  await card(
    page,
    'Takatak MEV — Système d\'enregistrement des ventes (SEV), secteur restauration\n\n' +
      'Démonstration enregistrée sur le SIMULATEUR LOCAL de Takatak MEV, avec des données fictives.\n' +
      'Ce n\'est PAS l\'environnement de Revenu Québec (DEV / ESSAI) et ce n\'est pas une certification.\n\n' +
      'Mode d\'opération : mode SEV — Takatak MEV numérote, signe et transmet chaque transaction lui-même.',
    9000,
  );

  // 1. Login
  await caption(page, '1. Connexion de l\'utilisateur (gérant). Chaque utilisateur est inscrit au MEV-WEB (requête UTL).', 2500);
  await page.locator('input[type=text]').fill(demo.admin.username);
  await page.locator('input[type=password]').fill(demo.admin.password);
  await pause(800);
  await page.locator('button[type=submit]').click();
  await page.waitForURL(demo.web + '/');
  await page.waitForLoadState('networkidle');
  await caption(page, '2. Tableau de bord : certificat du SEV actif, appareil en ligne, file d\'attente vide, environnement SIMULATEUR.', 6000);

  // 2. Devices and certificate
  await go(page, '/devices');
  await caption(page, '3. Appareils : chaque appareil a son certificat (requête CRT — clé ECDSA P-256), sa chaîne de signatures et sa numérotation.', 6000);

  // 3. Counter sale, closing receipt, cash
  const s1 = await sale(page, {
    items: [['Poutine régulière', 1, 11.5, 'FP'], ['Boisson gazeuse', 2, 2.75, 'FP']],
    caption: '4. Vente au comptoir : reçu de fermeture (RFER), paiement comptant, TPS et TVQ calculées en cents.',
  });
  await showReceipt(page, '5. La facture telle que Revenu Québec la décrit : mentions, TPS / TVQ, code QR, heure de traitement et numéro MEV-WEB.');

  // 4. Reproduction and merchant copy
  await caption(page, '6. Reproduction (RPR) : une nouvelle transaction transmise, marquée « REPRODUCTION ».', 2500);
  await page.getByRole('button', { name: 'Reproduction' }).click();
  await page.waitForURL((u) => u.href !== s1);
  await page.waitForLoadState('networkidle');
  await showReceipt(page, '6. Reproduction (RPR) transmise au MEV-WEB, avec la mention « REPRODUCTION ».', 5000);
  await page.goto(s1);
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Copie du commerçant' }).click();
  await page.waitForURL((u) => u.href !== s1);
  await page.waitForLoadState('networkidle');
  await showReceipt(page, '7. Copie du commerçant (DUP) : « COPIE DU COMMERÇANT — NE PAS REMETTRE AU CLIENT ».', 5000);

  // 5. Credit note
  await page.goto(s1);
  await page.waitForLoadState('networkidle');
  await caption(page, '8. Note de crédit : la vente est créditée en entier par une transaction négative qui la référence.', 2500);
  await page.getByRole('button', { name: 'Note de crédit' }).click();
  await page.waitForURL((u) => u.href !== s1);
  await page.waitForLoadState('networkidle');
  await showReceipt(page, '8. Note de crédit transmise : montants négatifs, référence à la facture d\'origine.', 5000);

  // 6. Table service: bill then closing receipt with a tip
  await sale(page, {
    items: [['Table d\'hôte du jour', 2, 24, 'FP'], ['Verre de vin', 2, 9, 'FP']],
    kind: 'ADDITION',
    service: 'TBL',
    table: '12',
    covers: '2',
    caption: '9. Service aux tables : l\'addition (ADDI) est produite avant le paiement — numéro de table et nombre de clients.',
  });
  await showReceipt(page, '9. Addition de la table 12 (2 clients) : document transmis, sans paiement.', 5000);
  await sale(page, {
    items: [['Table d\'hôte du jour', 2, 24, 'FP'], ['Verre de vin', 2, 9, 'FP']],
    payment: 'CREDIT_CARD',
    tip: '10.00',
    service: 'TBL',
    table: '12',
    covers: '2',
    caption: '10. Paiement de la table 12 par carte de crédit avec pourboire : le pourboire est inscrit à part, jamais dans le total.',
  });
  await showReceipt(page, '10. Reçu de fermeture : le pourboire suit le total après taxes.', 5000);

  // 7. Training mode
  await sale(page, {
    items: [['Burger (formation)', 1, 14, 'FP']],
    training: true,
    caption: '11. Mode formation : la transaction est transmise en mode FOR et le document porte la mention de formation.',
  });
  await showReceipt(page, '11. « DOCUMENT DE FORMATION » : aucune valeur, visible sur la facture.', 5000);

  // 8. Electronic invoice
  await sale(page, {
    items: [['Salade César', 1, 13.5, 'FP']],
    payment: 'DEBIT_CARD',
    format: 'ELE',
    caption: '12. Facture électronique (ELE) : le client reçoit le lien « Consulter la transaction en ligne » sous le code QR.',
  });
  await showReceipt(page, '12. Facture électronique : lien de consultation sous le code QR.', 5000);

  // 9. Offline mode
  await backend('POST', '/mev-simulator/_control', { mevDown: true });
  await go(page, '/');
  await caption(page, '13. Panne de communication avec le MEV-WEB (simulée). Le SEV continue de facturer : mode hors ligne.', 4500);
  await sale(page, {
    items: [['Club sandwich', 1, 16, 'FP']],
    caption: '13. Vente pendant la panne : la transaction est signée localement et mise en file.',
  });
  const offline = page.url();
  await showReceipt(page, '14. Facture hors ligne : « PROBLÈME DE COMMUNICATION » remplace l\'heure de traitement et le numéro MEV-WEB.', 6000);
  await go(page, '/');
  await caption(page, '15. Tableau de bord : l\'appareil est hors ligne et la transaction attend dans la file (délai maximal : 48 heures).', 5000);
  await backend('POST', '/mev-simulator/_control', { mevDown: false });
  await caption(page, '16. La communication revient : la file est transmise automatiquement en lot (transLot), dans l\'ordre.', 4000);
  // Wait for the automatic flush (MEV_OFFLINE_FLUSH_SECONDS) before claiming the queue is empty
  for (let i = 0; i < 60; i++) {
    await go(page, '/');
    if (await page.getByText(/^\s*0\s*tx\s*$/).count()) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await caption(page, '16. File vide, appareil de nouveau en ligne.', 4000);
  await page.goto(offline);
  await page.waitForLoadState('networkidle');
  await caption(page, '17. La transaction faite pendant la panne a maintenant son accusé et son numéro MEV-WEB.', 6000);

  // 10. Transactions list + user report
  await go(page, '/transactions');
  await caption(page, '18. Liste des transactions de la journée : chaque document est numéroté par appareil et chaîné.', 6000);
  await go(page, '/reports/user-report');
  await caption(page, '19. Rapport de l\'utilisateur : produit sur demande, ses sommes sont transmises au MEV-WEB (DOC RUT).', 4000);
  const produce = page.getByRole('button', { name: /Produire|Générer/ });
  if (await produce.count()) {
    await produce.first().click();
    await page.waitForLoadState('networkidle');
    await pause(1500);
  }
  await caption(page, '19. Rapport de l\'utilisateur produit.', 6000);

  await card(
    page,
    'Fin de la démonstration\n\n' +
      'Enregistrée sur le simulateur local de Takatak MEV, données fictives.\n' +
      'La démonstration officielle sera refaite dans l\'environnement d\'ESSAI de Revenu Québec,\n' +
      'avec les cas d\'essais SW-77 personnalisés fournis par Revenu Québec.',
    8000,
  );
} catch (e) {
  failed = e;
  log(`FAILED: ${e.message}`);
  await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
} finally {
  await backend('POST', '/mev-simulator/_control', { mevDown: false }).catch(() => {});
  const video = page.video();
  await context.close();
  await browser.close();
  const webm = video ? await video.path() : null;
  if (webm) {
    const final = path.join(out, 'takatak-mev-demonstration.webm');
    fs.renameSync(webm, final);
    log(`video: ${final}`);
    const mp4 = final.replace(/\.webm$/, '.mp4');
    const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', final, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
    if (ff.status === 0) log(`video: ${mp4}`);
    else log('ffmpeg not available: kept the WebM only');
  }
  process.exit(failed ? 1 : 0);
}
