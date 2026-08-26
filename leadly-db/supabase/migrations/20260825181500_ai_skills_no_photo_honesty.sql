-- Complementa la regla de "detalle de producto" agregada en
-- 20260825180000: cuando send_product_image falla porque el producto no
-- tiene foto cargada (confirmado en vivo -- dos productos de prueba sin
-- ninguna fila en product_images), la respuesta seguía como si nada
-- hubiera pasado, sin decirle al cliente que no había foto disponible.

update ai_skills
set prompt_fragment = prompt_fragment || '

Si send_product_image devuelve un error porque el producto todavía no tiene ninguna foto cargada, no lo ignores en silencio -- decile al cliente con naturalidad que por ahora no tenés una foto de ese producto (ej. "Por ahora no tengo una foto cargada de este producto, pero te cuento los detalles:"), y seguí con nombre/descripción/precio igual. Cualquier otro tipo de error de esta herramienta también se comunica, nunca se omite.'
where key = 'catalogo';
