#!/usr/bin/env node
/**
 * Browser check of the self-serve path a TAKATAK MEV (Clover App Market) merchant follows in the dashboard, against a
 * running demo stack (stack.mjs, SIMULATOR): sign-up page with the Food Hub kitchen code from Clover → signed in →
 * Appareils with the code pre-filled → its Clover register enrolled → certificate (Paramètres) → kitchen linked →
 * the three ready flags Food Hub reads in /health (device, certificate, FOODHUB-AUTO). Also: mismatched passwords,
 * a second sign-up with the same NEQ (409), the new operator sees no other operator's device.
 *
 *   node tools/demo-video/stack.mjs                       (another terminal)
 *   node tools/demo-video/check-signup.mjs [<dir>/demo.json] [<screenshots dir>]
 *
 * Every run uses a new random NEQ, username and kitchen code (placeholder values, simulator only).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const demoFile = process.argv[2] ?? path.join(process.env.QCMEV_DEMO_DIR ?? '', 'demo.json');
const demo = JSON.parse(fs.readFileSync(demoFile, 'utf8'));
const out = process.argv[3] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'qcmev-signup-'));
fs.mkdirSync(out, { recursive: true });

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CODE = `CLV_${[...crypto.randomBytes(16)].map((b) => B32[b & 31]).join('')}`;
const NEQ = String(crypto.randomInt(1_000_000_000, 9_999_999_999));
const USER = `gerante-${crypto.randomBytes(3).toString('hex')}`;
const PASSWORD = `Essai-${crypto.randomBytes(6).toString('hex')}!`;
const NAME = `Restaurant Essai ${USER} (données fictives)`;

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const shot = (page, n) => page.screenshot({ path: path.join(out, `signup-${n}.png`), fullPage: true });

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('dialog', (d) => d.accept());
  await page.goto(`${demo.web}/register?tenant=takatak&fh=${CODE}`);
  await page.getByRole('heading', { name: 'Créer un compte Takatak MEV' }).waitFor();
  check('the sign-up page opens without sign-in', true);
  check('the Food Hub kitchen code from TAKATAK MEV is shown', await page.getByText(CODE).isVisible());

  const fill = (label, v) => page.getByLabel(label, { exact: true }).fill(v);
  await fill('Nom légal ou commercial', NAME);
  await fill('NEQ (10 chiffres)', NEQ);
  await fill('No TPS', '123456789RT0001');
  await fill('No TVQ', '1234567890TQ0001');
  await fill('Adresse', '2 rue Exemple');
  await fill('Code postal', 'H2X 1Y4');
  await fill('Ville', 'Montréal');
  await fill('Prénom', 'Gérante');
  await fill('Nom', 'Essai');
  await fill("Nom d'utilisateur", USER);
  await fill('Mot de passe (12 caractères ou plus)', PASSWORD);
  await fill('Confirmer le mot de passe', `${PASSWORD}x`);
  await page.getByRole('button', { name: 'Créer le compte' }).click();
  check('two different passwords are refused before anything is sent', await page.getByText('Les deux mots de passe ne sont pas identiques.').isVisible());
  await fill('Confirmer le mot de passe', PASSWORD);
  await shot(page, '1-form');
  await page.getByRole('button', { name: 'Créer le compte' }).click();
  await page.waitForURL(/\/devices/, { timeout: 20_000 });
  check('account created → signed in → Appareils', true);

  const kitchen = page.locator('input[placeholder="KITCHEN_A"]');
  await kitchen.waitFor({ timeout: 15_000 });
  check('« Cuisines Food Hub » is pre-filled with the code', (await kitchen.inputValue()) === CODE, await kitchen.inputValue());
  const token = await page.evaluate(() => localStorage.getItem('takatak_token'));
  const api = (p) => page.evaluate(async ([u, t]) => (await fetch(u, { headers: { Authorization: `Bearer ${t}` } })).json(), [`/api${p}`, token]);
  check('the new account is its own operator', (await api('/operators/me'))?.name === NAME);
  const before = await api('/devices');
  check('it sees no other operator\'s device', Array.isArray(before) && before.length === 0);
  await shot(page, '2-devices');

  // Its Clover register as a SEV device (placeholder file number and authorization code: simulator only).
  await page.getByRole('button', { name: '+ Enregistrer un appareil' }).click();
  await page.getByPlaceholder('Caisse principale').fill('Clover Station (essai)');
  await page.getByPlaceholder('SN-123456').fill(`CLOVER-${USER.toUpperCase()}`);
  await page.getByPlaceholder('facultatif maintenant').nth(0).fill('ER0001');
  await page.getByPlaceholder('facultatif maintenant').nth(1).fill('ABCD-1234');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await page.getByRole('heading', { name: 'Clover Station (essai)' }).waitFor({ timeout: 15_000 });
  check('its Clover register is enrolled as a device', true);

  await page.goto(`${demo.web}/settings`);
  await page.getByRole('button', { name: /Demander un certificat/ }).click();
  await page.getByText(/Demande de certificat soumise avec succès/).waitFor({ timeout: 30_000 });
  check('its certificate is issued (CRT, then UTL)', true);
  await shot(page, '3-certificate');

  await page.goto(`${demo.web}/devices`);
  await kitchen.waitFor();
  check('the code is still pre-filled after the certificate', (await kitchen.inputValue()) === CODE);
  await page.getByRole('button', { name: 'Lier la cuisine' }).click();
  const notice = page.getByText(new RegExp(`Cuisine ${CODE} liée`));
  await notice.waitFor({ timeout: 20_000 });
  check('linked, FOODHUB-AUTO registered with MEV-WEB', /FOODHUB-AUTO inscrit au MEV-WEB/.test(await notice.innerText()));
  const flags = await page.locator('tr', { hasText: CODE }).locator('span').allInnerTexts();
  check('ready: device, certificate, FOODHUB-AUTO (what Food Hub reads in /health)', ['Appareil', 'Certificat', 'FOODHUB-AUTO'].every((f) => flags.includes(f)), flags.join(' · '));
  check('the code is no longer kept in the browser', (await page.evaluate(() => localStorage.getItem('takatak_foodhub_link'))) === null);
  await shot(page, '4-linked');

  const again = await browser.newPage();
  await again.goto(`${demo.web}/register`);
  const f2 = (label, v) => again.getByLabel(label, { exact: true }).fill(v);
  await f2('Nom légal ou commercial', 'Doublon');
  await f2('NEQ (10 chiffres)', NEQ);
  await f2('No TPS', '123456789RT0001');
  await f2('No TVQ', '1234567890TQ0001');
  await f2("Nom d'utilisateur", `${USER}-2`);
  await f2('Mot de passe (12 caractères ou plus)', PASSWORD);
  await f2('Confirmer le mot de passe', PASSWORD);
  await again.getByRole('button', { name: 'Créer le compte' }).click();
  await again.getByText('An operator with this NEQ is already registered').waitFor({ timeout: 10_000 });
  check('the same NEQ twice is refused (409) with its message', true);
  await again.goto(`${demo.web}/login`);
  check('the login page links to « Créer un compte »', await again.getByRole('link', { name: 'Créer un compte' }).isVisible());
} catch (e) {
  check('unexpected error', false, e instanceof Error ? e.message : String(e));
} finally {
  await browser.close();
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed · screenshots: ${out}`);
process.exit(failed ? 1 : 0);
