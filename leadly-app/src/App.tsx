import { BrowserRouter, Routes, Route } from 'react-router-dom'
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
import { ComingSoon } from './pages/ComingSoon'
import { ClientesList } from './pages/backoffice/ClientesList'
import { ClienteDetalle } from './pages/backoffice/ClienteDetalle'
import { Configuracion } from './pages/backoffice/Configuracion'
import { Asistente } from './pages/tenant/Asistente'
import { Usuarios } from './pages/tenant/Usuarios'
import { Inbox } from './pages/tenant/Inbox'
import { Contactos } from './pages/tenant/Contactos'
import { ContactoDetalle } from './pages/tenant/ContactoDetalle'
import { LockedFeature } from './pages/tenant/LockedFeature'
import { MiCuenta } from './pages/shared/MiCuenta'
import { CatalogIcon, MegaphoneIcon } from './components/icons'

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
            <Route index element={<ComingSoon title="Dashboard" />} />
            <Route path="clientes" element={<ClientesList />} />
            {/* Líneas de WhatsApp lives inside ClienteDetalle, not as its own route. */}
            <Route path="clientes/:id" element={<ClienteDetalle />} />
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
            <Route path="clientes" element={<Contactos />} />
            <Route path="clientes/:id" element={<ContactoDetalle />} />
            <Route
              path="campanas"
              element={
                <LockedFeature
                  icon={MegaphoneIcon}
                  title="Campañas"
                  description="Pausas publicitarias y campañas masivas de WhatsApp llegarán próximamente. Estamos trabajando en esta función."
                />
              }
            />
            <Route
              path="catalogo"
              element={
                <LockedFeature
                  icon={CatalogIcon}
                  title="Catálogo"
                  description="Muestra tu catálogo de productos directamente en WhatsApp. Esta función estará disponible próximamente."
                />
              }
            />
            <Route path="asistente" element={<Asistente />} />
            <Route path="usuarios" element={<Usuarios />} />
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
