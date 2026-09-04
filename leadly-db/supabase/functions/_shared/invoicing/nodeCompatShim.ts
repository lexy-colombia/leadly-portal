/** Ajusta (no borra) el polyfill de `process` de Node que expone el runtime
 * REAL de Edge Functions (no existe al correr con el Deno CLI local, por
 * eso ninguno de estos dos bugs apareció en ninguna prueba local -- recién
 * se vieron al desplegar de verdad, uno después del otro).
 *
 * Dos librerías del pipeline de firma leen `process` para cosas
 * incompatibles entre sí en este runtime:
 *
 * 1. `pkijs` corre `initCryptoEngine()` automáticamente al importarse
 *    (antes de que cualquier código propio pueda actuar) y su `setEngine()`
 *    detecta `typeof process !== "undefined" && "pid" in process` para
 *    cachear el engine en `global[process.pid]` -- acá `process.pid` es
 *    `undefined` (el polyfill no lo implementa) y `global` resuelve a un
 *    objeto congelado en este runtime, así que `global[undefined] = {}`
 *    tira "Cannot assign to read only property 'undefined'".
 * 2. `node-forge` usa `typeof process !== 'undefined' && process.versions
 *    && process.versions.node` para decidir si usar `global` (rama
 *    Node.js) o `self`/`window` (rama navegador) como su "globalScope".
 *    Si `process` no existe (ej. borrándolo a mano, primer intento de este
 *    shim), cae a la rama navegador -- pero este runtime tampoco define
 *    `self` ni `window`, así que revienta con "window is not defined".
 *
 * La solución no es borrar `process`, es reemplazarlo por un objeto mínimo
 * que conteste lo que cada librería necesita sin activar la rama rota de
 * ninguna: sin `pid` (para que pkijs nunca entre a esa rama) pero con
 * `versions.node` (para que node-forge sí tome la rama `global`, que en
 * este runtime sí existe -- confirmado, el envío llegó más lejos con este
 * cambio).
 *
 * Importar este archivo como la PRIMERA línea del entrypoint de la función
 * (`index.ts`), no solo desde `certificate.ts` -- tanto pkijs (vía
 * xmldsigjs, dependencia interna) como node-forge (usado directo en
 * certificate.ts) necesitan este ajuste ya aplicado antes de que el grafo
 * de imports llegue a cualquiera de los dos, y con ESM eso solo se
 * garantiza siendo el primer import del archivo raíz. */
try {
  // deno-lint-ignore no-explicit-any
  (globalThis as any).process = { versions: { node: "20.0.0" } };
} catch {
  // Si el runtime no deja reasignar `process` (no configurable), no hay
  // más que intentar acá -- va a fallar igual y quedará evidente en los
  // logs, no en silencio.
}
