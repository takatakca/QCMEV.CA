import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { assertMigrationBaseline } from '../src/cli/check-database';

const file = join(__dirname, '../prisma/migrations/20261024000000_init/migration.sql');
const expected = createHash('sha256').update(readFileSync(file)).digest('hex');

describe('database preflight: preserve unknown existing data', () => {
  it('accepts the current migration checksum and a database with no applied initial migration', async () => {
    for (const rows of [[], [{ checksum: expected }]]) {
      await expect(assertMigrationBaseline({ $queryRaw: jest.fn().mockResolvedValue(rows) } as never, file)).resolves.toBeUndefined();
    }
  });
  it('accepts a fresh database without a migration table', async () => {
    const error = new Prisma.PrismaClientKnownRequestError('table missing', { code: 'P2010', clientVersion: '5.22.0', meta: { code: '42P01' } });
    await expect(assertMigrationBaseline({ $queryRaw: jest.fn().mockRejectedValue(error) } as never, file)).resolves.toBeUndefined();
  });
  it('refuses the legacy checksum instead of resetting or rebaselining data', async () => {
    await expect(assertMigrationBaseline({ $queryRaw: jest.fn().mockResolvedValue([{ checksum: 'legacy-checksum' }]) } as never, file)).rejects.toThrow(/Incompatible initial migration/);
  });
  it('does not mistake an inaccessible database or migration table for a fresh installation', async () => {
    const error = new Prisma.PrismaClientKnownRequestError('permission denied', { code: 'P2010', clientVersion: '5.22.0', meta: { code: '42501' } });
    await expect(assertMigrationBaseline({ $queryRaw: jest.fn().mockRejectedValue(error) } as never, file)).rejects.toBe(error);
  });
});
