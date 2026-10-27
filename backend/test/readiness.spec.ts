import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { HealthController } from '../src/app.module';
import { APP_CONFIG } from '../src/config/app-config';
import { PrismaService } from '../src/prisma/prisma.service';

describe('HTTP liveness vs database readiness', () => {
  let app: INestApplication;
  let base: string;
  const query = jest.fn();
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: { mevEnvironment: 'SIMULATOR', certified: false } },
        { provide: PrismaService, useValue: { $queryRaw: query } },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); });

  it('keeps liveness up while a failed database makes readiness return 503 without internal errors', async () => {
    query.mockRejectedValue(new Error('postgresql://sensitive:password@private-db/internal'));
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    const response = await fetch(`${base}/api/health/ready`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ statusCode: 503, status: 'not_ready', database: 'unavailable' });
  });

  it('returns ready after database recovery', async () => {
    query.mockResolvedValue([{ '?column?': 1 }]);
    const response = await fetch(`${base}/api/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', database: 'ready', environment: 'SIMULATOR', certified: false });
  });
});
