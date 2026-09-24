import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: { default: 'NOMFLOW', template: '%s - NOMFLOW' },
  description: 'Portal de autogestión del empleado',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>
        <a className="skip-link" href="#contenido">
          Saltar al contenido
        </a>
        {children}
      </body>
    </html>
  );
}
