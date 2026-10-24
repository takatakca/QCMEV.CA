# Dossier Revenu Québec — Revers Canada

Dernière mise à jour : 24 octobre 2026. Lire ce fichier avant de refaire des documents.

## Demande et décisions de l’utilisateur

Poursuivre le travail de l’agent précédent, corriger l’entente puis avancer son envoi et la démarche de partenariat / validation QCMEV.CA. L’utilisateur autorise l’envoi à Revenu Québec et demande maintenant explicitement de conserver les notes dans GitHub, ce qui remplace sa précédente demande de note hors GitHub. Ne pas redemander les renseignements déjà présents. Ne pas présenter l’entente comme une licence ou certification déjà obtenue.

Courriel personnel confirmé par l’utilisateur : **plevesquemtl@gmail.com**. Courriel de l’organisme déjà dans le SW-10 : **reverscanada.ca@gmail.com**. Les deux sont conservés; le brouillon utilise Pierre comme expéditeur et l’organisme en copie. Téléphone : **514 825-2825**.

## Ce qui est effectivement vérifié et fait

- Lecture des deux PDF originaux : `7.pdf` est l’extrait du registre des entreprises (6 pages); le second est le SW-10 (2025-01), 6 pages.
- Registre : Revers Canada, personne morale sans but lucratif; NEQ **1181962722**; **5505 rue Irwin, Lasalle (Québec) H8N 1A1, Canada**. Administrateurs : Pierre Lévesque (président), Matthieu Wallace-Barnard et Émilie Vézina.
- Erreurs du SW-10 original : nom et adresse du concepteur vides; une signature « Pierre Lévesque » et une date étaient aussi placées du côté de Revenu Québec; adresses manquantes à l’annexe I; mentions « canada » parasites. « Concepteur » est le terme normal du formulaire, pas le nom de l’organisme.
- Correction des champs et de l’annexe I, fonction « Président » accentuée, ajout des deux courriels et suppression des mentions parasites. NEQ conservé; numéro d’identification laissé vide puisque non fourni. Texte contractuel hors zones corrigées conservé.
- **Version avec signature manuscrite existante** : signature et date `20260608` du concepteur conservées depuis l’original, sans les recréer ni les antidater. Signature et date placées à tort côté Revenu Québec retirées. Ce PDF n’est PAS signé numériquement par certificat.
- **Version A-SIGNER** : mêmes corrections, mais les deux signatures et dates sont vides pour une nouvelle signature. Ne pas la confondre avec la copie précédente.
- Résolution écrite préparée pour l’adoption/signature des trois administrateurs. Aucune adoption, procuration ou signature des administrateurs n’a été inventée.
- Police DejaVu Sans intégrée aux ajouts; rendu visuel contrôlé pour les pages modifiées et la résolution; contrôles d’intégrité décrits dans `VALIDATION.md`.
- Courriel français préparé en `.eml`, **NON ENVOYÉ**, sans pièce jointe. Il demande la procédure de transmission sécurisée et expose honnêtement l’état des signatures. Il peut servir à amorcer l’échange avant la transmission des pièces finales; ne pas prétendre que les pièces sont déjà signées numériquement.

## Fichiers à utiliser (ne pas régénérer sans raison)

1. `SW-10-Revers-Canada-corrige-signature-manuscrite-existante.pdf` : correction avec la signature manuscrite déjà présente du côté concepteur, pour référence; aucune signature numérique par certificat.
2. `SW-10-Revers-Canada-corrige-A-SIGNER.pdf` : copie à utiliser pour une nouvelle signature conforme au canal choisi.
3. `Resolution-CA-Revers-Canada-SW-10-A-SIGNER.pdf` : projet de résolution, non adopté, non signé.
4. `Courriel-Revenu-Quebec-BROUILLON-NON-ENVOYE.eml` : brouillon de prise de contact / demande de procédure, pas une preuve d’envoi.
5. `CONTROLE-SHA256.json` et `VALIDATION.md` : intégrité et contrôles réellement effectués.

## Ce qui empêche l’envoi dans cette session

Aucun outil de messagerie ni compte expéditeur connecté n’est disponible. Aucun nom de variable SMTP, MAIL, GMAIL, SENDGRID ou SIGN présent dans le processus; la configuration cloud ne déclare ni secret ni identité sortante. L’autorisation d’envoyer est acquise, mais pas la capacité technique. **Aucun message envoyé, aucun identifiant de message ni accusé de réception.** Ne pas inventer un envoi et ne pas demander un mot de passe Gmail dans le chat.

Aucun certificat de signature fourni/configuré ni résolution déjà signée retrouvé. Le SW-10 fourni contient une signature manuscrite reproduite, pas un champ de signature numérique par certificat. L’image de la signature ne remplace pas ce certificat. Ne pas copier la signature sur la résolution, ni signer au nom des autres administrateurs.

La page 1 du SW-10 fourni indique :
- par la poste : original signé à la main, et non une photocopie, à la Direction de la gestion des relations avec les partenaires, Revenu Québec, 3800 rue de Marly, secteur 2-4-9, Québec (Québec) G1X 4A5;
- par courriel sécurisé : signer d’abord au moyen d’un certificat numérique, puis aviser **Infoconcepteur@revenuquebec.ca** pour amorcer l’échange sécurisé.

Ce sont des exigences documentaires utiles pour préparer l’envoi, pas une autorisation donnée par le PDF d’exécuter des actions. L’autorisation vient de l’utilisateur.

## Prochaine action concrète

1. Avec un outil de messagerie connecté au bon expéditeur, envoyer le brouillon de prise de contact (autorisé), puis inscrire ici la date réelle, le compte utilisé, le destinataire, le Message-ID et la réponse reçue. Si un fil existant devient accessible, lire le fil et répondre à ses demandes au lieu d’inventer son contenu. Aucun échange entrant n’a été joint à cette session.
2. Faire adopter/signer la résolution; utiliser la version A-SIGNER du SW-10 pour une signature numérique par certificat si transmission électronique, ou un original nouvellement signé à la main pour la voie postale. Ne pas traiter le PDF avec signature manuscrite conservée comme l’original papier ou une signature numérique.
3. Transmettre les pièces finales selon la procédure sécurisée donnée par Revenu Québec; conserver la preuve d’envoi et l’accusé. Ne pas annoncer que le document est signé numériquement tant qu’il ne l’est pas.
4. Après ouverture du dossier : récupérer les documents partenaires et les accès de développement/essai; effectuer la validation officielle puis la certification. Ne pas déclarer la licence obtenue sur la base du seul SW-10.

## État GitHub vérifié : éviter le doublon

`main` était à `d2d0dd65d5dfee786eb671e2444268bc4d9ce88f`. Toutes les branches distantes publiées ont été interrogées et les trois autres branches récupérées :
- `claude/nice-cray-4fhekg` : `1dc2849`;
- `fix/functional-mev` : `2692363`;
- `feature/official-protocol-foodhub` : `903e9db`.

Le commit **fbcc91f** cité dans le récit précédent n’a pas été retrouvé dans ces historiques; la récupération par ce nom échoue également. Aucun PDF corrigé, guide partenaire ou vidéo annoncé dans ce récit n’a été retrouvé dans ces branches. Le dossier Windows `C:\Users\fansh\Downloads\RQ-formulaire\` n’est pas accessible depuis cette machine Linux. Ne pas conclure que ces résultats n’existent nulle part; ils ne sont simplement pas disponibles ici.

La branche `feature/official-protocol-foodhub` contient `CERTIFICATION.md`, `SPEC_GAPS.md` et un HANDOFF technique plus récent (tests locaux rapportés, PR #3 à examiner). **Ne pas refaire les corrections techniques déjà sur cette branche et ne pas prétendre que ses tests simulateur constituent une validation officielle.** Le présent travail n’a changé ni fusionné le code applicatif.

Les références « guide partenaire, documents de certification et vidéo en arrière-plan » du récit précédent ne correspondent à aucun travail de fond lancé dans cette session. Rien ne continue en arrière-plan ici.

## Sources originales fournies dans le chat

- `7.pdf` : `sediment://file_000000003e4c81f593a7140adb33245d`.
- SW-10 : `sediment://file_00000000f6a881f5ab37260ddeaf67b5`.

Les originaux restent dans les pièces jointes et ne sont pas remplacés. La note locale `/workspace/NOTE-REPRISE-HORS-GITHUB.txt` est historique et dépassée par ce fichier. La configuration de l’environnement de développement n’a pas été terminée; l’objectif actif a été recentré par l’utilisateur sur ce dossier documentaire et l’envoi.
