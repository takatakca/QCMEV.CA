/**
 * A MEV-WEB refusal reaching a controller (the transaction is saved as REJECTED) answers
 * 422 with Revenu Québec's code and message, instead of a bare 500.
 */

import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { Response } from 'express';
import { MevWebError } from './dto/mev-web.dto';

@Catch(MevWebError)
export class MevWebErrorFilter implements ExceptionFilter {
  catch(err: MevWebError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    res.status(422).json({
      statusCode: 422,
      error:      'MEV-WEB refused the request',
      mevCode:    err.code,
      message:    err.messageFr,
    });
  }
}
