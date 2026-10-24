/**
 * User report (DOC, typDoc RUT). PROVEN (SW-76 §4.4.3, « Production du rapport de l'utilisateur »): the SEV displays
 * or prints it, and transmits its required information to MEV-WEB, every time it is produced.
 *
 *  - Displayed / printed (user-report-renderer.ts): business name, TPS / TVQ numbers, the active user's name, the
 *    establishment address, the last document produced on the device, the device id, the SEV id and version, the login
 *    and production moments, and a QR code. The sales summary is never displayed.
 *  - Transmitted (reqDoc): the sales summary of the year (and of the previous year): number of transactions, number of
 *    payment transactions, amounts before taxes, TPS, TVQ, after taxes, adjusted amount, total amount due.
 * Order: the database row is created first, then the request is sent, then the row is updated, so nothing is lost if
 * MEV-WEB fails. With an expired certificate the report is displayed but nothing is transmitted (PROVEN: an expired
 * certificate cannot transmit).
 * SPEC (SPEC_GAPS #11, #31, #32): the reqDoc structure and every summary field NAME (SW-73.D); which documents count as
 * "transactions" and "payment transactions"; the last document and the summary taken over every user of the device
 * (restaurant sector) rather than the active user only; the report QR content.
 */
import { BadRequestException, Body, Controller, Get, Inject, Injectable, Post, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { AuditEventType, CertificateType, MevStatus, Prisma } from '@prisma/client';
import { AuthUser, CurrentUser, JwtAuthGuard, MANAGERS, Roles, RolesGuard } from '../auth/auth';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { mevAmount } from '../common/money';
import { civilTime } from '../common/time';
import { CertificatesService } from '../certificates/certificates.service';
import { encryptQrPayload } from '../crypto/qr-crypto';
import { AuditLogService } from '../logging/audit-log.service';
import { MevUnreachableError, MevWebService } from '../mev-web/mev-web.service';
import { classifyErrors, ReqDoc, SommVentes } from '../mev-web/mev-web.types';
import { PrismaService } from '../prisma/prisma.service';
import { qrContent } from '../receipts/receipt-renderer';
import { formatEstablishmentAddress, renderUserReport, RenderedUserReport, UserReportInput, userReportQrPayload } from './user-report-renderer';

/** Sales summary in cents, before formatting for MEV-WEB. */
export interface Summary {
  /** Every transaction recorded in operating mode (receipts, credit notes, additions, reprints, duplicates...). */
  nbTrans: number;
  /** Closing receipts and credit notes (RFER, original print FAC): the transactions where a payment is settled. */
  nbTransPai: number;
  avantTax: number;
  tps: number;
  tvq: number;
  apresTax: number;
  /** Σ mont.ajus (QCMEV never sends an adjustment today: 0). */
  ajus: number;
  /** Total amount due: Σ mont.mtdu when recorded, else apresTax + ajus (SPEC). */
  mtdu: number;
}

export function sommVentesOf(s: Summary): SommVentes {
  return {
    nbTrans: s.nbTrans,
    nbTransPai: s.nbTransPai,
    avantTax: mevAmount(s.avantTax),
    TPS: mevAmount(s.tps),
    TVQ: mevAmount(s.tvq),
    apresTax: mevAmount(s.apresTax),
    ajus: mevAmount(s.ajus),
    mtdu: mevAmount(s.mtdu),
  };
}

const OFFLINE: readonly MevStatus[] = [MevStatus.PENDING, MevStatus.OFFLINE_PENDING, MevStatus.RETRY_BATCH];

@Injectable()
export class ReportsService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly mevWeb: MevWebService,
    private readonly certificates: CertificatesService,
    private readonly audit: AuditLogService,
  ) {}

  /** Sales summary of one civil year on one device, every user (training documents excluded). */
  async summary(operatorId: string, year: number, deviceId: string): Promise<Summary> {
    const base: Prisma.TransactionWhereInput = { operatorId, deviceId, civilDate: { gte: `${year}0101`, lte: `${year}1231` }, transactionMode: 'OPE' };
    const paid: Prisma.TransactionWhereInput = { ...base, printMode: 'FAC', transactionType: 'RFER' };
    const [nbTrans, agg, dueRecorded] = await Promise.all([
      this.prisma.transaction.count({ where: base }),
      this.prisma.transaction.aggregate({ where: paid, _sum: { subtotalCents: true, tpsCents: true, tvqCents: true, totalCents: true, adjustCents: true }, _count: true }),
      this.prisma.transaction.aggregate({ where: { ...paid, amountDueCents: { not: null } }, _sum: { amountDueCents: true, totalCents: true, adjustCents: true } }),
    ]);
    const apresTax = agg._sum.totalCents ?? 0;
    const ajus = agg._sum.adjustCents ?? 0;
    // Rows with a recorded amount due use it; the others count apresTax + ajus.
    const mtdu = apresTax + ajus - ((dueRecorded._sum.totalCents ?? 0) + (dueRecorded._sum.adjustCents ?? 0)) + (dueRecorded._sum.amountDueCents ?? 0);
    return { nbTrans, nbTransPai: agg._count, avantTax: agg._sum.subtotalCents ?? 0, tps: agg._sum.tpsCents ?? 0, tvq: agg._sum.tvqCents ?? 0, apresTax, ajus, mtdu };
  }

  async userReport(operatorId: string, year: number, userId: string, deviceId?: string) {
    const current = Number(civilTime().civilDate.slice(0, 4));
    if (!Number.isInteger(year) || year < current - 1 || year > current) throw new BadRequestException(`year must be ${current - 1} or ${current}`);
    const [device, user] = await Promise.all([
      this.prisma.device.findFirst({
        where: { operatorId, isActive: true, mevDeviceId: { not: null }, ...(deviceId ? { id: deviceId } : {}), certificates: { some: { type: CertificateType.SEV, isActive: true } } },
        include: { operator: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.sEVUser.findFirst({ where: { id: userId, operatorId } }),
    ]);
    if (!device) throw new UnprocessableEntityException('No certified device: run CRT first');
    if (!user) throw new BadRequestException('Unknown user');
    const mevWebCertPem = await this.certificates.mevWebCertificate(device.id);
    if (!mevWebCertPem) throw new UnprocessableEntityException('No MEV-WEB certificate on this device to encrypt the QR code (run CRT again)');
    const op = device.operator;

    const [s, prev, last] = await Promise.all([
      this.summary(operatorId, year, device.id),
      this.summary(operatorId, year - 1, device.id),
      this.prisma.transaction.findFirst({ where: { deviceId: device.id }, orderBy: { deviceSeq: 'desc' } }),
    ]);
    const producedAt = civilTime().datTrans;
    const content: Omit<UserReportInput, 'qrContent'> = {
      merchantName: op.name,
      noTPS: op.noTPS,
      noTVQ: op.noTVQ,
      userName: `${user.firstName} ${user.lastName}`.trim() || (user.mevUserName ?? user.username),
      address: formatEstablishmentAddress(op),
      lastDocument: last
        ? {
            noTrans: last.noTrans,
            totalCents: last.totalCents,
            formImpr: last.printFormat,
            recipientMasked: null,
            producedAt: last.datTrans,
            mevProcessedAt: OFFLINE.includes(last.mevStatus) ? null : last.mevProcessedAt,
            mevTransactionNumber: OFFLINE.includes(last.mevStatus) ? null : last.mevTransactionNumber,
          }
        : null,
      deviceId: device.mevDeviceId as string,
      sevId: this.cfg.sev.idSev,
      sevVersion: this.cfg.sev.versi,
      loginAt: user.lastLoginAt ? civilTime(user.lastLoginAt).datTrans : null,
      producedAt,
    };
    const display: RenderedUserReport = await renderUserReport({
      ...content,
      qrContent: qrContent(this.cfg.qrBaseUrl, encryptQrPayload(mevWebCertPem, userReportQrPayload(content, year))),
    });

    const sommVentes = sommVentesOf(s);
    const sommVentesAnt = sommVentesOf(prev);
    const report = await this.prisma.userReport.create({
      data: {
        operatorId,
        reportYear: year,
        deviceId: device.id,
        userId: user.id,
        totalSalesCents: s.avantTax,
        totalTpsCents: s.tps,
        totalTvqCents: s.tvq,
        totalTransactions: s.nbTrans,
        previousYearJson: prev as unknown as Prisma.InputJsonValue,
        summaryJson: { sommVentes, sommVentesAnt } as unknown as Prisma.InputJsonValue,
        displayJson: { lines: display.lines, qrContent: display.qr.content } as unknown as Prisma.InputJsonValue,
        mevStatus: MevStatus.PENDING,
      },
    });
    const body: ReqDoc = {
      reqDoc: {
        typDoc: 'RUT',
        noDossFO: device.fileNumber as string,
        noTPS: op.noTPS,
        noTVQ: op.noTVQ,
        annee: year,
        datDoc: producedAt,
        sommVentes,
        sommVentesAnt,
      },
    };
    let status: MevStatus = MevStatus.PENDING;
    let number: string | null = null;
    let response: unknown = null;
    let transmitted = false;
    const m = await this.certificates.signingMaterial(device.id);
    if (!m.expired) {
      try {
        const res = await this.mevWeb.documentRequest({ id: operatorId, noTPS: op.noTPS, noTVQ: op.noTVQ }, m, body);
        response = res;
        transmitted = true;
        const outcome = classifyErrors(res?.retourDoc?.listErr);
        status = outcome === 'accepted' ? MevStatus.ACCEPTED : outcome === 'retry_batch' ? MevStatus.RETRY_BATCH : MevStatus.REJECTED;
        number = res?.retourDoc?.noDoc ?? null;
      } catch (e) {
        if (!(e instanceof MevUnreachableError)) throw e;
        status = MevStatus.OFFLINE_PENDING;
      }
    }
    const saved = await this.prisma.userReport.update({
      where: { id: report.id },
      data: { mevStatus: status, mevReportNumber: number, submittedAt: transmitted ? new Date() : null, mevResponse: (response ?? undefined) as Prisma.InputJsonValue | undefined },
    });
    await this.audit.log({
      operatorId,
      eventType: AuditEventType.USER_REPORT_GENERATED,
      userId,
      deviceId: device.id,
      description: m.expired ? `user report ${year} displayed, NOT transmitted: the device certificate has expired` : `user report ${year} displayed and transmitted (${status})`,
    });
    const { summaryJson: _s, displayJson: _d, ...row } = saved;
    return { ...row, transmitted, ...(m.expired ? { notTransmittedReason: 'certificateExpired' } : {}), display };
  }

  list(operatorId: string) {
    return this.prisma.userReport.findMany({
      where: { operatorId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, reportType: true, reportYear: true, deviceId: true, userId: true, mevStatus: true, mevReportNumber: true, submittedAt: true, createdAt: true },
    });
  }
}

@Controller('reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...MANAGERS)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.reports.list(u.operatorId);
  }

  /** Displays (and therefore transmits) the user report of a year, for the logged-in user, on one device. */
  @Post('user-report')
  userReport(@CurrentUser() u: AuthUser, @Body() b: { year?: number; deviceId?: string }) {
    return this.reports.userReport(u.operatorId, Number(b?.year), u.sub, typeof b?.deviceId === 'string' ? b.deviceId : undefined);
  }
}
