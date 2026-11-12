import { lazy, Suspense, type ReactNode } from 'react';
import type { RouteObject } from 'react-router';
import { MorePage } from '../features/account/MorePage';
import { ChangePasswordPage } from '../features/auth/ChangePasswordPage';
import { LoginPage } from '../features/auth/LoginPage';
import { LoadingScreen, RequireAuth, RequirePermission } from '../features/auth/RequireAuth';
import { ResetPasswordPage } from '../features/auth/ResetPasswordPage';
import { PlaceholderPage } from '../features/placeholder/PlaceholderPage';
import { Layout } from './Layout';
import { navItemFor } from './navItems';

// Administration is used by a few people: keep it out of the initial bundle every phone downloads.
const UsersPage = lazy(() =>
  import('../features/admin/UsersPage').then((m) => ({ default: m.UsersPage })),
);
const UserCreatePage = lazy(() =>
  import('../features/admin/UserCreatePage').then((m) => ({ default: m.UserCreatePage })),
);
const UserDetailPage = lazy(() =>
  import('../features/admin/UserDetailPage').then((m) => ({ default: m.UserDetailPage })),
);
const RolesPage = lazy(() =>
  import('../features/admin/RolesPage').then((m) => ({ default: m.RolesPage })),
);
const RoleEditorPage = lazy(() =>
  import('../features/admin/RoleEditorPage').then((m) => ({ default: m.RoleEditorPage })),
);
const AuditPage = lazy(() =>
  import('../features/admin/AuditPage').then((m) => ({ default: m.AuditPage })),
);

/** A page that needs one of the permissions of its nav entry. UI hint only: the API authorizes. */
function forNavItem(to: string, element: ReactNode): ReactNode {
  return <RequirePermission anyOf={navItemFor(to).anyOf}>{element}</RequirePermission>;
}

/** An administration page: the chunk is fetched only once the permission check passes. */
function requires(permission: string, element: ReactNode): ReactNode {
  return (
    <RequirePermission anyOf={[permission]}>
      <Suspense fallback={<LoadingScreen />}>{element}</Suspense>
    </RequirePermission>
  );
}

export const routes: RouteObject[] = [
  { path: 'login', element: <LoginPage /> },
  { path: 'reset-password', element: <ResetPasswordPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: 'change-password', element: <ChangePasswordPage /> },
      {
        element: <Layout />,
        children: [
          { index: true, element: <PlaceholderPage titleKey="page.home.title" /> },
          {
            path: 'trips',
            element: forNavItem('/trips', <PlaceholderPage titleKey="page.trips.title" />),
          },
          {
            path: 'expenses',
            element: forNavItem('/expenses', <PlaceholderPage titleKey="page.expenses.title" />),
          },
          {
            path: 'approvals',
            element: forNavItem('/approvals', <PlaceholderPage titleKey="page.approvals.title" />),
          },
          { path: 'more', element: <MorePage /> },
          { path: 'admin/users', element: requires('users.manage', <UsersPage />) },
          { path: 'admin/users/new', element: requires('users.manage', <UserCreatePage />) },
          { path: 'admin/users/:id', element: requires('users.manage', <UserDetailPage />) },
          { path: 'admin/roles', element: requires('roles.manage', <RolesPage />) },
          { path: 'admin/roles/new', element: requires('roles.manage', <RoleEditorPage />) },
          { path: 'admin/roles/:id', element: requires('roles.manage', <RoleEditorPage />) },
          { path: 'admin/audit', element: requires('audit.view', <AuditPage />) },
          { path: '*', element: <PlaceholderPage titleKey="page.notFound.title" /> },
        ],
      },
    ],
  },
];
