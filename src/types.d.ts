import 'express-session';

declare module 'express-session' {
  interface SessionData {
    userId?: number;
    csrf?: boolean;
    meta?: { ip?: string; ua?: string; createdAt: number; lastSeen: number };
  }
}

declare global {
  namespace Express {
    interface Request {
      /** Signed-in principal, set by loadPrincipal (null when anonymous). */
      user?: any;
      /** The verified API key behind a /api/v1 request (D-068); unset for anonymous callers. */
      apiKey?: { id: number; name: string; scopes: string[]; rateLimit: number };
      /** An API key was sent but isn't valid; the public API turns this into a 401 after rate limiting. */
      badApiKey?: boolean;
    }
  }
}
