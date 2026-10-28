# Garde des clés privées du SEV (Google Cloud KMS) — 2026-10-28

**État : construit et testé contre un KMS factice local; pas encore contre le vrai Google Cloud KMS.**
SW-76 (2025-06) § 4.2.1 demande une clé privée **non exportable** en mode SEV. Avec `SEV_KEY_CUSTODY=gcp-kms`, chaque
clé d’appareil est créée **dans** Google Cloud KMS (algorithme `EC_SIGN_P256_SHA256`, niveau `HSM`) et n’en sort jamais :
QCMEV garde seulement son nom (scellé AES-256-GCM, dans la même colonne qu’avant — aucune migration) et demande à KMS
chaque signature. **PROD ne démarre qu’avec `gcp-kms` au niveau HSM** et le numéro de certification; un appareil qui
aurait encore une clé logicielle ne signe rien en PROD.

## Ce qui est signé par KMS

| Endroit | Signature |
|---|---|
| `crypto/csr.ts` `csrForKey` | la demande de certificat (CRT `AJO` / `REM`) |
| `transactions/transactions.service.ts` | `signa.actu` de chaque transaction |
| `mev-web/mev-web.service.ts` | l’en-tête `SIGNATRANSM` de chaque envoi (TRX, UTL, DOC, CRT `REM`) |

Chaque signature rendue par KMS est vérifiée avec la clé publique avant usage (une réponse fausse ou corrompue n’est
jamais transmise). Le renouvellement (CRT `REM`) crée une nouvelle clé et **désactive** l’ancienne (pas détruite).
Code : `backend/src/crypto/key-custody.ts`, `backend/src/crypto/gcp-kms.ts`. API REST v1 + compte de service (JWT),
aucune dépendance ajoutée. La clé ne sert pas au TLS.

## Preuves (2026-10-28)

- Tests unitaires `backend/test/key-custody.spec.ts` (12) contre un KMS en mémoire qui signe le condensé SHA-256 comme
  le vrai (`backend/test/fake-gcp-kms.ts`) : création HSM (attente `PENDING_GENERATION` → `ENABLED`), signature
  88 caractères vérifiée, CSR signé dans KMS et vérifié, réponse corrompue refusée, renouvellement désactive l’ancienne
  clé, compte de service refusé, configuration PROD. Suite complète : 217 tests.
- Parcours complet sur le simulateur avec le KMS factice comme serveur HTTP (`backend/test/fake-gcp-kms-server.ts`) :
  certificat de l’appareil de démo, inscription d’un restaurant dans le navigateur (`tools/demo-video/check-signup.mjs`,
  15/15), vente Food Hub puis remboursement (`foodhubca tests/mev-qcmev-live.test.ts`, 2/2) — toutes les signatures
  faites par KMS (2 clés HSM, 11 signatures), puis renouvellement : ancienne clé `DISABLED`, nouvelle `ENABLED`.

## Mise en place par le propriétaire (Google Cloud, une fois)

```sh
gcloud config set project <projet>
gcloud services enable cloudkms.googleapis.com
gcloud kms keyrings create qcmev-sev --location northamerica-northeast1      # Montréal
gcloud iam service-accounts create qcmev-kms --display-name "Takatak MEV — clés SEV"
# Droits minimaux sur ce trousseau seulement (créer, lire la clé publique, signer, désactiver; jamais détruire ni importer)
gcloud iam roles create qcmevSevKeys --project <projet> --permissions \
  cloudkms.cryptoKeys.create,cloudkms.cryptoKeyVersions.get,cloudkms.cryptoKeyVersions.viewPublicKey,cloudkms.cryptoKeyVersions.useToSign,cloudkms.cryptoKeyVersions.update
gcloud kms keyrings add-iam-policy-binding qcmev-sev --location northamerica-northeast1 \
  --member serviceAccount:qcmev-kms@<projet>.iam.gserviceaccount.com --role projects/<projet>/roles/qcmevSevKeys
gcloud iam service-accounts keys create qcmev-kms.json --iam-account qcmev-kms@<projet>.iam.gserviceaccount.com
```

Puis dans l’environnement du serveur (Coolify, jamais dans git) :

```
SEV_KEY_CUSTODY=gcp-kms
QCMEV_GCP_KMS_KEY_RING=projects/<projet>/locations/northamerica-northeast1/keyRings/qcmev-sev
QCMEV_GCP_KMS_PROTECTION=HSM
QCMEV_GCP_KMS_CREDENTIALS_JSON=<contenu de qcmev-kms.json>   (ou QCMEV_GCP_KMS_CREDENTIALS_FILE=<chemin>)
```

Premier essai conseillé en ESSAI : demander le certificat d’un appareil, vérifier dans la console Google Cloud que la
clé est apparue (niveau HSM), faire une vente test. Coût : par clé (une par appareil) et par signature — voir le tarif
du jour de Google Cloud KMS.

**Disponibilité :** sans réponse de KMS, aucune facture ne peut être signée. Garder QCMEV et le trousseau dans la même
région; une panne KMS se voit comme un appareil non prêt.

## À demander à Revenu Québec (par écrit, avec le dossier SW-10)

- Une clé gardée dans un HSM infonuagique (Google Cloud KMS, niveau HSM) et utilisée par le SEV par appel réseau
  satisfait-elle SW-76 § 4.2.1 « clé privée non exportable » pour un SEV infonuagique ?
- Une clé par appareil (IDAPPRL), comme aujourd’hui : confirmé ?
