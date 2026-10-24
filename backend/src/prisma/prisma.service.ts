import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { safeErrorMessage } from '../common/redact';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Prisma');

  constructor() {
    // errorFormat "minimal" keeps query arguments (identity values) out of error messages.
    super({ errorFormat: 'minimal', log: [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }] });
    (this as unknown as { $on: (e: string, cb: (ev: { message: string }) => void) => void }).$on('warn', (e) => this.logger.warn(safeErrorMessage(e)));
    (this as unknown as { $on: (e: string, cb: (ev: { message: string }) => void) => void }).$on('error', (e) => this.logger.error(safeErrorMessage(e)));
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
