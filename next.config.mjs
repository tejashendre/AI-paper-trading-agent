/** @type {import('next').NextConfig} */
const nextConfig = {
    reactStrictMode: true,
    async redirects() {
        return [
            {
                source: '/:path*',
                has: [
                    {
                        type: 'host',
                        value: '(?!(ai-quant-trader\\.duckdns\\.org|localhost)).*',
                    },
                ],
                destination: 'https://ai-quant-trader.duckdns.org/:path*',
                permanent: true,
            },
        ];
    },
};

export default nextConfig;
