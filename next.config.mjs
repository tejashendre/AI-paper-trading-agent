/** @type {import('next').NextConfig} */
const nextConfig = {
    reactStrictMode: true,
    async redirects() {
        const canonicalHost = 'trader.tejashendre.com';
        const allowedHosts = [
            canonicalHost.replace(/\./g, '\\.'),
            'localhost',
            '127\\.0\\.0\\.1',
            '.*\\.trycloudflare\\.com',
        ].join('|');

        return [
            {
                source: '/:path*',
                has: [
                    {
                        type: 'host',
                        value: `(?!(?:${allowedHosts})$).*`,
                    },
                ],
                destination: `https://${canonicalHost}/:path*`,
                permanent: true,
            },
        ];
    },
};

export default nextConfig;
