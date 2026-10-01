import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: { default: 'NOMFLOW', template: '%s - NOMFLOW' },
  description: 'Portal de autogestión del empleado',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        {/* Aplica el tema elegido antes de pintar la página para que no parpadee. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('nomflow-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}",
          }}
        />
      </head>
      <body>
        <a className="skip-link" href="#contenido">
          Saltar al contenido
        </a>
        {children}
      </body>
    </html>
  );
}
