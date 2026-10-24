/**
 * User report (DOC, typDoc RUT). PROVEN: it is transmitted every time it is displayed or printed (SW-76 §4.4.3),
 * with the sales summary of the current or previous year. Order: the database row is created first, then the
 * request is sent, then the row is updated, so nothing is lost if MEV-WEB fails.
 * SPEC: the reqDoc structure and the summary fields wait for SW-73.D.
 */
import { BadRequestException, Body, Controller, Get, Injectable, Post, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { AuditEventType, CertificateType, MevStatus, Prisma } from '@prisma/client';
import { AuthUser, CurrentUser, JwtAuthGuard, MANAGERS, Roles, RolesGuard } from '../auth/auth';
import { mevAmount } from '../common/money';
import { civilTime } from '../common/time';
import { CertificatesService } from '../certificates/certificates.service';
import { AuditLogService } from '../logging/audit-log.service';
import { MevUnreachableError, MevWebService } from '../mev-web/mev-web.service';
import { classifyErrors, ReqDoc } from '../mev-web/mev-web.types';
import { PrismaService } from '../prisma/prisma.service';

interface Summary {
  avantTax: number;
  tps: number;
  tvq: number;
  apresTax: number;
  nbTrans: number;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mevWeb: MevWebService,
    private readonly certificates: CertificatesService,
    private readonly audit: AuditLogService,
  ) {}

  async summary(operatorId: string, year: number, deviceId?: string): Promise<Summary> {
    const where: Prisma.TransactionWhereInput = {
      operatorId,
      civilDate: { gte: `${year}0101`, lte: `${year}1231` },
      printMode: 'FAC',
      transactionMode: 'OPE',
      transactionType: 'RFER',
      ...(deviceId ? { deviceId } : {}),
    };
    const agg = await this.prisma.transaction.aggregate({ where, _sum: { subtotalCents: true, tpsCents: true, tvqCents: true, totalCents: true }, _count: true });
    return { avantTax: agg._sum.subtotalCents ?? 0, tps: agg._sum.tpsCents ?? 0, tvq: agg._sum.tvqCents ?? 0, apresTax: agg._sum.totalCents ?? 0, nbTrans: agg._count };
  }

  async userReport(operatorId: string, year: number, userId: string, deviceId?: string) {
    const current = Number(civilTime().civilDate.slice(0, 4));
    if (!Number.isInteger(year) || year < current - 1 || year > current) throw new BadRequestException(`year must be ${current - 1} or ${current}`);
    const device = await this.prisma.device.findFirst({
      where: { operatorId, isActive: true, mevDeviceId: { not: null }, ...(deviceId ? { id: deviceId } : {}), certificates: { some: { type: CertificateType.SEV, isActive: true } } },
      include: { operator: true },
    });
    if (!device) throw new UnprocessableEntityException('No certified device: run CRT first');
    const s = await this.summary(operatorId, year, device.id);
    const prev = await this.summary(operatorId, year - 1, device.id);

    const report = await this.prisma.userReport.create({
      data: { operatorId, reportYear: year, totalSalesCents: s.avantTax, totalTpsCents: s.tps, totalTvqCents: s.tvq, totalTransactions: s.nbTrans, previousYearJson: prev as unknown as Prisma.InputJsonValue, mevStatus: MevStatus.PENDING },
    });
    const fmt = (x: Summary) => ({ avantTax: mevAmount(x.avantTax), TPS: mevAmount(x.tps), TVQ: mevAmount(x.tvq), apresTax: mevAmount(x.apresTax), nbTrans: x.nbTrans });
    const body: ReqDoc = {
      reqDoc: {
        typDoc: 'RUT',
        noDossFO: device.fileNumber as string,
        noTPS: device.operator.noTPS,
        noTVQ: device.operator.noTVQ,
        annee: year,
        datDoc: civilTime().datTrans,
        sommVentes: fmt(s),
        sommVentesAnt: fmt(prev),
      },
    };
    let status: MevStatus = MevStatus.PENDING;
    let number: string | null = null;
    let response: unknown = null;
    try {
      const m = await this.certificates.signingMaterial(device.id);
      const res = await this.mevWeb.documentRequest({ id: operatorId, noTPS: device.operator.noTPS, noTVQ: device.operator.noTVQ }, m, body);
      response = res;
      const outcome = classifyErrors(res?.retourDoc?.listErr);
      status = outcome === 'accepted' ? MevStatus.ACCEPTED : outcome === 'retry_batch' ? MevStatus.RETRY_BATCH : MevStatus.REJECTED;
      number = res?.retourDoc?.noDoc ?? null;
    } catch (e) {
      if (!(e instanceof MevUnreachableError)) throw e;
      status = MevStatus.OFFLINE_PENDING;
    }
    const saved = await this.prisma.userReport.update({
      where: { id: report.id },
      data: { mevStatus: status, mevReportNumber: number, submittedAt: new Date(), mevResponse: (response ?? undefined) as Prisma.InputJsonValue | undefined },
    });
    await this.audit.log({ operatorId, eventType: AuditEventType.USER_REPORT_GENERATED, userId, description: `user report ${year} transmitted (${status})` });
    return { ...saved, summary: s, previousYear: prev };
  }

  list(operatorId: string) {
    return this.prisma.userReport.findMany({ where: { operatorId }, orderBy: { createdAt: 'desc' }, take: 50 });
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

  /** Displays (and therefore transmits) the user report of a year. */
  @Post('user-report')
  userReport(@CurrentUser() u: AuthUser, @Body() b: { year?: number; deviceId?: string }) {
    return this.reports.userReport(u.operatorId, Number(b?.year), u.sub, b?.deviceId);
  }
}
