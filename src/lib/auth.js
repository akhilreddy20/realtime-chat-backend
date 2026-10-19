import jwt from 'jsonwebtoken';
import { config, isProduction } from '../config/index.js';

export const COOKIE_NAME = 'jwt';

export const signToken = (userId) =>
  jwt.sign({ sub: String(userId) }, config.jwtSecret, { expiresIn: config.jwtTtlSeconds });

/** Returns the user id, or null for a missing/invalid/expired token. */
export const verifyToken = (token) => {
  if (!token) return null;
  try {
    return jwt.verify(token, config.jwtSecret).sub ?? null;
  } catch {
    return null;
  }
};

export const setAuthCookie = (res, userId) => {
  res.cookie(COOKIE_NAME, signToken(userId), {
    httpOnly: true, // not readable from JS (XSS can't steal it)
    sameSite: 'strict', // not sent on cross-site requests (CSRF)
    secure: isProduction(),
    maxAge: config.jwtTtlSeconds * 1000,
    path: '/',
  });
};

export const clearAuthCookie = (res) =>
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', secure: isProduction(), path: '/' });

/** Token from the httpOnly cookie, or an "Authorization: Bearer" header (API clients). */
export const tokenFromRequest = ({ cookies, headers }) => {
  if (cookies?.[COOKIE_NAME]) return cookies[COOKIE_NAME];
  const header = headers?.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
};

/** Minimal Cookie header parser, used for the Socket.IO handshake. */
export const parseCookies = (header = '') =>
  Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([k, v]) => k && v !== undefined)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
