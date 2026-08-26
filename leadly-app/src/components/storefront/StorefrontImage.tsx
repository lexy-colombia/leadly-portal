import { useState } from 'react'
import { ImageOffIcon } from 'lucide-react'

/** `<img>` con fallback prolijo -- cubre tanto `src` nulo (nunca se subió
 * foto) como una URL que existe pero cuyo archivo ya no está en el storage
 * (rutas viejas de productos editados/borrados): el navegador no expone eso
 * como una promesa rechazable, solo como el evento `onError` del propio
 * `<img>`, así que sin esto se veía el ícono roto genérico en vez de un
 * placeholder consistente con el resto de la tienda. */
export function StorefrontImage({ src, alt, className = '', iconClassName = 'size-6', fit = 'cover' }: { src: string | null | undefined; alt: string; className?: string; iconClassName?: string; fit?: 'cover' | 'contain' }) {
  const [failed, setFailed] = useState(false)

  if (!src || failed) {
    return (
      <div className={`flex items-center justify-center bg-muted text-muted-foreground ${className}`}>
        <ImageOffIcon className={iconClassName} />
      </div>
    )
  }

  return <img src={src} alt={alt} onError={() => setFailed(true)} className={`${fit === 'contain' ? 'object-contain' : 'object-cover'} ${className}`} />
}
