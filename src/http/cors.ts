import type { RequestHandler } from 'express';

import { ALLOWED_ORIGINS } from '../config.js';
import { HttpError } from './errors.js';

/**
 * Only the website may call the API with credentials. Writes from anywhere
 * else are refused outright, on top of the SameSite cookie protection.
 */
export const cors: RequestHandler = (req, res, next) => {
  const origin = req.headers.origin;
  const allowed = origin !== undefined && ALLOWED_ORIGINS.has(origin);

  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') {
    if (!allowed) return void res.status(403).end();
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    return void res.status(204).end();
  }

  if (!['GET', 'HEAD'].includes(req.method) && origin !== undefined && !allowed) {
    return next(new HttpError(403, 'Cross-origin requests aren’t allowed.'));
  }

  next();
};

/** Mutating JSON endpoints must come from the site, never a bare form post. */
export const requireSiteOrigin: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD'].includes(req.method)) return next();
  if (!req.headers.origin || !ALLOWED_ORIGINS.has(req.headers.origin)) {
    return next(new HttpError(403, 'Cross-origin requests aren’t allowed.'));
  }
  next();
};
