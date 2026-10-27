# Garde des clés privées du SEV (KMS / HSM) — note de conception, 2026-10-27

**État : pas construit. PROD reste refusé** (`backend/src/config/app-config.ts`) tant que les clés privées des appareils
sont des clés logicielles exportables. SW-76 (2025-06) § 4.2.1 demande une clé privée **non exportable** en mode SEV.
Décision du propriétaire attendue : le fournisseur (ci-dessous). Rien n'est codé avant ce choix.

## Où la clé privée sert aujourd'hui (à remplacer, rien d'autre)

| Endroit | Usage |
|---|---|
| `crypto/csr.ts` `generateKeyAndCsr` | crée la paire P-256 dans Node et signe la demande de certificat (CRT) |
| `certificates/certificates.service.ts` l. 86–129 | garde la clé chiffrée AES-256-GCM en base (`encryptedPrivateKey`) |
| `certificates/certificates.service.ts` l. 166–176 `signingMaterial` | déchiffre la clé pour chaque signature |
| `transactions/transactions.service.ts` l. 160 | `signa.actu` de chaque transaction (`signP256`) |
| `mev-web/mev-web.service.ts` l. 199 | en-tête `SIGNATRANSM` de chaque envoi (`signP256`) |
| `reports/reports.ts`, `operators/operators.ts` | passent `signingMaterial` à MEV-WEB (rapport, UTL) |

La clé ne sert **pas** au TLS (aucun certificat client dans les appels HTTPS) : un KMS distant suffit, sans moteur
OpenSSL ni pilote PKCS#11 dans Node.

## Ce qui change (même code partout, un seul point d'entrée)

1. Une interface `SevKeyCustody` : `createKey(deviceId) → { keyRef, publicKeySpki }` et
   `sign(keyRef, data) → signature r||s 64 octets` (le KMS rend du DER : conversion en r||s, comme `dsaEncoding:
   'ieee-p1363'` aujourd'hui ; test : 88 caractères base64, `verifyP256` avec le certificat).
2. `software` (l'actuel, SIMULATOR / DEV / ESSAI) et **un** fournisseur KMS derrière la même interface
   (`SEV_KEY_CUSTODY=software | gcp-kms | aws-kms`).
3. CRT : la demande PKCS#10 est construite avec la clé publique du KMS et signée par `sign()` (la partie « à signer »
   du CSR est assemblée en ASN.1, puis la signature y est ajoutée).
4. En base : `keyRef` (le nom de la clé dans le KMS) au lieu de `encryptedPrivateKey`. Renouvellement (CRT REM) = une
   nouvelle version de clé, l'ancienne désactivée après l'acceptation du nouveau certificat.
5. `app-config.ts` : PROD accepté seulement avec un fournisseur KMS et `QCMEV_CERTIFICATION_NUMBER`.
6. Tests : un faux KMS (clé en mémoire, même interface) pour toute la suite ; un test opt-in contre le vrai KMS.

## Fournisseurs (tous font ECDSA P-256 / SHA-256, clé non exportable)

| | Google Cloud KMS | AWS KMS | Azure Key Vault (Premium / Managed HSM) |
|---|---|---|---|
| Algorithme | `EC_SIGN_P256_SHA256` | `ECC_NIST_P256` + `ECDSA_SHA_256` | `P-256` / `ES256` |
| Protection matérielle | niveau `HSM` (FIPS 140-2 niveau 3) | HSM du service | Premium (HSM) ou Managed HSM |
| Région au Québec | `northamerica-northeast1` (Montréal) | `ca-central-1` (Montréal) | Canada Est (Québec) |
| Coût | par clé et par opération (vérifier le tarif du jour) | idem | idem |

**Recommandation : Google Cloud KMS, niveau HSM, région Montréal** — même compte Google que le reste de TAKATAK,
données au Québec (Loi 25), une clé par appareil SEV. AWS KMS au même niveau si l'hébergement passe chez AWS.

## À demander à Revenu Québec (par écrit, avec le dossier SW-10)

- Une clé gardée dans un HSM infonuagique (KMS) et utilisée par le SEV par appel réseau satisfait-elle SW-76 § 4.2.1
  « clé privée non exportable » pour un SEV infonuagique ?
- Une clé par appareil (IDAPPRL), comme aujourd'hui : confirmé ?

## Estimation

Environ une journée de code et de tests après le choix, plus la création du compte / trousseau KMS par le
propriétaire (identifiants dans l'environnement, jamais dans git).
