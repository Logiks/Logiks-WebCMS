import authRoutes from './routes.js';

/** Sign-in, sign-out, password reset and invitations (/api/auth). */
export default {
  id: 'auth',
  label: 'Sign-in',
  description: 'Sessions, password reset and invitations.',
  provides: { services: ['recovery', 'sessionStore'], jobs: ['auth.cleanup', 'sessions.cleanup'] },
  routes: { auth: authRoutes },
};
