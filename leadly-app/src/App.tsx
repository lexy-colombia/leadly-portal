import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import { LanguageProvider } from './contexts/LanguageContext'
import { RequireAuth, RequireRole } from './routes/guards'
import { RootRedirect } from './routes/RootRedirect'
import { Login } from './pages/auth/Login'
import { Signup } from './pages/auth/Signup'
import { ForgotPassword } from './pages/auth/ForgotPassword'
import { CreateCompany } from './pages/auth/CreateCompany'
import { BackofficeLayout } from './layouts/BackofficeLayout'
import { TenantLayout } from './layouts/TenantLayout'
import { Changelog } from './pages/Changelog'
import { ClientesList } from './pages/backoffice/ClientesList'
import { ClienteDetalle } from './pages/backoffice/ClienteDetalle'
import { Configuracion } from './pages/backoffice/Configuracion'
import { Facturacion } from './pages/backoffice/Facturacion'
import { Dashboard as BackofficeDashboard } from './pages/backoffice/Dashboard'
import { Configuracion as TenantConfiguracion } from './pages/tenant/Configuracion'
import { Dashboard as TenantDashboard } from './pages/tenant/Dashboard'
import { Inbox } from './pages/tenant/Inbox'
import { Contactos } from './pages/tenant/Contactos'
import { ContactoDetalle } from './pages/tenant/ContactoDetalle'
import { Oportunidades } from './pages/tenant/Oportunidades'
import { Productos } from './pages/tenant/Productos'
import { ProductoDetalle } from './pages/tenant/ProductoDetalle'
import { Ventas } from './pages/tenant/Ventas'
import { VentaDetalle } from './pages/tenant/VentaDetalle'
import { Tareas } from './pages/tenant/Tareas'
import { Calendario } from './pages/tenant/Calendario'
import { Facturacion as TenantFacturacion } from './pages/tenant/Facturacion'
import { IaAgentes } from './pages/tenant/IaAgentes'
import { LockedFeature } from './pages/tenant/LockedFeature'
import { MiCuenta } from './pages/shared/MiCuenta'
import { BarChartIcon, MegaphoneIcon, RefreshIcon } from './components/icons'

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
            <Route path="clientes" element={<ClientesList />} />
            {/* Líneas de WhatsApp lives inside ClienteDetalle, not as its own route. */}
            <Route path="clientes/:id" element={<ClienteDetalle />} />
            <Route path="facturacion" element={<Facturacion />} />
            <Route path="configuracion" element={<Configuracion />} />
            <Route path="novedades" element={<Changelog />} />
            <Route path="perfil" element={<MiCuenta />} />
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
            <Route index element={<Inbox />} />
            <Route path="dashboard" element={<TenantDashboard />} />
            <Route path="clientes" element={<Contactos />} />
            <Route path="clientes/:id" element={<ContactoDetalle />} />
            {/* Empresas se fusionó dentro de Contactos (crm_accounts fue
                eliminada) -- este redirect solo cubre links/bookmarks viejos. */}
            <Route path="empresas" element={<Navigate to="/app/clientes" replace />} />
            <Route path="oportunidades" element={<Oportunidades />} />
            <Route path="productos" element={<Productos />} />
            <Route path="productos/:id" element={<ProductoDetalle />} />
            <Route path="ventas" element={<Ventas />} />
            <Route path="ventas/:id" element={<VentaDetalle />} />
            <Route path="tareas" element={<Tareas />} />
            <Route path="calendario" element={<Calendario />} />
            <Route
              path="reportes"
              element={
                <LockedFeature icon={BarChartIcon} descriptionKey="account.locked.reports" />
              }
            />
            <Route
              path="automatizaciones"
              element={
                <LockedFeature icon={RefreshIcon} descriptionKey="account.locked.automations" />
              }
            />
            <Route path="ia-agentes" element={<IaAgentes />} />
            <Route path="facturacion" element={<TenantFacturacion />} />
            <Route
              path="campanas"
              element={
                <LockedFeature icon={MegaphoneIcon} descriptionKey="account.locked.campaigns" />
              }
            />
            {/* Catálogo se fusionó dentro de Productos (mismo catálogo, no dos
                pantallas separadas) -- este redirect solo cubre links/bookmarks viejos. */}
            <Route path="catalogo" element={<Navigate to="/app/productos" replace />} />
            <Route path="configuracion" element={<TenantConfiguracion />} />
            <Route path="novedades" element={<Changelog />} />
            <Route path="perfil" element={<MiCuenta />} />
          </Route>

          <Route path="*" element={<RootRedirect />} />
        </Routes>
      </AuthProvider>
      </LanguageProvider>
    </BrowserRouter>
  )
}
