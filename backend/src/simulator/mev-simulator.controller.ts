import { Body, Controller, Get, Header, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { MevSimulatorService, SimRequestError, SimResponse } from './mev-simulator.service';

function headersOf(req: Request): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return out;
}

function rawOf(req: Request): string {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  return raw ? raw.toString('utf8') : JSON.stringify(req.body ?? {});
}

/** Mounted only when MEV_ENVIRONMENT is SIMULATOR or DEV (see AppModule.forRoot). */
@SkipThrottle()
@Controller('mev-simulator')
export class MevSimulatorController {
  constructor(private readonly sim: MevSimulatorService) {}

  private async reply(res: Response, fn: () => SimResponse | Promise<SimResponse>, wrapper: string) {
    if (this.sim.mevDown) {
      res.status(503).json({ message: 'simulated outage (mevDown)' });
      return;
    }
    try {
      const r = await fn();
      res.status(r.status).json(r.body);
    } catch (e) {
      if (e instanceof SimRequestError) {
        res.status(e.status).json({ [wrapper]: { listErr: e.errors } });
        return;
      }
      throw e;
    }
  }

  @Get('health')
  health() {
    return { status: this.sim.mevDown ? 'down' : 'ok', service: 'QCMEV local simulator (not Revenu Québec)', mevDown: this.sim.mevDown };
  }

  /** Test switches: {"mevDown": true|false, "notSentNext": n} */
  @Post('_control')
  @HttpCode(200)
  control(@Body() body: { mevDown?: boolean; notSentNext?: number }) {
    if (typeof body?.mevDown === 'boolean') this.sim.mevDown = body.mevDown;
    if (Number.isInteger(body?.notSentNext)) this.sim.notSentNext = Math.max(0, Number(body.notSentNext));
    return { mevDown: this.sim.mevDown, notSentNext: this.sim.notSentNext };
  }

  @Post('enrolement')
  async enrolement(@Req() req: Request, @Res() res: Response) {
    await this.reply(res, () => this.sim.enrolement(headersOf(req), req.body), 'retourCertif');
  }

  @Post('utilisateur')
  async utilisateur(@Req() req: Request, @Res() res: Response) {
    await this.reply(res, () => this.sim.utilisateur(headersOf(req), rawOf(req), req.body), 'retourUtil');
  }

  @Post('transaction')
  async transaction(@Req() req: Request, @Res() res: Response) {
    await this.reply(res, () => this.sim.transaction(headersOf(req), rawOf(req), req.body), 'retourTrans');
  }

  @Post('document')
  async document(@Req() req: Request, @Res() res: Response) {
    await this.reply(res, () => this.sim.document(headersOf(req), rawOf(req), req.body), 'retourDoc');
  }

  @Get('qr')
  @Header('Content-Type', 'text/html; charset=utf-8')
  qr(@Query('f') f: string) {
    const data = f ? this.sim.lookupQr(f) : null;
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const rows = data ? Object.entries(data).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(String(v))}</td></tr>`).join('') : '<tr><td>QR code inconnu</td></tr>';
    return `<!doctype html><meta charset="utf-8"><title>Simulateur local QCMEV</title><h1>Simulateur local QCMEV</h1><p>Ceci n'est pas Revenu Québec. Données de test seulement.</p><table>${rows}</table>`;
  }
}
