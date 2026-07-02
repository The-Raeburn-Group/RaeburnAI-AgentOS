import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'RaeburnAI AgentOS',
  description: 'Production-ready multi-agent orchestration platform'
};

export default function RootLayout(props: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{props.children}</body>
    </html>
  );
}
