/** Refuse silently upgrading a database initialized by the incompatible pre-protocol schema. Never resets data. */
import { Prisma, PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

export async function assertMigrationBaseline(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  migrationFile = join(__dirname, '../../prisma/migrations/20261024000000_init/migration.sql'),
): Promise<void> {
  const expected = createHash('sha256').update(readFileSync(migrationFile)).digest('hex');
  let rows: Array<{ checksum: string }>;
  try {
    rows = await prisma.$queryRaw<Array<{ checksum: string }>>`
      SELECT checksum FROM "_prisma_migrations"
      WHERE migration_name = '20261024000000_init' AND finished_at IS NOT NULL AND rolled_back_at IS NULL
    `;
  } catch (error) {
    // No migration table is normal on a new database. Permission, connection and other SQL errors stay fatal.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010' && error.meta?.code === '42P01') return;
    throw error;
  }
  if (rows.some((row) => row.checksum !== expected)) {
    throw new Error('Incompatible initial migration detected. Deployment stopped without changing data. Preserve a database backup and prepare a tested legacy migration; do not reset the database or mark this migration applied.');
  }
}

async function main(): Promise<void> {
  const prisma = new PrismaClient({ errorFormat: 'minimal' });
  try {
    await assertMigrationBaseline(prisma);
    console.log('Database migration baseline accepted');
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch(() => {
    console.error('Database preflight refused deployment: incompatible migration baseline or database unavailable. No reset or data conversion performed.');
    process.exitCode = 1;
  });
}
