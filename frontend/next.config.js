/** @type {import('next').NextConfig} */
const backend = process.env.API_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// Only the staff routes are proxied. The Food Hub integration API (/api/v1/integrations/...) and the
// simulator's write endpoints are never reachable through the dashboard's public port.
const STAFF = ['auth', 'operators', 'devices', 'certificates', 'transactions', 'reports'];

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [
      ...STAFF.map((p) => ({ source: `/api/${p}/:path*`, destination: `${backend}/api/${p}/:path*` })),
      ...STAFF.map((p) => ({ source: `/api/${p}`, destination: `${backend}/api/${p}` })),
      { source: '/api/health', destination: `${backend}/api/health` },
      { source: '/api/health/ready', destination: `${backend}/api/health/ready` },
      { source: '/api/mev-simulator/health', destination: `${backend}/api/mev-simulator/health` },
    ];
  },
};

module.exports = nextConfig;
