/**
 * MEV-WEB DTO Types
 * Revenu Québec MEV-WEB API — SW-76 (2025-06)
 *
 * All request payloads and response types for the four MEV-WEB
 * request types: CRT, UTL, TRX, DOC
 */

// ─── Request Type Codes ───────────────────────────────────────────────────────

export enum MevRequestTypeCode {
  CRT = 'CRT', // Certificat
  UTL = 'UTL', // Utilisateur
  TRX = 'TRX', // Transaction
  DOC = 'DOC', // Document
}

// ─── Transaction Type Codes ───────────────────────────────────────────────────

export enum TransactionTypeCode {
  ADD = 'ADD', // Addition (vente normale)
  RFC = 'RFC', // Fermeture de compte (closing receipt)
  NDC = 'NDC', // Note de crédit (credit note)
  EST = 'EST', // Estimation
  SOU = 'SOU', // Soumission (quote)
  DUP = 'DUP', // Duplicata
  REP = 'REP', // Reproduction
  ANN = 'ANN', // Annulation (cancellation)
  COR = 'COR', // Correction
  FOR = 'FOR', // Formation (training mode)
}

// ─── Sector Codes ────────────────────────────────────────────────────────────

export enum SectorCode {
  RST = 'RST', // Restauration
  TRP = 'TRP', // Transport de personnes payant
}

// ─── Payment Mode Codes ───────────────────────────────────────────────────────

export enum PaymentModeCode {
  ARC = 'ARC', // Argent comptant
  CRC = 'CRC', // Carte de crédit
  CRD = 'CRD', // Carte de débit
  CHQ = 'CHQ', // Chèque
  CAD = 'CAD', // Carte-cadeau
  PMO = 'PMO', // Paiement mobile
  CMP = 'CMP', // Combiné / mixte
  AUT = 'AUT', // Autre
}

// ─── Print Mode Codes ────────────────────────────────────────────────────────

export enum PrintModeCode {
  PAP = 'PAP', // Papier
  ELC = 'ELC', // Électronique
  AUC = 'AUC', // Aucune impression
}

// ─── Support Codes ───────────────────────────────────────────────────────────

export enum SupportCode {
  PAP = 'PAP', // Papier
  ELC = 'ELC', // Électronique
}

// ─── Tax Codes ───────────────────────────────────────────────────────────────

export enum TaxCode {
  FP = 'FP',  // Taxable TPS + TVQ
  F  = 'F',   // Taxable TPS seulement
  P  = 'P',   // Taxable TVQ seulement
}

// ─── MEV-WEB Header (common to all request types) ────────────────────────────

export interface MevWebHeader {
  typeRequete:    MevRequestTypeCode;  // CRT | UTL | TRX | DOC
  codeSEV:        string;              // SEV certification code
  versionSEV:     string;              // e.g. "1.0.0"
  typeAppareil:   string;              // Device type
  numeroAppareil: string;              // Device serial number or UUID
  dateCivile:     string;              // YYYYMMDD
  heureDebut:     string;              // HHMMSS
  signature:      string;              // RSA-SHA256 Base64 of canonical JSON
}

// ─── CRT — Certificate Request ────────────────────────────────────────────────

export interface CertificateRequestPayload {
  entete: MevWebHeader;
  corps: {
    neq:           string;  // Numéro d'entreprise du Québec
    codeAutorisation: string; // Authorization code from Revenu Québec
    secteur:       SectorCode;
    csrPem:        string;  // PEM-encoded CSR
  };
}

export interface CertificateResponse {
  codeRetour:      string;
  messageFr:       string;
  certificatPem:   string;
  identifiantCle:  string;  // Key ID assigned by MEV-WEB
}

// ─── UTL — User Request ───────────────────────────────────────────────────────

export interface UserRequestPayload {
  entete: MevWebHeader;
  corps: {
    neq:              string;
    codeAutorisation:  string;
    secteur:          SectorCode;
    prenomUtilisateur: string;
    nomUtilisateur:    string;
    roleUtilisateur:   string; // ADMIN | GERANT | CAISSIER
  };
}

export interface UserRequestResponse {
  codeRetour:         string;
  messageFr:          string;
  identifiantUtilisateur: string; // Assigned by MEV-WEB
}

// ─── TRX — Transaction Request ───────────────────────────────────────────────

export interface FournitureItem {
  description:    string;
  quantite:       number;
  prixUnitaire:   number;
  montantTotal:   number;
  codeTaxe:       TaxCode | '';
  montantTPS:     number;
  montantTVQ:     number;
}

export interface TransactionData {
  numeroTransaction:      number;        // Per device per civil day
  typeTransaction:        TransactionTypeCode;
  montantSousTotal:       number;
  montantTPS:             number;
  montantTVQ:             number;
  montantTotal:           number;
  montantPourboire?:      number;
  montantRemise?:         number;
  modePaiement:           PaymentModeCode;
  modeImpression:         PrintModeCode;
  numeroTable?:           string;
  nombreCouverts?:        number;
  hashChaine:             string;        // SHA-256 hash chain
  identifiantUtilisateur: string;        // MEV user ID
  fournitures:            FournitureItem[];
  numeroTransactionOriginal?: string;    // For NDC / ANN / COR
}

export interface TransactionRequestPayload {
  entete: MevWebHeader;
  corps: {
    neq:             string;
    codeAutorisation: string;
    secteur:         SectorCode;
    transaction:     TransactionData;
  };
}

export interface TransactionResponse {
  codeRetour:           string;
  messageFr:            string;
  numeroTransactionMEV: string;   // Assigned by MEV-WEB
  urlCodeQR:            string;   // QR URL (to be encrypted)
  donneeCertifiee:      string;   // Base64 certified data
}

// ─── DOC — Document Request ──────────────────────────────────────────────────

export interface SalesSummary {
  annee:             number;
  moisDebut:         number;  // 1–12
  moisFin:           number;
  montantVentes:     number;
  montantTPS:        number;
  montantTVQ:        number;
  nombreTransactions: number;
}

export interface UserReportData {
  typeDocument:       'RUT';   // Rapport d'utilisateur
  neq:               string;
  codeAutorisation:   string;
  secteur:           SectorCode;
  anneeRapport:      number;
  resumeVentesAnnuel: SalesSummary;
  resumeVentesAnnuelPrecedent?: SalesSummary;
}

export interface ThirdPartyDeclarationData {
  typeDocument:       'CPT';  // Convention de partage de terminaux
  neq:               string;
  neqTiers:          string;
  dateDebut:         string;  // YYYYMMDD
  dateFin?:          string;
}

export interface DocumentRequestPayload {
  entete: MevWebHeader;
  corps: UserReportData | ThirdPartyDeclarationData;
}

export interface DocumentResponse {
  codeRetour:     string;
  messageFr:      string;
  numeroDocument: string;
}

// ─── Offline Batch ───────────────────────────────────────────────────────────

export interface OfflineBatchItem {
  requestType: MevRequestTypeCode;
  payload:     TransactionRequestPayload;
  queuedAt:    string;
}

export interface OfflineBatchPayload {
  entete: MevWebHeader;
  lots:   OfflineBatchItem[];
}

// ─── MEV Error Codes ─────────────────────────────────────────────────────────

export const MEV_ERROR_CODES: Record<string, string> = {
  '0':    'Succès',
  '1000': 'Erreur technique',
  '1001': 'Format de la requête invalide',
  '1002': 'Signature invalide',
  '1003': 'Certificat invalide ou révoqué',
  '1004': 'Code d\'autorisation invalide',
  '1005': 'NEQ invalide',
  '1006': 'Secteur invalide',
  '1007': 'Numéro de transaction déjà utilisé',
  '1008': 'Hash de chaîne invalide',
  '1009': 'Montant invalide',
  '1010': 'Date civile invalide',
  '1011': 'Utilisateur non trouvé',
  '1012': 'Version SEV non supportée',
  '1013': 'Code SEV invalide',
  '2000': 'Erreur de communication avec MEV-WEB',
  '9999': 'Erreur inconnue',
};

// ─── Structured MEV Error ─────────────────────────────────────────────────────

export class MevWebError extends Error {
  constructor(
    public readonly code: string,
    public readonly messageFr: string,
    public readonly httpStatus?: number,
  ) {
    super(`MEV-WEB Error ${code}: ${messageFr}`);
    this.name = 'MevWebError';
  }
}

/**
 * True when a MEV-WEB failure is transient (network down, timeout, 5xx) and the
 * request should be queued for offline resubmission rather than rejected.
 * A 4xx with a MEV codeRetour is a business rejection — retrying won't help.
 */
export function isTransientMevError(err: unknown): boolean {
  if (!(err instanceof MevWebError)) return false;
  if (err.code === 'NETWORK_ERROR') return true;
  if (err.httpStatus === undefined || err.httpStatus === null) return true;
  return err.httpStatus >= 500;
}
