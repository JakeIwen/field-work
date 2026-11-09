import type { Response } from "express";

/** The local preview and cloud shell enforce the same client resource policy. */
export function clientSecurityHeaders(res: Response) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' blob:; frame-src 'self' http://127.0.0.1:* blob:; object-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
  );
}
