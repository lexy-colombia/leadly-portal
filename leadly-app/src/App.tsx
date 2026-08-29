import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import { LanguageProvider } from './contexts/LanguageContext'
import { RequireAuth, RequireModule, RequireRole } from './routes/guards'
import { RootRedirect } from './routes/RootRedirect'
import { Login } from './pages/auth/Login'
import { Signup } from './pages/auth/Signup'
import { ForgotPassword } from './pages/auth/ForgotPassword'
import { CreateCompany } from './pages/auth/CreateCompany'
import { BackofficeLayout } from './layouts/BackofficeLayout'
import { TenantLayout } from './layouts/TenantLayout'
import { StorefrontLayout } from './layouts/StorefrontLayout'
import { StorefrontCatalog } from './pages/storefront/StorefrontCatalog'
import { StorefrontProductDetail } from './pages/storefront/StorefrontProductDetail'
import { StorefrontCart } from './pages/storefront/StorefrontCart'
import { Changelog } from './pages/Changelog'
import { TenantsList } from './pages/backoffice/TenantsList'
import { TenantDetail } from './pages/backoffice/TenantDetail'
import { Settings } from './pages/backoffice/Settings'
import { Billing } from './pages/backoffice/Billing'
import { Integrations } from './pages/backoffice/Integrations'
import { Dashboard as BackofficeDashboard } from './pages/backoffice/Dashboard'
import { Settings as TenantSettings } from './pages/tenant/Settings'
import { Dashboard as TenantDashboard } from './pages/tenant/Dashboard'
import { Inbox } from './pages/tenant/Inbox'
import { Clients } from './pages/tenant/Clients'
import { ClientDetail } from './pages/tenant/ClientDetail'
import { Opportunities } from './pages/tenant/Opportunities'
import { Products } from './pages/tenant/Products'
import { Categories } from './pages/tenant/Categories'
import { Brands } from './pages/tenant/Brands'
import { Suppliers } from './pages/tenant/Suppliers'
import { ProductDetail } from './pages/tenant/ProductDetail'
import { Orders } from './pages/tenant/Orders'
import { OrderDetail } from './pages/tenant/OrderDetail'
import { Credit } from './pages/tenant/Credit'
import { Returns } from './pages/tenant/Returns'
import { Calendar } from './pages/tenant/Calendar'
import { Billing as TenantBilling } from './pages/tenant/Billing'
import { Integrations as TenantIntegrations } from './pages/tenant/Integrations'
import { AiAgents } from './pages/tenant/AiAgents'
import { Campaigns } from './pages/tenant/Campaigns'
import { Users as TenantUsers } from './pages/tenant/Users'
import { Roles as TenantRoles } from './pages/tenant/Roles'
import { MyAccount } from './pages/shared/MyAccount'

export default function App() {
  return (
    <BrowserRouter>
      <LanguageProvider>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          {/* CreateCompany guards itself (session + unprovisioned checks) instead of using
              RequireAuth, since RequireAuth's own unprovisioned check redirects here --
              wrapping it would just bounce this route back to itself. */}
          <Route path="/create-company" element={<CreateCompany />} />
          {/* Tienda pública por tenant (marketplace) -- sin auth, hermana de
              /login, StorefrontLayout resuelve el tenant por :slug y no
              TenantLayout/RequireAuth (esos asumen una sesión). */}
          <Route path="/tienda/:slug" element={<StorefrontLayout />}>
            <Route index element={<StorefrontCatalog />} />
            <Route path="producto/:productId" element={<StorefrontProductDetail />} />
            <Route path="carrito" element={<StorefrontCart />} />
          </Route>
          <Route path="/" element={<RootRedirect />} />

          <Route
            path="/backoffice"
            element={
              <RequireAuth>
                <RequireRole allowed={['superadmin']}>
                  <BackofficeLayout />
                </RequireRole>
              </RequireAuth>
            }
          >
            <Route index element={<BackofficeDashboard />} />
            <Route path="clients" element={<TenantsList />} />
            {/* Líneas de WhatsApp lives inside TenantDetail, not as its own route. */}
            <Route path="clients/:id" element={<TenantDetail />} />
            <Route path="billing" element={<Billing />} />
            <Route path="integrations" element={<Integrations />} />
            <Route path="settings" element={<Settings />} />
            <Route path="changelog" element={<Changelog />} />
            <Route path="account" element={<MyAccount />} />
          </Route>

          <Route
            path="/app"
            element={
              <RequireAuth>
                <RequireRole allowed={['tenant_admin', 'tenant_agent']}>
                  <TenantLayout />
                </RequireRole>
              </RequireAuth>
            }
          >
            <Route index element={<RequireModule moduleKey="conversations" action="conversations.view"><Inbox /></RequireModule>} />
            <Route path="dashboard" element={<RequireModule moduleKey="dashboard"><TenantDashboard /></RequireModule>} />
            <Route path="clients" element={<RequireModule moduleKey="contacts" action="contacts.view"><Clients /></RequireModule>} />
            <Route path="clients/:id" element={<RequireModule moduleKey="contacts" action="contacts.view"><ClientDetail /></RequireModule>} />
            {/* Empresas se fusionó dentro de Clients (crm_accounts fue
                eliminada) -- este redirect solo cubre links/bookmarks viejos,
                se deja en español a propósito porque es lo que un bookmark
                viejo real todavía puede traer. */}
            <Route path="empresas" element={<Navigate to="/app/clients" replace />} />
            <Route path="opportunities" element={<RequireModule moduleKey="pipeline" action="pipeline.view"><Opportunities /></RequireModule>} />
            <Route path="products" element={<RequireModule moduleKey="products" action="products.view"><Products /></RequireModule>} />
            <Route path="products/categories" element={<RequireModule moduleKey="products" action="products.view"><Categories /></RequireModule>} />
            <Route path="products/brands" element={<RequireModule moduleKey="products" action="products.view"><Brands /></RequireModule>} />
            <Route path="products/suppliers" element={<RequireModule moduleKey="products" action="products.view"><Suppliers /></RequireModule>} />
            <Route path="products/:id" element={<RequireModule moduleKey="products" action="products.view"><ProductDetail /></RequireModule>} />
            {/* Warehouses (Inventario Fase 1) se movió al perfil de la empresa
                (Configuración) el 2026-08-16 -- ya no tiene ruta propia. */}
            <Route path="inventario" element={<Navigate to="/app/settings" replace />} />
            <Route path="sales" element={<RequireModule moduleKey="sales" action="sales.view"><Orders /></RequireModule>} />
            <Route path="sales/new" element={<RequireModule moduleKey="sales" action="sales.view"><OrderDetail /></RequireModule>} />
            <Route path="sales/:id" element={<RequireModule moduleKey="sales" action="sales.view"><OrderDetail /></RequireModule>} />
            <Route path="credit" element={<RequireModule moduleKey="credit" action="credit.view"><Credit /></RequireModule>} />
            <Route path="returns" element={<RequireModule moduleKey="returns" action="returns.view"><Returns /></RequireModule>} />
            {/* Tareas se fusionó dentro de Calendario el 2026-08-19 -- ya no
                tiene ruta propia. */}
            <Route path="tasks" element={<Navigate to="/app/calendar" replace />} />
            <Route path="calendar" element={<RequireModule moduleKey="calendar" action="calendar.view"><Calendar /></RequireModule>} />
            <Route path="ai-agents" element={<RequireModule moduleKey="aiAgents" action="aiAgents.view"><AiAgents /></RequireModule>} />
            <Route path="billing" element={<RequireModule moduleKey="billing"><TenantBilling /></RequireModule>} />
            <Route path="integrations" element={<RequireModule moduleKey="integrations"><TenantIntegrations /></RequireModule>} />
            <Route path="campaigns" element={<RequireModule moduleKey="campaigns" action="campaigns.view"><Campaigns /></RequireModule>} />
            <Route
              path="users"
              element={
                <RequireRole allowed={['tenant_admin']}>
                  <TenantUsers />
                </RequireRole>
              }
            />
            <Route
              path="roles"
              element={
                <RequireRole allowed={['tenant_admin']}>
                  <TenantRoles />
                </RequireRole>
              }
            />
            {/* Catálogo se fusionó dentro de Products (mismo catálogo, no dos
                pantallas separadas) -- este redirect solo cubre links/bookmarks viejos. */}
            <Route path="catalogo" element={<Navigate to="/app/products" replace />} />
            <Route path="settings" element={<RequireModule moduleKey="settings"><TenantSettings /></RequireModule>} />
            <Route path="changelog" element={<Changelog />} />
            <Route path="account" element={<MyAccount />} />
          </Route>

          <Route path="*" element={<RootRedirect />} />
        </Routes>
      </AuthProvider>
      </LanguageProvider>
    </BrowserRouter>
  )
}
