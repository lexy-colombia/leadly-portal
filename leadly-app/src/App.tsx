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
import { ProductDetail } from './pages/tenant/ProductDetail'
import { Orders } from './pages/tenant/Orders'
import { OrderDetail } from './pages/tenant/OrderDetail'
import { Tasks } from './pages/tenant/Tasks'
import { Calendar } from './pages/tenant/Calendar'
import { Billing as TenantBilling } from './pages/tenant/Billing'
import { Integrations as TenantIntegrations } from './pages/tenant/Integrations'
import { AiAgents } from './pages/tenant/AiAgents'
import { LockedFeature } from './pages/tenant/LockedFeature'
import { MyAccount } from './pages/shared/MyAccount'
import { MegaphoneIcon } from '@/components/atoms/icons'

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
            <Route path="clientes" element={<TenantsList />} />
            {/* Líneas de WhatsApp lives inside TenantDetail, not as its own route. */}
            <Route path="clientes/:id" element={<TenantDetail />} />
            <Route path="facturacion" element={<Billing />} />
            <Route path="integraciones" element={<Integrations />} />
            <Route path="configuracion" element={<Settings />} />
            <Route path="novedades" element={<Changelog />} />
            <Route path="perfil" element={<MyAccount />} />
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
            <Route index element={<RequireModule moduleKey="conversations"><Inbox /></RequireModule>} />
            <Route path="dashboard" element={<RequireModule moduleKey="dashboard"><TenantDashboard /></RequireModule>} />
            <Route path="clientes" element={<RequireModule moduleKey="contacts"><Clients /></RequireModule>} />
            <Route path="clientes/:id" element={<RequireModule moduleKey="contacts"><ClientDetail /></RequireModule>} />
            {/* Empresas se fusionó dentro de Clients (crm_accounts fue
                eliminada) -- este redirect solo cubre links/bookmarks viejos. */}
            <Route path="empresas" element={<Navigate to="/app/clientes" replace />} />
            <Route path="oportunidades" element={<RequireModule moduleKey="pipeline"><Opportunities /></RequireModule>} />
            <Route path="productos" element={<RequireModule moduleKey="products"><Products /></RequireModule>} />
            <Route path="productos/categorias" element={<RequireModule moduleKey="products"><Categories /></RequireModule>} />
            <Route path="productos/marcas" element={<RequireModule moduleKey="products"><Brands /></RequireModule>} />
            <Route path="productos/:id" element={<RequireModule moduleKey="products"><ProductDetail /></RequireModule>} />
            {/* Warehouses (Inventario Fase 1) se movió al perfil de la empresa
                (Configuración) el 2026-08-16 -- ya no tiene ruta propia. */}
            <Route path="inventario" element={<Navigate to="/app/configuracion" replace />} />
            <Route path="ventas" element={<RequireModule moduleKey="sales"><Orders /></RequireModule>} />
            <Route path="ventas/:id" element={<RequireModule moduleKey="sales"><OrderDetail /></RequireModule>} />
            <Route path="tareas" element={<RequireModule moduleKey="tasks"><Tasks /></RequireModule>} />
            <Route path="calendario" element={<RequireModule moduleKey="calendar"><Calendar /></RequireModule>} />
            <Route path="ia-agentes" element={<RequireModule moduleKey="aiAgents"><AiAgents /></RequireModule>} />
            <Route path="facturacion" element={<RequireModule moduleKey="billing"><TenantBilling /></RequireModule>} />
            <Route path="integraciones" element={<RequireModule moduleKey="integrations"><TenantIntegrations /></RequireModule>} />
            <Route
              path="campanas"
              element={
                <RequireModule moduleKey="campaigns">
                  <LockedFeature icon={MegaphoneIcon} descriptionKey="account.locked.campaigns" />
                </RequireModule>
              }
            />
            {/* Catálogo se fusionó dentro de Products (mismo catálogo, no dos
                pantallas separadas) -- este redirect solo cubre links/bookmarks viejos. */}
            <Route path="catalogo" element={<Navigate to="/app/productos" replace />} />
            <Route path="configuracion" element={<RequireModule moduleKey="settings"><TenantSettings /></RequireModule>} />
            <Route path="novedades" element={<Changelog />} />
            <Route path="perfil" element={<MyAccount />} />
          </Route>

          <Route path="*" element={<RootRedirect />} />
        </Routes>
      </AuthProvider>
      </LanguageProvider>
    </BrowserRouter>
  )
}
