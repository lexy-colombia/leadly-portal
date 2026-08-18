-- product-images nunca necesitó una policy de UPDATE hasta ahora: cada
-- upload de foto de producto usa un filename único (Date.now()), nunca
-- reescribe un objeto existente. Los logos de marca (uploadBrandLogo,
-- lib/api/brands.ts) sí usan un path fijo por marca con upsert:true --
-- mismo patrón de "single slot" que tenant-logos, que ya tiene su propia
-- policy de UPDATE (tenant_logos_update) por la misma razón. Sin esto, la
-- primera subida de un logo funciona (INSERT) pero cambiar el logo después
-- fallaría (el upsert hace un UPDATE sobre el objeto existente).
create policy product_images_storage_update on storage.objects
  for update using (
    bucket_id = 'product-images' and (is_superadmin() or (storage.foldername(name))[1] = auth_active_tenant_id()::text)
  );
