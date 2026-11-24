import type { Metadata, Viewport } from 'next';
import { Inter, Manrope } from 'next/font/google';
import { StoreProvider } from '@/lib/store';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const manrope = Manrope({ subsets: ['latin'], weight: ['600', '700', '800'], variable: '--font-manrope', display: 'swap' });

export const metadata: Metadata = {
  title: 'Hedge 360 · Hedging and risk desk',
  description: 'Options screener and position hedging for HNIs and active traders (demo).',
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#F3F6FA' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${manrope.variable}`}>
      <body>
        <StoreProvider>{children}</StoreProvider>
      </body>
    </html>
  );
}
