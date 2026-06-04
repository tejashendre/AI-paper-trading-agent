import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

export const metadata: Metadata = {
    title: "BTC Quant Trader | Algorithmic Trading System",
    description: "Multi-timeframe algorithmic Bitcoin trading system with technical analysis confluence scoring",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en" className="dark">
            <body className="antialiased min-h-screen">
                {children}
                <Analytics />
            </body>
        </html>
    );
}
