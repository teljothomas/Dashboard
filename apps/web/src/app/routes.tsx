import type { RouteObject } from 'react-router';
import { PlaceholderPage } from '../features/placeholder/PlaceholderPage';
import { Layout } from './Layout';

export const routes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { index: true, element: <PlaceholderPage titleKey="page.home.title" /> },
      { path: 'trips', element: <PlaceholderPage titleKey="page.trips.title" /> },
      { path: 'expenses', element: <PlaceholderPage titleKey="page.expenses.title" /> },
      { path: 'approvals', element: <PlaceholderPage titleKey="page.approvals.title" /> },
      { path: 'more', element: <PlaceholderPage titleKey="page.more.title" /> },
      { path: '*', element: <PlaceholderPage titleKey="page.notFound.title" /> },
    ],
  },
];
