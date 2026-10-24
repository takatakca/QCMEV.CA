/**
 * MEV-WEB Simulator
 *
 * Local simulator that mimics the Revenu Québec MEV-WEB API.
 * Used during development and for SW-77 test case execution.
 * Run with MEV_ENVIRONMENT=SIMULATOR.
 */

import { Controller, Get, Post, Body, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import * as forge from 'node-forge';
import {
  CertificateRequestPayload,
  CertificateResponse,
  UserRequestPayload,
  UserRequestResponse,
  TransactionRequestPayload,
  TransactionResponse,
  DocumentRequestPayload,
  DocumentResponse,
  TransactionTypeCode,
} from './dto/mev-web.dto';

// ─── Simulator Service ────────────────────────────────────────────────────────

@Injectable()
export class MevSimulatorService {
  private readonly logger = new Logger(MevSimulatorService.name);
  private transactionCounter = new Map<string, number>();
  private usedTransactionNumbers = new Set<string>();

  processCertificateRequest(payload: CertificateRequestPayload): CertificateResponse {
    this.logger.log(`[SIM] CRT request from NEQ ${payload.corps.neq}`);
    const serial = `SIM-CERT-${Date.now()}`;
    return {
      codeRetour:     '0',
      messageFr:      'Certificat émis (simulateur)',
      certificatPem:  this.issueCertificateFromCsr(payload.corps.csrPem, serial),
      identifiantCle: `KEY-${serial}`,
    };
  }

  processUserRequest(payload: UserRequestPayload): UserRequestResponse {
    this.logger.log(`[SIM] UTL request: ${payload.corps.prenomUtilisateur} ${payload.corps.nomUtilisateur}`);
    return {
      codeRetour: '0',
      messageFr: 'Succès',
      identifiantUtilisateur: `USR-${Date.now()}`,
    };
  }

  processTransaction(payload: TransactionRequestPayload): TransactionResponse {
    const { transaction } = payload.corps;
    const key = `${payload.entete.numeroAppareil}|${payload.entete.dateCivile}`;

    // Duplicate detection
    const dupKey = `${key}|${transaction.numeroTransaction}`;
    if (this.usedTransactionNumbers.has(dupKey)) {
      return {
        codeRetour: '1007',
        messageFr: 'Numéro de transaction déjà utilisé',
        numeroTransactionMEV: '',
        urlCodeQR: '',
        donneeCertifiee: '',
      };
    }

    // Validate amounts
    const validation = this.validateTransactionAmounts(transaction);
    if (validation) return { codeRetour: '1009', messageFr: validation, numeroTransactionMEV: '', urlCodeQR: '', donneeCertifiee: '' };

    this.usedTransactionNumbers.add(dupKey);

    // Generate MEV transaction number
    const current = (this.transactionCounter.get(key) ?? 0) + 1;
    this.transactionCounter.set(key, current);
    const mevNum = `SIM-${payload.entete.dateCivile}-${String(current).padStart(6, '0')}`;

    // Build QR URL
    const qrUrl = `https://mev-web.revenuquebec.ca/qr?t=${mevNum}&d=${payload.entete.dateCivile}&n=${payload.corps.neq}`;

    this.logger.log(`[SIM] TRX ${transaction.typeTransaction} → MEV# ${mevNum}`);
    return {
      codeRetour: '0',
      messageFr: 'Succès',
      numeroTransactionMEV: mevNum,
      urlCodeQR: qrUrl,
      donneeCertifiee: Buffer.from(JSON.stringify({ mevNum, timestamp: Date.now() })).toString('base64'),
    };
  }

  processDocument(payload: DocumentRequestPayload): DocumentResponse {
    this.logger.log(`[SIM] DOC request type: ${(payload.corps as any).typeDocument}`);
    return {
      codeRetour: '0',
      messageFr: 'Succès',
      numeroDocument: `SIM-DOC-${Date.now()}`,
    };
  }

  private validateTransactionAmounts(transaction: TransactionRequestPayload['corps']['transaction']): string | null {
    const { montantSousTotal, montantTPS, montantTVQ, montantTotal, fournitures } = transaction;

    // Check calculated total
    const expectedTotal = montantSousTotal + montantTPS + montantTVQ;
    if (Math.abs(expectedTotal - montantTotal) > 0.02) {
      return `Montant total invalide: attendu ${expectedTotal.toFixed(2)}, reçu ${montantTotal.toFixed(2)}`;
    }

    // Validate items total matches subtotal
    if (fournitures?.length) {
      const itemsTotal = fournitures.reduce((sum, item) => sum + item.montantTotal, 0);
      if (Math.abs(itemsTotal - montantSousTotal) > 0.02) {
        return `Sous-total des fournitures invalide`;
      }
    }

    return null;
  }

  // ─── Simulator CA ─────────────────────────────────────────────────────────
  // Issues REAL X.509 certificates (signed by an in-memory simulator CA) from
  // the operator's CSR, so the full CRT → store → sign → renew flow can be
  // exercised locally. Validity: SIMULATOR_CERT_VALIDITY_DAYS (default 365) —
  // set it low (e.g. 10) to test the automatic renewal job.
  private simCa?: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey };

  private getSimulatorCa() {
    if (this.simCa) return this.simCa;
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' }).toString());
    const cert = forge.pki.createCertificate();
    cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }).toString());
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 86400_000);
    const attrs = [{ name: 'commonName', value: 'MEV-WEB Simulateur CA (Takatak)' }, { name: 'countryName', value: 'CA' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([{ name: 'basicConstraints', cA: true }]);
    cert.sign(key, forge.md.sha256.create());
    this.simCa = { cert, key };
    return this.simCa;
  }

  private issueCertificateFromCsr(csrPem: string, serial: string): string {
    const csr = forge.pki.certificationRequestFromPem(csrPem);
    if (!csr.verify()) throw new Error('CSR signature invalid');
    const ca = this.getSimulatorCa();
    const days = Number(process.env.SIMULATOR_CERT_VALIDITY_DAYS ?? 365);

    const cert = forge.pki.createCertificate();
    cert.publicKey = csr.publicKey as forge.pki.rsa.PublicKey;
    cert.serialNumber = Buffer.from(serial).toString('hex').slice(0, 30);
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date(Date.now() + days * 86400_000);
    cert.setSubject(csr.subject.attributes);
    cert.setIssuer(ca.cert.subject.attributes);
    cert.sign(ca.key, forge.md.sha256.create());
    return forge.pki.certificateToPem(cert);
  }
}

// ─── Test Cases (SW-77) ───────────────────────────────────────────────────────

export interface TestCase {
  id:          string;
  name:        string;
  description: string;
  type:        string;
  expected:    string;
}

export class MevTestCaseRunner {
  static getRequiredTestCases(): TestCase[] {
    return [
      {
        id: 'TC-001',
        name: 'Reçu simple',
        description: 'Transaction ADD avec un seul item, paiement comptant, impression papier',
        type: 'TRX-ADD',
        expected: 'codeRetour=0, numeroTransactionMEV non vide, urlCodeQR non vide',
      },
      {
        id: 'TC-002',
        name: 'Addition puis fermeture de compte',
        description: 'Créer une ADD, puis créer une RFC qui la referme',
        type: 'TRX-ADD+RFC',
        expected: 'Deux transactions MEV successives, RFC référence l\'ADD',
      },
      {
        id: 'TC-003',
        name: 'Note de crédit',
        description: 'Créer une ADD, puis émettre une NDC (remboursement)',
        type: 'TRX-NDC',
        expected: 'NDC référence la transaction originale, montants négatifs',
      },
      {
        id: 'TC-004',
        name: 'Paiement partagé (mixte)',
        description: 'Transaction ADD avec modePaiement=CMP (combiné)',
        type: 'TRX-CMP',
        expected: 'Transaction acceptée avec mode paiement CMP',
      },
      {
        id: 'TC-005',
        name: 'Annulation',
        description: 'Créer une ADD, puis l\'annuler avec une ANN',
        type: 'TRX-ANN',
        expected: 'ANN acceptée, statut original marqué CANCELLED',
      },
      {
        id: 'TC-006',
        name: 'Mode hors-ligne',
        description: 'Simuler déconnexion, créer transaction, reconnecter, soumettre en lot',
        type: 'OFFLINE',
        expected: 'Transactions mises en file, soumises en ordre lors reconnexion',
      },
      {
        id: 'TC-007',
        name: 'Demande de certificat',
        description: 'Générer CSR et soumettre demande CRT',
        type: 'CRT',
        expected: 'Certificat reçu (PEM) avec identifiantCle',
      },
      {
        id: 'TC-008',
        name: 'Enregistrement utilisateur',
        description: 'Soumettre demande UTL pour un nouveau caissier',
        type: 'UTL',
        expected: 'identifiantUtilisateur reçu',
      },
      {
        id: 'TC-009',
        name: 'Rapport d\'utilisateur',
        description: 'Générer et soumettre le rapport annuel RUT (DOC)',
        type: 'DOC-RUT',
        expected: 'numeroDocument reçu',
      },
      {
        id: 'TC-010',
        name: 'Soumission / Estimation',
        description: 'Créer transaction de type SOU (soumission)',
        type: 'TRX-SOU',
        expected: 'Transaction SOU acceptée, non incluse dans totaux ventes',
      },
      {
        id: 'TC-011',
        name: 'Duplicata',
        description: 'Créer un DUP d\'une transaction existante',
        type: 'TRX-DUP',
        expected: 'DUP accepté, référence numéro transaction original',
      },
      {
        id: 'TC-012',
        name: 'Modification post-facturation',
        description: 'Modifier un item après émission de facture — doit créer TransactionModification (SW-76 §4.6)',
        type: 'POST-INVOICE',
        expected: 'TransactionModification enregistrée + AuditLog créé',
      },
    ];
  }
}

// ─── Simulator Controller ─────────────────────────────────────────────────────

@Controller('mev-simulator')
export class MevSimulatorController {
  constructor(private readonly simulatorService: MevSimulatorService) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'MEV-WEB Simulator', version: '1.0.0', timestamp: new Date().toISOString() };
  }

  @Get('test-cases')
  testCases() {
    return { testCases: MevTestCaseRunner.getRequiredTestCases() };
  }

  @Post('certificats')
  @HttpCode(HttpStatus.OK)
  certificats(@Body() payload: CertificateRequestPayload): CertificateResponse {
    return this.simulatorService.processCertificateRequest(payload);
  }

  @Post('utilisateurs')
  @HttpCode(HttpStatus.OK)
  utilisateurs(@Body() payload: UserRequestPayload): UserRequestResponse {
    return this.simulatorService.processUserRequest(payload);
  }

  @Post('transactions')
  @HttpCode(HttpStatus.OK)
  transactions(@Body() payload: TransactionRequestPayload): TransactionResponse {
    return this.simulatorService.processTransaction(payload);
  }

  @Post('documents')
  @HttpCode(HttpStatus.OK)
  documents(@Body() payload: DocumentRequestPayload): DocumentResponse {
    return this.simulatorService.processDocument(payload);
  }
}
