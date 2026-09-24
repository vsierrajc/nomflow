import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'NOMFLOW', description: 'Portal de autoservicio de empleados' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>
        <div className="shell">
          <p className="brand">NOMFLOW</p>
          {children}
        </div>
      </body>
    </html>
  );
}
