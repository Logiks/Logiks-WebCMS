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
    }
  }
}
