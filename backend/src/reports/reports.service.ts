/**
 * Reports Service
 *
 * Generates and submits annual user reports (RUT) to MEV-WEB.
 * Required by SW-76 §4.5 — each operator must submit an annual summary.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MevWebService } from '../mev-web/mev-web.service';
import { AuditLogService } from '../logging/audit-log.service';
import { SectorCode } from '../mev-web/dto/mev-web.dto';
import { AuditEventType, LogSeverity } from '@prisma/client';

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mevWebService: MevWebService,
    private readonly auditLog: AuditLogService,
  ) {}

  async generateUserReport(operatorId: string, year: number) {
    const operator = await this.prisma.operator.findUniqueOrThrow({ where: { id: operatorId } });

    // Aggregate annual sales
    const startDate = `${year}0101`;
    const endDate   = `${year}1231`;
    const txs = await this.prisma.transaction.findMany({
      where: {
        operatorId,
        civilDate: { gte: startDate, lte: endDate },
        status: { notIn: ['CANCELLED', 'DRAFT'] },
      },
    });

    const totalSales = txs.reduce((s, t) => s + Number(t.totalAmount), 0);
    const totalTps   = txs.reduce((s, t) => s + Number(t.tpsAmount), 0);
    const totalTvq   = txs.reduce((s, t) => s + Number(t.tvqAmount), 0);

    // Submit to MEV-WEB
    const now = new Date();
    const payload: any = {
      entete: {
        typeRequete:    'DOC',
        codeSEV:        operator.sevCertificationCode ?? 'DEV-CODE',
        versionSEV:     operator.sevVersion,
        typeAppareil:   'SERVEUR',
        numeroAppareil: operator.id,
        dateCivile:     now.toISOString().slice(0, 10).replace(/-/g, ''),
        heureDebut:     now.toTimeString().replace(/\D/g, '').slice(0, 6),
        signature:      '',
      },
      corps: {
        typeDocument:  'RUT',
        neq:           operator.neq,
        codeAutorisation: operator.authorizationCode ?? '',
        secteur:       operator.sector as SectorCode,
        anneeRapport:  year,
        resumeVentesAnnuel: {
          annee:              year,
          moisDebut:          1,
          moisFin:            12,
          montantVentes:      totalSales,
          montantTPS:         totalTps,
          montantTVQ:         totalTvq,
          nombreTransactions: txs.length,
        },
      },
    };

    const response = await this.mevWebService.submitDocument(operatorId, payload);

    const report = await this.prisma.userReport.create({
      data: {
        operatorId,
        year,
        reportType:        'ANNUAL_USER_REPORT',
        mevDocumentNumber: response.numeroDocument,
        submittedAt:       new Date(),
        totalSales,
        totalTps,
        totalTvq,
        transactionCount:  txs.length,
      },
    });

    await this.auditLog.log({
      operatorId,
      eventType:  AuditEventType.REPORT_SUBMITTED,
      severity:   LogSeverity.INFO,
      description: `Rapport annuel ${year} soumis: ${response.numeroDocument}`,
    });

    return report;
  }

  async listReports(operatorId: string) {
    return this.prisma.userReport.findMany({
      where: { operatorId },
      orderBy: { year: 'desc' },
    });
  }
}
