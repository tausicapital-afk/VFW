import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';
import { NewSubmission } from './pages/NewSubmission';
import { Queue } from './pages/Queue';
import { Submissions } from './pages/Submissions';
import { SubmissionDetail } from './pages/SubmissionDetail';
import { Guard, Shell } from './shell/Shell';
import './styles/console.css';

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      // A 401 or 403 will not become a 200 by asking again.
      retry: (count, err) => {
        const status = (err as { status?: number }).status;
        if (status === 401 || status === 403 || status === 404) return false;
        return count < 2;
      },
      refetchOnWindowFocus: false,
    },
  },
});

function Routed() {
  const { user, loading } = useAuth();

  // Render nothing until the session check resolves, otherwise a signed-in user
  // sees the login screen flash before being bounced back into the app.
  if (loading) return null;
  if (!user) return <Login />;

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/new" element={<Guard permission="submission.create"><NewSubmission /></Guard>} />
        <Route path="/submissions" element={<Submissions />} />
        <Route path="/submissions/:id" element={<SubmissionDetail />} />
        <Route path="/queue" element={<Guard permission="submission.approve"><Queue /></Guard>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <AuthProvider>
          <Routed />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
