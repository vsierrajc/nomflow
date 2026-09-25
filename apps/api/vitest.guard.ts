/**
 * Las pruebas vacían tablas. Si DATABASE_URL apunta a una base que no termina en «_test» (por ejemplo la
 * de desarrollo, `nomflow`), se detienen antes de tocar nada.
 */
const url = process.env.DATABASE_URL;
if (url) {
  let db = '';
  try {
    db = new URL(url).pathname.replace(/^\//, '');
  } catch {
    // URL inválida: se trata como no segura
  }
  if (!/_test$/.test(db)) {
    throw new Error(
      `Las pruebas se niegan a correr contra la base «${db || url.replace(/:[^:@/]*@/, ':***@')}»: vacían tablas. Use una base cuyo nombre termine en _test (nomflow_test).`,
    );
  }
}
