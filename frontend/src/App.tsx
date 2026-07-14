import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { ThemeProvider } from './theme/ThemeContext';
import { Account } from './pages/Account';
import { Admin } from './pages/Admin';
import { Audit } from './pages/Audit';
import { Board } from './pages/Board';
import { Contacts } from './pages/Contacts';
import { ContactDetail } from './pages/ContactDetail';
import { Dashboard } from './pages/Dashboard';
import { Settings } from './pages/Settings';
import { EditSubmission } from './pages/EditSubmission';
import { Feedback } from './pages/Feedback';
import { Internal } from './pages/Internal';
import { Login } from './pages/Login';
import { Logs } from './pages/Logs';
import { Messages } from './pages/Messages';
import { NewSubmission } from './pages/NewSubmission';
import { Qbo } from './pages/Qbo';
import { Queue } from './pages/Queue';
import { Reports } from './pages/Reports';
import { ForgotPassword, ResetPassword } from './pages/ResetPassword';
import { Signup } from './pages/Signup';
import { Submissions } from './pages/Submissions';
import { SubmissionDetail } from './pages/SubmissionDetail';
import { Guard, Shell } from './shell/Shell';
import './styles/console.css';
import './styles/additions.css';

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

  // Signed out: sign-in, plus the three screens someone must be able to reach
  // *without* an account — redeeming an invitation and resetting a password.
  // Everything else collapses to the login form.
  if (!user) {
    return (
      <Routes>
        <Route path="/signup/:code" element={<Signup />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot" element={<ForgotPassword />} />
        <Route path="/reset" element={<ResetPassword />} />
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/new" element={<Guard permission="submission.create"><NewSubmission /></Guard>} />
        <Route path="/submissions" element={<Submissions />} />
        <Route path="/submissions/:id" element={<SubmissionDetail />} />
        <Route path="/submissions/:id/edit" element={<Guard permission="submission.editOwn"><EditSubmission /></Guard>} />
        <Route path="/qbo" element={<Guard permission="quickbooks.export"><Qbo /></Guard>} />
        <Route path="/contacts" element={<Contacts />} />
        <Route path="/contacts/:id" element={<ContactDetail />} />
        <Route path="/messages" element={<Guard permission="messaging.use"><Messages /></Guard>} />
        <Route path="/queue" element={<Guard permission="submission.approve"><Queue /></Guard>} />
        <Route path="/board" element={<Guard permission="leaderboard.view"><Board /></Guard>} />
        <Route path="/feedback" element={<Guard permission="feedback.view"><Feedback /></Guard>} />
        <Route path="/internal" element={<Guard permission="internal.view"><Internal /></Guard>} />
        <Route path="/reports" element={<Guard permission="reports.view"><Reports /></Guard>} />
        <Route path="/audit" element={<Guard permission="reports.view"><Audit /></Guard>} />
        <Route path="/admin" element={<Guard permission="admin.manage"><Admin /></Guard>} />
        <Route path="/logs" element={<Guard permission="activity.view"><Logs /></Guard>} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/account" element={<Account />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <BrowserRouter>
          <AuthProvider>
            <Routed />
          </AuthProvider>
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
