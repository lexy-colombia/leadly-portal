/** Logo de marca de la app -- pasó de un wordmark de texto "Leadly" a la
 * imagen real de Lexy (2026-09-02, pedido explícito del usuario: "quita
 * leadly y pon el logo de lexy", rebranding completo del componente que se
 * usa en sidebar/login). Assets copiados tal cual del manual de marca
 * (Desktop/Proyectos/Lexy/Manual de marca/Lexy col/svg/lexy-logo-principal-
 * {color,blanco}.svg) a `public/brand/` -- mismo criterio que el resto de
 * assets estáticos del proyecto (favicon, apple-touch-icon), sin pipeline de
 * importación de SVG como componente (no hay SVGR configurado en Vite).
 * `onDark` sigue existiendo con el mismo propósito que antes: elige la
 * variante blanca para el sidebar/panel de auth con fondo navy. */
export function Logo({ size = 'md', onDark = false, className = '' }: { size?: 'sm' | 'md' | 'nav' | 'lg'; onDark?: boolean; className?: string }) {
  // `nav` es un tamaño propio para el header del sidebar (2026-09-02,
  // pedido explícito del usuario: "quiero mas grande") -- `md` se sentía
  // chico ahí y `lg` está pensado para el hero del login, demasiado grande
  // para un header de nav angosto.
  const heights = { sm: 'h-6', md: 'h-8', nav: 'h-10', lg: 'h-12 sm:h-16' }
  const src = onDark ? '/brand/lexy-logo-white.svg' : '/brand/lexy-logo-color.svg'

  return <img src={src} alt="Lexy" className={`w-auto ${heights[size]} ${className}`} />
}
