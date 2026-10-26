/**
 * One error format for the whole API, with no internal detail leaking:
 *   SaleRuleError → 422 {field}; InvalidMevPayloadError → 422 {problems}; LocationNotReadyError → 423 location_not_ready;
 *   HttpException → as is;
 *   anything else → 500 with a generic message (logged once, redacted).
 */
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { safeErrorMessage } from './redact';
import { ContractError } from '../integrations/foodhub/foodhub.contract';
import { InvalidMevPayloadError } from '../mev-web/payload-validator';
import { SaleRuleError } from '../transactions/trans-builder';
import { LocationNotReadyError } from '../transactions/transactions.service';

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Error');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) return;
    if (exception instanceof ContractError) {
      res.status(422).json({ statusCode: 422, error: 'validation_failed', errors: exception.errors });
      return;
    }
    if (exception instanceof SaleRuleError) {
      res.status(422).json({ statusCode: 422, error: 'validation_failed', errors: [{ field: exception.field, message: exception.message }] });
      return;
    }
    if (exception instanceof InvalidMevPayloadError) {
      res.status(422).json({ statusCode: 422, error: 'invalid_transaction', errors: exception.problems.map((message) => ({ field: 'transaction', message })) });
      return;
    }
    if (exception instanceof LocationNotReadyError) {
      res.status(423).json({ statusCode: 423, error: 'location_not_ready', field: exception.field, message: exception.message });
      return;
    }
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      res.status(exception.getStatus()).json(typeof body === 'string' ? { statusCode: exception.getStatus(), message: body } : body);
      return;
    }
    this.logger.error(safeErrorMessage(exception));
    res.status(500).json({ statusCode: 500, error: 'internal_error', message: 'Internal error (details are in the server log)' });
  }
}
